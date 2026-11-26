import http from "node:http";
import type { AddressInfo } from "node:net";
import { isCLPublicId } from "@megaui/core";
import { megaClLinks, megaClPublicIds, megaCls, user, type Database } from "@megaui/database";
import { MegaBadRequestError, MegaInternalError } from "@megaui/engine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CSRF_ORIGIN_REJECTED_CODE } from "../csrf";
import { assertMegaFailureEnvelope } from "../envelope";
import {
  addLiveMega2ClComment,
  ensureMegaClIdentity,
  getLiveMega2ClDetail,
  isMega2ClBackendEnabled,
  listLiveMega2Cls,
  resolveMegaClLinkByNumber,
  transitionLiveMega2Cl,
} from "./cl-projection";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_C = "cccccccccccccccccccccccccccccccccccccccc";

interface FakeMappingStore {
  byLink: Map<string, number>;
  byNumber: Map<number, string>;
  legacyLinks: Map<number, string>;
  publicIds: Map<number, string>;
  legacyPublicIds: Map<number, string>;
  underscorePublicIds: Map<number, string>;
  localMegaClsMaxNumber: number;
  advisoryLocks: number;
  updateCalls: number;
  megaClsWriteCalls: number;
  megaClLinksInsertCalls: number;
  db: Database;
}

function extractBoundValue(expr: unknown): unknown {
  if (!expr || typeof expr !== "object") return undefined;
  const chunks = (expr as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return undefined;
  for (const chunk of chunks) {
    if (
      chunk &&
      typeof chunk === "object" &&
      "value" in chunk &&
      !Array.isArray((chunk as { value: unknown }).value)
    ) {
      return (chunk as { value: unknown }).value;
    }
  }
  return undefined;
}

/**
 * Models the two immutable identity tables, and detects any writes to mutable CL data.
 */
function createFakeMappingDb(
  localMegaClsMaxNumber = 0,
  users: ReadonlyMap<string, { name: string; email: string }> = new Map(),
): FakeMappingStore {
  const store: FakeMappingStore = {
    byLink: new Map(),
    byNumber: new Map(),
    legacyLinks: new Map(),
    publicIds: new Map(),
    legacyPublicIds: new Map(),
    underscorePublicIds: new Map(),
    localMegaClsMaxNumber,
    advisoryLocks: 0,
    updateCalls: 0,
    megaClsWriteCalls: 0,
    megaClLinksInsertCalls: 0,
    db: null as unknown as Database,
  };

  function makeExecutor() {
    return {
      select(fields: Record<string, unknown>) {
        return {
          from(table: unknown) {
            const isMaxQuery = "maxNumber" in fields;
            if (isMaxQuery) {
              const numbers = table === megaClPublicIds ? store.publicIds : store.byNumber;
              const maxNumber = table === megaCls
                ? store.localMegaClsMaxNumber
                : Math.max(0, ...numbers.keys());
              return Promise.resolve([{ maxNumber }]);
            }
            return {
              innerJoin() {
                return this;
              },
              leftJoin() {
                return this;
              },
              where(expr: unknown) {
                const resolveRows = () => {
                  const bound = extractBoundValue(expr);
                  if (table === user && typeof bound === "string") {
                    const row = users.get(bound);
                    return Promise.resolve(row ? [row] : []);
                  }
                  if (table === megaCls) {
                    if (typeof bound === "number") {
                      const link = store.legacyLinks.get(bound);
                      return Promise.resolve(link === undefined ? [] : [{ link }]);
                    }
                    return Promise.resolve([...store.legacyLinks]
                      .filter(([, link]) => link === bound)
                      .sort(([a], [b]) => a - b)
                      .slice(0, 1)
                      .map(([number]) => ({ number })));
                  }
                  if (table === megaClPublicIds && typeof bound === "number") {
                    const publicId = store.publicIds.get(bound);
                    return Promise.resolve(publicId ? [{ publicId }] : []);
                  }
                  if (table === megaClPublicIds && "liveLink" in fields) {
                    const chunks = (expr as { queryChunks: unknown[] }).queryChunks;
                    let codes = store.publicIds;
                    if (chunks.includes(megaClPublicIds.legacyPublicId)) codes = store.legacyPublicIds;
                    if (chunks.includes(megaClPublicIds.underscorePublicId)) codes = store.underscorePublicIds;
                    const entry = [...codes].find(([, publicId]) => publicId === bound);
                    return Promise.resolve(entry ? [{
                      liveLink: store.byNumber.get(entry[0]),
                      legacyLink: store.legacyLinks.get(entry[0]),
                    }] : []);
                  }
                  if ("number" in fields && typeof bound === "string") {
                    const num = store.byLink.get(bound);
                    if ("publicId" in fields) {
                      const publicId = num === undefined ? undefined : store.publicIds.get(num);
                      return Promise.resolve(publicId ? [{ number: num, publicId }] : []);
                    }
                    return Promise.resolve(num !== undefined ? [{ number: num }] : []);
                  }
                  if ("link" in fields && typeof bound === "number") {
                    const link = store.byNumber.get(bound);
                    return Promise.resolve(link !== undefined ? [{ link }] : []);
                  }
                  return Promise.resolve([]);
                };
                return {
                  orderBy() {
                    return {
                      limit: resolveRows,
                    };
                  },
                  limit: resolveRows,
                };
              },
            };
          },
        };
      },
      insert(table: unknown) {
        if (table === megaCls) {
          store.megaClsWriteCalls += 1;
          throw new Error("cl-projection must NEVER insert placeholder rows into mega_cls");
        }
        return {
          values(row: { link: string; number: number; publicId: string }) {
            return {
              onConflictDoNothing() {
                if (table === megaClPublicIds) {
                  return {
                    returning() {
                      if (store.publicIds.has(row.number) || [...store.publicIds.values()].includes(row.publicId)) {
                        return Promise.resolve([]);
                      }
                      store.publicIds.set(row.number, row.publicId);
                      return Promise.resolve([{ publicId: row.publicId }]);
                    },
                  };
                }
                if (table === megaClLinks) {
                  store.megaClLinksInsertCalls += 1;
                  if (!store.byLink.has(row.link)) {
                    store.byLink.set(row.link, row.number);
                    store.byNumber.set(row.number, row.link);
                  }
                }
                return Promise.resolve();
              },
            };
          },
        };
      },
      update() {
        store.updateCalls += 1;
        throw new Error("cl-projection must NEVER update DB rows");
      },
      execute() {
        store.advisoryLocks += 1;
        return Promise.resolve();
      },
      async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        return fn(makeExecutor());
      },
    };
  }

  store.db = makeExecutor() as unknown as Database;
  return store;
}

describe("mega2 live non-mutating CL projection (CLB-22)", () => {
  let server: http.Server;
  let baseUrl: string;
  let routeHandler:
    | ((
        method: string,
        url: string,
        body: string,
        res: http.ServerResponse,
      ) => void)
    | undefined;

  function env(): Record<string, string | undefined> {
    return {
      MEGA_CODE_DATA_BACKEND: "mega2",
      MEGA2_PUBLIC_BASE_URL: baseUrl,
    };
  }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (routeHandler) {
          routeHandler(req.method ?? "GET", req.url ?? "/", body, res);
          return;
        }
        res.statusCode = 404;
        res.end("not found");
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  function sendCommon(res: http.ServerResponse, data: unknown) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ req_result: true, data, err_message: "" }));
  }

  it("checks MEGA_CODE_DATA_BACKEND === 'mega2' strictly", () => {
    expect(isMega2ClBackendEnabled({})).toBe(false);
    expect(isMega2ClBackendEnabled({ MEGA_CODE_DATA_BACKEND: "local" })).toBe(false);
    expect(isMega2ClBackendEnabled({ MEGA_CODE_DATA_BACKEND: "mega2" })).toBe(true);
  });

  it("reserves stable block-style public IDs and never reuses a deleted CL's number", async () => {
    const store = createFakeMappingDb(10);
    store.publicIds.set(12, "oldClCode901");
    const first = await ensureMegaClIdentity(store.db, "cl-alpha");
    const repeated = await ensureMegaClIdentity(store.db, "cl-alpha");
    const second = await ensureMegaClIdentity(store.db, "cl-beta");

    expect(first.number).toBe(13);
    expect(repeated).toEqual(first);
    expect(second.number).toBe(14);
    expect(isCLPublicId(first.publicId)).toBe(true);
    expect(isCLPublicId(second.publicId)).toBe(true);
    expect(second.publicId).not.toBe(first.publicId);
    expect(store.advisoryLocks).toBe(2);
    expect(store.megaClLinksInsertCalls).toBe(2);
    expect(store.megaClsWriteCalls).toBe(0);
    expect(store.updateCalls).toBe(0);
    expect(await resolveMegaClLinkByNumber(store.db, first.number)).toBe("cl-alpha");
    expect(await resolveMegaClLinkByNumber(store.db, second.number)).toBe("cl-beta");
  });

  it("keeps a pre-existing live link and its legacy number when assigning a public ID", async () => {
    const store = createFakeMappingDb();
    store.byLink.set("legacy-link", 4);
    store.byNumber.set(4, "legacy-link");

    const identity = await ensureMegaClIdentity(store.db, "legacy-link");
    expect(identity.number).toBe(4);
    expect(isCLPublicId(identity.publicId)).toBe(true);
    expect(await ensureMegaClIdentity(store.db, "legacy-link")).toEqual(identity);
    expect(store.megaClLinksInsertCalls).toBe(0);
  });

  it("never overwrites newer headRevision/state when overlapping concurrent refreshes resolve out of order", async () => {
    const store = createFakeMappingDb();
    await ensureMegaClIdentity(store.db, "cl-race");

    let detailCallCount = 0;
    let releaseSlowOlderRequest!: () => void;
    const slowOlderGate = new Promise<void>((resolve) => {
      releaseSlowOlderRequest = resolve;
    });

    routeHandler = (method, url, _body, res) => {
      if (method === "GET" && url === "/api/v1/cl/cl-race/detail") {
        detailCallCount += 1;
        const call = detailCallCount;
        if (call === 1) {
          void slowOlderGate.then(() => {
            sendCommon(res, {
              id: 1,
              link: "cl-race",
              title: "Stale v1 title",
              status: "Open",
              open_timestamp: 1_700_000_000,
              merge_timestamp: null,
              conversations: [],
              path: "/project/app",
              from_hash: SHA_A,
              to_hash: SHA_B,
              head_revision: 1,
              base_branch: "main",
              author: "alice",
            });
          });
          return;
        }
        sendCommon(res, {
          id: 1,
          link: "cl-race",
          title: "Fresh v2 merged title",
          status: "Merged",
          open_timestamp: 1_700_000_000,
          merge_timestamp: 1_700_000_200,
          conversations: [],
          path: "/project/app",
          from_hash: SHA_A,
          to_hash: SHA_C,
          head_revision: 2,
          base_branch: "main",
          author: "alice",
        });
        return;
      }
      if (url === "/api/v1/cl/cl-race/merge-box") {
        sendCommon(res, {
          merge_requirements: {
            state: "MERGEABLE",
            conditions: [
              {
                type: "CiStatus",
                display_name: "CI Build",
                description: "Buck2",
                message: "Passed",
                result: "PASSED",
                commit_id: SHA_C,
                head_revision: 2,
                raw_status: "PASSED",
              },
            ],
          },
        });
        return;
      }
      if (url === "/api/v1/cl/cl-race/files-list") {
        sendCommon(res, [{ path: "src/lib.rs", sha: SHA_C, action: "modified" }]);
        return;
      }
      if (url === "/api/v1/cl/cl-race/files-changed") {
        sendCommon(res, {
          page: {
            total: 1,
            items: [{ path: "src/lib.rs", data: "@@ -1 +1 @@\n-a\n+b" }],
          },
        });
        return;
      }
      if (url === "/api/v1/cl/cl-race/commits") {
        sendCommon(res, [
          {
            sha: SHA_C,
            message: "feat: v2",
            author_name: "alice",
            author_email: "alice@example.com",
          },
        ]);
        return;
      }
      res.statusCode = 404;
      res.end("unexpected");
    };

    const olderPromise = getLiveMega2ClDetail(store.db, 1, { env: env() });
    const newerResult = await getLiveMega2ClDetail(store.db, 1, { env: env() });
    expect(newerResult.headRevision).toBe(2);
    expect(newerResult.state).toBe("merged");
    expect(newerResult.title).toBe("Fresh v2 merged title");

    releaseSlowOlderRequest();
    const olderResult = await olderPromise;
    expect(olderResult.headRevision).toBe(1);

    const afterRace = await getLiveMega2ClDetail(store.db, 1, { env: env() });
    expect(afterRace.headRevision).toBe(2);
    expect(afterRace.state).toBe("merged");
    expect(afterRace.headCommit).toBe(SHA_C);
    expect(afterRace.ci).toBe("passing");
    expect(afterRace.merge).toBe("merged");
    expect(store.updateCalls).toBe(0);
    expect(store.megaClsWriteCalls).toBe(0);
  });

  it("projects multi-status list with mergeBox, author filter, transitions, and comments", async () => {
    const store = createFakeMappingDb();
    store.legacyLinks.set(7, "cl-live");
    store.legacyLinks.set(4, "cl-live");
    store.publicIds.set(4, "ClPublic0001");
    store.underscorePublicIds.set(4, "ClPublic_001");
    store.legacyPublicIds.set(4, "ClPublic-001");
    store.publicIds.set(7, "ClPublic0002");
    let currentStatus: "Open" | "Closed" | "Merged" = "Open";
    const comments: Array<{
      id: number;
      username: string;
      conv_type: "Comment";
      comment: string;
      resolved: null;
      created_at: number;
      updated_at: number;
    }> = [];

    routeHandler = (method, url, body, res) => {
      if (method === "POST" && url === "/api/v1/cl/list") {
        const reqBody = JSON.parse(body) as {
          additional: { status: string; author: string | null };
        };
        // mega2 only accepts "open" (Open+Draft) and "closed" (Closed+Merged)
        expect(["open", "closed"]).toContain(reqBody.additional.status);
        const items = [];
        const liveGroup = currentStatus === "Open" ? "open" : "closed";
        if (reqBody.additional.status === liveGroup) {
          items.push({
            id: 5,
            link: "cl-live",
            title: "Live CL",
            status: currentStatus,
            author: "bob",
            open_timestamp: 1_700_000_000,
            closed_at: null,
            merge_timestamp: null,
            updated_at: 1_700_000_200,
            comment_num: comments.length,
            path: "/project/demo",
            from_hash: SHA_A,
            to_hash: SHA_B,
            head_revision: 3,
            base_branch: "main",
          });
        }
        if (reqBody.additional.status === "closed") {
          items.push({
            id: 6,
            link: "cl-done",
            title: "Merged CL",
            status: "Merged",
            author: "carol",
            open_timestamp: 1_700_000_000,
            closed_at: null,
            merge_timestamp: 1_700_000_150,
            updated_at: 1_700_000_150,
            comment_num: 0,
            path: "/project/demo",
            from_hash: SHA_A,
            to_hash: SHA_C,
            head_revision: 2,
            base_branch: "main",
          });
        }
        sendCommon(res, { total: items.length, items });
        return;
      }
      if (method === "POST" && url === "/api/v1/cl/cl-live/close") {
        currentStatus = "Closed";
        sendCommon(res, "closed");
        return;
      }
      if (method === "POST" && url === "/api/v1/cl/cl-live/reopen") {
        currentStatus = "Open";
        sendCommon(res, "reopened");
        return;
      }
      if (method === "POST" && url === "/api/v1/cl/cl-live/merge") {
        currentStatus = "Merged";
        sendCommon(res, "merged");
        return;
      }
      if (method === "POST" && url === "/api/v1/cl/cl-live/comment") {
        const parsed = JSON.parse(body) as { content: string };
        comments.push({
          id: comments.length + 1,
          username: "bob",
          conv_type: "Comment",
          comment: parsed.content,
          resolved: null,
          created_at: 1_700_000_300,
          updated_at: 1_700_000_300,
        });
        sendCommon(res, null);
        return;
      }
      if (method === "GET" && url === "/api/v1/cl/cl-live/detail") {
        sendCommon(res, {
          id: 5,
          link: "cl-live",
          title: "Live CL",
          status: currentStatus,
          open_timestamp: 1_700_000_000,
          merge_timestamp: currentStatus === "Merged" ? 1_700_000_400 : null,
          conversations: comments,
          path: "/project/demo",
          from_hash: SHA_A,
          to_hash: SHA_B,
          head_revision: 3,
          base_branch: "main",
          author: "bob",
        });
        return;
      }
      if (url.endsWith("/merge-box")) {
        sendCommon(res, {
          merge_requirements: {
            state: "UNMERGEABLE",
            conditions: [
              {
                type: "CiStatus",
                display_name: "CI Build",
                description: "Buck2",
                message: "Running",
                result: "PENDING",
                raw_status: "RUNNING",
              },
            ],
          },
        });
        return;
      }
      if (url.endsWith("/files-list")) {
        sendCommon(res, []);
        return;
      }
      if (url.endsWith("/files-changed")) {
        sendCommon(res, { page: { total: 0, items: [] } });
        return;
      }
      if (url.endsWith("/commits")) {
        sendCommon(res, []);
        return;
      }
      res.statusCode = 404;
      res.end("unexpected");
    };

    // Unfiltered list returns BOTH open and merged CLs with live mergeBox attached
    const legacyDetail = await getLiveMega2ClDetail(store.db, 7, { env: env() });
    expect(legacyDetail).toMatchObject({ number: 4, publicId: "ClPublic0001" });
    const allList = await listLiveMega2Cls(store.db, {}, { env: env() });
    expect(allList).toHaveLength(2);
    expect(allList[0]?.link).toBe("cl-live");
    expect(allList[0]?.publicId).toBe(legacyDetail.publicId);
    expect(allList[0]?.mergeBox?.merge_requirements?.state).toBe("UNMERGEABLE");
    expect(allList[0]?.ci).toBe("running");
    expect(allList[1]?.link).toBe("cl-done");
    expect(allList[1]?.state).toBe("merged");

    for (const query of ["ClPublic0001", "!ClPublic0001", "ClPublic_001", "!ClPublic_001", "ClPublic-001", "!ClPublic-001"]) {
      const result = await listLiveMega2Cls(store.db, { text: query }, { env: env() });
      expect(result.map(({ link, publicId }) => ({ link, publicId }))).toEqual([
        { link: "cl-live", publicId: "ClPublic0001" },
      ]);
    }
    expect(await listLiveMega2Cls(store.db, { text: "!clpublic_001" }, { env: env() })).toEqual([]);

    // Multi-state + author filtering works accurately
    const onlyCarol = await listLiveMega2Cls(
      store.db,
      { states: ["closed", "merged"], author: "carol" },
      { env: env() },
    );
    expect(onlyCarol).toHaveLength(1);
    expect(onlyCarol[0]?.link).toBe("cl-done");

    const closed = await transitionLiveMega2Cl(store.db, 4, "closed", { env: env() });
    expect(closed.state).toBe("closed");
    expect(closed.publicId).toBe(allList[0]?.publicId);

    const reopened = await transitionLiveMega2Cl(store.db, 4, "ready", { env: env() });
    expect(reopened.state).toBe("ready");

    const comment = await addLiveMega2ClComment(store.db, 4, "Looks solid", {
      env: env(),
    });
    expect(comment.body).toBe("Looks solid");

    const merged = await transitionLiveMega2Cl(store.db, 4, "merged", { env: env() });
    expect(merged.state).toBe("merged");
    expect(store.updateCalls).toBe(0);
    expect(store.megaClsWriteCalls).toBe(0);
  });

  it("honors @me/packageIds/reviewer/sort filters, paginates >50 detail diffs, rejects wip transition, and isolates concurrent comments", async () => {
    const users = new Map([["user_bob", { name: "bob", email: "bob@example.com" }]]);
    const store = createFakeMappingDb(0, users);
    const requestedDiffPages: number[] = [];
    let nextCommentId = 1;
    const comments: Array<{
      id: number;
      username: string;
      conv_type: "Comment";
      comment: string;
      resolved: null;
      created_at: number;
      updated_at: number;
    }> = [];

    routeHandler = (method, url, body, res) => {
      if (method === "POST" && url === "/api/v1/cl/list") {
        const reqBody = JSON.parse(body) as { additional: { status: string } };
        if (reqBody.additional.status === "open") {
          sendCommon(res, {
            total: 2,
            items: [
              {
                id: 1,
                link: "cl-bob",
                title: "Bob CL",
                status: "Open",
                author: "bob",
                open_timestamp: 1_700_000_100,
                closed_at: null,
                merge_timestamp: null,
                updated_at: 1_700_000_200,
                comment_num: 0,
                path: "/pkg/alpha",
                from_hash: SHA_A,
                to_hash: SHA_B,
                head_revision: 1,
                base_branch: "main",
              },
              {
                id: 2,
                link: "cl-alice",
                title: "Alice CL",
                status: "Open",
                author: "alice",
                open_timestamp: 1_700_000_300,
                closed_at: null,
                merge_timestamp: null,
                updated_at: 1_700_000_400,
                comment_num: 0,
                path: "/pkg/beta",
                from_hash: SHA_A,
                to_hash: SHA_C,
                head_revision: 1,
                base_branch: "main",
              },
            ],
          });
          return;
        }
        sendCommon(res, { total: 0, items: [] });
        return;
      }
      if (url.endsWith("/merge-box")) {
        sendCommon(res, { merge_requirements: { state: "MERGEABLE", conditions: [] } });
        return;
      }
      if (method === "GET" && url === "/api/v1/cl/cl-bob/detail") {
        sendCommon(res, {
          id: 1,
          link: "cl-bob",
          title: "Bob CL",
          status: "Open",
          open_timestamp: 1_700_000_100,
          merge_timestamp: null,
          conversations: comments,
          path: "/pkg/alpha",
          from_hash: SHA_A,
          to_hash: SHA_B,
          head_revision: 1,
          base_branch: "main",
          author: "bob",
        });
        return;
      }
      if (method === "GET" && url === "/api/v1/cl/cl-bob/files-list") {
        const files = Array.from({ length: 52 }, (_, i) =>
          i === 1
            ? {
                path: `src/f${i}.ts`,
                old_path: `src/old_f${i}.ts`,
                sha: SHA_B,
                action: "renamed" as const,
              }
            : {
                path: `src/f${i}.ts`,
                sha: SHA_B,
                action: "modified" as const,
              },
        );
        sendCommon(res, files);
        return;
      }
      if (method === "POST" && url === "/api/v1/cl/cl-bob/files-changed") {
        const parsed = JSON.parse(body) as { pagination: { page: number; per_page: number } };
        requestedDiffPages.push(parsed.pagination.page);
        const start = (parsed.pagination.page - 1) * parsed.pagination.per_page;
        const end = Math.min(start + parsed.pagination.per_page, 52);
        const items = [];
        for (let i = start; i < end; i += 1) {
          // Include a file with `++` / `--` source lines inside a unified diff hunk
          const data =
            i === 0
              ? "--- a/src/f0.ts\n+++ b/src/f0.ts\n@@ -1,1 +1,1 @@\n---counter;\n+++counter;"
              : `@@ -0,0 +1,1 @@\n+line ${i}`;
          items.push({ path: `src/f${i}.ts`, data });
        }
        // mega2 reports `page.total` as total pages: ceil(52 / 50) = 2
        const totalPages = Math.ceil(52 / parsed.pagination.per_page);
        sendCommon(res, { page: { total: totalPages, items } });
        return;
      }
      if (method === "GET" && url === "/api/v1/cl/cl-bob/commits") {
        sendCommon(res, [{
          sha: SHA_B,
          message: "Update alpha",
          author_name: "bob",
          author_email: "bob@example.com",
        }]);
        return;
      }
      if (method === "POST" && url === "/api/v1/cl/cl-bob/comment") {
        const parsed = JSON.parse(body) as { content: string };
        comments.push({
          id: nextCommentId++,
          username: "bob",
          conv_type: "Comment",
          comment: parsed.content,
          resolved: null,
          created_at: 1_700_000_500,
          updated_at: 1_700_000_500,
        });
        // Simulate another user concurrently posting a newer comment right after bob's
        comments.push({
          id: nextCommentId++,
          username: "carol",
          conv_type: "Comment",
          comment: "unrelated concurrent comment",
          resolved: null,
          created_at: 1_700_000_501,
          updated_at: 1_700_000_501,
        });
        sendCommon(res, null);
        return;
      }
      res.statusCode = 404;
      res.end("unexpected");
    };

    // @me filter resolves actorUserId -> bob only
    const mine = await listLiveMega2Cls(
      store.db,
      { author: "@me" },
      { env: env(), actorUserId: "user_bob" },
    );
    expect(mine.map((c) => c.link)).toEqual(["cl-bob"]);

    // packageIds + sort filters
    const byPkg = await listLiveMega2Cls(
      store.db,
      { packageIds: ["pkg/beta"] },
      { env: env() },
    );
    expect(byPkg.map((c) => c.link)).toEqual(["cl-alice"]);

    const oldestFirst = await listLiveMega2Cls(
      store.db,
      { sort: "created-asc" },
      { env: env() },
    );
    expect(oldestFirst.map((c) => c.link)).toEqual(["cl-bob", "cl-alice"]);

    // reviewer filter fails closed rather than silently returning an empty list
    await expect(
      listLiveMega2Cls(store.db, { reviewer: "alice" }, { env: env() }),
    ).rejects.toBeInstanceOf(MegaBadRequestError);

    const { number: bobNumber } = await ensureMegaClIdentity(store.db, "cl-bob");
    const overview = await getLiveMega2ClDetail(store.db, bobNumber, { env: env(), view: "overview" });
    expect(requestedDiffPages).toEqual([]);
    expect(overview.files).toHaveLength(52);
    expect(overview.files[51]?.path).toBe("src/f51.ts");
    expect(overview).toMatchObject({
      baseBranch: "main",
      branch: "refs/cl/cl-bob",
      diffStatsAvailable: false,
      merge: "queue-ready",
      revisions: [{ filesChanged: 52, commitList: [{ sha: SHA_B, message: "Update alpha" }] }],
    });

    // Full detail paginates and counts `++`/`--` hunk lines accurately.
    const detail = await getLiveMega2ClDetail(store.db, bobNumber, { env: env() });
    expect(requestedDiffPages).toEqual([1, 2]);
    expect(detail.files).toHaveLength(52);
    expect(detail.additions).toBe(52);
    expect(detail.deletions).toBe(1);
    expect(detail.files[0]?.additions).toBe(1);
    expect(detail.files[0]?.deletions).toBe(1);
    expect(detail.files[1]?.mega2Action).toBe("renamed");
    expect(detail.files[1]?.oldPath).toBe("src/old_f1.ts");
    expect(detail.files[51]?.patch).toContain("+line 51");

    // wip transition is rejected fail-closed rather than calling reopen
    await expect(
      transitionLiveMega2Cl(store.db, bobNumber, "wip", { env: env() }),
    ).rejects.toBeInstanceOf(MegaBadRequestError);

    // Concurrent comment from carol does not hijack bob's returned comment
    const posted = await addLiveMega2ClComment(store.db, bobNumber, "Bob's review note", {
      env: env(),
      actorUserId: "user_bob",
    });
    expect(posted.body).toBe("Bob's review note");
    expect(posted.author.username).toBe("bob");

    // When multiple concurrent identical-text comments appear and none match local aliases, fail closed;
    // when a single new matching comment appears (even with differing mega2 username), return it cleanly.
    const prevHandler = routeHandler;
    routeHandler = (method, url, body, res) => {
      if (method === "POST" && url === "/api/v1/cl/cl-bob/comment") {
        const parsed = JSON.parse(body) as { content: string };
        if (parsed.content === "Ambiguous identical note") {
          comments.push(
            {
              id: nextCommentId++,
              username: "carol",
              conv_type: "Comment",
              comment: parsed.content,
              resolved: null,
              created_at: 1_700_000_510,
              updated_at: 1_700_000_510,
            },
            {
              id: nextCommentId++,
              username: "dave",
              conv_type: "Comment",
              comment: parsed.content,
              resolved: null,
              created_at: 1_700_000_511,
              updated_at: 1_700_000_511,
            },
          );
        } else if (parsed.content === "Duplicate self note") {
          comments.push(
            {
              id: nextCommentId++,
              username: "bob",
              conv_type: "Comment",
              comment: parsed.content,
              resolved: null,
              created_at: 1_700_000_510,
              updated_at: 1_700_000_510,
            },
            {
              id: nextCommentId++,
              username: "bob",
              conv_type: "Comment",
              comment: parsed.content,
              resolved: null,
              created_at: 1_700_000_511,
              updated_at: 1_700_000_511,
            },
          );
        } else {
          comments.push({
            id: nextCommentId++,
            username: "bob_mega2",
            conv_type: "Comment",
            comment: parsed.content,
            resolved: null,
            created_at: 1_700_000_512,
            updated_at: 1_700_000_512,
          });
        }
        sendCommon(res, null);
        return;
      }
      prevHandler?.(method, url, body, res);
    };
    await expect(
      addLiveMega2ClComment(store.db, bobNumber, "Ambiguous identical note", {
        env: env(),
        actorUserId: "user_bob",
      }),
    ).rejects.toBeInstanceOf(MegaInternalError);

    await expect(
      addLiveMega2ClComment(store.db, bobNumber, "Duplicate self note", {
        env: env(),
        actorUserId: "user_bob",
      }),
    ).rejects.toBeInstanceOf(MegaInternalError);

    const remappedUserComment = await addLiveMega2ClComment(
      store.db,
      bobNumber,
      "Note from different mega2 handle",
      { env: env(), actorUserId: "user_bob" },
    );
    expect(remappedUserComment.body).toBe("Note from different mega2 handle");
    expect(remappedUserComment.author.username).toBe("bob_mega2");

    // Decreasing reported total on a later empty page fails closed instead of silently truncating
    routeHandler = (method, url, body, res) => {
      if (method === "POST" && url === "/api/v1/cl/list") {
        const parsed = JSON.parse(body) as {
          pagination: { page: number };
          additional: { status: string };
        };
        if (parsed.additional.status === "open" && parsed.pagination.page === 1) {
          sendCommon(res, {
            total: 100,
            items: [
              {
                id: 1,
                link: "cl-bob",
                title: "Bob CL",
                status: "Open",
                author: "bob",
                open_timestamp: 1_700_000_100,
                closed_at: null,
                merge_timestamp: null,
                updated_at: 1_700_000_200,
                comment_num: 0,
                path: "/pkg/alpha",
                from_hash: SHA_A,
                to_hash: SHA_B,
                head_revision: 1,
                base_branch: "main",
              },
            ],
          });
          return;
        }
        sendCommon(res, { total: 0, items: [] });
        return;
      }
      prevHandler?.(method, url, body, res);
    };
    await expect(
      listLiveMega2Cls(store.db, { states: ["ready"] }, { env: env() }),
    ).rejects.toBeInstanceOf(MegaInternalError);

    // Inaccessible CL (403 on merge-box) is excluded from list without failing accessible CLs
    routeHandler = (method, url, body, res) => {
      if (method === "POST" && url === "/api/v1/cl/list") {
        const parsed = JSON.parse(body) as { additional: { status: string } };
        if (parsed.additional.status === "open") {
          sendCommon(res, {
            total: 2,
            items: [
              {
                id: 10,
                link: "cl-allowed",
                title: "Allowed CL",
                status: "Open",
                author: "bob",
                open_timestamp: 1_700_000_100,
                closed_at: null,
                merge_timestamp: null,
                updated_at: 1_700_000_200,
                comment_num: 0,
                path: "/pkg/public",
                from_hash: SHA_A,
                to_hash: SHA_B,
                head_revision: 1,
                base_branch: "main",
              },
              {
                id: 11,
                link: "cl-secret",
                title: "Secret CL",
                status: "Open",
                author: "alice",
                open_timestamp: 1_700_000_100,
                closed_at: null,
                merge_timestamp: null,
                updated_at: 1_700_000_250,
                comment_num: 0,
                path: "/pkg/private",
                from_hash: SHA_A,
                to_hash: SHA_C,
                head_revision: 1,
                base_branch: "main",
              },
            ],
          });
          return;
        }
        sendCommon(res, { total: 0, items: [] });
        return;
      }
      if (url === "/api/v1/cl/cl-secret/merge-box") {
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ req_result: false, data: null, err_message: "Forbidden" }));
        return;
      }
      if (url === "/api/v1/cl/cl-allowed/merge-box") {
        sendCommon(res, { merge_requirements: { state: "MERGEABLE", conditions: [] } });
        return;
      }
      if (method === "GET" && url === "/api/v1/cl/cl-draft/detail") {
        sendCommon(res, {
          id: 12,
          link: "cl-draft",
          title: "Draft CL",
          status: "Draft",
          open_timestamp: 1_700_000_100,
          merge_timestamp: null,
          conversations: [],
          path: "/pkg/public",
          from_hash: SHA_A,
          to_hash: SHA_B,
          head_revision: 1,
          base_branch: "main",
          author: "bob",
        });
        return;
      }
      if (method === "POST" && url === "/api/v1/cl/cl-bob/files-changed") {
        const parsed = JSON.parse(body) as { pagination: { page: number } };
        if (parsed.pagination.page === 1) {
          // mega2 reports total = 2 pages, then page 2 unexpectedly returns 0/empty
          sendCommon(res, {
            page: { total: 2, items: [{ path: "src/f0.ts", data: "+a" }] },
          });
          return;
        }
        sendCommon(res, { page: { total: 0, items: [] } });
        return;
      }
      prevHandler?.(method, url, body, res);
    };

    const filteredAccessible = await listLiveMega2Cls(store.db, {}, { env: env() });
    expect(filteredAccessible.map((c) => c.link)).toEqual(["cl-allowed"]);
    expect(store.byLink.has("cl-secret")).toBe(false);
    const secret = await ensureMegaClIdentity(store.db, "cl-secret");
    store.legacyPublicIds.set(secret.number, "ClSecret-001");
    store.underscorePublicIds.set(secret.number, "ClSecret_001");
    expect(await listLiveMega2Cls(store.db, { text: secret.publicId }, { env: env() })).toEqual([]);
    expect(await listLiveMega2Cls(store.db, { text: "!ClSecret-001" }, { env: env() })).toEqual([]);
    expect(await listLiveMega2Cls(store.db, { text: "!ClSecret_001" }, { env: env() })).toEqual([]);

    // Draft -> ready fails closed instead of silently calling reopen
    const { number: draftNumber } = await ensureMegaClIdentity(store.db, "cl-draft");
    await expect(
      transitionLiveMega2Cl(store.db, draftNumber, "ready", { env: env() }),
    ).rejects.toBeInstanceOf(MegaBadRequestError);

    // Decreasing reported total on files-changed fails closed
    await expect(
      getLiveMega2ClDetail(store.db, bobNumber, { env: env() }),
    ).rejects.toBeInstanceOf(MegaInternalError);
  });

  describe("CSRF protection on proxied CL mutations via /api/mega/[...segments]", () => {
    const savedEnv = {
      APP_BASE_URL: process.env.APP_BASE_URL,
      MEGA_CODE_DATA_BACKEND: process.env.MEGA_CODE_DATA_BACKEND,
      MEGA2_PUBLIC_BASE_URL: process.env.MEGA2_PUBLIC_BASE_URL,
    };

    beforeEach(() => {
      process.env.APP_BASE_URL = "https://mega.example.com";
      process.env.MEGA_CODE_DATA_BACKEND = "mega2";
      process.env.MEGA2_PUBLIC_BASE_URL = baseUrl;
    });

    afterEach(() => {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it("rejects cross-site POST to /api/mega/cls/1/transition and /api/mega/cls/1/comments with 403 CSRF before reaching mega2", async () => {
      const mega2Spy = vi.fn();
      routeHandler = (_m, _u, _b, res) => {
        mega2Spy();
        res.statusCode = 500;
        res.end("must not be called");
      };

      const { POST } = await import("../../../app/api/mega/[...segments]/route");

      for (const [segments, payload] of [
        [["cls", "1", "transition"], { state: "merged" }],
        [["cls", "1", "comments"], { body: "evil comment" }],
      ] as const) {
        const res = await POST(
          new Request(`https://mega.example.com/api/mega/${segments.join("/")}`, {
            method: "POST",
            headers: {
              Origin: "https://attacker.example",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          }),
          { params: Promise.resolve({ segments: [...segments] }) },
        );
        expect(res.status).toBe(403);
        const body: unknown = await res.json();
        assertMegaFailureEnvelope(body);
        expect(body.error.code).toBe(CSRF_ORIGIN_REJECTED_CODE);
      }

      expect(mega2Spy).not.toHaveBeenCalled();
    });
  });
});
