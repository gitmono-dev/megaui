// megaui:apps/next-app/app/[lang]/workspace/cls/[n]/layout.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-09+WA-10): five chrome tabs; merge sidebar only
// on the conversation route.
"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode } from "react";

import type { CL, CLComment, InlineComment } from "@megaui/core";
import { MegaApiError, megaGet, megaPost, megaQueryKeys } from "@megaui/ui/query";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";
import { authClient } from "@/lib/auth-client";

import { MergeBox } from "../components/merge-box";

export default function CLDetailLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ n: string }>();
  const pathname = usePathname() ?? "";
  const { locale, t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();
  const workspaceBase = `/${locale}/workspace`;
  const detail = t.workspace.clDetail;
  const clNumber = Number(params?.n);
  const validNumber = Number.isInteger(clNumber) && clNumber > 0;
  const baseHref = `${workspaceBase}/cls/${clNumber}`;
  const isConversation =
    pathname === baseHref || pathname === `${baseHref}/` || !pathname.slice(baseHref.length).replace(/^\//, "");

  const tabs = [
    { href: baseHref, id: "conversation", label: detail.chrome.tabs.conversation },
    { href: `${baseHref}/files`, id: "files", label: detail.chrome.tabs.files },
    { href: `${baseHref}/revisions`, id: "revisions", label: detail.chrome.tabs.revisions },
    { href: `${baseHref}/checks`, id: "checks", label: detail.chrome.tabs.checks },
    { href: `${baseHref}/deps`, id: "deps", label: detail.chrome.tabs.deps },
  ] as const;

  const clQuery = useQuery({
    queryKey: megaQueryKeys.cl(clNumber),
    queryFn: () => megaGet<CL>(["cls", String(clNumber)]),
    enabled: validNumber,
    retry: (failureCount, error) => !(error instanceof MegaApiError && error.status === 404) && failureCount < 2,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || data.state === "merged" || data.state === "closed") return false;
      return data.ci === "queued" || data.ci === "running" ? 3000 : 10000;
    },
  });
  const commentsQuery = useQuery({
    queryKey: megaQueryKeys.clComments(clNumber),
    queryFn: () => megaGet<CLComment[]>(["cls", String(clNumber), "comments"]),
    enabled: validNumber && Boolean(clQuery.data) && isConversation,
  });
  const inlineQuery = useQuery({
    queryKey: megaQueryKeys.clInlineComments(clNumber),
    queryFn: () => megaGet<InlineComment[]>(["cls", String(clNumber), "inline-comments"]),
    enabled: validNumber && Boolean(clQuery.data) && isConversation,
  });

  const transitionMutation = useMutation({
    mutationFn: (state: CL["state"]) => megaPost<CL>(["cls", String(clNumber), "transition"], { state }),
    onSuccess: (cl) => {
      queryClient.setQueryData(megaQueryKeys.cl(clNumber), cl);
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.cls() });
    },
  });

  const notFound =
    !validNumber ||
    (!clQuery.data && clQuery.isError && clQuery.error instanceof MegaApiError && clQuery.error.status === 404);

  if (notFound) {
    return (
      <main data-mega-cls="detail">
        <div data-mega-cls="not-found" role="alert" style={{ padding: `calc(${MEGA_SPACING_TOKENS[8]} * 4)` }}>
          <h1 style={{ fontWeight: 700, margin: 0 }}>{detail.notFoundTitle}</h1>
          <p style={{ color: MEGA_TOKENS.muted }}>
            {detail.notFoundBody.replace("{number}", String(params?.n ?? ""))}
          </p>
          <Link href={`${workspaceBase}/cls`}>{detail.backToList}</Link>
        </div>
      </main>
    );
  }

  if (clQuery.isPending) {
    return (
      <main aria-busy="true" data-mega-cls="detail">
        <p style={{ color: MEGA_TOKENS.muted, padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>{detail.loading}</p>
      </main>
    );
  }

  if (!clQuery.data) {
    return (
      <main data-mega-cls="detail">
        <div role="alert" style={{ alignItems: "center", display: "flex", gap: MEGA_SPACING_TOKENS[8], padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>
          <p style={{ margin: 0 }}>{detail.error}</p>
          <button data-mega-cls="retry" onClick={() => void clQuery.refetch()} type="button">
            {detail.retry}
          </button>
        </div>
      </main>
    );
  }

  const cl = clQuery.data;
  const transitionErrorMessage = transitionMutation.isError
    ? transitionMutation.error instanceof Error && transitionMutation.error.message.trim().length > 0
      ? transitionMutation.error.message
      : detail.error
    : null;
  const isMega2Backed = cl.author.id.startsWith("mega2:");
  const isLocalAuthor = Boolean(session?.user?.id && session.user.id === cl.author.id);
  const canTriggerMerge = Boolean(session?.user?.id && (isLocalAuthor || isMega2Backed));
  const canRebase = isLocalAuthor && !isMega2Backed && cl.state === "conflicts";
  const canMergeCi = cl.ci === "passing";
  const mergeTarget: CL["state"] | undefined = !canMergeCi
    ? undefined
    : cl.state === "ready" && cl.merge === "queue-ready"
      ? isMega2Backed
        ? "merged"
        : "queued"
      : cl.state === "queued"
        ? "merged"
        : undefined;
  const checksHref = `${baseHref}/checks`;
  const ciStatusLabel = detail.revisions.card.ciStatuses[cl.ci] ?? cl.ci;

  return (
    <main data-mega-cls="detail">
      <header
        data-mega-cls="chrome"
        style={{
          borderBottom: `1px solid ${MEGA_TOKENS.border}`,
          padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2) calc(${MEGA_SPACING_TOKENS[8]} * 3.5)`,
        }}
      >
        <p style={{ color: MEGA_TOKENS.muted, margin: 0 }}>
          <Link href={`${workspaceBase}/cls`} style={{ color: MEGA_TOKENS.muted, textDecoration: "none" }}>
            {detail.backToList}
          </Link>
        </p>
        <h1 data-mega-cls="detail-title" style={{ fontSize: "1.25rem", fontWeight: 700, margin: `${MEGA_SPACING_TOKENS[6]} 0 0` }}>
          !{cl.number} {cl.title}
        </h1>
        <p style={{ color: MEGA_TOKENS.muted, margin: `${MEGA_SPACING_TOKENS[6]} 0 0` }}>
          {cl.state} · {cl.branch} · {cl.author.displayName} ·{" "}
          <Link
            data-ci={cl.ci}
            data-mega-cls="detail-ci"
            href={checksHref}
            style={{ color: cl.ci === "failing" ? MEGA_TOKENS.danger : MEGA_TOKENS.accent, textDecoration: "none" }}
          >
            {detail.revisions.card.ci.replace("{status}", ciStatusLabel)}
          </Link>
          {isConversation && commentsQuery.data ? ` · ${commentsQuery.data.length} comments` : ""}
          {isConversation && inlineQuery.data ? ` · ${inlineQuery.data.length} inline` : ""}
        </p>
        <nav data-mega-cls="tabs" style={{ display: "flex", flexWrap: "wrap", gap: MEGA_SPACING_TOKENS[8], marginTop: MEGA_SPACING_TOKENS[8] }}>
          {tabs.map((tab) => {
            const active =
              tab.id === "conversation"
                ? isConversation
                : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
            return (
              <Link
                data-mega-cls={active ? "tab-active" : "tab"}
                data-tab={tab.id}
                href={tab.href}
                key={tab.id}
                style={{
                  color: active ? MEGA_TOKENS.text : MEGA_TOKENS.muted,
                  fontWeight: active ? 650 : 400,
                  textDecoration: "none",
                }}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
        {clQuery.isError ? (
          <div
            data-mega-cls="refresh-error"
            role="alert"
            style={{
              alignItems: "center",
              color: MEGA_TOKENS.danger,
              display: "flex",
              gap: MEGA_SPACING_TOKENS[8],
              marginTop: MEGA_SPACING_TOKENS[8],
            }}
          >
            <p style={{ margin: 0 }}>{detail.error}</p>
            <button data-mega-cls="retry" onClick={() => void clQuery.refetch()} type="button">
              {detail.retry}
            </button>
          </div>
        ) : null}
      </header>

      {isConversation ? (
        <div
          style={{
            display: "grid",
            gap: `calc(${MEGA_SPACING_TOKENS[8]} * 2)`,
            gridTemplateColumns: "minmax(0, 1fr) 280px",
            padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2) calc(${MEGA_SPACING_TOKENS[8]} * 3.5)`,
          }}
        >
          <div data-mega-cls="conversation">{children}</div>
          <aside data-mega-cls="sidebar">
            <MergeBox
              checksHref={checksHref}
              cl={cl}
              labels={detail.conversation.mergeBox}
              onMerge={mergeTarget && canTriggerMerge ? () => transitionMutation.mutate(mergeTarget) : undefined}
              onRebase={canRebase ? () => transitionMutation.mutate("ready") : undefined}
              pending={transitionMutation.isPending}
              showActions={canTriggerMerge || canRebase}
            />
            {transitionErrorMessage ? (
              <div
                data-mega-cls="merge-error"
                role="alert"
                style={{
                  color: MEGA_TOKENS.danger,
                  fontSize: "calc(var(--mega-density-font-size) - 1px)",
                  marginTop: MEGA_SPACING_TOKENS[8],
                }}
              >
                {transitionErrorMessage}
              </div>
            ) : null}
          </aside>
        </div>
      ) : (
        <div style={{ padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2) calc(${MEGA_SPACING_TOKENS[8]} * 3.5)` }}>{children}</div>
      )}
    </main>
  );
}
