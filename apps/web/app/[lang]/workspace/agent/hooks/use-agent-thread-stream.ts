import { useMutation, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { megaQueryKeys } from "@megaui/ui/query";

import {
  postAgentAsk,
  postAgentRegenerate,
  type AgentClientStreamEvent,
} from "../lib/agent-ask-client";

interface UseAgentThreadStreamOptions {
  readonly askError: string;
  readonly queryClient: QueryClient;
  readonly streamError: string;
  readonly threadId: string;
}

export function useAgentThreadStream({
  askError,
  queryClient,
  streamError,
  threadId,
}: UseAgentThreadStreamOptions) {
  const [draft, setDraft] = useState("");
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [streamingAnswerId, setStreamingAnswerId] = useState<string | null>(null);
  const [llmDisabled, setLlmDisabled] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const activeThreadRef = useRef(threadId);
  activeThreadRef.current = threadId;

  useEffect(() => {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    setDraft("");
    setStreamingText(null);
    setStreamingAnswerId(null);
    setLlmDisabled(false);
    setToast(null);
  }, [threadId]);

  const applyStreamEvent = (event: AgentClientStreamEvent, forThreadId: string) => {
    const isActive = activeThreadRef.current === forThreadId;

    switch (event.type) {
      case "start":
        if (!isActive) return;
        setStreamingText("");
        setStreamingAnswerId(event.answer.id);
        setLlmDisabled(false);
        if (event.thread) {
          queryClient.setQueryData(megaQueryKeys.agentThread(forThreadId), {
            ...event.thread,
            messages: event.thread.messages.filter((message) => message.id !== event.answer.id),
          });
        }
        return;
      case "delta":
        if (isActive) setStreamingText((current) => `${current ?? ""}${event.text}`);
        return;
      case "done":
        queryClient.setQueryData(megaQueryKeys.agentThread(forThreadId), event.thread);
        void queryClient.invalidateQueries({ queryKey: megaQueryKeys.agentThreads() });
        if (isActive) {
          setStreamingText(null);
          setStreamingAnswerId(null);
        }
        return;
      case "llm_disabled":
        queryClient.setQueryData(megaQueryKeys.agentThread(forThreadId), event.thread);
        if (isActive) {
          setStreamingText(null);
          setStreamingAnswerId(null);
          setLlmDisabled(true);
        }
        return;
      case "error":
        if (isActive) {
          setStreamingText(null);
          setStreamingAnswerId(null);
          setToast(event.message || streamError);
        }
        return;
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  };

  const beginStream = () => {
    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;
    return { controller, threadId };
  };

  const clearActiveStreamAfterError = (error: unknown) => {
    if (error instanceof DOMException && error.name === "AbortError") return;
    if (activeThreadRef.current !== threadId) return;
    setStreamingText(null);
    setStreamingAnswerId(null);
    setToast(askError);
  };

  const askMutation = useMutation({
    mutationFn: (message: string) => {
      const stream = beginStream();
      return postAgentAsk({
        threadId: stream.threadId,
        message,
        signal: stream.controller.signal,
        onEvent: (event) => applyStreamEvent(event, stream.threadId),
      });
    },
    onError: clearActiveStreamAfterError,
  });

  const regenerateMutation = useMutation({
    mutationFn: (messageId?: string) => {
      const stream = beginStream();
      return postAgentRegenerate({
        threadId: stream.threadId,
        messageId,
        signal: stream.controller.signal,
        onEvent: (event) => applyStreamEvent(event, stream.threadId),
      });
    },
    onError: clearActiveStreamAfterError,
  });

  return {
    askMutation,
    draft,
    llmDisabled,
    regenerateMutation,
    setDraft,
    setToast,
    streamingAnswerId,
    streamingText,
    toast,
  };
}
