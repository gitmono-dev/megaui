// megaui:apps/next-app/.../sessions/[threadId]/page.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-15): fixture-backed session view (usage,
// decisions, evidence, citation links); no libra object graph.
"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { MessageCitations, MessageUsage } from "@megaui/ui/ai-elements";
import { MegaApiError, megaGet } from "@megaui/ui/query";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import type { SessionFixture } from "@/lib/adapter/session-types";
import { useTranslation } from "@/hooks/use-translation";

export default function SessionPage() {
  const params = useParams<{ threadId: string }>();
  const { locale, t } = useTranslation();
  const sessionText = t.workspace.session;
  const workspaceBase = `/${locale}/workspace`;
  const sessionId = decodeURIComponent(params?.threadId ?? "");

  const sessionQuery = useQuery({
    queryKey: ["mega", "sessions", sessionId] as const,
    queryFn: () => megaGet<SessionFixture>(["sessions", sessionId]),
    enabled: Boolean(sessionId),
    retry: (count, error) => !(error instanceof MegaApiError && error.status === 404) && count < 2,
  });

  if (!sessionId || (sessionQuery.isError && sessionQuery.error instanceof MegaApiError && sessionQuery.error.status === 404)) {
    return (
      <main data-mega-session="page">
        <div data-mega-session="not-found" role="alert" style={{ padding: `calc(${MEGA_SPACING_TOKENS[8]} * 4)` }}>
          <h1 style={{ fontWeight: 700, margin: 0 }}>{sessionText.notFound}</h1>
          <Link href={`${workspaceBase}/agent`}>{t.workspace.nav.items.agent}</Link>
        </div>
      </main>
    );
  }

  if (sessionQuery.isPending) {
    return (
      <main aria-busy="true" data-mega-session="page">
        <p style={{ color: MEGA_TOKENS.muted, padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>{sessionText.loading}</p>
      </main>
    );
  }

  if (sessionQuery.isError) {
    return (
      <main data-mega-session="page">
        <div role="alert" style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8], padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>
          <p style={{ margin: 0 }}>{sessionText.notFound}</p>
          <button data-mega-session="retry" onClick={() => void sessionQuery.refetch()} type="button">
            {sessionText.retry}
          </button>
        </div>
      </main>
    );
  }

  const session = sessionQuery.data!;

  return (
    <main data-mega-session="page" style={{ padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>
      <header style={{ borderBottom: `1px solid ${MEGA_TOKENS.border}`, marginBottom: MEGA_SPACING_TOKENS[8], paddingBottom: MEGA_SPACING_TOKENS[8] }}>
        <h1 data-mega-session="title" style={{ fontSize: "1.3rem", fontWeight: 700, margin: 0 }}>
          {session.title}
        </h1>
        <p data-mega-session="status" data-status={session.status} style={{ color: MEGA_TOKENS.muted, margin: 0 }}>
          {session.status === "completed" ? sessionText.header.completed : sessionText.header.running}
        </p>
        <p style={{ color: MEGA_TOKENS.muted }}>{session.threadRef}</p>
      </header>

      <section data-mega-session="usage">
        <h2>{sessionText.rail.sectionRunUsage}</h2>
        <MessageUsage
          items={[
            { label: "input", value: String(session.usage.inputTokens) },
            { label: "output", value: String(session.usage.outputTokens) },
            { label: "total", value: String(session.usage.totalTokens) },
            { label: "latencyMs", value: String(session.usage.latencyMs) },
          ]}
        />
      </section>

      <section data-mega-session="decisions">
        <h2>{sessionText.rail.sectionDecision}</h2>
        <ul>
          {session.decisions.map((decision) => (
            <li data-mega-session="decision" key={decision.id}>
              <strong>{decision.label}</strong>
              <p style={{ margin: 0 }}>{decision.rationale}</p>
            </li>
          ))}
        </ul>
      </section>

      <section data-mega-session="evidence">
        <h2>{sessionText.rail.sectionEvidence}</h2>
        <ul>
          {session.evidence.map((item) => (
            <li key={item.id}>
              <Link data-mega-session="evidence-link" href={item.href}>
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section data-mega-session="citations">
        <h2>{t.workspace.agent.sources.sectionCitations}</h2>
        <MessageCitations citations={session.citations} label={t.workspace.agent.sources.sectionCitations} />
      </section>
    </main>
  );
}
