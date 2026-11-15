// megaui:libs/mega/services/releases.ts@0ff3a9d
// megaui:libs/mega/services/repos/releases-repo.ts@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the EG-08 task card):
// - No `MEGA_RELEASES_DATA_BACKEND` mock/database switch or `store.ts`
//   fixture backend (DEBT-04) — this is the only (drizzle PG)
//   implementation, same as the other EG-04/EG-05 services.
// - Every mutation takes an explicit `actorUserId: string | null | undefined`
//   and gates through `assertWorkspaceMember` (GC-07 fail-closed default —
//   upstream has no `CURRENT_USER`-free path and no permission check at all).
// - `publishRelease` is megaui-only: upstream's tags page only ever creates
//   drafts (`createDraftRelease`) and never publishes one — there is no
//   draft→publish mutation upstream. This card's AC requires the state
//   machine (`draft --publish--> published`, duplicate publish rejected
//   with `MegaConflictError`), so this module adds it as the only legal
//   transition on top of upstream's `megaReleaseStatuses`.
// - `addReleaseAsset` is megaui-only: upstream never persists asset rows
//   ("Assets are not persisted in v1" — `releases-repo.ts` `loadRelease`
//   always returns `assets: []`). This card's AC requires asset *key
//   metadata* only (binary upload is WA-19, out of scope) — see
//   `./asset-key.ts` for the GC-07 key-ownership guard. Metadata is stored
//   as `mega_content` rows the same way release notes are, under a
//   service-local container type (`release_asset`) that is not yet part of
//   `@megaui/database`'s `megaContentContainerTypes` vocabulary — that
//   package is outside this card's write set (`mega_content.container_type`
//   has no DB-level enum/check constraint, so this is safe; a future card
//   that touches `packages/database/src/schema/mega/constants.ts` should
//   promote this into the shared vocabulary instead of leaving it here).
// - Release note bodies reuse `../cls/comment-body.ts`'s
//   `normalizeCommentBodyJson`/`plainTextFromCommentBody` (GC-02 single
//   source of truth for the plain-text↔Lexical conversion this card also
//   needs) instead of porting a second copy of upstream's
//   `import/plain-text.ts`. `promotePlainRefsInEditorState` (re-scanning an
//   already-Lexical payload for bare `#N`/`!N`/`@user` tokens) is not
//   ported — same registered omission as EG-05's comment-body module.
//   `linkedCLs` on created notes stays `[]`, matching upstream's own
//   `createDraftRelease` (which never populates it either).
// - `listReleases` adds pagination (`ListReleasesInput.pagination` via the
//   shared `parsePagination` parser) — upstream's `listReleases()` returned
//   every row. It also adds a stable tie-break (`id` ascending) after the
//   draft-first/publishedAt-desc primary sort: `mega_releases` has no
//   `createdAt` column, so multiple drafts (all sorting via the same
//   `'9999'` sentinel) would otherwise come back in whatever order
//   Postgres feels like — undefined order breaks the pagination-boundary
//   AC. Out-of-range offsets and empty result sets both return
//   `{ items: [], total, offset, limit }`, never an error (issues.ts parity).
// - Release number allocation does not apply here (releases are keyed by
//   `tag`, not a serial number) — the `mega_releases_tag_uidx` unique index
//   plus an app-level pre-check under `assertWorkspaceMember` guards
//   duplicate tags; a concurrent race that still hits the unique index maps
//   the raw Postgres violation to `MegaConflictError` (docs.ts
//   `isPgUniqueViolation` convention) instead of leaking a raw driver error.
import { randomUUID } from "node:crypto";
import type { ReleaseNote, ReleaseNoteKind } from "@megaui/core";
import {
  megaContent,
  megaContentContainerTypes,
  megaReleases,
  megaReleaseStatuses,
  user,
  type Database,
} from "@megaui/database";
import { desc, eq } from "drizzle-orm";
import {
  MegaBadRequestError,
  MegaConflictError,
  MegaForbiddenError,
  MegaNotFoundError,
  MegaUnauthorizedError,
} from "../../errors";
import { parsePagination } from "../../context";
import { isEmptyCommentBody, normalizeCommentBodyJson, plainTextFromCommentBody } from "../cls/comment-body";
import { BODY_FORMAT_VERSION_BLOCK_TREE } from "../docs/body-format";
import { assertReleaseAssetKeyOwnership } from "./asset-key";
import { fallbackPublicProfile, resolvePublicProfiles } from "../enterprise/public-profile";
import type {
  AddReleaseAssetInput,
  CreateDraftReleaseInput,
  EngineRelease,
  EngineReleaseAsset,
  ListReleasesInput,
  ListReleasesResult,
} from "./types";

/**
 * Service-local container type for release asset key metadata (see module
 * diff header) — not yet part of `@megaui/database`'s
 * `megaContentContainerTypes` vocabulary.
 */
const RELEASE_ASSET_CONTAINER_TYPE = "release_asset";

function newReleaseId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function isPgUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      (current as { code: unknown }).code === "23505"
    ) {
      return true;
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause: unknown }).cause
        : undefined;
  }
  return false;
}

function toIso(value: Date | null | undefined): string | undefined {
  return value ? value.toISOString() : undefined;
}

function parseReleaseNoteKind(value: unknown): ReleaseNoteKind {
  return value === "feature" || value === "performance" || value === "fix" || value === "breaking" ? value : "feature";
}

interface ReleaseNoteEnvelope {
  releaseId: string;
  kind: ReleaseNoteKind;
  linkedCLs: readonly number[];
  text: string;
  ordinal: number;
  root: unknown;
}

function parseReleaseNoteEnvelope(raw: unknown): ReleaseNoteEnvelope | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.releaseId !== "string") return null;
  const linkedCLs = Array.isArray(body.linkedCLs)
    ? body.linkedCLs.filter((value): value is number => typeof value === "number")
    : [];
  const ordinal = typeof body.ordinal === "number" && Number.isFinite(body.ordinal) ? body.ordinal : 0;
  return {
    releaseId: body.releaseId,
    kind: parseReleaseNoteKind(body.kind),
    linkedCLs,
    text: typeof body.text === "string" ? body.text : "",
    ordinal,
    root: body.root,
  };
}

function packReleaseNoteBody(
  lexicalJson: string,
  meta: { releaseId: string; kind: ReleaseNoteKind; linkedCLs: readonly number[]; text: string; ordinal: number },
): Record<string, unknown> {
  const lexical = JSON.parse(lexicalJson) as { root: unknown };
  return {
    root: lexical.root,
    releaseId: meta.releaseId,
    kind: meta.kind,
    linkedCLs: [...meta.linkedCLs],
    text: meta.text,
    ordinal: meta.ordinal,
  };
}

interface ReleaseAssetEnvelope {
  releaseId: string;
  name: string;
  key: string;
  sizeBytes: number;
  contentType: string;
  ordinal: number;
}

function parseReleaseAssetEnvelope(raw: unknown): ReleaseAssetEnvelope | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.releaseId !== "string" || typeof body.key !== "string" || typeof body.name !== "string") {
    return null;
  }
  const ordinal = typeof body.ordinal === "number" && Number.isFinite(body.ordinal) ? body.ordinal : 0;
  return {
    releaseId: body.releaseId,
    name: body.name,
    key: body.key,
    sizeBytes: typeof body.sizeBytes === "number" ? body.sizeBytes : 0,
    contentType: typeof body.contentType === "string" ? body.contentType : "application/octet-stream",
    ordinal,
  };
}

/** Sorts drafts to the top, then published releases newest-first (upstream parity, plus a stable tie-break — see module diff header). */
function sortReleases(releases: readonly EngineRelease[]): EngineRelease[] {
  return [...releases].sort((left, right) => {
    const byPublishedAt = (right.publishedAt ?? "9999").localeCompare(left.publishedAt ?? "9999");
    if (byPublishedAt !== 0) return byPublishedAt;
    return left.id.localeCompare(right.id);
  });
}

export function createReleasesService(database: Database) {
  /**
   * Fail-closed workspace-membership gate (GC-07) shared by every release
   * mutation — same baseline as EG-04 issues / EG-05 CLs (no dedicated
   * releases ACL yet).
   */
  async function assertWorkspaceMember(actorUserId: string | null | undefined): Promise<string> {
    const id = actorUserId?.trim();
    if (!id) throw new MegaUnauthorizedError("A signed-in session is required");
    const [row] = await database.select({ id: user.id }).from(user).where(eq(user.id, id)).limit(1);
    if (!row) throw new MegaForbiddenError("Only workspace members can perform this action");
    return id;
  }

  // GC-10 note: upstream's RELEASE_NOTE domain has no dedicated relational
  // table (unlike issue/CL comments, which key off a real `issueNumber`/
  // `clNumber` column) — `releaseId` only exists inside the JSON body, so
  // this scans all rows of the container type and filters in JS, same as
  // upstream `releases-repo.ts` `loadReleaseNotes`. A proper indexed column
  // would live in `packages/database` (outside this card's write set); the
  // scan is bounded by total release-note/asset volume, not by workspace
  // size at large. Same tradeoff applies to `loadReleaseAssets` below
  // (megaui-only, no upstream precedent at all).
  async function loadReleaseNotes(releaseId: string): Promise<ReleaseNote[]> {
    const rows = await database
      .select()
      .from(megaContent)
      .where(eq(megaContent.containerType, megaContentContainerTypes.RELEASE_NOTE));

    const notes = rows.flatMap((row) => {
      const envelope = parseReleaseNoteEnvelope(row.bodyJson);
      if (!envelope || envelope.releaseId !== releaseId) return [];
      return [{ containerId: row.containerId, envelope }];
    });
    notes.sort((left, right) => left.envelope.ordinal - right.envelope.ordinal || left.containerId.localeCompare(right.containerId));

    return notes.map(({ containerId, envelope }) => ({
      id: containerId,
      kind: envelope.kind,
      text: envelope.text,
      body: JSON.stringify({ root: envelope.root }),
      linkedCLs: envelope.linkedCLs,
    }));
  }

  async function loadReleaseAssets(releaseId: string): Promise<EngineReleaseAsset[]> {
    const rows = await database
      .select()
      .from(megaContent)
      .where(eq(megaContent.containerType, RELEASE_ASSET_CONTAINER_TYPE));

    const assets = rows.flatMap((row) => {
      const envelope = parseReleaseAssetEnvelope(row.bodyJson);
      if (!envelope || envelope.releaseId !== releaseId) return [];
      return [{ containerId: row.containerId, envelope }];
    });
    assets.sort((left, right) => left.envelope.ordinal - right.envelope.ordinal || left.containerId.localeCompare(right.containerId));

    return assets.map(({ containerId, envelope }) => ({
      id: containerId,
      name: envelope.name,
      key: envelope.key,
      // No signed-URL resolution in this card (WA-19) — mirrors the raw key
      // until upload/signing is wired (see module diff header).
      downloadUrl: envelope.key,
      sizeBytes: envelope.sizeBytes,
      contentType: envelope.contentType,
    }));
  }

  async function loadReleaseRow(releaseId: string): Promise<typeof megaReleases.$inferSelect> {
    const [row] = await database.select().from(megaReleases).where(eq(megaReleases.id, releaseId)).limit(1);
    if (!row) throw new MegaNotFoundError("Release", releaseId);
    return row;
  }

  async function loadRelease(releaseId: string): Promise<EngineRelease> {
    const row = await loadReleaseRow(releaseId);
    const author = (await resolvePublicProfiles(database, [row.authorId])).get(row.authorId)
      ?? fallbackPublicProfile(row.authorId);
    const [notes, assets] = await Promise.all([loadReleaseNotes(row.id), loadReleaseAssets(row.id)]);

    return {
      id: row.id,
      tag: row.tag,
      title: row.title,
      state: row.status === megaReleaseStatuses.PUBLISHED ? "published" : "draft",
      publishedAt: toIso(row.publishedAt),
      targetSha: row.sha,
      author,
      commitsSince: row.commitsSince,
      sinceTag: row.sinceTag ?? undefined,
      prerelease: row.prerelease || undefined,
      major: row.major || undefined,
      notes,
      assets,
    };
  }

  /** AC: list sort/pagination boundaries — drafts-first, stable order, out-of-range pages return empty (never an error). */
  async function listReleases(input: ListReleasesInput = {}): Promise<ListReleasesResult> {
    const { offset, limit } = parsePagination(input.pagination);
    const rows = await database.select({ id: megaReleases.id }).from(megaReleases);
    const releases = await Promise.all(rows.map((row) => loadRelease(row.id)));
    const sorted = sortReleases(releases);
    const items = sorted.slice(offset, offset + limit);
    return { items, total: sorted.length, offset, limit };
  }

  async function getRelease(releaseId: string): Promise<EngineRelease> {
    return loadRelease(releaseId);
  }

  async function latestPublishedTagOnTx(tx: Database): Promise<string | undefined> {
    const [row] = await tx
      .select({ tag: megaReleases.tag })
      .from(megaReleases)
      .where(eq(megaReleases.status, megaReleaseStatuses.PUBLISHED))
      .orderBy(desc(megaReleases.publishedAt))
      .limit(1);
    return row?.tag;
  }

  async function createDraftRelease(
    input: CreateDraftReleaseInput,
    actorUserId: string | null | undefined,
  ): Promise<EngineRelease> {
    const authorId = await assertWorkspaceMember(actorUserId);
    const tag = input.tag.trim();
    const title = input.title.trim();
    const targetSha = input.targetSha.trim();
    if (!tag) throw new MegaBadRequestError("Release tag is required");
    if (!title) throw new MegaBadRequestError("Release title is required");
    if (!targetSha) throw new MegaBadRequestError("Release targetSha is required");

    const id = newReleaseId("release");
    const now = new Date();
    const notes = (input.notes ?? [])
      .map((raw) => raw.trim())
      .filter(Boolean)
      .map((raw, index) => {
        const lexical = normalizeCommentBodyJson(raw);
        if (isEmptyCommentBody(lexical)) throw new MegaBadRequestError("Release note text is required");
        return {
          id: newReleaseId("note"),
          kind: "feature" as const,
          lexical,
          text: plainTextFromCommentBody(lexical),
          ordinal: index,
        };
      });

    try {
      await database.transaction(async (tx) => {
        const existing = await tx.select({ id: megaReleases.id }).from(megaReleases).where(eq(megaReleases.tag, tag)).limit(1);
        if (existing.length > 0) {
          throw new MegaConflictError(`Release tag ${tag} already exists`);
        }
        const sinceTag = await latestPublishedTagOnTx(tx);
        await tx.insert(megaReleases).values({
          id,
          tag,
          title,
          sha: targetSha,
          publishedAt: null,
          prerelease: input.prerelease ?? false,
          major: input.major ?? false,
          authorId,
          commitsSince: 0,
          sinceTag: sinceTag ?? null,
          status: megaReleaseStatuses.DRAFT,
        });
        for (const note of notes) {
          await tx.insert(megaContent).values({
            containerType: megaContentContainerTypes.RELEASE_NOTE,
            containerId: note.id,
            bodyJson: packReleaseNoteBody(note.lexical, {
              releaseId: id,
              kind: note.kind,
              linkedCLs: [],
              text: note.text,
              ordinal: note.ordinal,
            }),
            bodyFormatVersion: BODY_FORMAT_VERSION_BLOCK_TREE,
            createdAt: now,
            updatedAt: now,
          });
        }
      });
    } catch (error) {
      if (error instanceof MegaConflictError) throw error;
      if (isPgUniqueViolation(error)) throw new MegaConflictError(`Release tag ${tag} already exists`);
      throw error;
    }

    return loadRelease(id);
  }

  /**
   * AC: draft→publish state machine. The only legal transition is
   * `draft --publish--> published`; publishing an already-published
   * release is illegal and rejected with `MegaConflictError` (duplicate
   * publish). Row-locked so two concurrent publish calls for the same
   * release cannot both succeed.
   */
  async function publishRelease(releaseId: string, actorUserId: string | null | undefined): Promise<EngineRelease> {
    await assertWorkspaceMember(actorUserId);

    await database.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: megaReleases.id, status: megaReleases.status, tag: megaReleases.tag })
        .from(megaReleases)
        .where(eq(megaReleases.id, releaseId))
        .for("update")
        .limit(1);
      if (!row) throw new MegaNotFoundError("Release", releaseId);
      if (row.status === megaReleaseStatuses.PUBLISHED) {
        throw new MegaConflictError(`Release ${row.tag} is already published`);
      }
      await tx
        .update(megaReleases)
        .set({ status: megaReleaseStatuses.PUBLISHED, publishedAt: new Date() })
        .where(eq(megaReleases.id, row.id));
    });

    return loadRelease(releaseId);
  }

  /**
   * AC: asset key ownership (GC-07). `assertReleaseAssetKeyOwnership`
   * fail-closes on malformed/out-of-scope keys before anything is
   * persisted; membership is asserted first so an unauthenticated/
   * non-member actor never learns whether the release exists.
   */
  async function addReleaseAsset(
    releaseId: string,
    input: AddReleaseAssetInput,
    actorUserId: string | null | undefined,
  ): Promise<EngineRelease> {
    await assertWorkspaceMember(actorUserId);
    const name = input.name.trim();
    if (!name) throw new MegaBadRequestError("Release asset name is required");
    const contentType = input.contentType.trim();
    if (!contentType) throw new MegaBadRequestError("Release asset contentType is required");
    if (!Number.isFinite(input.sizeBytes) || input.sizeBytes < 0) {
      throw new MegaBadRequestError("Release asset sizeBytes must be a non-negative number");
    }

    await loadReleaseRow(releaseId);
    assertReleaseAssetKeyOwnership({ key: input.key, releaseId });

    const now = new Date();
    const id = newReleaseId("asset");
    const existingAssets = await loadReleaseAssets(releaseId);

    await database.insert(megaContent).values({
      containerType: RELEASE_ASSET_CONTAINER_TYPE,
      containerId: id,
      bodyJson: {
        releaseId,
        name,
        key: input.key,
        sizeBytes: input.sizeBytes,
        contentType,
        ordinal: existingAssets.length,
      },
      bodyFormatVersion: 1,
      createdAt: now,
      updatedAt: now,
    });

    return loadRelease(releaseId);
  }

  return {
    listReleases,
    getRelease,
    createDraftRelease,
    publishRelease,
    addReleaseAsset,
  };
}

export type ReleasesService = ReturnType<typeof createReleasesService>;

// Keep re-exported so consumers importing constants from this module (a
// convention docs.ts/issues.ts also follow) get the drizzle vocabulary too.
export { megaReleaseStatuses };
