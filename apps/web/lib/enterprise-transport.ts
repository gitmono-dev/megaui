// megaui-only (FS-73): bounded Node transport for the enterprise pairing request.
import type { IncomingMessage, ServerResponse } from "node:http";

export interface EnterprisePairingTransport {
  readonly peerAddress: string;
  readonly forwardedFor?: string;
}

export const ENTERPRISE_REQUEST_BODY_LIMIT = 4 * 1024;
export const ENTERPRISE_REQUEST_HEADER_LIMIT = 16 * 1024;
export const ENTERPRISE_RESPONSE_BODY_LIMIT = 16 * 1024;
export const ENTERPRISE_RESPONSE_HEADER_LIMIT = 16 * 1024;
export const ENTERPRISE_BODY_TIMEOUT_MS = 2_000;
export const ENTERPRISE_REQUEST_TIMEOUT_MS = 10_000;

const SINGLE_VALUE_HEADERS = new Set([
  "host",
  "origin",
  "content-type",
  "content-length",
  "transfer-encoding",
  "cookie",
]);
const TOKEN_HEADER = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FLOW_PATH = "/api/auth/enterprise/request";

function hasHeaderControl(value: string): boolean {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

export type EnterpriseTransportFailure = Readonly<{
  readonly status: 400 | 404 | 413 | 408 | 503;
  readonly code:
    | "INVALID_REQUEST"
    | "NOT_FOUND"
    | "REQUEST_TOO_LARGE"
    | "REQUEST_TIMEOUT"
    | "UNAVAILABLE";
}>;

export type EnterpriseTransportContext = Readonly<{
  readonly request: Request;
  readonly transport: EnterprisePairingTransport;
  readonly active: { value: boolean };
}>;

export type EnterpriseRequestHandler = (request: Request) => Promise<Response>;

const TRANSPORT_REGISTRY = Symbol.for("megaui.web.enterprise-transport");
type TransportRegistry = WeakMap<Request, EnterpriseTransportContext>;
function transportRegistry(): TransportRegistry {
  const existing = Reflect.get(globalThis, TRANSPORT_REGISTRY) as TransportRegistry | undefined;
  if (existing) return existing;
  const created = new WeakMap<Request, EnterpriseTransportContext>();
  Reflect.set(globalThis, TRANSPORT_REGISTRY, created);
  return created;
}

/**
 * Run exactly one auth Request with its server-derived transport. The module
 * holds no reusable authority: the context is invalidated as soon as the
 * handler returns, throws, times out, or the socket disconnects.
 */
export async function withEnterpriseTransport<T>(
  context: EnterpriseTransportContext,
  work: () => Promise<T>,
): Promise<T> {
  const registry = transportRegistry();
  if (registry.has(context.request)) throw new Error("ENTERPRISE_TRANSPORT_ALREADY_ACTIVE");
  registry.set(context.request, context);
  try {
    return await work();
  } finally {
    context.active.value = false;
    if (registry.get(context.request) === context) registry.delete(context.request);
  }
}

/** Resolver injected into the auth factory; direct/catchall calls return null. */
export function resolveEnterpriseTransport(request: Request): EnterprisePairingTransport | null {
  const context = transportRegistry().get(request);
  if (!context || !context.active.value || context.request !== request) return null;
  return context.transport;
}

function headerBytes(name: string, value: string): number {
  return Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
}

function rawHeaderPairs(req: IncomingMessage): Array<[string, string]> | EnterpriseTransportFailure {
  if (!Array.isArray(req.rawHeaders) || req.rawHeaders.length % 2 !== 0) {
    return { status: 400, code: "INVALID_REQUEST" };
  }
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const value = req.rawHeaders[i + 1];
    if (typeof name !== "string" || typeof value !== "string" || !TOKEN_HEADER.test(name) || hasHeaderControl(value)) {
      return { status: 400, code: "INVALID_REQUEST" };
    }
    pairs.push([name.toLowerCase(), value]);
  }
  return pairs;
}

function buildHeaders(pairs: Array<[string, string]>): Headers | EnterpriseTransportFailure {
  const counts = new Map<string, number>();
  let bytes = 0;
  for (const [name, value] of pairs) {
    bytes += headerBytes(name, value);
    if (bytes > ENTERPRISE_REQUEST_HEADER_LIMIT) return { status: 413, code: "REQUEST_TOO_LARGE" };
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const name of SINGLE_VALUE_HEADERS) {
    if ((counts.get(name) ?? 0) > 1) return { status: 400, code: "INVALID_REQUEST" };
  }
  const headers = new Headers();
  try {
    for (const [name, value] of pairs) {
      if (name === "x-forwarded-for") {
        const prior = headers.get(name);
        headers.set(name, prior ? `${prior},${value}` : value);
      } else {
        headers.append(name, value);
      }
    }
  } catch {
    return { status: 400, code: "INVALID_REQUEST" };
  }
  return headers;
}

function requestPath(req: IncomingMessage, origin: string): EnterpriseTransportFailure | string {
  if (typeof req.url !== "string") return { status: 400, code: "INVALID_REQUEST" };
  try {
    const url = new URL(req.url, origin);
    if (url.pathname !== FLOW_PATH || url.search || url.hash) return { status: 404, code: "NOT_FOUND" };
    return new URL(FLOW_PATH, origin).toString();
  } catch {
    return { status: 400, code: "INVALID_REQUEST" };
  }
}

function peerAddress(req: IncomingMessage): string | null {
  const value = req.socket?.remoteAddress;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function forwardingHeader(headers: Headers): string | undefined {
  const value = headers.get("x-forwarded-for");
  return value === null ? undefined : value;
}

async function readBody(req: IncomingMessage): Promise<Buffer | EnterpriseTransportFailure> {
  const chunks: Buffer[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Buffer | EnterpriseTransportFailure>((resolve) => {
      let settled = false;
      const finish = (result: Buffer | EnterpriseTransportFailure) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", onError);
        req.off("aborted", onAborted);
        resolve(result);
      };
      const onData = (chunk: Buffer | string) => {
        const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += next.length;
        if (size > ENTERPRISE_REQUEST_BODY_LIMIT) {
          finish({ status: 413, code: "REQUEST_TOO_LARGE" });
          req.resume();
          return;
        }
        chunks.push(next);
      };
      const onEnd = () => finish(Buffer.concat(chunks));
      const onError = () => finish({ status: 503, code: "UNAVAILABLE" });
      const onAborted = () => finish({ status: 408, code: "REQUEST_TIMEOUT" });
      timer = setTimeout(() => {
        finish({ status: 408, code: "REQUEST_TIMEOUT" });
        req.resume();
      }, ENTERPRISE_BODY_TIMEOUT_MS);
      req.on("data", onData);
      req.once("end", onEnd);
      req.once("error", onError);
      req.once("aborted", onAborted);
      req.resume();
    });
  } catch {
    return { status: 503, code: "UNAVAILABLE" };
  }
}

export async function readEnterpriseRequest(
  req: IncomingMessage,
  origin: string,
): Promise<{ readonly request: Request; readonly transport: EnterprisePairingTransport } | EnterpriseTransportFailure> {
  const path = requestPath(req, origin);
  if (typeof path !== "string") return path;
  const peer = peerAddress(req);
  if (!peer) return { status: 503, code: "UNAVAILABLE" };
  const pairs = rawHeaderPairs(req);
  if (!Array.isArray(pairs)) return pairs;
  const headers = buildHeaders(pairs);
  if (!(headers instanceof Headers)) return headers;
  const body = await readBody(req);
  if (!Buffer.isBuffer(body)) return body;
  const totalBytes = body.length + pairs.reduce((sum, [name, value]) => sum + headerBytes(name, value), 0);
  if (totalBytes > ENTERPRISE_REQUEST_BODY_LIMIT) return { status: 413, code: "REQUEST_TOO_LARGE" };
  try {
    const request = new Request(path, {
      method: req.method ?? "GET",
      headers,
      body: body.length === 0 ? undefined : body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    return { request, transport: Object.freeze({ peerAddress: peer, forwardedFor: forwardingHeader(headers) }) };
  } catch {
    return { status: 400, code: "INVALID_REQUEST" };
  }
}

function jsonBody(code: string): Buffer {
  return Buffer.from(JSON.stringify({ error: code }), "utf8");
}

function writeJson(res: ServerResponse, status: number, code: string): void {
  if (res.headersSent || res.destroyed) return;
  const body = jsonBody(code);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

async function readResponseBody(response: Response): Promise<Buffer | null> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks);
      const chunk = Buffer.from(next.value);
      size += chunk.length;
      if (size > ENTERPRISE_RESPONSE_BODY_LIMIT) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk);
    }
  } catch {
    return null;
  }
}

export async function handleEnterpriseRequest(options: {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly origin: string;
  readonly handler: EnterpriseRequestHandler;
}): Promise<void> {
  const { req, res, origin, handler } = options;
  if (req.method !== "POST") {
    writeJson(res, 405, "METHOD_NOT_ALLOWED");
    return;
  }
  const active = { value: true };
  let disconnected = false;
  let timedOut = false;
  const onAborted = () => { disconnected = true; active.value = false; };
  const onClose = () => { if (!res.writableFinished) { disconnected = true; active.value = false; } };
  req.once("aborted", onAborted);
  res.once("close", onClose);
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = (async () => {
      const parsed = await readEnterpriseRequest(req, origin);
      if (!("request" in parsed)) return parsed;
      return await withEnterpriseTransport({ request: parsed.request, transport: parsed.transport, active }, () => handler(parsed.request));
    })();
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        active.value = false;
        reject(Object.freeze({ status: 408, code: "REQUEST_TIMEOUT" }));
      }, ENTERPRISE_REQUEST_TIMEOUT_MS);
    });
    let response: Response | EnterpriseTransportFailure;
    try {
      response = await Promise.race([work, deadline]);
    } catch (error) {
      active.value = false;
      if (disconnected || res.destroyed) return;
      if (error && typeof error === "object" && "status" in error && "code" in error) {
        const failure = error as EnterpriseTransportFailure;
        writeJson(res, failure.status, failure.code);
      } else {
        writeJson(res, 503, "UNAVAILABLE");
      }
      return;
    }
    if (!(response instanceof Response)) {
      active.value = false;
      if (!disconnected) writeJson(res, response.status, response.code);
      return;
    }
    if (timedOut || disconnected || res.destroyed || Date.now() - started > ENTERPRISE_REQUEST_TIMEOUT_MS) return;
    const body = await readResponseBody(response);
    if (!body || timedOut || disconnected || res.destroyed) {
      active.value = false;
      if (!disconnected) writeJson(res, 503, "RESPONSE_TOO_LARGE");
      return;
    }
    const responseHeaders: Array<[string, string]> = [];
    for (const [name, value] of response.headers) {
      if (Buffer.byteLength(name) + Buffer.byteLength(value) > ENTERPRISE_RESPONSE_HEADER_LIMIT) {
        writeJson(res, 503, "RESPONSE_TOO_LARGE");
        return;
      }
      responseHeaders.push([name, value]);
    }
    if (timedOut || disconnected || res.destroyed) return;
    res.statusCode = response.status;
    for (const [name, value] of responseHeaders) res.setHeader(name, value);
    res.end(body);
  } catch {
    active.value = false;
    if (!disconnected) writeJson(res, 503, "UNAVAILABLE");
  } finally {
    active.value = false;
    if (timer) clearTimeout(timer);
    req.off("aborted", onAborted);
    res.off("close", onClose);
  }
}
