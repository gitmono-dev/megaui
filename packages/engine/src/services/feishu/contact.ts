// megaui-only (FSL-117): Directory v1 member lookup for the Feishu login path.
/**
 * FSL-117：Directory v1 成员查询客户端。
 *
 * `findByEmail` searches the directory for one email and matches the result
 * locally: the member's `enterprise_email` is compared when it is a non-empty
 * string, and only an empty `enterprise_email` falls back to `email`. Exactly
 * one match on a page without more results is a hit; anything else is "no
 * unique target". `readMember` reads one member by open_id and decides
 * whether the member is in office (`active_status == 2` and not resigned).
 *
 * Every response the transport lets through is validated field by field. A
 * missing or mistyped field fails closed with the stable key
 * `FEISHU_CONTACT_INVALID_RESPONSE`; the error carries no email, open_id,
 * token or response value. Transport errors (non-2xx, non-zero business
 * code, timeouts) are propagated unchanged.
 */
import type { FeishuTransport } from "../enterprise/feishu/http";
import type { FeishuTokenManager } from "../enterprise/feishu/token";
import type { FeishuTenantCredentials } from "../enterprise/feishu/types";

/** Directory v1 search, with open_id as the employee id type. */
export const FEISHU_DIRECTORY_SEARCH_PATH =
  "/open-apis/directory/v1/employees/search?employee_id_type=open_id";
/** Directory v1 batch read, with open_id as the employee id type. */
export const FEISHU_DIRECTORY_MGET_PATH =
  "/open-apis/directory/v1/employees/mget?employee_id_type=open_id";
/** The field set both requests ask for (measured by FSL-115 and FSL-164). */
export const FEISHU_DIRECTORY_REQUIRED_FIELDS = Object.freeze([
  "base_info.employee_id",
  "base_info.email",
  "base_info.enterprise_email",
  "base_info.name",
  "base_info.active_status",
  "base_info.is_resigned",
  "work_info.staff_status",
] as const);
/** The search reads only the first page of this size. */
export const FEISHU_DIRECTORY_SEARCH_PAGE_SIZE = 10;
/** The stable key of every response this client cannot accept. */
export const FEISHU_CONTACT_INVALID_RESPONSE = "FEISHU_CONTACT_INVALID_RESPONSE";

/** `active_status` value of an activated member (official Directory v1 enum). */
const ACTIVE_STATUS_ACTIVATED = 2;
const ACTIVE_STATUS_MIN = 1;
const ACTIVE_STATUS_MAX = 5;

/** A response the client cannot accept. The message is exactly the stable key. */
export class FeishuContactError extends Error {
  readonly code = FEISHU_CONTACT_INVALID_RESPONSE;

  constructor() {
    super(FEISHU_CONTACT_INVALID_RESPONSE);
    this.name = "FeishuContactError";
  }
}

export type FeishuFindByEmailResult =
  | { readonly kind: "unique"; readonly openId: string }
  | { readonly kind: "no_unique_target" };

export type FeishuReadMemberResult =
  | { readonly kind: "active"; readonly name: string }
  | { readonly kind: "inactive" };

export interface FeishuContactClientOptions {
  /** The fixed-origin transport. */
  readonly transport: FeishuTransport;
  /** Server-held app credentials; never derived from request input. */
  readonly credentials: FeishuTenantCredentials;
  /** Reuses the process token cache and single-flight refresh layer. */
  readonly tokenManager?: FeishuTokenManager;
  /** Test/assembly seam; production uses tokenManager. */
  readonly getToken?: (credentials: FeishuTenantCredentials) => Promise<string>;
}

export class FeishuContactClient {
  private readonly transport: FeishuTransport;
  private readonly credentials: FeishuTenantCredentials;
  private readonly getToken: (credentials: FeishuTenantCredentials) => Promise<string>;

  constructor(options: FeishuContactClientOptions) {
    if (
      !options ||
      !options.transport ||
      typeof options.transport.request !== "function" ||
      !options.credentials ||
      !isNonBlankText(options.credentials.tenantKey) ||
      !isNonBlankText(options.credentials.appId) ||
      !isNonBlankText(options.credentials.appSecret) ||
      (!options.tokenManager && typeof options.getToken !== "function") ||
      (options.tokenManager && options.getToken)
    ) {
      throw new Error("INVALID_FEISHU_CONTACT_CLIENT_CONFIG");
    }
    this.transport = options.transport;
    this.credentials = Object.freeze({ ...options.credentials });
    this.getToken = options.tokenManager
      ? (credentials) => options.tokenManager!.getToken(credentials)
      : options.getToken!;
  }

  /** Finds the single member whose comparison email equals `email`. */
  async findByEmail(email: string): Promise<FeishuFindByEmailResult> {
    if (!isNonBlankText(email)) {
      throw new Error("INVALID_FEISHU_CONTACT_INPUT");
    }
    const body = await this.post(FEISHU_DIRECTORY_SEARCH_PATH, {
      query: email,
      required_fields: [...FEISHU_DIRECTORY_REQUIRED_FIELDS],
      page_request: { page_size: FEISHU_DIRECTORY_SEARCH_PAGE_SIZE },
    });
    const data = readEnvelope(body);
    const employees = readArray(data, "employees");
    const wanted = email.toLowerCase();
    const matches: string[] = [];
    for (const employee of employees) {
      const base = readObject(employee, "base_info");
      const openId = readEmployeeId(base);
      const enterpriseEmail = readString(base, "enterprise_email");
      const personalEmail = readString(base, "email");
      const compared = enterpriseEmail !== "" ? enterpriseEmail : personalEmail;
      if (compared !== "" && compared.toLowerCase() === wanted) {
        matches.push(openId);
      }
    }
    const page = readObject(data, "page_response");
    const hasMore = page.has_more;
    if (typeof hasMore !== "boolean") throw new FeishuContactError();
    if (hasMore || matches.length !== 1) return { kind: "no_unique_target" };
    return { kind: "unique", openId: matches[0]! };
  }

  /** Reads one member by open_id and decides whether the member is in office. */
  async readMember(openId: string): Promise<FeishuReadMemberResult> {
    if (!isNonBlankText(openId)) {
      throw new Error("INVALID_FEISHU_CONTACT_INPUT");
    }
    const body = await this.post(FEISHU_DIRECTORY_MGET_PATH, {
      employee_ids: [openId],
      required_fields: [...FEISHU_DIRECTORY_REQUIRED_FIELDS],
    });
    const data = readEnvelope(body);
    const employees = readArray(data, "employees");
    if (employees.length !== 1) throw new FeishuContactError();
    const base = readObject(employees[0], "base_info");
    if (readEmployeeId(base) !== openId) throw new FeishuContactError();
    const name = readString(readObject(readObject(base, "name"), "name"), "default_value");
    const activeStatus = base.active_status;
    if (
      typeof activeStatus !== "number" ||
      !Number.isInteger(activeStatus) ||
      activeStatus < ACTIVE_STATUS_MIN ||
      activeStatus > ACTIVE_STATUS_MAX
    ) {
      throw new FeishuContactError();
    }
    const resigned = base.is_resigned;
    if (typeof resigned !== "boolean") throw new FeishuContactError();
    if (activeStatus === ACTIVE_STATUS_ACTIVATED && !resigned) {
      return { kind: "active", name };
    }
    return { kind: "inactive" };
  }

  private async post(path: string, json: Record<string, unknown>): Promise<unknown> {
    const token = await this.getToken(this.credentials);
    if (!isNonBlankText(token)) throw new FeishuContactError();
    // Transport errors (non-2xx, non-zero numeric business code, timeouts)
    // propagate unchanged; only bodies the transport lets through are read.
    return this.transport.request<unknown>(path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      json,
    });
  }
}

/** Factory form for service assembly code. */
export function createFeishuContactClient(
  options: FeishuContactClientOptions,
): FeishuContactClient {
  return new FeishuContactClient(options);
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** `code` must be exactly the number 0; the transport already threw on other numbers. */
function readEnvelope(body: unknown): JsonObject {
  if (!isObject(body) || body.code !== 0) throw new FeishuContactError();
  return readObject(body, "data");
}

function readObject(parent: unknown, key: string): JsonObject {
  if (!isObject(parent)) throw new FeishuContactError();
  const value = parent[key];
  if (!isObject(value)) throw new FeishuContactError();
  return value;
}

function readArray(parent: JsonObject, key: string): unknown[] {
  const value = parent[key];
  if (!Array.isArray(value)) throw new FeishuContactError();
  return value;
}

/** A present string; an absent field is never read as an empty string. */
function readString(parent: JsonObject, key: string): string {
  const value = parent[key];
  if (typeof value !== "string") throw new FeishuContactError();
  return value;
}

function readEmployeeId(base: JsonObject): string {
  const value = base.employee_id;
  if (!isNonBlankText(value)) throw new FeishuContactError();
  return value;
}
