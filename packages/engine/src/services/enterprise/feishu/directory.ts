// megaui-only (FS-04): the Contact directory snapshot reader has no upstream counterpart.
/**
 * FS-04：授权通讯录读取与完整快照。
 *
 * The reader walks the departments of the configured scope only, page by
 * page, through the fixed-origin transport of FS-03. A snapshot is complete
 * only when every page of every authorized department was read; an
 * interrupted read produces an incomplete snapshot, and an incomplete
 * snapshot may never produce a member-missing verdict.
 */
import { createHash } from "node:crypto";

import { FeishuTransport } from "./http";
import type { FeishuTenantCredentials } from "./types";

/** The authorized scope of a directory read. */
export interface DirectoryScope {
  tenantKey: string;
  appId: string;
  /** The departments the administrator authorized. */
  departmentIds: readonly string[];
}

/** The status of a directory member. */
export interface DirectoryMemberStatus {
  isActivated: boolean;
  isFrozen: boolean;
  isResigned: boolean;
  isExited: boolean;
}

/** One member of the directory. */
export interface DirectoryMember {
  openId: string;
  unionId?: string;
  name: string;
  /** The notification address; null when the provider has none or it is unusable. */
  notificationEmail: string | null;
  status: DirectoryMemberStatus;
  departmentIds: readonly string[];
}

/** The four provider states required by a single-member admission read. */
export interface AuthoritativeDirectoryMemberStatus {
  isActivated: boolean;
  isFrozen: boolean;
  isResigned: boolean;
  isExited: boolean;
}

/** The minimal authoritative member fact used by directory admission. */
export interface AuthoritativeDirectoryMember {
  openId: string;
  departmentIds: readonly string[];
  status: AuthoritativeDirectoryMemberStatus;
}

export interface DirectorySnapshot {
  scopeHash: string;
  /** The monotonic generation of the snapshot. */
  generation: number;
  /** True only when every page of every authorized department was read. */
  complete: boolean;
  members: readonly DirectoryMember[];
  /** The page the read stopped at, when the snapshot is incomplete. */
  interruptedAt?: { departmentId: string; pageToken?: string; reason: string };
}

/** The frozen shape of a directory user of the provider. */
interface ProviderUser {
  open_id?: string;
  union_id?: string;
  name?: string;
  email?: string;
  enterprise_email?: string;
  status?: {
    is_activated?: boolean;
    is_frozen?: boolean;
    is_resigned?: boolean;
    is_exited?: boolean;
  };
  department_ids?: string[];
}

type ProviderPage =
  | { members: DirectoryMember[]; hasMore: false; pageToken?: string }
  | { members: DirectoryMember[]; hasMore: true; pageToken: string };

/** The frozen path of the department user listing. */
export const FEISHU_DIRECTORY_USERS_PATH = "/open-apis/contact/v3/users/find_by_department";
/** The frozen prefix of the exact single-member Contact endpoint. */
export const FEISHU_DIRECTORY_USER_PATH = "/open-apis/contact/v3/users";
const PAGE_SIZE = 100;

/** The scope hash: the tenant, the app and the sorted authorized departments. */
export function scopeHashOf(scope: DirectoryScope): string {
  const departments = [...scope.departmentIds].sort();
  return createHash("sha256")
    .update(`${scope.tenantKey}\u0000${scope.appId}\u0000${departments.join("\u0000")}`)
    .digest("hex");
}

/** The directory status must be one of the boundary states. */
function readStatus(status: ProviderUser["status"]): DirectoryMemberStatus {
  if (
    !status ||
    typeof status.is_activated !== "boolean" ||
    typeof status.is_frozen !== "boolean" ||
    typeof status.is_resigned !== "boolean" ||
    typeof status.is_exited !== "boolean"
  ) {
    throw new Error("[@megaui/engine] the directory status is missing its boundary fields");
  }
  return {
    isActivated: status.is_activated,
    isFrozen: status.is_frozen,
    isResigned: status.is_resigned,
    isExited: status.is_exited,
  };
}

/** True only for the exact four-state member admitted to the current watermark. */
export function isDirectoryMemberActive(member: DirectoryMember): boolean {
  return (
    member.status.isActivated === true &&
    member.status.isFrozen === false &&
    member.status.isResigned === false &&
    member.status.isExited === false
  );
}

/**
 * The notification address of a member.
 *
 * The provider email is validated against the notification profile contract:
 * an address that cannot be used for notification is stored as null, never
 * as a malformed value.
 */
export function validateNotificationEmail(email: string | undefined): string | null {
  if (email === undefined || email.trim() === "") return null;
  const value = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  return value;
}

function readMember(user: ProviderUser): DirectoryMember {
  if (
    typeof user.open_id !== "string" ||
    user.open_id.trim() === "" ||
    typeof user.name !== "string" ||
    user.name.trim() === "" ||
    (user.union_id !== undefined && typeof user.union_id !== "string") ||
    (user.email !== undefined && typeof user.email !== "string") ||
    (user.enterprise_email !== undefined && typeof user.enterprise_email !== "string") ||
    (user.department_ids !== undefined &&
      (!Array.isArray(user.department_ids) ||
        !user.department_ids.every(
          (departmentId) =>
            typeof departmentId === "string" && departmentId.trim() !== "",
        )))
  ) {
    throw new Error("[@megaui/engine] the directory user boundary fields are malformed");
  }
  return {
    openId: user.open_id,
    unionId: user.union_id,
    name: user.name,
    notificationEmail: validateNotificationEmail(user.enterprise_email ?? user.email),
    status: readStatus(user.status),
    departmentIds: user.department_ids ?? [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformedPageResponse(): Error {
  return new Error("[@megaui/engine] the directory page response is malformed");
}

/** Parses a successful page only when the complete provider envelope is present. */
function readProviderPage(envelope: unknown): ProviderPage {
  if (
    !isRecord(envelope) ||
    envelope.code !== 0 ||
    typeof envelope.msg !== "string" ||
    !isRecord(envelope.data)
  ) {
    throw malformedPageResponse();
  }
  const data = envelope.data;
  if (!Array.isArray(data.items) || typeof data.has_more !== "boolean") {
    throw malformedPageResponse();
  }
  if (
    data.page_token !== undefined &&
    (typeof data.page_token !== "string" ||
      (data.has_more && data.page_token.trim() === ""))
  ) {
    throw malformedPageResponse();
  }
  if (data.has_more && typeof data.page_token !== "string") {
    throw malformedPageResponse();
  }

  const members = data.items.map((user) => {
    if (!isRecord(user)) throw malformedPageResponse();
    return readMember(user as ProviderUser);
  });
  if (data.has_more) {
    return { members, hasMore: true, pageToken: data.page_token as string };
  }
  return { members, hasMore: false, pageToken: data.page_token };
}

function malformedSingleMemberResponse(): Error {
  return new Error("[@megaui/engine] the single-member directory response is malformed");
}

/** Parses only the authority fields of a successful single-member envelope. */
function readAuthoritativeMember(envelope: unknown): AuthoritativeDirectoryMember {
  if (!isRecord(envelope) || envelope.code !== 0 || !isRecord(envelope.data)) {
    throw malformedSingleMemberResponse();
  }
  const user = envelope.data.user;
  if (!isRecord(user) || typeof user.open_id !== "string" || user.open_id.trim() === "") {
    throw malformedSingleMemberResponse();
  }
  if (
    !Array.isArray(user.department_ids) ||
    !user.department_ids.every(
      (departmentId) => typeof departmentId === "string" && departmentId.trim() !== "",
    )
  ) {
    throw malformedSingleMemberResponse();
  }
  if (!isRecord(user.status)) throw malformedSingleMemberResponse();
  const status = user.status;
  if (
    typeof status.is_activated !== "boolean" ||
    typeof status.is_frozen !== "boolean" ||
    typeof status.is_resigned !== "boolean" ||
    typeof status.is_exited !== "boolean"
  ) {
    throw malformedSingleMemberResponse();
  }
  return {
    openId: user.open_id,
    departmentIds: [...user.department_ids],
    status: {
      isActivated: status.is_activated,
      isFrozen: status.is_frozen,
      isResigned: status.is_resigned,
      isExited: status.is_exited,
    },
  };
}

export interface SingleMemberDirectoryReaderOptions {
  transport: FeishuTransport;
  credentials: FeishuTenantCredentials;
  /** The token manager function; credentials and secret stay factory-bound. */
  getToken: (credentials: FeishuTenantCredentials) => Promise<string>;
}

/** Reads one member through the exact FSM-18 endpoint without caching the result. */
export class SingleMemberDirectoryReader {
  readonly tenantKey: string;
  readonly appId: string;

  private readonly transport: FeishuTransport;
  private readonly credentials: FeishuTenantCredentials;
  private readonly getToken: (credentials: FeishuTenantCredentials) => Promise<string>;

  constructor(options: SingleMemberDirectoryReaderOptions) {
    this.transport = options.transport;
    this.credentials = { ...options.credentials };
    this.tenantKey = this.credentials.tenantKey;
    this.appId = this.credentials.appId;
    this.getToken = options.getToken;
  }

  async read(openId: string): Promise<AuthoritativeDirectoryMember> {
    if (openId.trim() === "") throw malformedSingleMemberResponse();
    const authorization = `Bearer ${await this.getToken(this.credentials)}`;
    const path =
      `${FEISHU_DIRECTORY_USER_PATH}/${encodeURIComponent(openId)}` +
      "?user_id_type=open_id&department_id_type=open_department_id";
    const envelope = await this.transport.request<unknown>(path, {
      method: "GET",
      headers: { authorization },
    });
    return readAuthoritativeMember(envelope);
  }
}

export interface DirectoryReaderOptions {
  transport: FeishuTransport;
  /** The token of the tenant application; the reader never builds one itself. */
  getToken: (credentials: FeishuTenantCredentials) => Promise<string>;
  /** The generation of the produced snapshot; it only grows. */
  generation: number;
}

export class DirectoryReader {
  private readonly transport: FeishuTransport;
  private readonly getToken: (credentials: FeishuTenantCredentials) => Promise<string>;
  private generation: number;

  constructor(options: DirectoryReaderOptions) {
    this.transport = options.transport;
    this.getToken = options.getToken;
    this.generation = options.generation;
  }

  /** Reads the whole authorized scope and returns its snapshot. */
  async read(scope: DirectoryScope, credentials: FeishuTenantCredentials): Promise<DirectorySnapshot> {
    const scopeHash = scopeHashOf(scope);
    const members: DirectoryMember[] = [];
    const seen = new Set<string>();
    const authorization = `Bearer ${await this.getToken(credentials)}`;

    for (const departmentId of scope.departmentIds) {
      let pageToken: string | undefined;
      const seenPageTokens = new Set<string>();
      for (;;) {
        const path =
          `${FEISHU_DIRECTORY_USERS_PATH}?department_id=${encodeURIComponent(departmentId)}` +
          `&page_size=${PAGE_SIZE}` +
          (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "");
        let page: ProviderPage;
        try {
          const envelope = await this.transport.request<unknown>(path, {
            method: "GET",
            headers: { authorization },
          });
          page = readProviderPage(envelope);
        } catch (error) {
          // A failed or malformed page is never complete and never claims a
          // member disappeared. The provider body is not copied into evidence.
          return {
            scopeHash,
            generation: this.generation,
            complete: false,
            members,
            interruptedAt: {
              departmentId,
              pageToken,
              reason: error instanceof Error ? error.message : String(error),
            },
          };
        }
        if (page.hasMore && seenPageTokens.has(page.pageToken)) {
          return {
            scopeHash,
            generation: this.generation,
            complete: false,
            members,
            interruptedAt: {
              departmentId,
              pageToken,
              reason: "the provider repeated a directory page token",
            },
          };
        }
        for (const member of page.members) {
          if (seen.has(member.openId)) continue;
          seen.add(member.openId);
          members.push(member);
        }
        if (!page.hasMore) break;
        seenPageTokens.add(page.pageToken);
        pageToken = page.pageToken;
      }
    }

    return { scopeHash, generation: this.generation, complete: true, members };
  }

  /** Advances the generation; every new snapshot is a new generation. */
  nextGeneration(): number {
    this.generation += 1;
    return this.generation;
  }
}

/**
 * Compares two snapshots.
 *
 * An incomplete snapshot may not produce a member-missing verdict: it is
 * refused instead of being read as "the member disappeared".
 */
export function diffSnapshots(
  previous: DirectorySnapshot,
  next: DirectorySnapshot,
): { added: DirectoryMember[]; removed: DirectoryMember[]; scopeChanged: boolean } {
  if (!previous.complete || !next.complete) {
    throw new Error(
      "[@megaui/engine] an incomplete directory snapshot must not produce a member-missing verdict",
    );
  }
  if (previous.scopeHash !== next.scopeHash) {
    throw new Error(
      "[@megaui/engine] the snapshots cover different directory scopes",
    );
  }
  const previousIds = new Set(previous.members.map((member) => member.openId));
  const nextIds = new Set(next.members.map((member) => member.openId));
  return {
    added: next.members.filter((member) => !previousIds.has(member.openId)),
    removed: previous.members.filter((member) => !nextIds.has(member.openId)),
    scopeChanged: false,
  };
}
