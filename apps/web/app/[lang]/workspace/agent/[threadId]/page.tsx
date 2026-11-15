// megaui:apps/next-app/.../agent/[threadId]/page.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-15): lean SSE ask UI via ai-elements; no credit
// toast; llm_disabled guide; citations from completed answers; scope deferred.
"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import type { AgentThread } from "@megaui/core";
import { MegaApiError, megaGet, megaPost, megaQueryKeys } from "@megaui/ui/query";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";

import { AgentThreadComposer } from "../components/agent-thread-composer";
import { AgentThreadRail } from "../components/agent-thread-rail";
import { AgentThreadSources } from "../components/agent-thread-sources";
import {
  AgentThreadError,
  AgentThreadLoading,
  AgentThreadNotFound,
} from "../components/agent-thread-state";
import { AgentThreadTranscript } from "../components/agent-thread-transcript";
import { useAgentThreadStream } from "../hooks/use-agent-thread-stream";
import type { AgentThreadListPage } from "../lib/agent-thread-types";

export default function AgentThreadPage() {
  const params = useParams<{ threadId: string }>();
  const router = useRouter();
  const { locale, t } = useTranslation();
  const queryClient = useQueryClient();
  const agentText = t.workspace.agent;
  const sessionText = t.workspace.session;
  const workspaceBase = `/${locale}/workspace`;
  const threadId = decodeURIComponent(params?.threadId ?? "");
  const stream = useAgentThreadStream({
    askError: agentText.askError,
    queryClient,
    streamError: agentText.streamError,
    threadId,
  });
  const threadQuery = useQuery({
    queryKey: megaQueryKeys.agentThread(threadId),
    queryFn: () => megaGet<AgentThread>(["agent", threadId]),
    enabled: Boolean(threadId),
    retry: (count, error) => !(error instanceof MegaApiError && error.status === 404) && count < 2,
  });
  const listQuery = useQuery({
    queryKey: megaQueryKeys.agentThreads(),
    queryFn: () => megaGet<AgentThreadListPage>("agent"),
  });
  const createMutation = useMutation({
    mutationFn: () => megaPost<AgentThread>("agent", { title: agentText.rail.untitled }),
    onSuccess: (thread) => {
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.agentThreads() });
      router.push(`${workspaceBase}/agent/${encodeURIComponent(thread.id)}`);
    },
  });

  const messages = (threadQuery.data?.messages ?? []).filter(
    (message) => message.id !== stream.streamingAnswerId,
  );
  const citations = useMemo(() => {
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    return lastAssistant?.citations ?? [];
  }, [messages]);
  const notFound =
    !threadId ||
    (threadQuery.isError &&
      threadQuery.error instanceof MegaApiError &&
      threadQuery.error.status === 404);

  if (notFound) {
    return (
      <AgentThreadNotFound
        label={agentText.notFound}
        newThreadLabel={agentText.rail.newThread}
        workspaceBase={workspaceBase}
      />
    );
  }
  if (threadQuery.isPending) {
    return <AgentThreadLoading label={agentText.loading} />;
  }
  if (threadQuery.isError) {
    return (
      <AgentThreadError
        label={agentText.notFound}
        onRetry={() => void threadQuery.refetch()}
        retryLabel={agentText.retry}
      />
    );
  }
  if (!threadQuery.data) {
    return <AgentThreadLoading label={agentText.loading} />;
  }

  const thread = threadQuery.data;
  const busy =
    stream.askMutation.isPending ||
    stream.regenerateMutation.isPending ||
    stream.streamingText !== null;

  return (
    <main
      data-mega-agent="thread"
      style={{
        display: "flex",
        gap: MEGA_SPACING_TOKENS[8],
        height: "100%",
        minHeight: 480,
        padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2)`,
      }}
    >
      <AgentThreadRail
        activeThreadId={threadId}
        ariaLabel={agentText.rail.railAriaLabel}
        isCreating={createMutation.isPending}
        newThreadLabel={agentText.rail.newThread}
        onCreate={() => createMutation.mutate()}
        recentLabel={agentText.rail.recent}
        threads={listQuery.data?.items ?? []}
        untitledLabel={agentText.rail.untitled}
        workspaceBase={workspaceBase}
      />
      <section style={{ display: "flex", flex: 1, flexDirection: "column", minWidth: 0 }}>
        {stream.toast ? (
          <div
            data-mega-agent="toast"
            role="status"
            style={{
              background: MEGA_TOKENS.danger,
              borderRadius: MEGA_RADIUS_TOKENS.md,
              color: MEGA_TOKENS.accentForeground,
              marginBottom: MEGA_SPACING_TOKENS[8],
              padding: MEGA_SPACING_TOKENS[8],
            }}
          >
            {stream.toast}
          </div>
        ) : null}
        <header
          style={{
            borderBottom: `1px solid ${MEGA_TOKENS.border}`,
            marginBottom: MEGA_SPACING_TOKENS[8],
            paddingBottom: MEGA_SPACING_TOKENS[8],
          }}
        >
          <h1 data-mega-agent="title" style={{ fontSize: "1.2rem", fontWeight: 700, margin: 0 }}>
            {thread.title || agentText.header.title}
          </h1>
          <Link data-mega-agent="open-session" href={`${workspaceBase}/sessions/sess_demo`}>
            {sessionText.rail.sectionRunUsage}
          </Link>
        </header>
        {stream.llmDisabled ? (
          <div
            data-mega-agent="llm-disabled"
            role="status"
            style={{
              border: `1px solid ${MEGA_TOKENS.border}`,
              borderRadius: MEGA_RADIUS_TOKENS.md,
              marginBottom: MEGA_SPACING_TOKENS[8],
              padding: MEGA_SPACING_TOKENS[8],
            }}
          >
            <strong>{agentText.llmDisabledTitle}</strong>
            <p style={{ marginBottom: 0 }}>{agentText.llmDisabledBody}</p>
          </div>
        ) : null}
        <AgentThreadTranscript
          citationsLabel={agentText.sources.sectionCitations}
          messages={messages}
          streamingText={stream.streamingText}
        />
        <AgentThreadComposer
          busy={busy}
          draft={stream.draft}
          inputAriaLabel={agentText.composer.inputAriaLabel}
          messages={messages}
          onDraftChange={stream.setDraft}
          onRegenerate={(messageId) => stream.regenerateMutation.mutate(messageId)}
          onSubmit={(message) => {
            stream.setDraft("");
            stream.setToast(null);
            stream.askMutation.mutate(message);
          }}
          placeholder={agentText.composer.placeholder}
          regenerateLabel={agentText.answer.regenerate}
          sendLabel={agentText.composer.sendAriaLabel}
        />
      </section>
      <AgentThreadSources
        citations={citations}
        citationsLabel={agentText.sources.sectionCitations}
        emptyLabel={agentText.sources.noCitations}
        panelAriaLabel={agentText.sources.panelAriaLabel}
        scopeHint={agentText.sources.scopeHint}
        scopeLabel={agentText.sources.sectionScope}
      />
    </main>
  );
}
