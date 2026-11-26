"use client";

import { useEffect, useRef, useState } from "react";

import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

export const MAX_LOG_LINES = 5000;

export interface BuildLogViewerLabels {
  readonly title: string;
  readonly connecting: string;
  readonly streaming: string;
  readonly closed: string;
  readonly error: string;
  readonly empty: string;
  readonly truncated: string;
}

type StreamState = "connecting" | "streaming" | "closed" | "error";

interface ParsedSsePayload {
  readonly text: string;
  readonly sequence?: number;
}

interface LogBufferState {
  readonly completedLines: readonly string[];
  readonly partialLine: string;
  readonly truncated: boolean;
}

const EMPTY_LOG_BUFFER: LogBufferState = {
  completedLines: [],
  partialLine: "",
  truncated: false,
};

function parseSseChunkPayload(rawData: string, isLogChunkEvent: boolean): ParsedSsePayload {
  if (isLogChunkEvent && rawData.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(rawData);
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        if (record.type === "log.chunk" && typeof record.data === "string") {
          const sequence =
            typeof record.sequence === "number" &&
            Number.isSafeInteger(record.sequence) &&
            record.sequence > 0
              ? record.sequence
              : undefined;
          return { text: record.data, sequence };
        }
      }
    } catch {
      // Non-JSON payload; render verbatim.
    }
  }
  return { text: rawData };
}

function appendChunkToLogBuffer(prev: LogBufferState, rawText: string): LogBufferState {
  if (rawText.length === 0) return prev;
  const normalized = rawText.replace(/\r\n/g, "\n");
  const combined = prev.partialLine + normalized;
  const parts = combined.split("\n");
  const nextPartial = parts.pop() ?? "";
  let nextCompleted = parts.length > 0 ? prev.completedLines.concat(parts) : prev.completedLines;
  let truncated = prev.truncated;

  const maxCompleted = nextPartial.length > 0 ? MAX_LOG_LINES - 1 : MAX_LOG_LINES;
  if (nextCompleted.length > maxCompleted) {
    nextCompleted = nextCompleted.slice(nextCompleted.length - maxCompleted);
    truncated = true;
  }

  return {
    completedLines: nextCompleted,
    partialLine: nextPartial,
    truncated,
  };
}

/**
 * Live Buck2 build log viewer (`CLB-33`):
 * Connects via same-origin `EventSource('/api/mega/orion/attempts/<attemptId>/logs')`,
 * handles both Orion2 `log.chunk`/`log.complete` and default SSE events, preserves
 * cross-chunk partial lines until newline arrival, caps output at `MAX_LOG_LINES` (5000)
 * to prevent DOM OOM, and closes cleanly on unmount or attempt switch (`GC-09`).
 */
export function BuildLogViewer({
  attemptId,
  labels,
}: {
  readonly attemptId: string;
  readonly labels: BuildLogViewerLabels;
}) {
  const [buffer, setBuffer] = useState<LogBufferState>(EMPTY_LOG_BUFFER);
  const [streamState, setStreamState] = useState<StreamState>("connecting");
  const highestSequenceRef = useRef<number>(0);

  useEffect(() => {
    setBuffer(EMPTY_LOG_BUFFER);
    setStreamState("connecting");
    highestSequenceRef.current = 0;

    if (typeof EventSource === "undefined" || !attemptId) {
      setStreamState("closed");
      return;
    }

    const url = `/api/mega/orion/attempts/${encodeURIComponent(attemptId)}/logs`;
    const eventSource = new EventSource(url);
    let closedByComplete = false;

    const appendEvent = (event: MessageEvent<unknown>) => {
      const isLogChunkEvent = event.type === "log.chunk";
      const parsed = parseSseChunkPayload(String(event.data ?? ""), isLogChunkEvent);
      // Deduplicate only structured Orion2 `log.chunk` events by strictly monotonic
      // `sequence`; default `message` events never interact with the sequence watermark.
      if (isLogChunkEvent && parsed.sequence !== undefined) {
        if (parsed.sequence <= highestSequenceRef.current) {
          return;
        }
        highestSequenceRef.current = parsed.sequence;
      }
      if (parsed.text.length === 0) return;
      setStreamState("streaming");
      setBuffer((prev) => appendChunkToLogBuffer(prev, parsed.text));
    };

    const handleComplete = () => {
      closedByComplete = true;
      setStreamState("closed");
      eventSource.close();
    };

    eventSource.onopen = () => {
      if (!closedByComplete) {
        setStreamState("streaming");
      }
    };
    eventSource.onmessage = appendEvent;
    eventSource.addEventListener("log.chunk", appendEvent as EventListener);
    eventSource.addEventListener("log.complete", handleComplete);
    eventSource.onerror = () => {
      if (closedByComplete) return;
      if (eventSource.readyState === EventSource.CLOSED) {
        setStreamState("closed");
      } else {
        setStreamState("error");
      }
    };

    return () => {
      eventSource.removeEventListener("log.chunk", appendEvent as EventListener);
      eventSource.removeEventListener("log.complete", handleComplete);
      eventSource.close();
    };
  }, [attemptId]);

  const statusLabel =
    streamState === "streaming"
      ? labels.streaming
      : streamState === "closed"
        ? labels.closed
        : streamState === "error"
          ? labels.error
          : labels.connecting;

  const visibleLines =
    buffer.partialLine.length > 0
      ? buffer.completedLines.concat(buffer.partialLine)
      : buffer.completedLines;

  return (
    <section
      data-attempt-id={attemptId}
      data-mega-cls="build-log-viewer"
      data-stream-state={streamState}
      style={{
        border: `1px solid ${MEGA_TOKENS.border}`,
        borderRadius: MEGA_RADIUS_TOKENS.md,
        padding: `calc(${MEGA_SPACING_TOKENS[8]} * 1.5)`,
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          gap: MEGA_SPACING_TOKENS[8],
          justifyContent: "space-between",
        }}
      >
        <h3 style={{ fontSize: "0.95rem", fontWeight: 650, margin: 0 }}>{labels.title}</h3>
        <span data-mega-cls="build-log-status" style={{ color: MEGA_TOKENS.muted }}>
          {statusLabel}
        </span>
      </div>
      {buffer.truncated ? (
        <p data-mega-cls="build-log-truncated" style={{ color: MEGA_TOKENS.muted, margin: `${MEGA_SPACING_TOKENS[6]} 0 0` }}>
          {labels.truncated.replace("{limit}", String(MAX_LOG_LINES))}
        </p>
      ) : null}
      <pre
        data-mega-cls="build-log-output"
        style={{
          background: MEGA_TOKENS.subtle,
          borderRadius: MEGA_RADIUS_TOKENS.sm,
          margin: `${MEGA_SPACING_TOKENS[8]} 0 0`,
          maxHeight: "360px",
          overflow: "auto",
          padding: MEGA_SPACING_TOKENS[8],
          whiteSpace: "pre-wrap",
        }}
      >
        {visibleLines.length === 0 ? labels.empty : visibleLines.join("\n")}
      </pre>
    </section>
  );
}
