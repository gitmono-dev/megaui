// megaui-only (FSL-149, FSL-160): the attempt count and the deadline of the fixed-origin transport.
//
// Baseline cases pin the existing retry behaviour of `FeishuTransport` (three attempts by
// default, transient failures retried, permanent ones not), and the new optional
// `maxAttempts` proves that `maxAttempts: 1` makes exactly one HTTP attempt per `request()`.
// FSL-160: the optional absolute `deadline` of `request()` refuses to start a request once it
// has passed (`transport_deadline`), bounds each attempt by min(budget, deadline - now), and
// leaves a request without `deadline` exactly as before.
import { admitProvider, type ProviderTarget } from "@megaui/core";
import { describe, expect, it, vi } from "vitest";

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

function transport(
  steps: Step[],
  options: { maxAttempts?: number; budgetMs?: number; backoffMs?: number; now?: () => number } = {},
) {
  const { fetchImpl, calls } = scripted(steps);
  const instance = new FeishuTransport({ target, fetchImpl, backoffMs: 1, ...options });
  return { instance, calls };
}

/** A fetch that never answers and records how long after the call its signal aborted. */
function hanging(): { fetchImpl: typeof fetch; calls: number; abortedAfter: number[] } {
  const record = { calls: 0, abortedAfter: [] as number[] };
  const fetchImpl: typeof fetch = async (_input, init) => {
    record.calls += 1;
    const startedAt = Date.now();
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => {
        record.abortedAfter.push(Date.now() - startedAt);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  };
  return Object.assign(record, { fetchImpl });
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

describe("FeishuTransport deadline (FSL-160)", () => {
  it("AC1-AC3 basis: starts no HTTP attempt once the deadline has passed", async () => {
    const clock = 10_000;
    for (const deadline of [10_000, 9_999, 0]) {
      const { instance, calls } = transport([{ status: 200 }], { now: () => clock });
      const error = await failure(instance.request("/open-apis/x", { method: "POST", json: {}, deadline }));
      expect(error.code).toBe("transport_deadline");
      expect(error.status).toBeUndefined();
      expect(calls).toHaveLength(0);
    }
  });

  it("AC1-AC3 basis: a deadline crossed between the entry check and the attempt starts no fetch", async () => {
    // The entry reading is before the deadline; every later reading is at it.
    const readings = [1_000];
    const { instance, calls } = transport([{ status: 200 }], { now: () => readings.shift() ?? 1_300 });
    const error = await failure(instance.request("/open-apis/x", { deadline: 1_300 }));
    expect(error.code).toBe("transport_deadline");
    expect(calls).toHaveLength(0);
  });

  it("AC1-AC3 basis: the clock is read after the request is prepared, right before fetch", async () => {
    // Serializing the body takes the clock to the deadline: the attempt reads the clock after
    // that work and does not start.
    let clock = 1_000;
    const { instance, calls } = transport([{ status: 200 }], { now: () => clock });
    const slowBody = {
      toJSON() {
        clock = 1_300;
        return { v: 1 };
      },
    };
    const error = await failure(
      instance.request("/open-apis/x", { method: "POST", json: { slow: slowBody }, deadline: 1_300 }),
    );
    expect(error.code).toBe("transport_deadline");
    expect(calls).toHaveLength(0);
  });

  it("refuses a deadline that is not a finite number before any request", async () => {
    for (const deadline of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const { instance, calls } = transport([{ status: 200 }]);
      await expect(instance.request("/open-apis/x", { deadline })).rejects.toThrow("INVALID_FEISHU_TRANSPORT_DEADLINE");
      expect(calls).toHaveLength(0);
    }
  });

  it("AC4: one attempt times out at the deadline when it comes before the budget", async () => {
    const record = hanging();
    const instance = new FeishuTransport({ target, fetchImpl: record.fetchImpl, maxAttempts: 1, budgetMs: 10_000 });
    const started = Date.now();
    const error = await failure(instance.request("/open-apis/x", { deadline: started + 150 }));
    expect(error.code).toBe("transport_timeout");
    expect(record.calls).toBe(1);
    // Aborted by the deadline (150 ms), long before the 10-second budget.
    expect(record.abortedAfter[0]).toBeGreaterThanOrEqual(100);
    expect(record.abortedAfter[0]).toBeLessThan(1_000);
  });

  it("AC4: the attempt timer is exactly min(budget, deadline - now)", async () => {
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      ms?: number,
    ) => {
      delays.push(ms ?? 0);
      return realSetTimeout(handler, 0);
    }) as typeof setTimeout);
    try {
      const fixed = () => 1_000;
      // The deadline leaves 300 ms, the budget 20 s: the attempt gets 300 ms.
      const early = transport([{ status: 200, body: { code: 0 } }], { maxAttempts: 1, budgetMs: 20_000, now: fixed });
      await early.instance.request("/open-apis/x", { deadline: 1_300 });
      // The budget (50 ms) is shorter than the 300 ms left: the attempt gets 50 ms.
      const budget = transport([{ status: 200, body: { code: 0 } }], { maxAttempts: 1, budgetMs: 50, now: fixed });
      await budget.instance.request("/open-apis/x", { deadline: 1_300 });
      // AC7: without a deadline the attempt gets the budget, as before.
      const none = transport([{ status: 200, body: { code: 0 } }], { maxAttempts: 1, budgetMs: 20_000, now: fixed });
      await none.instance.request("/open-apis/x");
    } finally {
      spy.mockRestore();
    }
    expect(delays).toEqual([300, 50, 20_000]);
  });

  it("AC4: an attempt never outlives the deadline when the clock moved before it started", async () => {
    let clock = 1_000;
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      ms?: number,
    ) => {
      delays.push(ms ?? 0);
      return realSetTimeout(handler, 0);
    }) as typeof setTimeout);
    try {
      // The first attempt fails at t=1000 (500), the clock moves to t=1250 during the backoff,
      // so the second attempt has 50 ms left before the deadline (1300).
      const steps: Step[] = [{ status: 500 }, { status: 200, body: { code: 0 } }];
      const { fetchImpl, calls } = scripted(steps);
      const wrapped: typeof fetch = async (input, init) => {
        const response = await fetchImpl(input, init);
        clock += 250;
        return response;
      };
      const instance = new FeishuTransport({ target, fetchImpl: wrapped, backoffMs: 1, budgetMs: 20_000, now: () => clock });
      await instance.request("/open-apis/x", { deadline: 1_300 });
      expect(calls).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
    // Attempt 1: 300 ms; backoff: 1 ms; attempt 2: 1300 - 1250 = 50 ms.
    expect(delays).toEqual([300, 1, 50]);
  });

  it("starts no retry past the deadline and reports the last attempt", async () => {
    let clock = 1_000;
    const { fetchImpl, calls } = scripted([{ status: 503 }]);
    const wrapped: typeof fetch = async (input, init) => {
      const response = await fetchImpl(input, init);
      clock = 2_000; // past the deadline once the first attempt has answered
      return response;
    };
    const instance = new FeishuTransport({ target, fetchImpl: wrapped, backoffMs: 1, now: () => clock });
    const error = await failure(instance.request("/open-apis/x", { deadline: 1_500 }));
    expect(error).toMatchObject({ code: "transport_transient", status: 503 });
    expect(calls).toHaveLength(1);
  });

  it("AC7: without a deadline the default retries and the budget are unchanged", async () => {
    const retried = transport([{ status: 500 }, { status: 200, body: { code: 0, data: { ok: 1 } } }]);
    await expect(retried.instance.request("/open-apis/x")).resolves.toEqual({ code: 0, data: { ok: 1 } });
    expect(retried.calls).toHaveLength(2);

    const explicitUndefined = transport([{ status: 500 }]);
    expect((await failure(explicitUndefined.instance.request("/open-apis/x", { deadline: undefined }))).code).toBe(
      "transport_transient",
    );
    expect(explicitUndefined.calls).toHaveLength(FEISHU_MAX_ATTEMPTS);

    const record = hanging();
    const instance = new FeishuTransport({ target, fetchImpl: record.fetchImpl, maxAttempts: 1, budgetMs: 120 });
    expect((await failure(instance.request("/open-apis/x"))).code).toBe("transport_timeout");
    expect(record.abortedAfter[0]).toBeGreaterThanOrEqual(80);
  });

  it("a deadline later than the budget leaves the budget in charge", async () => {
    const record = hanging();
    const instance = new FeishuTransport({ target, fetchImpl: record.fetchImpl, maxAttempts: 1, budgetMs: 120 });
    const error = await failure(instance.request("/open-apis/x", { deadline: Date.now() + 60_000 }));
    expect(error.code).toBe("transport_timeout");
    expect(record.abortedAfter[0]).toBeLessThan(1_000);
  });
});
