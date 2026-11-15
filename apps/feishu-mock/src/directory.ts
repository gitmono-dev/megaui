/**
 * FSM-09：Contact 目录读取与游标。
 *
 * 本片交付按部门分页读取目录成员，以及与完整查询绑定的游标：游标绑定部门、两种
 * ID 类型和 page_size，篡改、跨查询或过期都不获准；游标上限 128 个、TTL 300 秒，
 * 到期回收，满额时拒绝新建且不淘汰有效记录。
 */
import { randomBytes } from "node:crypto";

import { mockError, type MockHttpError } from "./http";
import type { MockState, MockUser } from "./state";

/** How long a cursor stays valid, in seconds. */
export const MOCK_CURSOR_TTL_SECONDS = 300;

/** How many cursors may exist at the same time. */
export const MOCK_MAX_CURSORS = 128;

/** The page size the directory uses when the caller does not ask for one. */
export const MOCK_DEFAULT_PAGE_SIZE = 2;

/** The largest page the directory serves. */
export const MOCK_MAX_PAGE_SIZE = 100;

/** The only accepted department id type. */
export const MOCK_DEPARTMENT_ID_TYPE = "open_department_id";

/** The only accepted user id type. */
export const MOCK_USER_ID_TYPE = "open_id";

/** The complete query a cursor is bound to. */
export interface MockDirectoryBinding {
  departmentId: string;
  departmentIdType: string;
  userIdType: string;
  pageSize: number;
}

export interface MockCursor {
  token: string;
  binding: MockDirectoryBinding;
  /** How many members of the department the cursor already served. */
  offset: number;
  expiresAt: number;
}

export type MockCursorResult =
  | { ok: true; cursor: MockCursor }
  | { ok: false; error: MockHttpError };

/**
 * The cursors of one run.
 *
 * A cursor is an opaque random token; the store keeps the query it belongs to,
 * so a token that was tampered with, that belongs to another query or that
 * expired is refused.
 */
export class MockCursorStore {
  #cursors: MockCursor[] = [];
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** The number of cursors that are still valid. */
  get activeCount(): number {
    this.#reclaim();
    return this.#cursors.length;
  }

  /** Registers a cursor for the next page of the given query. */
  create(binding: MockDirectoryBinding, offset: number): MockCursorResult {
    this.#reclaim();
    if (this.#cursors.length >= MOCK_MAX_CURSORS) {
      return { ok: false, error: mockError(6, "mock_cursor_capacity_exceeded") };
    }
    const cursor: MockCursor = {
      token: randomBytes(32).toString("base64url"),
      binding: { ...binding },
      offset,
      expiresAt: this.#now() + MOCK_CURSOR_TTL_SECONDS * 1000,
    };
    this.#cursors.push(cursor);
    return { ok: true, cursor };
  }

  /**
   * Resolves a cursor for the given query.
   *
   * Only a cursor of this store that has not expired and that was issued for
   * the very same query is accepted.
   */
  resolve(token: string | undefined, binding: MockDirectoryBinding): MockCursor | undefined {
    if (token === undefined || token === "") return undefined;
    const cursor = this.#cursors.find((candidate) => candidate.token === token);
    if (cursor === undefined) return undefined;
    if (cursor.expiresAt <= this.#now()) return undefined;
    if (!sameBinding(cursor.binding, binding)) return undefined;
    return cursor;
  }

  /** Forgets every cursor; the store is registered for reset. */
  reset(): void {
    this.#cursors = [];
  }

  #reclaim(): void {
    const now = this.#now();
    this.#cursors = this.#cursors.filter((cursor) => cursor.expiresAt > now);
  }
}

function sameBinding(left: MockDirectoryBinding, right: MockDirectoryBinding): boolean {
  return (
    left.departmentId === right.departmentId &&
    left.departmentIdType === right.departmentIdType &&
    left.userIdType === right.userIdType &&
    left.pageSize === right.pageSize
  );
}

/**
 * Reads a single member of the current synthetic directory.
 *
 * The mock only knows open ids, so the path value is read as one; a member
 * that is unknown or was deleted is not in the directory anymore.
 */
export function findDirectoryUser(state: MockState, openId: string): MockUser | undefined {
  return state.users.find((user) => user.open_id === openId);
}

export interface MockDirectoryQuery {
  departmentId: string;
  departmentIdType: string;
  userIdType: string;
  pageSize: number;
  pageToken: string | undefined;
}

export type MockDirectoryResult =
  | { ok: true; items: MockUser[]; hasMore: boolean; pageToken: string | undefined }
  | { ok: false; error: MockHttpError };

/**
 * Reads one page of a department.
 *
 * The members of a department are the synthetic directory entries that belong
 * to it, in the order of the fixture, so the pages are stable.
 */
export function queryDepartment(
  state: MockState,
  query: MockDirectoryQuery,
  cursors: MockCursorStore,
): MockDirectoryResult {
  const department = state.departments.find(
    (candidate) => candidate.open_department_id === query.departmentId,
  );
  if (department === undefined) {
    return { ok: false, error: mockError(4, "mock_department_not_found") };
  }
  const members = state.users.filter((user) => user.department_ids.includes(query.departmentId));
  const binding: MockDirectoryBinding = {
    departmentId: query.departmentId,
    departmentIdType: query.departmentIdType,
    userIdType: query.userIdType,
    pageSize: query.pageSize,
  };
  let offset = 0;
  if (query.pageToken !== undefined) {
    const cursor = cursors.resolve(query.pageToken, binding);
    if (cursor === undefined) {
      return { ok: false, error: mockError(1, "mock_cursor_invalid") };
    }
    offset = cursor.offset;
  }
  const items = members.slice(offset, offset + query.pageSize);
  const hasMore = offset + items.length < members.length;
  if (!hasMore) {
    return { ok: true, items, hasMore: false, pageToken: undefined };
  }
  const created = cursors.create(binding, offset + items.length);
  if (!created.ok) {
    return { ok: false, error: created.error };
  }
  return { ok: true, items, hasMore: true, pageToken: created.cursor.token };
}
