import { isBlockId } from "@megaui/core";
import type {
  CIStatus,
  CL,
  CLComment,
  CLFile,
  CLMergeState,
  CLState,
  Filter,
  Revision,
  User,
} from "@megaui/core";
import { megaClLinks, megaClPublicIds, megaCls, user, type Database } from "@megaui/database";
import {
  MAX_MEGA2_CL_PER_PAGE,
  MegaBadRequestError,
  MegaForbiddenError,
  MegaInternalError,
  MegaNotFoundError,
  addMega2ClComment,
  closeMega2Cl,
  ensureCLPublicId,
  lockCLNumberAllocation,
  nextCLNumber,
  fetchClCommits,
  fetchMega2ClDetail,
  fetchMega2ClFilesChanged,
  fetchMega2ClFilesList,
  fetchMega2ClList,
  fetchMega2ClMergeBox,
  matchesCLPublicId,
  mergeMega2Cl,
  reopenMega2Cl,
  type ClCommit,
  type Mega2ClDetailRes,
  type Mega2ClFileRes,
  type Mega2ClFilesChangedItem,
  type Mega2ClItemRes,
  type Mega2Condition,
  type Mega2MergeBoxRes,
} from "@megaui/engine";
import { asc, eq } from "drizzle-orm";

type Mega2MergeStatus = Mega2ClDetailRes["status"];

export interface Mega2ClListFilter {
  readonly text?: string;
  readonly states?: readonly string[];
  readonly packageIds?: Filter["packageIds"];
  readonly author?: string;
  readonly reviewer?: string;
  readonly sort?: Filter["sort"];
}

const MAX_MEGA2_LIST_PAGES_PER_STATUS = 200;
const MAX_MEGA2_DIFF_PAGES = 200;
const MERGE_BOX_CONCURRENCY = 8;

export interface ProjectedMega2CLFile extends CLFile {
  readonly oldPath?: string;
  readonly mega2Action?: Mega2ClFileRes["action"];
}

export interface ProjectedMega2CL extends CL {
  readonly files: ProjectedMega2CLFile[];
  readonly link: string;
  readonly repoPath: string;
  readonly headCommit: string;
  readonly headRevision: number;
  readonly baseBranch: string;
  readonly mergeBox?: Mega2MergeBoxRes;
}

export interface Mega2ProjectionOptions {
  readonly headers?: HeadersInit;
  readonly env?: Record<string, string | undefined>;
  readonly actorUserId?: string | null;
}

export function isMega2ClBackendEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.MEGA_CODE_DATA_BACKEND?.trim() === "mega2";
}

function isoFromUnixSeconds(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

function syntheticUser(username: string): User {
  const clean = username.trim() || "mega2";
  const initials = clean.slice(0, 2).toUpperCase();
  return {
    id: `mega2:${clean}`,
    username: clean,
    displayName: clean,
    avatarInitials: initials,
  };
}

function packageIdFromRepoPath(repoPath: string): string {
  const trimmed = repoPath.replace(/^\/+|\/+$/g, "");
  return trimmed || "root";
}

export function mapMega2StatusToCLState(
  status: Mega2MergeStatus,
  mergeBox?: Mega2MergeBoxRes,
): CLState {
  if (status === "Merged") return "merged";
  if (status === "Closed") return "closed";
  if (status === "Draft") return "wip";
  const hasConflict = mergeBox?.merge_requirements?.conditions.some(
    (c) => c.type === "MergeConflict" && c.result === "FAILED",
  );
  return hasConflict ? "conflicts" : "ready";
}

export function deriveCiStatusFromMergeBox(
  status: Mega2MergeStatus,
  mergeBox?: Mega2MergeBoxRes,
): CIStatus {
  const ciCondition: Mega2Condition | undefined =
    mergeBox?.merge_requirements?.conditions.find((c) => c.type === "CiStatus");
  if (ciCondition) {
    if (ciCondition.raw_status === "RUNNING") return "running";
    if (ciCondition.result === "PASSED") return "passing";
    if (ciCondition.result === "FAILED") return "failing";
    return "queued";
  }
  // Never report "passing" without explicit CiStatus=PASSED evidence.
  return status === "Merged" || status === "Closed" ? "skipped" : "queued";
}

export function deriveMergeStateFromMergeBox(
  status: Mega2MergeStatus,
  mergeBox?: Mega2MergeBoxRes,
): CLMergeState {
  if (status === "Merged") return "merged";
  const reqs = mergeBox?.merge_requirements;
  if (!reqs) return "needs-review";
  if (reqs.state === "MERGEABLE") return "queue-ready";
  const hasSyncFailure = reqs.conditions.some(
    (c) =>
      (c.type === "ClSync" || c.type === "MergeConflict") &&
      c.result === "FAILED",
  );
  return hasSyncFailure ? "rebase-needed" : "needs-review";
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function countDiffLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let hasHunk = false;

  for (const line of patch.split("\n")) {
    if (oldRemaining === 0 && newRemaining === 0) {
      const match = HUNK_HEADER_RE.exec(line);
      if (match) {
        hasHunk = true;
        oldRemaining = match[2] !== undefined ? Number(match[2]) : 1;
        newRemaining = match[4] !== undefined ? Number(match[4]) : 1;
      }
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
      if (newRemaining > 0) newRemaining -= 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
      if (oldRemaining > 0) oldRemaining -= 1;
    } else if (line.startsWith(" ")) {
      if (oldRemaining > 0) oldRemaining -= 1;
      if (newRemaining > 0) newRemaining -= 1;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" does not consume hunk line counts.
    }
  }

  if (!hasHunk) {
    for (const line of patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++ ")) additions += 1;
      else if (line.startsWith("-") && !line.startsWith("--- ")) deletions += 1;
    }
  }

  return { additions, deletions };
}

function mapFileAction(action: Mega2ClFileRes["action"]): CLFile["status"] {
  if (action === "new") return "added";
  if (action === "deleted") return "deleted";
  return "modified";
}

function buildProjectedFiles(
  filesList: readonly Mega2ClFileRes[],
  diffItems: readonly Mega2ClFilesChangedItem[],
): { files: ProjectedMega2CLFile[]; additions: number; deletions: number } {
  const diffByPath = new Map<string, Mega2ClFilesChangedItem>();
  for (const diff of diffItems) {
    diffByPath.set(diff.path, diff);
  }

  let totalAdditions = 0;
  let totalDeletions = 0;
  const files: ProjectedMega2CLFile[] = filesList.map((file) => {
    const diff = diffByPath.get(file.path);
    const patch = diff?.data ?? "";
    const counts = countDiffLines(patch);
    totalAdditions += counts.additions;
    totalDeletions += counts.deletions;
    const oldPath = file.old_path ?? diff?.old_path;
    return {
      path: file.path,
      status: mapFileAction(file.action),
      additions: counts.additions,
      deletions: counts.deletions,
      patch,
      viewed: false,
      commentCount: 0,
      mega2Action: file.action,
      ...(oldPath ? { oldPath } : {}),
    };
  });

  return { files, additions: totalAdditions, deletions: totalDeletions };
}

function buildCurrentRevision(
  detail: Mega2ClDetailRes,
  commits: readonly ClCommit[],
  ci: CIStatus,
  additions: number,
  deletions: number,
  filesChanged: number,
): Revision {
  const createdAt = isoFromUnixSeconds(detail.open_timestamp);
  return {
    id: `rev_${detail.link}_${detail.head_revision}`,
    number: detail.head_revision,
    sha: detail.to_hash,
    label: `rev ${detail.head_revision}`,
    createdAt,
    rebased: false,
    forcePushed: false,
    commitList: commits.map((c) => ({
      sha: c.sha,
      message: c.message,
      author: syntheticUser(c.authorName),
      createdAt,
      filesChanged,
      additions,
      deletions,
    })),
    reviewerState: [],
    summary: detail.title,
    base: `${detail.base_branch} @ ${detail.from_hash.slice(0, 7)}`,
    ci,
    additions,
    deletions,
    filesChanged,
  };
}

/**
 * Pure projection from a `mega2` `ItemRes`, its persisted identity, and live
 * `MergeBoxRes` to `@megaui/core` `CL` DTO. Never writes back to Postgres.
 */
export function projectMega2ClListItem(
  item: Mega2ClItemRes,
  identity: { number: number; publicId: string },
  mergeBox?: Mega2MergeBoxRes,
): ProjectedMega2CL {
  const state = mapMega2StatusToCLState(item.status, mergeBox);
  return {
    id: `cl_m2_${item.link}`,
    ...identity,
    title: item.title,
    state,
    packageId: packageIdFromRepoPath(item.path),
    author: syntheticUser(item.author),
    reviewers: [],
    additions: 0,
    deletions: 0,
    diffStatsAvailable: false,
    files: [],
    revisions: [],
    ci: deriveCiStatusFromMergeBox(item.status, mergeBox),
    merge: deriveMergeStateFromMergeBox(item.status, mergeBox),
    atomic: false,
    crossPackage: [],
    linkedIssues: [],
    branch: `refs/cl/${item.link}`,
    createdAt: isoFromUnixSeconds(item.open_timestamp),
    updatedAt: isoFromUnixSeconds(item.updated_at),
    ...(item.merge_timestamp !== null
      ? { mergedAt: isoFromUnixSeconds(item.merge_timestamp) }
      : {}),
    link: item.link,
    repoPath: item.path,
    headCommit: item.to_hash,
    headRevision: item.head_revision,
    baseBranch: item.base_branch,
    ...(mergeBox !== undefined ? { mergeBox } : {}),
  };
}

/**
 * Pure projection from live `mega2` detail, mergeBox, files, diffs, and
 * commits to `@megaui/core` `CL` DTO. Never writes mutable fields back to Postgres.
 */
export function projectMega2ClDetailDto(params: {
  number: number;
  publicId: string;
  detail: Mega2ClDetailRes;
  mergeBox: Mega2MergeBoxRes;
  filesList: readonly Mega2ClFileRes[];
  diffItems: readonly Mega2ClFilesChangedItem[] | null;
  commits: readonly ClCommit[];
}): ProjectedMega2CL {
  const { number, detail, mergeBox, filesList, diffItems, commits } = params;
  const state = mapMega2StatusToCLState(detail.status, mergeBox);
  const ci = deriveCiStatusFromMergeBox(detail.status, mergeBox);
  const merge = deriveMergeStateFromMergeBox(detail.status, mergeBox);
  const { files, additions, deletions } = buildProjectedFiles(
    filesList,
    diffItems ?? [],
  );
  const revision = buildCurrentRevision(
    detail,
    commits,
    ci,
    additions,
    deletions,
    files.length,
  );
  const createdAt = isoFromUnixSeconds(detail.open_timestamp);

  return {
    id: `cl_m2_${detail.link}`,
    number,
    publicId: params.publicId,
    title: detail.title,
    state,
    packageId: packageIdFromRepoPath(detail.path),
    author: syntheticUser(detail.author),
    reviewers: [],
    diffStatsAvailable: diffItems !== null,
    additions,
    deletions,
    files,
    revisions: [revision],
    ci,
    merge,
    atomic: false,
    crossPackage: [],
    linkedIssues: [],
    branch: `refs/cl/${detail.link}`,
    createdAt,
    updatedAt: createdAt,
    ...(detail.merge_timestamp !== null
      ? { mergedAt: isoFromUnixSeconds(detail.merge_timestamp) }
      : {}),
    link: detail.link,
    repoPath: detail.path,
    headCommit: detail.to_hash,
    headRevision: detail.head_revision,
    baseBranch: detail.base_branch,
    mergeBox,
  };
}

/**
 * The number and public ID stay stable as upstream state and viewer change.
 * Reserve both in one transaction under the lock shared with local CL creation.
 */
export async function ensureMegaClIdentity(
  db: Database,
  link: string,
): Promise<{ number: number; publicId: string }> {
  const [existing] = await db
    .select({ number: megaClLinks.number, publicId: megaClPublicIds.publicId })
    .from(megaClLinks)
    .innerJoin(megaClPublicIds, eq(megaClPublicIds.number, megaClLinks.number))
    .where(eq(megaClLinks.link, link))
    .limit(1);
  if (existing) return existing;

  return db.transaction(async (tx) => {
    await lockCLNumberAllocation(tx);

    const afterLock = await tx
      .select({ number: megaClLinks.number })
      .from(megaClLinks)
      .where(eq(megaClLinks.link, link))
      .limit(1);
    if (afterLock[0]?.number !== undefined) {
      const number = afterLock[0].number;
      return { number, publicId: await ensureCLPublicId(tx, number) };
    }

    // Preserve the earliest pre-seeded number already associated with this link in mega_cls,
    // unless that number is already allocated to a different link in mega_cl_links.
    const legacy = await tx
      .select({ number: megaCls.number })
      .from(megaCls)
      .where(eq(megaCls.link, link))
      .orderBy(asc(megaCls.number))
      .limit(1);

    let assignedNumber: number | undefined;
    const legacyNumber = legacy[0]?.number;
    if (legacyNumber !== undefined) {
      const taken = await tx
        .select({ link: megaClLinks.link })
        .from(megaClLinks)
        .where(eq(megaClLinks.number, legacyNumber))
        .limit(1);
      if (taken.length === 0) {
        assignedNumber = legacyNumber;
      }
    }

    if (assignedNumber === undefined) {
      assignedNumber = await nextCLNumber(tx);
    }

    await tx
      .insert(megaClLinks)
      .values({ link, number: assignedNumber })
      .onConflictDoNothing();

    const resolved = await tx
      .select({ number: megaClLinks.number })
      .from(megaClLinks)
      .where(eq(megaClLinks.link, link))
      .limit(1);
    if (resolved[0]?.number === undefined) {
      throw new MegaNotFoundError("CL link mapping", link);
    }
    const number = resolved[0].number;
    return { number, publicId: await ensureCLPublicId(tx, number) };
  });
}

/**
 * Resolves the immutable `mega2` `link` for a `!{number}` CL identifier.
 * Checks `mega_cl_links` first, then falls back read-only to `mega_cls.link`
 * for any pre-seeded mapping. Never reads mutable CL columns.
 */
export async function resolveMegaClLinkByNumber(
  db: Database,
  number: number,
): Promise<string> {
  const mapped = await db
    .select({ link: megaClLinks.link })
    .from(megaClLinks)
    .where(eq(megaClLinks.number, number))
    .limit(1);
  const directLink = mapped[0]?.link?.trim();
  if (directLink) {
    return directLink;
  }

  const legacy = await db
    .select({ link: megaCls.link })
    .from(megaCls)
    .where(eq(megaCls.number, number))
    .limit(1);
  const legacyLink = legacy[0]?.link?.trim();
  if (!legacyLink) {
    throw new MegaNotFoundError("CL", number);
  }
  return legacyLink;
}

async function resolveActorIdentityAliases(
  db: Database,
  actorUserId: string | null | undefined,
): Promise<Set<string>> {
  const aliases = new Set<string>();
  const id = actorUserId?.trim();
  if (!id) return aliases;
  aliases.add(id.toLowerCase());
  aliases.add(`mega2:${id.toLowerCase()}`);

  const rows = await db
    .select({ name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, id))
    .limit(1);
  const row = rows[0];
  if (row?.name?.trim()) {
    aliases.add(row.name.trim().toLowerCase());
  }
  if (row?.email?.trim()) {
    const emailLower = row.email.trim().toLowerCase();
    aliases.add(emailLower);
    const localPart = emailLower.split("@")[0]?.trim();
    if (localPart) aliases.add(localPart);
  }
  return aliases;
}

function mega2StatusesForFilter(filter: Mega2ClListFilter): string[] {
  // mega2 `POST /api/v1/cl/list` recognizes only `"open"` (Open + Draft) and
  // `"closed"` (Closed + Merged); any other value returns all statuses.
  const states = filter.states;
  if (!states || states.length === 0) {
    return ["open", "closed"];
  }
  const statuses = new Set<string>();
  for (const st of states) {
    if (st === "closed" || st === "merged") statuses.add("closed");
    else statuses.add("open");
  }
  return [...statuses];
}

function sortProjectedCls(
  cls: ProjectedMega2CL[],
  sort: Filter["sort"],
): ProjectedMega2CL[] {
  const byField =
    (field: "updatedAt" | "createdAt", direction: 1 | -1) =>
    (left: ProjectedMega2CL, right: ProjectedMega2CL) =>
      direction * left[field].localeCompare(right[field]) ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.number - left.number;
  if (sort === "updated-asc") return cls.sort(byField("updatedAt", 1));
  if (sort === "created-desc") return cls.sort(byField("createdAt", -1));
  if (sort === "created-asc") return cls.sort(byField("createdAt", 1));
  return cls.sort(byField("updatedAt", -1));
}

async function fetchAllItemsForStatus(
  status: string,
  author: string | undefined,
  headers: HeadersInit | undefined,
  env: NodeJS.ProcessEnv,
): Promise<Mega2ClItemRes[]> {
  const collected: Mega2ClItemRes[] = [];
  let expectedTotal = 0;
  for (let pageNum = 1; pageNum <= MAX_MEGA2_LIST_PAGES_PER_STATUS; pageNum += 1) {
    const page = await fetchMega2ClList(
      {
        status,
        author,
        page: pageNum,
        perPage: MAX_MEGA2_CL_PER_PAGE,
      },
      { headers },
      env,
    );
    expectedTotal = Math.max(expectedTotal, page.total);
    if (page.items.length === 0) {
      break;
    }
    collected.push(...page.items);
    if (collected.length >= expectedTotal) {
      return collected;
    }
  }
  if (collected.length < expectedTotal) {
    throw new MegaInternalError(
      `mega2 CL list pagination for status "${status}" returned incomplete results (${collected.length}/${expectedTotal})`,
    );
  }
  return collected;
}

async function fetchAllMega2ClFilesChanged(
  link: string,
  headers: HeadersInit | undefined,
  env: NodeJS.ProcessEnv,
): Promise<Mega2ClFilesChangedItem[]> {
  const collected: Mega2ClFilesChangedItem[] = [];
  // mega2's `/api/v1/cl/{link}/files-changed` reports `page.total` as the total
  // number of pages (`ceil(changed_files / per_page)`), not the item count.
  let expectedPages = 0;
  let pagesFetched = 0;
  for (let pageNum = 1; pageNum <= MAX_MEGA2_DIFF_PAGES; pageNum += 1) {
    const res = await fetchMega2ClFilesChanged(
      link,
      { page: pageNum, perPage: MAX_MEGA2_CL_PER_PAGE },
      { headers },
      env,
    );
    expectedPages = Math.max(expectedPages, res.page.total);
    if (expectedPages === 0) {
      return collected;
    }
    if (res.page.items.length === 0) {
      break;
    }
    collected.push(...res.page.items);
    pagesFetched = pageNum;
    if (pageNum >= expectedPages) {
      return collected;
    }
  }
  if (pagesFetched < expectedPages) {
    throw new MegaInternalError(
      `mega2 CL files-changed pagination for "${link}" returned incomplete pages (${pagesFetched}/${expectedPages})`,
    );
  }
  return collected;
}

function matchesActorFilter(
  candidate: User,
  filterValue: string,
  actorAliases: ReadonlySet<string>,
): boolean {
  if (filterValue === "@me") {
    if (actorAliases.size === 0) return false;
    return (
      actorAliases.has(candidate.id.toLowerCase()) ||
      actorAliases.has(candidate.username.toLowerCase())
    );
  }
  const normalized = (
    filterValue.startsWith("@") ? filterValue.slice(1) : filterValue
  )
    .trim()
    .toLowerCase();
  if (!normalized) return true;
  return (
    candidate.id.toLowerCase() === normalized ||
    candidate.username.toLowerCase() === normalized
  );
}

async function mapSettledWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const idx = nextIndex;
        nextIndex += 1;
        if (idx >= items.length) return;
        try {
          const value = await worker(items[idx]!);
          results[idx] = { status: "fulfilled", value };
        } catch (reason) {
          results[idx] = { status: "rejected", reason };
        }
      }
    }),
  );

  return results;
}

export async function listLiveMega2Cls(
  db: Database,
  filter: Mega2ClListFilter,
  options: Mega2ProjectionOptions = {},
): Promise<ProjectedMega2CL[]> {
  if (filter.reviewer?.trim()) {
    throw new MegaBadRequestError(
      "Reviewer filter is not supported in live mega2 backend mode",
    );
  }
  const env = (options.env ?? process.env) as NodeJS.ProcessEnv;
  const statuses = mega2StatusesForFilter(filter);
  const rawAuthor = filter.author?.trim();

  const needsActorAliases = rawAuthor === "@me";
  const actorAliases = needsActorAliases
    ? await resolveActorIdentityAliases(db, options.actorUserId)
    : new Set<string>();

  if (needsActorAliases && actorAliases.size === 0) {
    return [];
  }

  // Do not pass `author` to mega2's case-sensitive equality filter; apply our
  // case-insensitive author/package/text pre-filters below before merge-box fanout.
  const pagesByStatus = await Promise.all(
    statuses.map((status) =>
      fetchAllItemsForStatus(status, undefined, options.headers, env),
    ),
  );

  const uniqueItems = new Map<string, Mega2ClItemRes>();
  for (const list of pagesByStatus) {
    for (const item of list) {
      if (!uniqueItems.has(item.link)) {
        uniqueItems.set(item.link, item);
      }
    }
  }

  const search = filter.text?.trim();
  const searchLower = search?.toLowerCase();
  const publicId = search?.replace(/^!/, "");
  let matchingLink: string | undefined;
  if (isBlockId(publicId)) {
    const [mapping] = await db
      .select({ liveLink: megaClLinks.link, legacyLink: megaCls.link })
      .from(megaClPublicIds)
      .leftJoin(megaClLinks, eq(megaClPublicIds.number, megaClLinks.number))
      .leftJoin(megaCls, eq(megaClPublicIds.number, megaCls.number))
      .where(matchesCLPublicId(publicId))
      .limit(1);
    matchingLink = mapping?.liveLink ?? mapping?.legacyLink ?? undefined;
  }
  const stateSet =
    filter.states && filter.states.length > 0 ? new Set(filter.states) : undefined;
  const packageIdSet =
    filter.packageIds && filter.packageIds !== "all"
      ? new Set(filter.packageIds)
      : undefined;

  const candidateItems = [...uniqueItems.values()]
    .filter((item) => {
      if (stateSet) {
        if (item.status === "Merged" && !stateSet.has("merged")) return false;
        if (item.status === "Closed" && !stateSet.has("closed")) return false;
        if (item.status === "Draft" && !stateSet.has("wip")) return false;
        if (
          item.status === "Open" &&
          !stateSet.has("ready") &&
          !stateSet.has("conflicts")
        ) {
          return false;
        }
      }
      if (packageIdSet && !packageIdSet.has(packageIdFromRepoPath(item.path))) {
        return false;
      }
      if (
        rawAuthor &&
        !matchesActorFilter(syntheticUser(item.author), rawAuthor, actorAliases)
      ) {
        return false;
      }
      if (
        searchLower &&
        item.link !== matchingLink &&
        !item.title.toLowerCase().includes(searchLower) &&
        !item.link.toLowerCase().includes(searchLower) &&
        !item.path.toLowerCase().includes(searchLower)
      ) {
        return false;
      }
      return true;
    })
    .sort((a, b) => b.updated_at - a.updated_at || b.id - a.id);

  const mergeBoxResults = await mapSettledWithConcurrency(
    candidateItems,
    MERGE_BOX_CONCURRENCY,
    (item) => fetchMega2ClMergeBox(item.link, { headers: options.headers }, env),
  );

  const projected: ProjectedMega2CL[] = [];
  for (let i = 0; i < candidateItems.length; i += 1) {
    const item = candidateItems[i]!;
    const settled = mergeBoxResults[i]!;
    if (settled.status === "rejected") {
      const reason = settled.reason;
      // Exclude CLs the caller lacks ViewRepo access to (or that vanished concurrently)
      // without exposing their metadata or failing the whole list.
      if (
        reason instanceof MegaForbiddenError ||
        reason instanceof MegaNotFoundError
      ) {
        continue;
      }
      throw reason;
    }
    const clState = mapMega2StatusToCLState(item.status, settled.value);
    if (stateSet && !stateSet.has(clState)) {
      continue;
    }
    const identity = await ensureMegaClIdentity(db, item.link);
    projected.push(projectMega2ClListItem(item, identity, settled.value));
  }

  return sortProjectedCls(projected, filter.sort);
}

export async function getLiveMega2ClDetail(
  db: Database,
  number: number,
  options: Mega2ProjectionOptions & { view?: "overview" | "full" } = {},
): Promise<ProjectedMega2CL> {
  const env = (options.env ?? process.env) as NodeJS.ProcessEnv;
  const link = await resolveMegaClLinkByNumber(db, number);
  const reqOpts = { headers: options.headers };

  const [detail, mergeBox, filesList, diffItems, commits] = await Promise.all([
    fetchMega2ClDetail(link, reqOpts, env),
    fetchMega2ClMergeBox(link, reqOpts, env),
    fetchMega2ClFilesList(link, reqOpts, env),
    options.view === "overview" ? null : fetchAllMega2ClFilesChanged(link, options.headers, env),
    fetchClCommits(link, reqOpts, env),
  ]);

  return projectMega2ClDetailDto({
    ...await ensureMegaClIdentity(db, link),
    detail,
    mergeBox,
    filesList,
    diffItems,
    commits,
  });
}

function projectCommentsFromDetail(
  number: number,
  detail: Mega2ClDetailRes,
): Array<CLComment & { readonly numericId: number }> {
  return detail.conversations
    .filter((c) => c.conv_type === "Comment" && c.comment !== null)
    .sort((a, b) => a.id - b.id)
    .map((c) => ({
      numericId: c.id,
      id: `m2_conv_${c.id}`,
      clNumber: number,
      author: syntheticUser(c.username),
      body: c.comment ?? "",
      createdAt: isoFromUnixSeconds(c.created_at),
      reactions: [],
    }));
}

export async function listLiveMega2ClComments(
  db: Database,
  number: number,
  options: Mega2ProjectionOptions = {},
): Promise<CLComment[]> {
  const env = (options.env ?? process.env) as NodeJS.ProcessEnv;
  const link = await resolveMegaClLinkByNumber(db, number);
  const detail = await fetchMega2ClDetail(
    link,
    { headers: options.headers },
    env,
  );
  return projectCommentsFromDetail(number, detail).map(
    ({ numericId: _numericId, ...comment }) => comment,
  );
}

export async function transitionLiveMega2Cl(
  db: Database,
  number: number,
  targetState: CLState,
  options: Mega2ProjectionOptions = {},
): Promise<ProjectedMega2CL> {
  const env = (options.env ?? process.env) as NodeJS.ProcessEnv;
  const link = await resolveMegaClLinkByNumber(db, number);
  const reqOpts = { headers: options.headers };

  if (targetState === "merged") {
    await mergeMega2Cl(link, reqOpts, env);
  } else if (targetState === "closed") {
    await closeMega2Cl(link, reqOpts, env);
  } else if (targetState === "ready") {
    const current = await fetchMega2ClDetail(link, reqOpts, env);
    if (current.status === "Closed") {
      await reopenMega2Cl(link, reqOpts, env);
    } else if (current.status !== "Open") {
      throw new MegaBadRequestError(
        `Cannot transition mega2 CL from "${current.status}" to "ready"`,
      );
    }
  } else {
    throw new MegaBadRequestError(
      `Unsupported mega2 CL transition target: ${targetState}`,
    );
  }

  return getLiveMega2ClDetail(db, number, options);
}

export async function addLiveMega2ClComment(
  db: Database,
  number: number,
  content: string,
  options: Mega2ProjectionOptions = {},
): Promise<CLComment> {
  const env = (options.env ?? process.env) as NodeJS.ProcessEnv;
  const link = await resolveMegaClLinkByNumber(db, number);
  const reqOpts = { headers: options.headers };

  const [beforeDetail, actorAliases] = await Promise.all([
    fetchMega2ClDetail(link, reqOpts, env),
    resolveActorIdentityAliases(db, options.actorUserId),
  ]);
  const beforeIds = new Set(
    projectCommentsFromDetail(number, beforeDetail).map((c) => c.id),
  );

  await addMega2ClComment(link, content, reqOpts, env);

  const afterDetail = await fetchMega2ClDetail(link, reqOpts, env);
  const newMatching = projectCommentsFromDetail(number, afterDetail).filter(
    (c) => !beforeIds.has(c.id) && c.body === content,
  );

  let chosen: (CLComment & { readonly numericId: number }) | undefined;
  if (actorAliases.size > 0) {
    const actorMatched = newMatching.filter((c) =>
      actorAliases.has(c.author.username.toLowerCase()),
    );
    if (actorMatched.length === 1) {
      chosen = actorMatched[0];
    } else if (actorMatched.length === 0 && newMatching.length === 1) {
      // POST /comment succeeded synchronously in mega2 and produced exactly one
      // new comment matching the submitted content (handles differing mega2 vs local username).
      chosen = newMatching[0];
    }
  } else if (newMatching.length === 1) {
    chosen = newMatching[0];
  }

  if (!chosen) {
    throw new MegaInternalError(
      "Posted comment could not be reliably attributed in live mega2 CL conversations",
    );
  }
  const { numericId: _numericId, ...comment } = chosen;
  return comment;
}
