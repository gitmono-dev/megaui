// FS-04：授权通讯录读取与完整快照。
//
// The suite drives the reader against a real local HTTP server through the
// fixed-origin transport of FS-03 and proves the acceptance criteria, including
// the rule that a failed snapshot never produces a member-missing verdict.
import { createServer, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";

import { admitProvider } from "@megaui/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { reconcileDirectory } from "../directory-sync";
import {
  DirectoryReader,
  SingleMemberDirectoryReader,
  diffSnapshots,
  scopeHashOf,
  validateNotificationEmail,
} from "./directory";
import { FeishuTransport } from "./http";

interface TestServer {
  origin: string;
  requests: string[];
  close: () => Promise<void>;
}

async function startServer(
  handler: (url: string, response: ServerResponse) => void,
): Promise<TestServer> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    handler(request.url ?? "", response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function user(openId: string, overrides: Record<string, unknown> = {}) {
  return {
    open_id: openId,
    union_id: `union-${openId}`,
    name: `Member ${openId}`,
    enterprise_email: `${openId}@example.com`,
    status: {
      is_activated: true,
      is_frozen: false,
      is_resigned: false,
      is_exited: false,
    },
    department_ids: ["od-authorized"],
    ...overrides,
  };
}

function transportFor(origin: string): FeishuTransport {
  const target = admitProvider({
    enabled: true,
    provider: "simulator",
    role: "development",
    nodeEnv: "test",
    simulatorOrigin: origin,
  });
  if (!target) throw new Error("unreachable: the simulator target must be admitted");
  return new FeishuTransport({ target, backoffMs: 5 });
}

function readerFor(origin: string, generation: number) {
  return new DirectoryReader({
    transport: transportFor(origin),
    generation,
    getToken: async () => "t-directory",
  });
}

function singleMemberReaderFor(origin: string) {
  return new SingleMemberDirectoryReader({
    transport: transportFor(origin),
    credentials: CREDENTIALS,
    getToken: async () => "t-directory",
  });
}

const SCOPE = { tenantKey: "tenant-x", appId: "app-x", departmentIds: ["od-authorized"] };
const CREDENTIALS = { tenantKey: "tenant-x", appId: "app-x", appSecret: "secret-x" };

describe("authorized directory reading and complete snapshot (FS-04)", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer((url, response) => {
      const parsed = new URL(url, "http://127.0.0.1");
      if (!parsed.searchParams.has("department_id")) {
        json(response, 400, { code: 2, msg: "department is required" });
        return;
      }
      const pageToken = parsed.searchParams.get("page_token");
      if (!pageToken) {
        json(response, 200, {
          code: 0,
          msg: "ok",
          data: { items: [user("ou-1"), user("ou-2")], has_more: true, page_token: "page-2" },
        });
        return;
      }
      if (pageToken === "page-2") {
        json(response, 200, {
          code: 0,
          msg: "ok",
          data: { items: [user("ou-3")], has_more: false },
        });
        return;
      }
      json(response, 200, { code: 0, msg: "ok", data: { items: [], has_more: false } });
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("reads only the authorized departments and produces a complete snapshot", async () => {
    server.requests.length = 0;
    const reader = readerFor(server.origin, 1);
    const snapshot = await reader.read(SCOPE, CREDENTIALS);

    expect(snapshot.complete).toBe(true);
    expect(snapshot.generation).toBe(1);
    expect(snapshot.scopeHash).toBe(scopeHashOf(SCOPE));
    expect(snapshot.members.map((member) => member.openId)).toEqual(["ou-1", "ou-2", "ou-3"]);
    expect(server.requests).toHaveLength(2);
    for (const request of server.requests) {
      const parsed = new URL(request, "http://127.0.0.1");
      expect(parsed.searchParams.get("department_id")).toBe("od-authorized");
    }
  });

  it("gives every snapshot its own generation", async () => {
    const reader = readerFor(server.origin, 1);
    expect(await reader.read(SCOPE, CREDENTIALS)).toMatchObject({ generation: 1 });
    expect(reader.nextGeneration()).toBe(2);
  });

  it("does not mark an interrupted snapshot complete", async () => {
    const failing = await startServer((url, response) => {
      const parsed = new URL(url, "http://127.0.0.1");
      if (parsed.searchParams.get("page_token") === "page-2") {
        json(response, 500, { code: 8, msg: "provider failure" });
        return;
      }
      json(response, 200, {
        code: 0,
        msg: "ok",
        data: { items: [user("ou-1")], has_more: true, page_token: "page-2" },
      });
    });
    try {
      const snapshot = await readerFor(failing.origin, 3).read(SCOPE, CREDENTIALS);
      expect(snapshot.complete).toBe(false);
      expect(snapshot.interruptedAt?.departmentId).toBe("od-authorized");
      // The members of the pages that were read stay in the incomplete snapshot.
      expect(snapshot.members.map((member) => member.openId)).toEqual(["ou-1"]);
    } finally {
      await failing.close();
    }
  });

  it.each([
    [
      "missing code",
      { msg: "ok", data: { items: [], has_more: false } },
    ],
    [
      "nonnumeric code",
      { code: "0", msg: "ok", data: { items: [], has_more: false } },
    ],
    [
      "missing message",
      { code: 0, data: { items: [], has_more: false } },
    ],
    ["missing data", { code: 0, msg: "ok" }],
    [
      "missing items",
      { code: 0, msg: "ok", data: { has_more: false } },
    ],
    [
      "missing has_more",
      { code: 0, msg: "ok", data: { items: [] } },
    ],
    [
      "missing next-page token",
      { code: 0, msg: "ok", data: { items: [], has_more: true } },
    ],
    [
      "a malformed member field",
      {
        code: 0,
        msg: "ok",
        data: { items: [user("ou-bad", { name: 42 })], has_more: false },
      },
    ],
  ])("marks a page with %s incomplete and performs no reconcile write", async (_name, body) => {
    const malformed = await startServer((_url, response) => {
      json(response, 200, body);
    });
    try {
      const snapshot = await readerFor(malformed.origin, 4).read(SCOPE, CREDENTIALS);
      expect(snapshot).toMatchObject({
        complete: false,
        members: [],
        interruptedAt: {
          departmentId: "od-authorized",
          reason: expect.stringMatching(/malformed/),
        },
      });

      let writes = 0;
      await expect(
        reconcileDirectory({
          scope: SCOPE,
          store: {
            applyCompleteSnapshot: async () => {
              writes += 1;
              return { applied: true, previous: [] };
            },
          },
          readSnapshot: async () => snapshot,
        }),
      ).resolves.toEqual({ kind: "skipped", reason: "incomplete" });
      expect(writes).toBe(0);
    } finally {
      await malformed.close();
    }
  });

  it("marks a repeated continuation token incomplete without mutating or reconciling it", async () => {
    const cyclic = await startServer((url, response) => {
      const pageToken = new URL(url, "http://127.0.0.1").searchParams.get("page_token");
      json(response, 200, {
        code: 0,
        msg: "ok",
        data: {
          items: [user(pageToken ? "ou-repeated-page" : "ou-first-page")],
          has_more: true,
          page_token: "loop",
        },
      });
    });
    try {
      const snapshot = await readerFor(cyclic.origin, 5).read(SCOPE, CREDENTIALS);
      expect(cyclic.requests).toHaveLength(2);
      expect(snapshot).toMatchObject({
        complete: false,
        interruptedAt: {
          departmentId: "od-authorized",
          pageToken: "loop",
          reason: expect.stringMatching(/repeated/),
        },
      });
      expect(snapshot.members.map((member) => member.openId)).toEqual(["ou-first-page"]);

      let writes = 0;
      await expect(
        reconcileDirectory({
          scope: SCOPE,
          store: {
            applyCompleteSnapshot: async () => {
              writes += 1;
              return { applied: true, previous: [] };
            },
          },
          readSnapshot: async () => snapshot,
        }),
      ).resolves.toEqual({ kind: "skipped", reason: "incomplete" });
      expect(writes).toBe(0);
    } finally {
      await cyclic.close();
    }
  });

  it("refuses to produce a member-missing verdict from an incomplete snapshot", async () => {
    const complete = await readerFor(server.origin, 1).read(SCOPE, CREDENTIALS);
    const incomplete = { ...complete, complete: false, members: [] };

    expect(() => diffSnapshots(complete, complete)).not.toThrow();
    expect(() => diffSnapshots(complete, incomplete)).toThrow(/must not produce a member-missing verdict/);
    expect(() => diffSnapshots(incomplete, complete)).toThrow(/must not produce a member-missing verdict/);
  });

  it("detects a removed member only between two complete snapshots", async () => {
    const first = await readerFor(server.origin, 1).read(SCOPE, CREDENTIALS);
    const second = {
      ...first,
      generation: 2,
      members: first.members.filter((member) => member.openId !== "ou-3"),
    };
    const delta = diffSnapshots(first, second);
    expect(delta.removed.map((member) => member.openId)).toEqual(["ou-3"]);
    expect(delta.added).toHaveLength(0);
  });

  it("refuses a directory status outside the boundary schema", async () => {
    const invalid = await startServer((_url, response) => {
      json(response, 200, {
        code: 0,
        msg: "ok",
        data: { items: [{ open_id: "ou-bad", name: "Bad", status: {} }], has_more: false },
      });
    });
    try {
      await expect(readerFor(invalid.origin, 1).read(SCOPE, CREDENTIALS)).resolves.toMatchObject({
        complete: false,
        members: [],
        interruptedAt: {
          departmentId: "od-authorized",
          reason: expect.stringMatching(/boundary fields/),
        },
      });
    } finally {
      await invalid.close();
    }
  });

  it("stores an unusable directory email as a null notification address", async () => {
    const mixed = await startServer((_url, response) => {
      json(response, 200, {
        code: 0,
        msg: "ok",
        data: {
          items: [
            user("ou-mail"),
            user("ou-nomail", { enterprise_email: "not-an-address" }),
            user("ou-empty", { enterprise_email: "" }),
          ],
          has_more: false,
        },
      });
    });
    try {
      const snapshot = await readerFor(mixed.origin, 1).read(SCOPE, CREDENTIALS);
      expect(snapshot.members.map((member) => member.notificationEmail)).toEqual([
        "ou-mail@example.com",
        null,
        null,
      ]);
    } finally {
      await mixed.close();
    }

    expect(validateNotificationEmail("a@b.co")).toBe("a@b.co");
    expect(validateNotificationEmail("not-an-address")).toBeNull();
    expect(validateNotificationEmail(undefined)).toBeNull();
  });
});

describe("exact single-member directory reading (FS-10)", () => {
  it("uses the frozen path and returns all four status bits", async () => {
    const server = await startServer((_url, response) => {
      json(response, 200, {
        code: 0,
        msg: "ok",
        data: {
          user: {
            open_id: "ou/member",
            department_ids: ["od-authorized", "od-secondary"],
            status: {
              is_activated: true,
              is_frozen: false,
              is_resigned: false,
              is_exited: false,
            },
          },
        },
      });
    });
    try {
      await expect(singleMemberReaderFor(server.origin).read("ou/member")).resolves.toEqual({
        openId: "ou/member",
        departmentIds: ["od-authorized", "od-secondary"],
        status: {
          isActivated: true,
          isFrozen: false,
          isResigned: false,
          isExited: false,
        },
      });
      expect(server.requests).toEqual([
        "/open-apis/contact/v3/users/ou%2Fmember?user_id_type=open_id&department_id_type=open_department_id",
      ]);
    } finally {
      await server.close();
    }
  });

  it.each([
    { name: "missing code", body: { msg: "ok", data: { user: {} } } },
    { name: "non-numeric code", body: { code: "0", data: { user: {} } } },
    { name: "non-zero code", body: { code: 4, msg: "denied", data: { user: {} } } },
    { name: "missing user", body: { code: 0, msg: "ok", data: {} } },
    {
      name: "missing frozen status",
      body: {
        code: 0,
        msg: "ok",
        data: {
          user: {
            open_id: "ou-1",
            department_ids: ["od-authorized"],
            status: { is_activated: true, is_resigned: false, is_exited: false },
          },
        },
      },
    },
    {
      name: "malformed departments",
      body: {
        code: 0,
        msg: "ok",
        data: {
          user: {
            open_id: "ou-1",
            department_ids: [""],
            status: {
              is_activated: true,
              is_frozen: false,
              is_resigned: false,
              is_exited: false,
            },
          },
        },
      },
    },
  ])("fails closed for a malformed HTTP 200 envelope: $name", async ({ body }) => {
    const server = await startServer((_url, response) => json(response, 200, body));
    try {
      await expect(singleMemberReaderFor(server.origin).read("ou-1")).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  it("fails closed when the provider request fails", async () => {
    const server = await startServer((_url, response) => {
      json(response, 500, { code: 8, msg: "provider failure" });
    });
    try {
      await expect(singleMemberReaderFor(server.origin).read("ou-1")).rejects.toThrow(
        /provider answered with 500/,
      );
      expect(server.requests).toHaveLength(3);
    } finally {
      await server.close();
    }
  });
});
