/**
 * WA-08 code BFF contract tests (root-entries / code-tree / source-file / readme).
 * Fail-closed against mega2 stub (no fixture fallback).
 */
import { ownedContractFixture } from "../helpers/owned-contract";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { GET } from "../../app/api/mega/[...segments]/route";
import { assertMegaFailureEnvelope, assertMegaSuccessEnvelope } from "../../lib/adapter/envelope";

const fixture = ownedContractFixture();
afterAll(() => fixture.close(), 120_000);

function megaUrl(path: string): string {
  return `http://127.0.0.1:3000/api/mega${path}`;
}

function authedRequest(path: string, cookie: string): Request {
  return new Request(megaUrl(path), { headers: { Cookie: cookie } });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function commonResultOk(data: unknown) {
  return { req_result: true, data, err_message: "" };
}

interface StubServerHandle {
  baseUrl: string;
  close: () => Promise<void>;
}

function startStubServer(
  respond: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<StubServerHandle> {
  return new Promise((resolvePromise) => {
    const server: Server = createServer((req, res) => respond(req, res));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolvePromise({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

let cookie = "";
let stub: StubServerHandle | undefined;
let previousMega2Url: string | undefined;

beforeAll(async () => {
    await fixture.start();

  cookie = await fixture.mint();
}, 60_000);

afterEach(async () => {
  await stub?.close();
  stub = undefined;
  if (previousMega2Url === undefined) {
    delete process.env.MEGA2_PUBLIC_BASE_URL;
  } else {
    process.env.MEGA2_PUBLIC_BASE_URL = previousMega2Url;
  }
  previousMega2Url = undefined;
});

function pinMega2(url: string): void {
  previousMega2Url = process.env.MEGA2_PUBLIC_BASE_URL;
  process.env.MEGA2_PUBLIC_BASE_URL = url;
}

describe("WA-08 mega code BFF", () => {
  it("GET /api/mega/root-entries maps mega2 commit-info", async () => {
    stub = await startStubServer((_req, res) =>
      sendJson(
        res,
        200,
        commonResultOk([
          {
            commit_id: "c1",
            name: "readme.md",
            content_type: "file",
            commit_message: "docs",
            date: "1735689600",
          },
          {
            commit_id: "c1",
            name: "packages",
            content_type: "directory",
            commit_message: "init",
            date: "1735689600",
          },
        ]),
      ),
    );
    pinMega2(stub.baseUrl);

    const response = await GET(authedRequest("/root-entries", cookie), {
      params: Promise.resolve({ segments: ["root-entries"] }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    assertMegaSuccessEnvelope(body);
    const names = (body.data as Array<{ name: string }>).map((row) => row.name);
    expect(names).toEqual(["packages", "readme.md"]);
  });

  it("GET /api/mega/code-tree returns tree nodes", async () => {
    stub = await startStubServer((_req, res) =>
      sendJson(
        res,
        200,
        commonResultOk({
          file_tree: {},
          tree_items: [
            { name: "a.ts", path: "/a.ts", content_type: "file" },
            { name: "lib", path: "/lib", content_type: "directory" },
          ],
        }),
      ),
    );
    pinMega2(stub.baseUrl);

    const response = await GET(authedRequest("/code-tree", cookie), {
      params: Promise.resolve({ segments: ["code-tree"] }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    assertMegaSuccessEnvelope(body);
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as unknown[]).length).toBe(2);
  });

  it("GET /api/mega/source-file returns blob view", async () => {
    stub = await startStubServer((_req, res) =>
      sendJson(res, 200, commonResultOk("export const x = 1;\n")),
    );
    pinMega2(stub.baseUrl);

    const response = await GET(authedRequest("/source-file?path=src/x.ts", cookie), {
      params: Promise.resolve({ segments: ["source-file"] }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    assertMegaSuccessEnvelope(body);
    const file = body.data as { path: string; content: string; lines: number };
    expect(file.path).toBe("src/x.ts");
    expect(file.content).toContain("export const x");
    expect(file.lines).toBeGreaterThan(0);
  });

  it("GET /api/mega/readme returns prose blocks from markdown blob", async () => {
    stub = await startStubServer((_req, res) =>
      sendJson(res, 200, commonResultOk("# Hello\n\nWorld\n")),
    );
    pinMega2(stub.baseUrl);

    const response = await GET(authedRequest("/readme?path=README.md", cookie), {
      params: Promise.resolve({ segments: ["readme"] }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    assertMegaSuccessEnvelope(body);
    const blocks = body.data as Array<{ type: string; text?: string }>;
    expect(blocks.some((block) => block.type === "heading" && block.text === "Hello")).toBe(true);
  });

  it("root-entries fails closed when mega2 is unreachable", async () => {
    pinMega2("http://127.0.0.1:1");
    const response = await GET(authedRequest("/root-entries", cookie), {
      params: Promise.resolve({ segments: ["root-entries"] }),
    });
    expect(response.status).toBeGreaterThanOrEqual(500);
    assertMegaFailureEnvelope(await response.json());
  });

  it("source-file without path is a client error", async () => {
    pinMega2("http://127.0.0.1:1");
    const response = await GET(authedRequest("/source-file", cookie), {
      params: Promise.resolve({ segments: ["source-file"] }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    assertMegaFailureEnvelope(await response.json());
  });
});
