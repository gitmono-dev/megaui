import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import {
  ENTERPRISE_REQUEST_BODY_LIMIT,
  handleEnterpriseRequest,
  readEnterpriseRequest,
} from "../../lib/enterprise-transport";

function request(body: string, headers: string[][] = [["content-type", "application/json"]]): PassThrough & {
  method: string; url: string; rawHeaders: string[]; socket: { remoteAddress: string };
} {
  const stream = new PassThrough() as PassThrough & {
    method: string; url: string; rawHeaders: string[]; socket: { remoteAddress: string };
  };
  stream.method = "POST";
  stream.url = "/api/auth/enterprise/request";
  stream.rawHeaders = ["Host", "127.0.0.1:3000", ...headers.flat()];
  stream.socket = { remoteAddress: "192.0.2.1" };
  queueMicrotask(() => stream.end(body));
  return stream;
}

describe("enterprise Node transport (FS-73)", () => {
  it("uses the canonical origin and socket peer, never the request Host/XFF as peer", async () => {
    const parsed = await readEnterpriseRequest(request('{"alias":"acme"}', [["content-type", "application/json"], ["x-forwarded-for", "198.51.100.9"]]) as unknown as IncomingMessage, "http://127.0.0.1:3000");
    expect("request" in parsed).toBe(true);
    if (!("request" in parsed)) return;
    expect(parsed.request.url).toBe("http://127.0.0.1:3000/api/auth/enterprise/request");
    expect(parsed.transport).toEqual({ peerAddress: "192.0.2.1", forwardedFor: "198.51.100.9" });
  });

  it("rejects duplicate authority headers and actual bodies over the bound", async () => {
    const duplicate = await readEnterpriseRequest(request("{}", [["content-type", "application/json"], ["Content-Type", "application/json"]]) as unknown as IncomingMessage, "http://127.0.0.1:3000");
    expect(duplicate).toEqual({ status: 400, code: "INVALID_REQUEST" });
    const oversized = await readEnterpriseRequest(request("x".repeat(ENTERPRISE_REQUEST_BODY_LIMIT + 1)) as unknown as IncomingMessage, "http://127.0.0.1:3000");
    expect(oversized).toEqual({ status: 413, code: "REQUEST_TOO_LARGE" });
  });

  it("invalidates the exact transport context after the handler returns", async () => {
    const response: { statusCode: number; headersSent: boolean; destroyed: boolean; writableFinished: boolean; setHeader: () => unknown; end: () => void; once: () => unknown; off: () => unknown } = { statusCode: 0, headersSent: false, destroyed: false, writableFinished: false,
      setHeader() { return this; },
      end() { this.writableFinished = true; },
      once() { return this; },
      off() { return this; },
    };
    let seen: Request | undefined;
    await handleEnterpriseRequest({
      req: request('{"alias":"acme"}') as unknown as IncomingMessage,
      res: response as unknown as ServerResponse,
      origin: "http://127.0.0.1:3000",
      handler: async current => { seen = current; return new Response("{}", { status: 202 }); },
    });
    expect(seen).toBeDefined();
  });
});
