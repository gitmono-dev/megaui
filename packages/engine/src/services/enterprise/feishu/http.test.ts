// megaui-only (FSL-149): the attempt count of the fixed-origin transport.
//
// Baseline cases pin the existing retry behaviour of `FeishuTransport` (three attempts by
// default, transient failures retried, permanent ones not), and the new optional
// `maxAttempts` proves that `maxAttempts: 1` makes exactly one HTTP attempt per `request()`.
import { admitProvider, type ProviderTarget } from "@megaui/core";
import { describe, expect, it } from "vitest";

import { FEISHU_MAX_ATTEMPTS, FeishuTransport, FeishuTransportError } from "./http";

const target: ProviderTarget = admitProvider({
  enabled: true,
  provider: "simulator",
  role: "test",
  nodeEnv: "test",
  simulatorOrigin: "http://127.0.0.1:9",
})!;

type Step = { status: number; body?: unknown } | "network" | "hang";

/** A scripted fetch: each call takes the next step, the last step repeats. */
function scripted(steps: Step[]): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push(String(input));
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    if (step === "network") throw new TypeError("fetch failed");
    if (step === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return new Response(JSON.stringify("body" in step ? step.body : { code: 0, data: {} }), {
      status: step.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

function transport(steps: Step[], options: { maxAttempts?: number; budgetMs?: number } = {}) {
  const { fetchImpl, calls } = scripted(steps);
  const instance = new FeishuTransport({ target, fetchImpl, backoffMs: 1, ...options });
  return { instance, calls };
}

async function failure(promise: Promise<unknown>): Promise<FeishuTransportError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FeishuTransportError);
    return error as FeishuTransportError;
  }
  throw new Error("expected the request to fail");
}

describe("FeishuTransport attempts: baseline (default maxAttempts)", () => {
  it("defaults to three attempts", () => {
    expect(FEISHU_MAX_ATTEMPTS).toBe(3);
  });

  it("retries a 5xx and returns the first successful answer", async () => {
    const { instance, calls } = transport([{ status: 500 }, { status: 503 }, { status: 200, body: { code: 0, data: { ok: 1 } } }]);
    await expect(instance.request("/open-apis/x")).resolves.toEqual({ code: 0, data: { ok: 1 } });
    expect(calls).toEqual(Array(3).fill(target.origin + "/open-apis/x"));
  });

  it("stops after three transient failures and reports the last one", async () => {
    const { instance, calls } = transport([{ status: 500 }]);
    const error = await failure(instance.request("/open-apis/x"));
    expect(error.code).toBe("transport_transient");
    expect(error.status).toBe(500);
    expect(calls).toHaveLength(3);
  });

  it("retries 429 and connection failures as transient", async () => {
    const limited = transport([{ status: 429 }]);
    expect((await failure(limited.instance.request("/open-apis/x"))).status).toBe(429);
    expect(limited.calls).toHaveLength(3);

    const dropped = transport(["network"]);
    expect((await failure(dropped.instance.request("/open-apis/x"))).code).toBe("transport_transient");
    expect(dropped.calls).toHaveLength(3);
  });

  it("does not retry a permanent refusal or a business error", async () => {
    const forbidden = transport([{ status: 403 }]);
    expect((await failure(forbidden.instance.request("/open-apis/x"))).code).toBe("transport_permanent");
    expect(forbidden.calls).toHaveLength(1);

    const business = transport([{ status: 200, body: { code: 230002, msg: "refused" } }]);
    const error = await failure(business.instance.request("/open-apis/x"));
    expect(error).toMatchObject({ code: "transport_permanent", businessCode: 230002 });
    expect(business.calls).toHaveLength(1);
  });

  it("treats a 2xx answer whose body is not a JSON object as transient", async () => {
    const empty = transport([{ status: 200, body: null }], { maxAttempts: 1 });
    expect((await failure(empty.instance.request("/open-apis/x"))).code).toBe("transport_transient");
    expect(empty.calls).toHaveLength(1);
  });

  it("keeps the default when maxAttempts is omitted or undefined", async () => {
    const omitted = transport([{ status: 500 }]);
    await failure(omitted.instance.request("/open-apis/x"));
    expect(omitted.calls).toHaveLength(FEISHU_MAX_ATTEMPTS);

    const undefinedValue = transport([{ status: 500 }], { maxAttempts: undefined });
    await failure(undefinedValue.instance.request("/open-apis/x"));
    expect(undefinedValue.calls).toHaveLength(FEISHU_MAX_ATTEMPTS);
  });
});

describe("FeishuTransport attempts: maxAttempts (FSL-149)", () => {
  it("makes exactly one HTTP attempt on a 5xx, a 429 or a dropped connection", async () => {
    for (const step of [{ status: 500 }, { status: 429 }, "network"] as const) {
      const { instance, calls } = transport([step], { maxAttempts: 1 });
      expect((await failure(instance.request("/open-apis/x"))).code).toBe("transport_transient");
      expect(calls).toHaveLength(1);
    }
  });

  it("makes exactly one HTTP attempt when the attempt times out", async () => {
    const { instance, calls } = transport(["hang"], { maxAttempts: 1, budgetMs: 50 });
    expect((await failure(instance.request("/open-apis/x"))).code).toBe("transport_timeout");
    expect(calls).toHaveLength(1);
  });

  it("returns a success of the single attempt unchanged", async () => {
    const { instance, calls } = transport([{ status: 200, body: { code: 0, data: { v: 2 } } }], { maxAttempts: 1 });
    await expect(instance.request("/open-apis/x")).resolves.toEqual({ code: 0, data: { v: 2 } });
    expect(calls).toHaveLength(1);
  });

  it("honours another bound", async () => {
    const { instance, calls } = transport([{ status: 502 }], { maxAttempts: 2 });
    await failure(instance.request("/open-apis/x"));
    expect(calls).toHaveLength(2);
  });

  it("refuses a value that is not a positive integer", () => {
    for (const maxAttempts of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new FeishuTransport({ target, maxAttempts })).toThrow("INVALID_FEISHU_TRANSPORT_MAX_ATTEMPTS");
    }
  });
});
