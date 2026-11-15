import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  MegaBadRequestError,
  MegaForbiddenError,
  MegaNotFoundError,
  MegaUnauthorizedError,
} from "../../errors";
import {
  fetchClCommits,
  fetchCodeTree,
  fetchRootEntries,
  fetchSourceFile,
  fetchWorkspace,
} from "./code-backend";

interface StubServerHandle {
  baseUrl: string;
  requests: { method: string | undefined; url: string | undefined }[];
  close: () => Promise<void>;
}

function startStubServer(
  respond: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<StubServerHandle> {
  const requests: StubServerHandle["requests"] = [];
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      requests.push({ method: req.method, url: req.url });
      respond(req, res);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function commonResultOk(data: unknown) {
  return { req_result: true, data, err_message: "" };
}

let activeServer: StubServerHandle | undefined;

afterEach(async () => {
  await activeServer?.close();
  activeServer = undefined;
});

describe("mega2 code-backend (EG-11 contract, GET /api/v1/latest-commit -> fetchWorkspace)", () => {
  it("maps the wire commit into a Workspace with the commit oid as headSha", async () => {
    activeServer = await startStubServer((_req, res) =>
      sendJson(res, 200, {
        oid: "a1b2c3d4",
        date: "1735689600",
        short_message: "chore: bump version",
        author: "tianjing",
        committer: "tianjing",
        status: "success",
      }),
    );
    const env = { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl };

    const workspace = await fetchWorkspace({}, env);

    expect(workspace.headSha).toBe("a1b2c3d4");
    expect(workspace.defaultBranch).toBe("main");
    expect(workspace.starred).toBe(false);
    expect(workspace.packages.length).toBeGreaterThan(0);
    expect(activeServer.requests[0]?.url).toMatch(/^\/api\/v1\/latest-commit\?/);
  });

  it("propagates 401 as MegaUnauthorizedError", async () => {
    activeServer = await startStubServer((_req, res) => sendJson(res, 401, "no session"));
    await expect(
      fetchWorkspace({}, { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl }),
    ).rejects.toBeInstanceOf(MegaUnauthorizedError);
  });
});

describe("mega2 code-backend (EG-11 contract, GET /api/v1/tree/commit-info -> fetchRootEntries)", () => {
  it("maps and directory-first sorts root entries", async () => {
    activeServer = await startStubServer((_req, res) =>
      sendJson(
        res,
        200,
        commonResultOk([
          { commit_id: "c1", name: "readme.md", content_type: "file", commit_message: "docs: init", date: "1735689600" },
          { commit_id: "c2", name: "project", content_type: "directory", commit_message: "feat: init", date: "1735689600" },
        ]),
      ),
    );
    const env = { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl };

    const entries = await fetchRootEntries({}, env);

    expect(entries.map((entry) => entry.name)).toEqual(["project", "readme.md"]);
    expect(entries[0]?.kind).toBe("directory");
    expect(entries[0]?.packageId).toBe("project");
    expect(entries[1]?.packageId).toBeUndefined();
  });

  it("propagates 403 as MegaForbiddenError", async () => {
    activeServer = await startStubServer((_req, res) => sendJson(res, 403, "denied"));
    await expect(
      fetchRootEntries({}, { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl }),
    ).rejects.toBeInstanceOf(MegaForbiddenError);
  });
});

describe("mega2 code-backend (EG-11 contract, GET /api/v1/tree -> fetchCodeTree)", () => {
  it("maps tree_items into directory-first sorted TreeNode[]", async () => {
    activeServer = await startStubServer((_req, res) =>
      sendJson(
        res,
        200,
        commonResultOk({
          file_tree: {},
          tree_items: [
            { name: "index.ts", path: "/src/index.ts", content_type: "file" },
            { name: "services", path: "/src/services", content_type: "directory" },
          ],
        }),
      ),
    );
    const env = { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl };

    const nodes = await fetchCodeTree("/src", {}, env);

    expect(nodes.map((node) => node.name)).toEqual(["services", "index.ts"]);
    expect(nodes[0]?.path).toBe("src/services");
    expect(activeServer.requests[0]?.url).toContain("path=%2Fsrc");
  });

  it("propagates 404 as MegaNotFoundError", async () => {
    activeServer = await startStubServer((_req, res) => sendJson(res, 404, "missing"));
    await expect(
      fetchCodeTree("/missing", {}, { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl }),
    ).rejects.toBeInstanceOf(MegaNotFoundError);
  });
});

describe("mega2 code-backend (EG-11 contract, GET /api/v1/blob -> fetchSourceFile)", () => {
  it("maps the raw string body into a SourceFileView with derived language/lines/size", async () => {
    activeServer = await startStubServer((_req, res) =>
      sendJson(res, 200, commonResultOk("export const x = 1\n")),
    );
    const env = { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl };

    const file = await fetchSourceFile("/src/index.ts", {}, env);

    expect(file.content).toBe("export const x = 1\n");
    expect(file.language).toBe("typescript");
    expect(file.lines).toBe(2);
    expect(file.sizeBytes).toBe(Buffer.byteLength("export const x = 1\n"));
  });

  it("propagates 400 as MegaBadRequestError", async () => {
    activeServer = await startStubServer((_req, res) => sendJson(res, 400, "bad path"));
    await expect(
      fetchSourceFile("/bad", {}, { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl }),
    ).rejects.toBeInstanceOf(MegaBadRequestError);
  });
});

describe("mega2 code-backend (EG-11 contract, GET /api/v1/cl/{link}/commits -> fetchClCommits)", () => {
  it("transforms snake_case wire commits into camelCase ClCommit[] in chain order", async () => {
    activeServer = await startStubServer((_req, res) =>
      sendJson(
        res,
        200,
        commonResultOk([
          { sha: "aaa111", message: "feat: a", author_name: "tianjing", author_email: "t@example.com" },
          { sha: "bbb222", message: "fix: b", author_name: "tianjing", author_email: "t@example.com" },
        ]),
      ),
    );
    const env = { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl };

    const commits = await fetchClCommits("abcd1234", {}, env);

    expect(commits).toEqual([
      { sha: "aaa111", message: "feat: a", authorName: "tianjing", authorEmail: "t@example.com" },
      { sha: "bbb222", message: "fix: b", authorName: "tianjing", authorEmail: "t@example.com" },
    ]);
    expect(activeServer.requests[0]?.url).toBe("/api/v1/cl/abcd1234/commits");
  });

  it("encodes the link into the path and propagates 404 (unknown link) as MegaNotFoundError", async () => {
    activeServer = await startStubServer((_req, res) => sendJson(res, 404, "CL not found"));
    await expect(
      fetchClCommits("un/known", {}, { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl }),
    ).rejects.toBeInstanceOf(MegaNotFoundError);
    expect(activeServer.requests[0]?.url).toBe("/api/v1/cl/un%2Fknown/commits");
  });

  it("forwards only the cookie header for session propagation (no Authorization leakage)", async () => {
    let seenHeaders: IncomingHttpHeaders | undefined;
    activeServer = await startStubServer((req, res) => {
      seenHeaders = req.headers;
      sendJson(res, 200, commonResultOk([]));
    });
    const env = { MEGA2_PUBLIC_BASE_URL: activeServer.baseUrl };

    await fetchClCommits(
      "abcd1234",
      { headers: { cookie: "session=abc", authorization: "Bearer secret" } },
      env,
    );

    expect(seenHeaders?.cookie).toBe("session=abc");
    expect(seenHeaders?.authorization).toBeUndefined();
  });
});
