// megaui:apps/next-app/app/[lang]/workspace/cls/[n]/layout.tsx@0ff3a9d
// Overview layout reference: GitHub's 2026-11-19 pull request overview preview.
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight, Check, ChevronRight, ClipboardCheck, FileDiff, Folder, GitBranch,
  GitPullRequest, History, LayoutList, Network, UsersRound,
} from "lucide-react";
import type { ReactNode } from "react";

import type { CL } from "@megaui/core";
import { MegaApiError, megaPost, megaQueryKeys } from "@megaui/ui/query";
import { ShellAvatar } from "@megaui/ui/shell";

import { useTranslation } from "@/hooks/use-translation";
import { authClient } from "@/lib/auth-client";

import { MergeBox } from "../components/merge-box";
import { presentCLAuthor } from "./cl-author";
import { CLRouteProvider, useCLDetailRoute } from "./cl-route";
import styles from "./cl-detail.module.css";

export default function CLDetailLayout({ children }: { children: ReactNode }) {
  const { clQuery, routeId, validRoute, baseHref } = useCLDetailRoute();
  const pathname = usePathname() ?? "";
  const { locale, t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();
  const listHref = `/${locale}/workspace/cls`;
  const detail = t.workspace.clDetail;
  const side = detail.conversation.sidebar;
  const cl = clQuery.data;

  const transition = useMutation({
    mutationFn: ({ number, state }: Pick<CL, "number" | "state">) =>
      megaPost<CL>(["cls", String(number), "transition"], { state }),
    onSuccess: (updated) => {
      queryClient.setQueryData(megaQueryKeys.clOverview(updated.publicId), updated);
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.cls() });
    },
  });

  if (!validRoute || (!cl && clQuery.error instanceof MegaApiError && clQuery.error.status === 404)) {
    return (
      <main className={styles.notice} data-mega-cls="detail">
        <div data-mega-cls="not-found" role="alert">
          <h1>{detail.notFoundTitle}</h1>
          <p>{detail.notFoundBody.replace("{id}", routeId)}</p>
          <Link href={listHref}>{detail.backToList}</Link>
        </div>
      </main>
    );
  }

  if (clQuery.isPending) {
    return <main aria-busy="true" className={styles.notice} data-mega-cls="detail"><p role="status">{detail.loading}</p></main>;
  }

  const retryNotice = (
    <div className={styles.error} data-mega-cls={cl ? "refresh-error" : "error"} role="alert">
      {detail.error}
      <button data-mega-cls="retry" onClick={() => void clQuery.refetch()} type="button">{detail.retry}</button>
    </div>
  );
  if (!cl) return <main className={styles.notice} data-mega-cls="detail">{retryNotice}</main>;

  // Keep the current tab active while a numeric bookmark is being canonicalized.
  const routeBase = `${listHref}/${routeId}`;
  const activeTab = pathname.slice(routeBase.length).split("/").filter(Boolean)[0] ?? "conversation";
  const isOverview = activeTab === "conversation";
  const checksHref = `${baseHref}/checks`;
  const tabs = [
    { id: "conversation", icon: LayoutList, href: baseHref },
    { id: "files", icon: FileDiff, href: `${baseHref}/files`, count: cl.files.length },
    { id: "revisions", icon: History, href: `${baseHref}/revisions`, count: cl.revisions.length },
    { id: "checks", icon: ClipboardCheck, href: checksHref },
    { id: "deps", icon: Network, href: `${baseHref}/deps` },
  ] as const;

  const isMega2Backed = cl.author.id.startsWith("mega2:");
  const isLocalAuthor = Boolean(session?.user?.id && session.user.id === cl.author.id);
  const canTriggerMerge = Boolean(session?.user?.id && (isLocalAuthor || isMega2Backed));
  const canRebase = isLocalAuthor && !isMega2Backed && cl.state === "conflicts";
  const mergeTarget: CL["state"] | undefined = cl.state === "ready" && cl.merge === "queue-ready"
      ? isMega2Backed ? "merged" : "queued"
      : cl.state === "queued" ? "merged" : undefined;

  const author = presentCLAuthor(cl.author, session?.user);
  const stateLabel = isMega2Backed && cl.state === "ready"
    ? t.workspace.clsList.scopes.open
    : t.workspace.clsList.row.states[cl.state];
  const target = "baseBranch" in cl && typeof cl.baseBranch === "string" ? cl.baseBranch : undefined;
  const repoPath = "repoPath" in cl && typeof cl.repoPath === "string" ? cl.repoPath : undefined;
  const opened = new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(cl.createdAt));
  const ciLabel = detail.revisions.card.ciStatuses[cl.ci];
  return (
    <main className={styles.page} data-mega-cls="detail">
      <div className={styles.frame} data-files-review={activeTab === "files" || undefined}>
        <header className={styles.header} data-mega-cls="chrome">
          <div className={styles.breadcrumb}>
            <Link href={listHref}><GitPullRequest size={15} aria-hidden="true" />{detail.chrome.breadcrumbCls}</Link>
            <ChevronRight size={13} aria-hidden="true" />
            <span>{repoPath || cl.packageId}</span>
          </div>
          <h1 className={styles.title} data-mega-cls="detail-title">
            {cl.title} <span className={styles.publicId}>{cl.publicId}</span>
          </h1>
          <div className={styles.meta}>
            <span className={styles.state} data-state={cl.state}><GitPullRequest size={14} aria-hidden="true" />{stateLabel}</span>
            <strong>{author.displayName || author.username}</strong>
            <time dateTime={cl.createdAt}>{t.workspace.clsList.row.openedOn.replace("{date}", opened)}</time>
            {(cl.branch || target) && (
              <span className={styles.branchPair}>
                {cl.branch && <span className={styles.ref} title={detail.chrome.sourceBranch}><GitBranch size={13} aria-hidden="true" /><bdi>{cl.branch}</bdi></span>}
                {cl.branch && target && <ArrowRight size={14} aria-label={detail.chrome.intoBranch} />}
                {target && <span className={styles.ref} title={detail.chrome.targetBranch}><bdi>{target}</bdi></span>}
              </span>
            )}
          </div>
        </header>

        <nav aria-label={detail.chrome.navigation} className={styles.tabs} data-mega-cls="tabs">
          {tabs.map(({ id, href, icon: Icon, ...tab }) => (
            <Link
              aria-current={activeTab === id ? "page" : undefined}
              data-mega-cls={activeTab === id ? "tab-active" : "tab"}
              data-tab={id} href={href} key={id}
            >
              <Icon size={16} aria-hidden="true" />{detail.chrome.tabs[id]}
              {"count" in tab && <span className={styles.count}>{tab.count}</span>}
            </Link>
          ))}
        </nav>
        {clQuery.isError && retryNotice}

        <CLRouteProvider key={cl.publicId} value={cl}>
          {isOverview ? (
            <div className={styles.columns}>
              <div className={styles.primary} data-mega-cls="conversation">
                <MergeBox
                  checksHref={checksHref}
                  cl={cl}
                  labels={detail.conversation.mergeBox}
                  onMerge={mergeTarget && canTriggerMerge ? () => transition.mutate({ number: cl.number, state: mergeTarget }) : undefined}
                  onRebase={canRebase ? () => transition.mutate({ number: cl.number, state: "ready" }) : undefined}
                  pending={transition.isPending}
                  showActions={canTriggerMerge || canRebase}
                />
                {transition.isError && (
                  <div className={styles.error} data-mega-cls="merge-error" role="alert">
                    {transition.error.message || detail.error}
                  </div>
                )}
                {children}
              </div>
              <aside aria-label={detail.chrome.details} className={styles.sidebar} data-mega-cls="sidebar">
                <section>
                  <h2><UsersRound size={16} aria-hidden="true" />{side.reviewers}</h2>
                  {cl.reviewers.length ? (
                    <ul>
                      {cl.reviewers.map(({ user, verdict }) => (
                        <li className={styles.reviewer} key={user.id}>
                          <ShellAvatar size={22} user={user} />
                          <strong>{user.displayName || user.username}</strong>
                          <span className={styles.verdict} data-verdict={verdict}>{verdict === "approved" && <Check size={13} aria-hidden="true" />}{side.verdicts[verdict]}</span>
                        </li>
                      ))}
                    </ul>
                  ) : <p>{side.noReviewers}</p>}
                </section>
                <section>
                  <h2><Folder size={16} aria-hidden="true" />{repoPath ? detail.chrome.repository : side.package}</h2>
                  <p className={styles.path}>{repoPath || cl.packageId}</p>
                </section>
                {cl.ciRequired !== false && <section>
                  <h2><ClipboardCheck size={16} aria-hidden="true" />{side.checks}</h2>
                  <Link data-ci={cl.ci} data-mega-cls="detail-ci" href={checksHref}>{detail.revisions.card.ci.replace("{status}", ciLabel)}</Link>
                </section>}
                {cl.linkedIssues.length > 0 && (
                  <section>
                    <h2>{side.linkedIssues}</h2>
                    <ul>{cl.linkedIssues.map(issue => <li key={issue}><Link href={`/${locale}/workspace/issues/${issue}`}>#{issue}</Link></li>)}</ul>
                  </section>
                )}
              </aside>
            </div>
          ) : <div className={styles.subpage}>{children}</div>}
        </CLRouteProvider>
      </div>
    </main>
  );
}
