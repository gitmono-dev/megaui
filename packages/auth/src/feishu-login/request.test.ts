// FSL-123, FSL-154: the request contract of `POST /feishu-login/request`, driven through the real
// `createAuth` handler with injected `reserve` / `deliver` ports (no database, no Feishu).
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuth } from "../create-auth";
import { FEISHU_LOGIN_FLOW_COOKIE } from "./cookie";
import { FEISHU_LOGIN_PLUGIN_ID, feishuLogin } from "./plugin";
import {
  FEISHU_LOGIN_ISSUE_FAILED,
  FEISHU_LOGIN_RESERVE_FAILED,
  type FeishuLoginIssueInput,
  type FeishuLoginIssuePort,
} from "./request";

const ORIGIN = "http://127.0.0.1:3000";
const URL_REQUEST = `${ORIGIN}/api/auth/feishu-login/request`;
const FLOW_VALUE = /^[A-Za-z0-9_-]{43}$/;

type ReserveFn = (input: FeishuLoginIssueInput) => Promise<unknown>;
type DeliverFn = (reservation: unknown) => Promise<unknown>;

/**
 * Two spied ports. By default `reserve` resolves with a reservation that names its input, and
 * `deliver` resolves with nothing.
 */
function makePorts(options: { reserve?: ReserveFn; deliver?: DeliverFn } = {}) {
  const reserve = vi.fn<ReserveFn>(options.reserve ?? (async (input) => ({ reservedFor: input })));
  const deliver = vi.fn<DeliverFn>(options.deliver ?? (async () => undefined));
  return { reserve, deliver } satisfies FeishuLoginIssuePort;
}

type Ports = ReturnType<typeof makePorts>;

function expectNoPortCalled(issue: Ports): void {
  expect(issue.reserve).not.toHaveBeenCalled();
  expect(issue.deliver).not.toHaveBeenCalled();
}

function buildAuth(options: {
  issue?: FeishuLoginIssuePort;
  log?: (key: string) => void;
  enabled?: boolean;
  nodeEnv?: string;
} = {}) {
  return createAuth({
    appName: "megaui-test",
    secret: "test-secret-at-least-32-characters-long",
    baseURL: ORIGIN,
    db: {} as never,
    email: { sendVerificationEmail: vi.fn(), sendResetPasswordEmail: vi.fn() } as never,
    nodeEnv: options.nodeEnv ?? "test",
    ...(options.enabled === false
      ? {}
      : { feishuLogin: { issue: options.issue ?? makePorts(), ...(options.log ? { log: options.log } : {}) } }),
  });
}

type Auth = ReturnType<typeof buildAuth>;

async function post(auth: Auth, body: unknown, cookie?: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", origin: ORIGIN, ...extraHeaders };
  if (cookie !== undefined) headers.cookie = cookie;
  return auth.handler(new Request(URL_REQUEST, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

/** Lets every `setImmediate` queued so far run, together with the microtasks it starts. */
async function flushScheduled(): Promise<void> {
  for (let round = 0; round < 3; round++) await new Promise<void>(resolve => setImmediate(resolve));
}

function flowSetCookie(response: Response): string[] {
  return response.headers.getSetCookie().filter(line => line.startsWith(`${FEISHU_LOGIN_FLOW_COOKIE}=`));
}

function parseSetCookie(line: string) {
  const [pair, ...attributes] = line.split(";").map(part => part.trim());
  const separator = pair!.indexOf("=");
  return {
    name: pair!.slice(0, separator),
    value: decodeURIComponent(pair!.slice(separator + 1)),
    attributes: attributes.map(attribute => attribute.toLowerCase()).sort(),
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** A canonical flow different from anything the server draws. */
const EXISTING_FLOW = Buffer.alloc(32, 7).toString("base64url");
const EXPECTED_ATTRIBUTES = ["httponly", "max-age=600", "path=/", "samesite=lax", "secure"];

afterEach(() => {
  vi.useRealTimers();
});

describe("feishu login request endpoint (FSL-123)", () => {
  it("is registered only when createAuth receives the feishuLogin option", async () => {
    const disabled = buildAuth({ enabled: false });
    expect(disabled.options.plugins?.some(plugin => plugin.id === FEISHU_LOGIN_PLUGIN_ID)).toBe(false);
    const disabledRules = disabled.options.rateLimit?.customRules as Record<string, unknown> | undefined;
    expect(disabledRules?.["/feishu-login/request"]).toBeUndefined();
    expect((await post(disabled, { email: "alice@example.com" })).status).toBe(404);

    const enabled = buildAuth();
    expect(enabled.options.plugins?.some(plugin => plugin.id === FEISHU_LOGIN_PLUGIN_ID)).toBe(true);
  });

  it("keeps Better Auth's default limit for admissible requests and exempts only invalid inputs", async () => {
    const auth = buildAuth({ nodeEnv: "production" });
    const rule = (auth.options.rateLimit?.customRules as Record<string, unknown>)["/feishu-login/request"] as (
      request: Request, current: { window: number; max: number }) => Promise<{ window: number; max: number } | false>;
    const current = { window: 10, max: 100 };
    const request = (body: string, contentType = "application/json") => new Request(URL_REQUEST, {
      method: "POST", headers: { "content-type": contentType }, body });
    const admissible = request(JSON.stringify({ email: "alice@example.com" }));
    expect(await rule(admissible, current)).toBe(current);
    // The rule reads a clone: the endpoint still gets the body.
    expect(await admissible.json()).toEqual({ email: "alice@example.com" });
    expect(await rule(request(JSON.stringify({ email: "" })), current)).toBe(false);
    expect(await rule(request(JSON.stringify({ email: "alice@example.com", x: 1 })), current)).toBe(false);
    expect(await rule(request("not json"), current)).toBe(false);
    expect(await rule(request(JSON.stringify({ email: "alice@example.com" }), "text/plain"), current)).toBe(false);
    expect(await rule(request(JSON.stringify({ email: "alice@example.com" }), "application/json-extra"), current)).toBe(false);
    expect(await rule(request(JSON.stringify({ email: "alice@example.com" }), "application/json; charset=utf-8"), current)).toBe(current);
    // Over 4 KiB the body is invalid input whatever it carries: exempt, and the clone leaves the body intact.
    const padded = `{"email":"alice@example.com"${" ".repeat(5000)}}`;
    expect(await rule(request(`{"email":""${" ".repeat(5000)}}`), current)).toBe(false);
    const paddedRequest = request(padded);
    expect(await rule(paddedRequest, current)).toBe(false);
    expect(await paddedRequest.json()).toEqual({ email: "alice@example.com" });
    const exact = `{"email":"alice@example.com"${" ".repeat(4096 - 29)}}`;
    expect(new TextEncoder().encode(exact).byteLength).toBe(4096);
    expect(await rule(request(exact), current)).toBe(current);
  });

  it("production limit: invalid input answers 400 before 429, admissible emails all answer the same 429", async () => {
    const issue = makePorts();
    const auth = buildAuth({ issue, nodeEnv: "production" });
    const address = { "x-forwarded-for": "198.51.100.23" };
    let limited: Response | undefined;
    for (let attempt = 0; attempt < 500 && !limited; attempt++) {
      const response = await post(auth, { email: "known@example.com" }, undefined, address);
      if (response.status === 429) limited = response;
      else expect(response.status).toBe(202);
    }
    expect(limited?.status).toBe(429);

    const invalid = await post(auth, { email: "" }, undefined, address);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ code: "INVALID_INPUT" });
    expect(invalid.headers.getSetCookie()).toEqual([]);
    // Bodies over 4 KiB are invalid input: 400 ahead of 429, whether the padded email is valid or empty.
    for (const oversized of [`{"email":"known@example.com"${" ".repeat(5000)}}`, `{"email":""${" ".repeat(5000)}}`]) {
      const response = await post(auth, oversized, undefined, address);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "INVALID_INPUT" });
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    // An oversized body under a media type the framework would still parse as JSON is also 400.
    const oversizedLookalike = await post(auth, `{"email":"known@example.com"${" ".repeat(5000)}}`, undefined,
      { ...address, "content-type": "application/json-extra" });
    expect(oversizedLookalike.status).toBe(400);
    expect(await oversizedLookalike.json()).toEqual({ code: "INVALID_INPUT" });
    // A media type the framework still parses as JSON is neither exempt from the limit nor admitted.
    const lookalike = await post(auth, { email: "known@example.com" }, undefined, { ...address, "content-type": "application/json-extra" });
    expect(lookalike.status).toBe(400);
    expect(lookalike.headers.getSetCookie()).toEqual([]);

    const shapes = await Promise.all(["known@example.com", "unknown@example.com", "shared@example.com"].map(async email => {
      const response = await post(auth, { email }, undefined, address);
      return { status: response.status, body: await response.text(), setCookie: response.headers.getSetCookie() };
    }));
    expect(shapes[0]!.status).toBe(429);
    expect(shapes[0]!.setCookie).toEqual([]);
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);

    // Another address is not limited.
    expect((await post(auth, { email: "known@example.com" }, undefined, { "x-forwarded-for": "198.51.100.24" })).status).toBe(202);
    await flushScheduled();
    expect(issue.reserve.mock.calls.every(call => call[0].email === "known@example.com")).toBe(true);
    // A limited request reserves nothing; every admitted one was reserved, then delivered.
    expect(issue.deliver).toHaveBeenCalledTimes(issue.reserve.mock.calls.length);
  });

  it("AC1/AC2: a valid email answers 202 accepted and sets a new host-only flow cookie", async () => {
    const issue = makePorts();
    const auth = buildAuth({ issue });
    const response = await post(auth, { email: "alice@example.com" });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "accepted" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const lines = flowSetCookie(response);
    expect(lines).toHaveLength(1);
    const cookie = parseSetCookie(lines[0]!);
    expect(cookie.value).toMatch(FLOW_VALUE);
    expect(Buffer.from(cookie.value, "base64url")).toHaveLength(32);
    expect(cookie.attributes).toEqual(EXPECTED_ATTRIBUTES);
    expect(cookie.attributes.some(attribute => attribute.startsWith("domain"))).toBe(false);

    await flushScheduled();
    const input = { flowHash: sha256Hex(cookie.value), email: "alice@example.com" };
    expect(issue.reserve).toHaveBeenCalledExactlyOnceWith(input);
    // FSL-154: `deliver` receives exactly what `reserve` resolved with.
    expect(issue.deliver).toHaveBeenCalledExactlyOnceWith({ reservedFor: input });
  });

  it("AC2: two requests without a valid cookie get independent flows", async () => {
    const auth = buildAuth();
    const first = parseSetCookie(flowSetCookie(await post(auth, { email: "alice@example.com" }))[0]!);
    const second = parseSetCookie(flowSetCookie(await post(auth, { email: "alice@example.com" }))[0]!);
    expect(first.value).not.toBe(second.value);
  });

  it.each([
    ["a malformed value", `${FEISHU_LOGIN_FLOW_COOKIE}=not-a-flow`],
    ["a non-canonical value", `${FEISHU_LOGIN_FLOW_COOKIE}=${"A".repeat(42)}B`],
    ["a duplicated cookie", `${FEISHU_LOGIN_FLOW_COOKIE}=${EXISTING_FLOW}; ${FEISHU_LOGIN_FLOW_COOKIE}=${EXISTING_FLOW}`],
    ["another cookie only", "theme=dark"],
  ])("AC2: %s is not a valid flow, so a new flow cookie is set", async (_label, header) => {
    const issue = makePorts();
    const response = await post(buildAuth({ issue }), { email: "alice@example.com" }, header);
    expect(response.status).toBe(202);
    const cookie = parseSetCookie(flowSetCookie(response)[0]!);
    expect(cookie.value).toMatch(FLOW_VALUE);
    expect(cookie.value).not.toBe(EXISTING_FLOW);
    expect(cookie.attributes).toEqual(EXPECTED_ATTRIBUTES);
    await flushScheduled();
    expect(issue.reserve.mock.calls[0]?.[0].flowHash).toBe(sha256Hex(cookie.value));
  });

  it("AC3: a valid flow cookie is set again with the same value and a fresh Max-Age of 600", async () => {
    const issue = makePorts();
    const auth = buildAuth({ issue });
    const response = await post(auth, { email: "alice@example.com" }, `theme=dark; ${FEISHU_LOGIN_FLOW_COOKIE}=${EXISTING_FLOW}`);
    expect(response.status).toBe(202);
    const lines = flowSetCookie(response);
    expect(lines).toHaveLength(1);
    const cookie = parseSetCookie(lines[0]!);
    expect(cookie.value).toBe(EXISTING_FLOW);
    expect(cookie.attributes).toEqual(EXPECTED_ATTRIBUTES);
    await flushScheduled();
    expect(issue.reserve).toHaveBeenCalledExactlyOnceWith({ flowHash: sha256Hex(EXISTING_FLOW), email: "alice@example.com" });
  });

  it("AC3: a flow cookie with less than 5 minutes left is renewed for 10 minutes with the same flow", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-11-21T08:00:00.000Z");
    vi.setSystemTime(start);
    const issue = makePorts();
    const auth = buildAuth({ issue });

    const first = parseSetCookie(flowSetCookie(await post(auth, { email: "alice@example.com" }))[0]!);
    // Six minutes later the browser's copy has four minutes (under five) left and is still sent.
    vi.setSystemTime(new Date(start.getTime() + 6 * 60_000));
    const renewed = parseSetCookie(
      flowSetCookie(await post(auth, { email: "alice@example.com" }, `${FEISHU_LOGIN_FLOW_COOKIE}=${first.value}`))[0]!,
    );
    expect(renewed.value).toBe(first.value);
    expect(renewed.attributes).toContain("max-age=600");
    expect(renewed.attributes).toEqual(EXPECTED_ATTRIBUTES);
    await flushScheduled();
    expect(issue.reserve.mock.calls.map(call => call[0].flowHash)).toEqual([sha256Hex(first.value), sha256Hex(first.value)]);
  });

  it("AC4: surrounding whitespace is trimmed and the email is lowercased before the reserve port", async () => {
    const issue = makePorts();
    const response = await post(buildAuth({ issue }), { email: " \t Alice.Smith@Example.COM \n" });
    expect(response.status).toBe(202);
    await flushScheduled();
    expect(issue.reserve).toHaveBeenCalledTimes(1);
    expect(issue.reserve.mock.calls[0]?.[0].email).toBe("alice.smith@example.com");
    expect(issue.reserve.mock.calls[0]?.[0].flowHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("AC5: an email of exactly 254 characters is still admitted", async () => {
    const issue = makePorts();
    const email = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.com`;
    expect(email).toHaveLength(254);
    expect((await post(buildAuth({ issue }), { email })).status).toBe(202);
    await flushScheduled();
    expect(issue.reserve.mock.calls[0]?.[0].email).toBe(email);
  });

  const tooLong = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(58)}.com`;
  it.each([
    ["an empty string", { email: "" }],
    ["only whitespace", { email: "   " }],
    ["no @", { email: "alice.example.com" }],
    ["more than 254 characters", { email: tooLong }],
    ["inner whitespace in the local part", { email: "ali ce@example.com" }],
    ["inner whitespace in the domain", { email: "alice@exa mple.com" }],
    ["an inner tab", { email: "alice\t@example.com" }],
    ["a non-string email", { email: 42 }],
    ["a missing email", {}],
    ["an extra field", { email: "alice@example.com", name: "x" }],
    ["an array body", ["alice@example.com"]],
  ])("AC5: %s answers 400 INVALID_INPUT without a cookie and without any port", async (_label, body) => {
    if (_label === "more than 254 characters") expect(tooLong).toHaveLength(255);
    const issue = makePorts();
    const response = await post(buildAuth({ issue }), body, `${FEISHU_LOGIN_FLOW_COOKIE}=${EXISTING_FLOW}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_INPUT" });
    expect(response.headers.getSetCookie()).toEqual([]);
    await flushScheduled();
    expectNoPortCalled(issue);
  });

  it.each(["application/json-extra", "application/jsonp"])(
    "AC5: a valid email sent as %s answers 400 INVALID_INPUT without a cookie and without any port",
    async contentType => {
      const issue = makePorts();
      const response = await post(buildAuth({ issue }), { email: "alice@example.com" }, undefined, { "content-type": contentType });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "INVALID_INPUT" });
      expect(response.headers.getSetCookie()).toEqual([]);
      await flushScheduled();
      expectNoPortCalled(issue);
    });

  it("AC5: a body over 4096 bytes answers 400 INVALID_INPUT even when it carries a valid email", async () => {
    const issue = makePorts();
    const auth = buildAuth({ issue });
    const atLimit = `{"email":"alice@example.com"${" ".repeat(4096 - 29)}}`;
    expect(new TextEncoder().encode(atLimit).byteLength).toBe(4096);
    expect((await post(auth, atLimit)).status).toBe(202);
    const overLimit = `{"email":"alice@example.com"${" ".repeat(4096 - 28)}}`;
    const response = await post(auth, overLimit, `${FEISHU_LOGIN_FLOW_COOKIE}=${EXISTING_FLOW}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_INPUT" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.getSetCookie()).toEqual([]);
    await flushScheduled();
    expect(issue.reserve).toHaveBeenCalledTimes(1);
    expect(issue.deliver).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["text/plain", JSON.stringify({ email: "alice@example.com" })],
    ["application/json", "not json"],
    ["application/json", ""],
  ])("AC5: a %s body %j answers the same 400 INVALID_INPUT before the framework parses it", async (contentType, body) => {
    const issue = makePorts();
    const response = await post(buildAuth({ issue }), body, undefined, { "content-type": contentType });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_INPUT" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.getSetCookie()).toEqual([]);
    await flushScheduled();
    expectNoPortCalled(issue);
  });

  it.each(["application/json", "application/json-extra"])(
    "AC5: a streamed body over 4096 bytes sent as %s answers 400 after reading only a bounded prefix",
    async contentType => {
      const issue = makePorts();
      const chunk = new TextEncoder().encode(" ".repeat(1024));
      let pulled = 0;
      let first = true;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (first) {
            first = false;
            controller.enqueue(new TextEncoder().encode('{"email":"alice@example.com"'));
            return;
          }
          if (pulled >= 1024 * 1024) { controller.enqueue(new TextEncoder().encode("}")); controller.close(); return; }
          pulled += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      const response = await buildAuth({ issue }).handler(new Request(URL_REQUEST, {
        method: "POST",
        headers: { "content-type": contentType, origin: ORIGIN },
        body: stream,
        duplex: "half",
      } as RequestInit));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "INVALID_INPUT" });
      expect(response.headers.getSetCookie()).toEqual([]);
      // Only the bounded prefix was pulled, never the whole megabyte.
      expect(pulled).toBeLessThan(64 * 1024);
      await flushScheduled();
      expectNoPortCalled(issue);
    });

  it("AC5: a single body chunk over 4096 bytes answers 400 and no later chunk is pulled", async () => {
    const issue = makePorts();
    const big = new TextEncoder().encode(`{"email":"alice@example.com","pad":"${"x".repeat(64 * 1024)}"}`);
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) { controller.enqueue(big); return; }
        if (pulls > 50) { controller.close(); return; }
        controller.enqueue(new TextEncoder().encode(" ".repeat(1024)));
      },
    });
    const response = await buildAuth({ issue }).handler(new Request(URL_REQUEST, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: stream,
      duplex: "half",
    } as RequestInit));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_INPUT" });
    expect(response.headers.getSetCookie()).toEqual([]);
    // The oversized first chunk is the last one read: the stream is not drained.
    expect(pulls).toBeLessThan(50);
    await flushScheduled();
    expectNoPortCalled(issue);
  });

  it("AC1: a JSON content type with parameters is admitted", async () => {
    const response = await post(buildAuth(), { email: "alice@example.com" }, undefined, { "content-type": "Application/JSON; charset=utf-8" });
    expect(response.status).toBe(202);
  });

  it("AC6: known, unknown and shared emails get the same status, body and cookie", async () => {
    // The ports would behave differently per email; none of it can reach the response: the
    // reservation of one email is refused by the cooldown, `deliver` fails for another.
    const issue = makePorts({
      reserve: async ({ email }: FeishuLoginIssueInput) =>
        email === "shared@example.com" ? { status: "cooldown" } : { status: "reserved", email },
      deliver: async (reservation) => {
        const { email } = reservation as { email?: string };
        if (email === "known@example.com") return { status: "sent", send: "accepted" };
        if (email === undefined) return { status: "cooldown" };
        throw new Error("unknown member");
      },
    });
    const auth = buildAuth({ issue, log: () => undefined });
    const emails = ["known@example.com", "unknown@example.com", "shared@example.com"];

    const withFlow = await Promise.all(emails.map(email =>
      post(auth, { email }, `${FEISHU_LOGIN_FLOW_COOKIE}=${EXISTING_FLOW}`)));
    const shapes = await Promise.all(withFlow.map(async response => ({
      status: response.status,
      body: await response.text(),
      setCookie: response.headers.getSetCookie(),
      cacheControl: response.headers.get("cache-control"),
      contentType: response.headers.get("content-type"),
    })));
    expect(shapes[0]!.status).toBe(202);
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);

    const fresh = await Promise.all(emails.map(email => post(auth, { email })));
    const redacted = await Promise.all(fresh.map(async response => ({
      status: response.status,
      body: await response.text(),
      cookie: flowSetCookie(response).map(line => {
        const parsed = parseSetCookie(line);
        expect(parsed.value).toMatch(FLOW_VALUE);
        return { name: parsed.name, attributes: parsed.attributes };
      }),
    })));
    expect(redacted[1]).toEqual(redacted[0]);
    expect(redacted[2]).toEqual(redacted[0]);
    await flushScheduled();
    expect(issue.reserve).toHaveBeenCalledTimes(6);
    expect(issue.deliver).toHaveBeenCalledTimes(6);
  });

  it("answers after reserve and before deliver is called", async () => {
    let responded = false;
    let reserveSawResponse: boolean | undefined;
    let deliverSawResponse: boolean | undefined;
    const issue = makePorts({
      reserve: async () => {
        reserveSawResponse = responded;
        return "reservation";
      },
      deliver: async () => {
        deliverSawResponse = responded;
      },
    });
    const auth = buildAuth({ issue });
    const response = await post(auth, { email: "alice@example.com" });
    responded = true;
    expect(response.status).toBe(202);
    expect(issue.reserve).toHaveBeenCalledTimes(1);
    expect(issue.deliver).not.toHaveBeenCalled();
    await flushScheduled();
    expect(issue.deliver).toHaveBeenCalledExactlyOnceWith("reservation");
    expect(reserveSawResponse).toBe(false);
    expect(deliverSawResponse).toBe(true);
  });

  it("does not wait for a slow deliver port", async () => {
    let release!: () => void;
    const issue = makePorts({ deliver: () => new Promise<void>(resolve => { release = resolve; }) });
    const auth = buildAuth({ issue });
    expect((await post(auth, { email: "alice@example.com" })).status).toBe(202);
    await flushScheduled();
    expect(issue.deliver).toHaveBeenCalledTimes(1);
    expect((await post(auth, { email: "bob@example.com" })).status).toBe(202);
    release();
  });

  it("FSL-154 AC1: the answer waits until reserve has resolved (its transaction committed)", async () => {
    let commit!: (value: unknown) => void;
    const issue = makePorts({ reserve: () => new Promise(resolve => { commit = resolve; }) });
    const auth = buildAuth({ issue });
    let settled = false;
    const pending = post(auth, { email: "alice@example.com" }).then((response) => {
      settled = true;
      return response;
    });
    // However long the reservation takes, the handler has not answered.
    await flushScheduled();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(issue.reserve).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(issue.deliver).not.toHaveBeenCalled();

    commit({ committed: true });
    const response = await pending;
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "accepted" });
    expect(flowSetCookie(response)).toHaveLength(1);
    await flushScheduled();
    expect(issue.deliver).toHaveBeenCalledExactlyOnceWith({ committed: true });
  });

  it.each([
    ["rejects", async () => { throw new Error("db down: alice@example.com"); }],
    ["throws synchronously", () => { throw new Error("boom alice@example.com"); }],
  ] as Array<[string, ReserveFn]>)(
    "FSL-154 AC2: when reserve %s the answer is 503 retry without a cookie, and deliver is never called",
    async (_label, reserve) => {
      const issue = makePorts({ reserve });
      const log = vi.fn<(key: string) => void>();
      const auth = buildAuth({ issue, log });
      const shapes = [];
      for (const [email, cookie] of [
        ["known@example.com", undefined],
        ["unknown@example.com", `${FEISHU_LOGIN_FLOW_COOKIE}=${EXISTING_FLOW}`],
        ["shared@example.com", undefined],
      ] as const) {
        const response = await post(auth, { email }, cookie);
        shapes.push({
          status: response.status,
          body: await response.text(),
          setCookie: response.headers.getSetCookie(),
          cacheControl: response.headers.get("cache-control"),
          contentType: response.headers.get("content-type"),
        });
      }
      expect(shapes[0]!.status).toBe(503);
      expect(JSON.parse(shapes[0]!.body)).toEqual({ status: "retry" });
      expect(shapes[0]!.setCookie).toEqual([]);
      expect(shapes[0]!.cacheControl).toBe("no-store");
      // Known, unknown and shared emails, with or without a flow cookie: the same answer.
      expect(shapes[1]).toEqual(shapes[0]);
      expect(shapes[2]).toEqual(shapes[0]);
      await flushScheduled();
      expect(issue.reserve).toHaveBeenCalledTimes(3);
      expect(issue.deliver).not.toHaveBeenCalled();
      // Only the stable key: no error, email or flow.
      expect(log.mock.calls).toEqual([[FEISHU_LOGIN_RESERVE_FAILED], [FEISHU_LOGIN_RESERVE_FAILED], [FEISHU_LOGIN_RESERVE_FAILED]]);
    });

  it("FSL-154: the plugin refuses an issue option without both ports", () => {
    expect(() => feishuLogin({ issue: (async () => undefined) as never })).toThrow("INVALID_FEISHU_LOGIN_PLUGIN_CONFIG");
    expect(() => feishuLogin({ issue: { reserve: async () => undefined } as never })).toThrow("INVALID_FEISHU_LOGIN_PLUGIN_CONFIG");
    expect(() => feishuLogin({ issue: { deliver: async () => undefined } as never })).toThrow("INVALID_FEISHU_LOGIN_PLUGIN_CONFIG");
    expect(() => feishuLogin({ issue: makePorts() })).not.toThrow();
  });

  it.each([
    ["rejects", async () => { throw new Error("db down: alice@example.com"); }],
    ["throws synchronously", () => { throw new Error("boom alice@example.com"); }],
  ] as Array<[string, DeliverFn]>)("AC7: when deliver %s the request still answers 202 and only the stable key is logged", async (_label, deliver) => {
    const issue = makePorts({ deliver });
    const log = vi.fn<(key: string) => void>();
    const auth = buildAuth({ issue, log });
    const response = await post(auth, { email: "alice@example.com" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "accepted" });
    expect(flowSetCookie(response)).toHaveLength(1);
    await flushScheduled();
    expect(issue.deliver).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([[FEISHU_LOGIN_ISSUE_FAILED]]);
  });

  it("AC7: the default logger receives only the stable key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const auth = buildAuth({ issue: makePorts({ deliver: async () => { throw new Error("private detail alice@example.com"); } }) });
      expect((await post(auth, { email: "alice@example.com" })).status).toBe(202);
      await flushScheduled();
      expect(warn.mock.calls).toEqual([[FEISHU_LOGIN_ISSUE_FAILED]]);
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("AC7: a throwing logger does not escape as an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const auth = buildAuth({
        issue: makePorts({ deliver: async () => { throw new Error("x"); } }),
        log: () => { throw new Error("logger down"); },
      });
      expect((await post(auth, { email: "alice@example.com" })).status).toBe(202);
      // A failed reservation with a throwing logger still answers 503.
      const failing = buildAuth({
        issue: makePorts({ reserve: async () => { throw new Error("x"); } }),
        log: () => { throw new Error("logger down"); },
      });
      expect((await post(failing, { email: "alice@example.com" })).status).toBe(503);
      await flushScheduled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
