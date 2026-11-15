/**
 * FSM-04：有界 provider 故障注入。
 *
 * 本片交付规则队列与同步 403/429/500 故障。规则按加入顺序按 target 消费，
 * skip 次先跳过，再逐次扣减 count，归零后移除。异步的 timeout 与
 * disconnect_after_accept 在本片没有注册 handler，因此明确拒绝，由 FSM-19 扩展。
 */
import { mockError, type MockHttpError } from "./http";
import type { MockLifecycle } from "./lifecycle";
import type { MockFaultRule, MockState } from "./state";

/** How many fault rules one run keeps. */
export const MOCK_MAX_FAULT_RULES = 16;

/** The frozen fault targets. */
export const MOCK_FAULT_TARGETS = ["token", "directory", "user", "message"] as const;
export type MockFaultTarget = (typeof MOCK_FAULT_TARGETS)[number];

/** The synchronous fault kinds this card delivers. */
export const MOCK_SYNC_FAULT_KINDS = ["429", "403", "500"] as const;
/** The asynchronous kinds; they need a handler that only FSM-19 delivers. */
export const MOCK_ASYNC_FAULT_KINDS = ["timeout", "disconnect_after_accept"] as const;
export type MockFaultKind = (typeof MOCK_SYNC_FAULT_KINDS)[number] | (typeof MOCK_ASYNC_FAULT_KINDS)[number];

export interface MockFaultInput {
  target?: unknown;
  kind?: unknown;
  count?: unknown;
  skip?: unknown;
}

export type MockFaultAddResult =
  | { ok: true; rule: MockFaultRule }
  | { ok: false; error: MockHttpError };

/**
 * The fault queue of one run.
 *
 * The queue lives in the run state, so the control plane view shows it and a
 * reset empties it with the rest of the state.
 */
export class MockFaultStore {
  readonly #state: MockState;

  constructor(state: MockState) {
    this.#state = state;
  }

  /** How many rules are queued. */
  get size(): number {
    return this.#state.faults.length;
  }

  /** Adds one bounded rule. */
  add(input: MockFaultInput): MockFaultAddResult {
    if (typeof input.target !== "string" || !MOCK_FAULT_TARGETS.includes(input.target as MockFaultTarget)) {
      return { ok: false, error: mockError(1, "mock_fault_target_invalid") };
    }
    if (typeof input.kind !== "string") {
      return { ok: false, error: mockError(1, "mock_fault_kind_invalid") };
    }
    const known = [
      ...(MOCK_SYNC_FAULT_KINDS as readonly string[]),
      ...(MOCK_ASYNC_FAULT_KINDS as readonly string[]),
    ] as const;
    if (!known.includes(input.kind as (typeof known)[number])) {
      return { ok: false, error: mockError(1, "mock_fault_kind_invalid") };
    }
    // The asynchronous kinds are only accepted for messages.
    if (input.kind === "disconnect_after_accept" && input.target !== "message") {
      return { ok: false, error: mockError(1, "mock_fault_target_invalid") };
    }
    if (this.#state.faults.length >= MOCK_MAX_FAULT_RULES) {
      return { ok: false, error: mockError(6, "mock_fault_capacity_exceeded") };
    }
    const count = readBounded(input.count, 1, 1, 10);
    if (count === undefined) {
      return { ok: false, error: mockError(1, "mock_fault_count_invalid") };
    }
    const skip = readBounded(input.skip, 0, 0, 10);
    if (skip === undefined) {
      return { ok: false, error: mockError(1, "mock_fault_skip_invalid") };
    }
    const rule: MockFaultRule = {
      target: input.target as MockFaultTarget,
      kind: input.kind as MockFaultRule["kind"],
      count,
      skip,
    };
    this.#state.faults.push(rule);
    return { ok: true, rule };
  }

  /**
   * Consumes one rule for a target.
   *
   * Only a provider request that passed its own input and authentication asks,
   * so a refused request never consumes a rule. The first rule of the target
   * is skipped while its skip budget lasts, then its count is decremented and
   * the rule is removed when it reaches zero.
   */
  take(target: MockFaultTarget): MockFaultRule["kind"] | undefined {
    const index = this.#state.faults.findIndex((rule) => rule.target === target);
    if (index === -1) return undefined;
    const rule = this.#state.faults[index] as MockFaultRule;
    if (rule.skip > 0) {
      rule.skip -= 1;
      return undefined;
    }
    rule.count -= 1;
    if (rule.count <= 0) {
      this.#state.faults.splice(index, 1);
    }
    return rule.kind;
  }

  /** Forgets every rule; the store is registered for reset. */
  reset(): void {
    this.#state.faults = [];
  }
}

/** The frozen delay of an injected timeout fault, in milliseconds. */
export const MOCK_FAULT_TIMEOUT_DELAY_MS = 1_000;

/** The injected response of an asynchronous fault. */
export function asyncFaultError(): MockHttpError {
  return mockError(7, "mock_provider_timeout");
}

/**
 * Runs the injected delay.
 *
 * The delay is registered as a task, so a reset aborts it before the reset
 * succeeds and an older request can never report into the new generation.
 */
export async function runFaultDelay(
  lifecycle: MockLifecycle,
  name: string,
  delayMs: number = MOCK_FAULT_TIMEOUT_DELAY_MS,
): Promise<void> {
  await lifecycle.startTask(name, async (context) => {
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        clearInterval(poll);
        resolvePromise();
      }, delayMs);
      timer.unref?.();
      const poll = setInterval(() => {
        if (!context.aborted) return;
        clearTimeout(timer);
        clearInterval(poll);
        resolvePromise();
      }, 5);
      poll.unref?.();
    });
  });
}

/** The injected response of a synchronous fault. */
export function faultError(kind: MockFaultRule["kind"]): MockHttpError {
  if (kind === "403") return mockError(3, "mock_fault_forbidden");
  if (kind === "429") return mockError(6, "mock_fault_rate_limited");
  // The frozen override: a 500 fault answers HTTP 500 with code 8 and the
  // frozen message, even though code 8 defaults to 503 for callback failures.
  return { httpStatus: 500, code: 8, msg: "mock_provider_failure" };
}

function readBounded(value: unknown, fallback: number, min: number, max: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return undefined;
  return value;
}
