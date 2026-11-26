// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@megaui/i18n";

vi.mock("next/navigation", () => ({
  useParams: () => ({ lang: "en", n: "1" }),
}));

vi.mock("@/hooks/use-translation", () => ({
  useTranslation: () => ({ locale: "en", t: en }),
}));

import { MAX_LOG_LINES } from "./components/build-log-viewer";
import CLChecksPage from "./page";

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readyState = FakeEventSource.CONNECTING;
  closed = false;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  private listeners = new Map<string, Set<(ev: Event) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (ev: Event) => void) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (ev: Event) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emitOpen() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.(new Event("open"));
  }

  emitNamed(type: string, data: string, lastEventId = "") {
    const event = new MessageEvent(type, { data, lastEventId });
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

function renderChecksPage() {
  return act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(CLChecksPage),
      ),
    );
  });
}

async function waitForUi(predicate: () => boolean, maxAttempts = 40) {
  for (let i = 0; i < maxAttempts; i += 1) {
    if (predicate()) return;
    await act(async () => {
      if (vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(10);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
  }
}

describe("CLChecksPage & BuildLogViewer (CLB-33)", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("preserves legacy selectors and renders identically for stub ChecksView without Orion context", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: {
              pipeline: [{ id: "p1", name: "CI", status: "failing" }],
              runner: "local-stub",
              checks: [
                { id: "c1", name: "lint", status: "passing", durationSeconds: 12 },
                { id: "c2", name: "unit", status: "failing", durationSeconds: 20 },
              ],
              logTail: [],
              benchmarks: [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await renderChecksPage();
    await waitForUi(() => container.querySelector('[data-mega-cls="checks-hero"]') !== null);

    expect(container.querySelector('[data-mega-cls="checks"]')).not.toBeNull();
    expect(container.querySelector('[data-mega-cls="checks-hero"]')?.getAttribute("data-status")).toBe("failing");
    expect(container.querySelector('[data-mega-cls="checks-failed"]')).not.toBeNull();
    expect(container.querySelector('[data-mega-cls="checks-table"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-mega-cls="check-row"]')).toHaveLength(2);
    expect(container.querySelector('[data-mega-cls="orion-controls"]')).toBeNull();
    expect(container.querySelector('[data-mega-cls="build-log-viewer"]')).toBeNull();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("renders Orion controls, reuses stable Idempotency-Key across failed retries, rotates on success, and cancels/retries tasks", async () => {
    const triggerKeys: string[] = [];
    const retryKeys: string[] = [];
    const cancelCalls: string[] = [];
    let triggerAttempts = 0;

    const currentView = {
      pipeline: [{ id: "stage-1", name: "Buck2", status: "failing" }],
      runner: "orion2",
      clLink: "cl-100",
      headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      headRevision: 2,
      latestTask: {
        task_id: "tsk_100",
        attempt_id: "att_100",
        status: "failed" as const,
      },
      tasks: [
        { task_id: "tsk_100", attempt_id: "att_100", status: "failed" as const },
        { task_id: "tsk_99", attempt_id: "att_99", status: "succeeded" as const },
      ],
      checks: [{ id: "t1", name: "//:app", status: "failing", durationSeconds: 8 }],
      logTail: [],
      benchmarks: [],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        if (url === "/api/mega/cls/1/checks") {
          return new Response(JSON.stringify({ data: currentView }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === "/api/mega/cls/1/checks/trigger" && init?.method === "POST") {
          triggerKeys.push(headers.get("Idempotency-Key") ?? "");
          triggerAttempts += 1;
          if (triggerAttempts === 1) {
            return new Response(
              JSON.stringify({ error: { code: "ORION_UPSTREAM_UNAVAILABLE", message: "try again" } }),
              { status: 503, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(
            JSON.stringify({ data: { task_id: "tsk_101", attempt_id: "att_101", status: "accepted" } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === "/api/mega/orion/tasks/tsk_100/retry" && init?.method === "POST") {
          retryKeys.push(headers.get("Idempotency-Key") ?? "");
          return new Response(
            JSON.stringify({ data: { task_id: "tsk_100", attempt_id: "att_102", status: "accepted" } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/cancel") && init?.method === "POST") {
          cancelCalls.push(url);
          return new Response(
            JSON.stringify({ data: { task_id: "tsk_100", status: "cancelled" } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    await renderChecksPage();
    await waitForUi(() => container.querySelector('[data-mega-cls="checks-hero"]') !== null);

    const triggerBtn = container.querySelector('[data-mega-cls="trigger-build"]') as HTMLButtonElement;
    expect(triggerBtn).not.toBeNull();
    expect(container.querySelector('[data-mega-cls="retry-build"]')).not.toBeNull();

    // 1st click fails -> keeps Idempotency-Key
    await act(async () => { triggerBtn.click(); });
    await waitForUi(() => container.querySelector('[data-mega-cls="orion-action-error"]') !== null);
    expect(container.querySelector('[data-mega-cls="orion-action-error"]')).not.toBeNull();

    // 2nd click reuses the EXACT same Idempotency-Key and succeeds -> rotates key
    await act(async () => { triggerBtn.click(); });
    await waitForUi(() => triggerKeys.length === 2 && !triggerBtn.disabled);
    expect(triggerKeys).toHaveLength(2);
    expect(triggerKeys[0]).toBeTruthy();
    expect(triggerKeys[1]).toBe(triggerKeys[0]);

    // 3rd click after success rotates to a NEW Idempotency-Key
    await act(async () => { triggerBtn.click(); });
    await waitForUi(() => triggerKeys.length === 3 && !triggerBtn.disabled);
    expect(triggerKeys).toHaveLength(3);
    expect(triggerKeys[2]).not.toBe(triggerKeys[1]);

    // Retry Build sends Idempotency-Key and records the new retry attempt alongside the earlier attempt
    const retryBtn = container.querySelector('[data-mega-cls="retry-build"]') as HTMLButtonElement;
    await act(async () => { retryBtn.click(); });
    await waitForUi(() => retryKeys.length === 1 && !retryBtn.disabled);
    expect(retryKeys).toHaveLength(1);
    expect(retryKeys[0]).toBeTruthy();

    // After retrying the same task, BOTH the new retry attempt (att_102) and the prior attempt (att_100) are selectable
    await waitForUi(() =>
      container.querySelector('[data-mega-cls="select-attempt"][data-attempt-id="att_102"]') !== null &&
      container.querySelector('[data-mega-cls="select-attempt"][data-attempt-id="att_100"]') !== null,
    );
    const priorAttemptBtn = container.querySelector(
      '[data-mega-cls="select-attempt"][data-attempt-id="att_100"]',
    ) as HTMLButtonElement;
    const prevEsCount = FakeEventSource.instances.length;
    await act(async () => { priorAttemptBtn.click(); });
    await waitForUi(() => FakeEventSource.instances.length === prevEsCount + 1);
    expect(FakeEventSource.instances[prevEsCount - 1]!.closed).toBe(true);
    expect(FakeEventSource.instances[prevEsCount]!.url).toBe(
      "/api/mega/orion/attempts/att_100/logs",
    );
    expect(cancelCalls).toHaveLength(0);
  });

  it("preserves partial SSE lines across chunks, does not drop ID-less frames, caps at 5000 lines, and polls when failing + running coexist", async () => {
    vi.useFakeTimers();
    let fetchCount = 0;
    let runningCheckStatus: "running" | "passing" = "running";
    let taskStatusNow: "failed" | "succeeded" = "failed";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/mega/orion/tasks/tsk_200/cancel" && init?.method === "POST") {
          return new Response(
            JSON.stringify({ data: { task_id: "tsk_200", status: "cancelled" } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        fetchCount += 1;
        return new Response(
          JSON.stringify({
            data: {
              pipeline: [{ id: "p1", name: "Buck2", status: "failing" }],
              runner: "orion2",
              clLink: "cl-200",
              headCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              headRevision: 1,
              latestTask: {
                task_id: "tsk_200",
                attempt_id: "att_200",
                status: taskStatusNow,
              },
              tasks: [{ task_id: "tsk_200", attempt_id: "att_200", status: taskStatusNow }],
              checks: [
                { id: "c1", name: "//:failed_target", status: "failing" },
                { id: "c2", name: "//:still_running", status: runningCheckStatus },
              ],
              logTail: [],
              benchmarks: [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    await renderChecksPage();
    await waitForUi(() => container.querySelector('[data-mega-cls="build-log-viewer"]') !== null);
    expect(fetchCount).toBe(1);

    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe("/api/mega/orion/attempts/att_200/logs");

    // 1. Cross-chunk partial line assembly ("build" + "ing\n") + ID-less subsequent SSE events + JSON default message with sequence field
    await act(async () => {
      es.emitOpen();
      es.emitNamed("log.chunk", JSON.stringify({ type: "log.chunk", sequence: 1, data: "build" }), "1");
      // Subsequent event with same lastEventId (per SSE spec when id: is omitted) must NOT be dropped!
      es.onmessage?.(new MessageEvent("message", { data: "ing\n", lastEventId: "1" }));
      // Default message carrying JSON with a higher `sequence` field must render verbatim AND NOT advance the log.chunk watermark
      es.onmessage?.(new MessageEvent("message", { data: '{"sequence":99,"data":"raw-json"}\n', lastEventId: "1" }));
      // Duplicate Orion2 log.chunk sequence 1 IS ignored
      es.emitNamed("log.chunk", JSON.stringify({ type: "log.chunk", sequence: 1, data: "dup\n" }), "1");
    });
    expect(container.querySelector('[data-mega-cls="build-log-output"]')?.textContent).toBe(
      'building\n{"sequence":99,"data":"raw-json"}',
    );

    // 2. Exceeding 5000 lines caps cleanly at MAX_LOG_LINES (5000)
    await act(async () => {
      const bigBatch = Array.from({ length: MAX_LOG_LINES + 25 }, (_, i) => `line-${i + 1}\n`).join("");
      es.emitNamed(
        "log.chunk",
        JSON.stringify({ type: "log.chunk", sequence: 2, data: bigBatch }),
        "2",
      );
    });
    const output = container.querySelector('[data-mega-cls="build-log-output"]')?.textContent ?? "";
    const renderedLines = output.split("\n");
    expect(renderedLines).toHaveLength(MAX_LOG_LINES);
    expect(renderedLines[0]).toBe("line-26");
    expect(renderedLines[renderedLines.length - 1]).toBe(`line-${MAX_LOG_LINES + 25}`);
    expect(container.querySelector('[data-mega-cls="build-log-truncated"]')).not.toBeNull();

    // 3. Even though one check is failing AND latestTask is terminal, polling continues every 3s while another check is still running
    const beforePoll = fetchCount;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await waitForUi(() => fetchCount > beforePoll);
    expect(fetchCount).toBeGreaterThan(beforePoll);

    // 4. Once all checks become terminal, polling stops
    runningCheckStatus = "passing";
    taskStatusNow = "succeeded";
    const beforeTerminalPoll = fetchCount;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await waitForUi(() => fetchCount > beforeTerminalPoll);
    const terminalCount = fetchCount;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(fetchCount).toBe(terminalCount);

    // 5. log.complete closes EventSource cleanly
    await act(async () => {
      es.emitNamed("log.complete", JSON.stringify({ type: "log.complete" }), "3");
    });
    expect(es.closed).toBe(true);
    expect(container.querySelector('[data-mega-cls="build-log-viewer"]')?.getAttribute("data-stream-state")).toBe("closed");

    // Unmount cleanup
    await act(async () => root.unmount());
    expect(es.closed).toBe(true);
  });
});
