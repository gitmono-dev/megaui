// megaui:apps/next-app/app/[lang]/workspace/cls/[n]/page.tsx@0ff3a9d
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, GitCommitHorizontal, ListFilter, MessageSquare, SquareCode } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import type { CL, CLComment, InlineComment, User } from "@megaui/core";
import type { ClCommit } from "@megaui/engine";
import { MegaApiError, megaGet, megaPost, megaQueryKeys } from "@megaui/ui/query";
import { ShellAvatar } from "@megaui/ui/shell";

import { WorkspaceLoading } from "@/app/[lang]/workspace/components/workspace-loading";
import { useTranslation } from "@/hooks/use-translation";
import { authClient } from "@/lib/auth-client";
import { plainTextFromCommentBody } from "@/lib/comment-plain-text";

import { isCLViewer, presentCLAuthor, type CLViewer } from "./cl-author";
import { useCurrentCL } from "./cl-route";
import styles from "./conversation.module.css";

type DiscussionFilter = "all" | "unresolved" | "mine";

function Author({ user, at, dateFormat, viewer }: {
  user: User; at: string; dateFormat: Intl.DateTimeFormat; viewer?: CLViewer;
}) {
  const author = presentCLAuthor(user, viewer);
  return (
    <div className={styles.byline}>
      <ShellAvatar size={20} user={author} />
      <strong>{author.displayName || author.username}</strong>
      <time dateTime={at}>{dateFormat.format(new Date(at))}</time>
    </div>
  );
}

function CommitActivity({ number }: { number: number }) {
  const { t } = useTranslation();
  const labels = t.workspace.clDetail.revisions.clCommits;
  const activity = t.workspace.clDetail.conversation.activity;
  const [showAll, setShowAll] = useState(false);
  const commits = useQuery({
    queryKey: megaQueryKeys.clCommits(number),
    queryFn: () => megaGet<ClCommit[]>(["cls", String(number), "commits"]),
    retry: (count, error) => !(error instanceof MegaApiError && error.status === 404) && count < 2,
  });
  const items = commits.data ?? [];

  return (
    <section className={styles.commits} data-mega-cls="commits" id="cl-commits">
      <h2 className={styles.subheading}>
        <GitCommitHorizontal size={17} aria-hidden /> {labels.title}
        {commits.data && <span className={styles.count}>{items.length}</span>}
      </h2>
      {commits.isError ? (
        <div role="alert" className={styles.feedback}>
          {labels.error}
          <button data-mega-cls="commits-retry" onClick={() => void commits.refetch()} type="button">{labels.retry}</button>
        </div>
      ) : commits.isPending ? (
        <WorkspaceLoading label={labels.loading} />
      ) : items.length === 0 ? (
        <p className={styles.empty} data-mega-cls="commits-empty">{labels.empty}</p>
      ) : (
        <>
          <ul className={styles.commitList} data-mega-cls="commits-list">
            {(showAll ? items : items.slice(0, 3)).map((commit) => (
              <li data-mega-cls="commit" key={commit.sha}>
                <span className={styles.commitMessage} title={commit.message}>{commit.message.split("\n")[0]}</span>
                <span className={styles.commitAuthor}>{commit.authorName}</span>
                <code>{commit.sha.slice(0, 7)}</code>
              </li>
            ))}
          </ul>
          {items.length > 3 && (
            <button aria-expanded={showAll} className={styles.more} onClick={() => setShowAll(!showAll)} type="button">
              {showAll ? activity.lessCommits : activity.moreCommits.replace("{count}", String(items.length))}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function InlineComposer({ cl }: { cl: CL }) {
  const { t } = useTranslation();
  const labels = t.workspace.clDetail.conversation;
  const [filePath, setFilePath] = useState(cl.files[0]?.path ?? "");
  const [line, setLine] = useState("1");
  const [body, setBody] = useState("");
  const queryClient = useQueryClient();
  const post = useMutation({
    mutationFn: () => megaPost<InlineComment>(["cls", String(cl.number), "inline-comments"], {
      filePath: filePath.trim(), line: Number(line), body: body.trim(),
    }),
    onSuccess: () => {
      setBody("");
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.clInlineComments(cl.number) });
    },
  });

  return (
    <details className={styles.inlineComposer} data-mega-cls="inline-composer">
      <summary><ChevronRight size={15} aria-hidden /> {labels.inlineSection.add}</summary>
      <form className={styles.inlineForm} data-mega-cls="inline-form" onSubmit={(event) => {
        event.preventDefault();
        if (body.trim() && filePath.trim() && Number.isInteger(Number(line)) && Number(line) > 0) post.mutate();
      }}>
        <label>{labels.inlineSection.filePath}
          <input data-mega-cls="inline-path" value={filePath} onChange={(e) => setFilePath(e.target.value)} required />
        </label>
        <label>{labels.inlineSection.line}
          <input data-mega-cls="inline-line" type="number" min={1} value={line} onChange={(e) => setLine(e.target.value)} required />
        </label>
        <label className={styles.full}>{labels.inlineSection.body}
          <textarea data-mega-cls="inline-body" value={body} rows={3} onChange={(e) => setBody(e.target.value)} required />
        </label>
        {post.isError && <p className={styles.feedback} role="alert">{labels.activity.postError}</p>}
        <button className={styles.formButton} data-mega-cls="inline-submit" disabled={post.isPending || !body.trim()} type="submit">
          {post.isPending ? labels.inlineSection.submitting : labels.inlineSection.submit}
        </button>
      </form>
    </details>
  );
}

function Discussion({ cl, dateFormat, viewer }: { cl: CL; dateFormat: Intl.DateTimeFormat; viewer?: CLViewer }) {
  const { t } = useTranslation();
  const labels = t.workspace.clDetail.conversation;
  const activity = labels.activity;
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<DiscussionFilter>("all");
  const [newestFirst, setNewestFirst] = useState(false);
  const [draft, setDraft] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [target, setTarget] = useState("");
  const comments = useQuery({
    queryKey: megaQueryKeys.clComments(cl.number),
    queryFn: () => megaGet<CLComment[]>(["cls", String(cl.number), "comments"]),
  });
  const inline = useQuery({
    queryKey: megaQueryKeys.clInlineComments(cl.number),
    queryFn: () => megaGet<InlineComment[]>(["cls", String(cl.number), "inline-comments"]),
  });
  const post = useMutation({
    mutationFn: (body: string) => megaPost<CLComment>(["cls", String(cl.number), "comments"], { body }),
    onSuccess: () => {
      setDraft("");
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.clComments(cl.number) });
    },
  });
  useEffect(() => {
    function readFragment() {
      try {
        const hash = decodeURIComponent(window.location.hash.slice(1));
        setTarget(hash.startsWith("comment-") ? hash : "");
      } catch {
        setTarget("");
      }
    }
    readFragment();
    window.addEventListener("hashchange", readFragment);
    return () => window.removeEventListener("hashchange", readFragment);
  }, []);

  useEffect(() => {
    if (!target) return;
    const el = document.getElementById(target);
    if (el) {
      const thread = el.closest("details");
      if (thread) thread.open = true;
      el.scrollIntoView({ block: "center" });
      setTarget("");
    } else if (
      comments.data?.some((c) => `comment-${c.id}` === target) ||
      inline.data?.some((c) => `comment-${c.id}` === target || c.replies.some((r) => `comment-${r.id}` === target))
    ) {
      setScope("all");
      setShowAll(true);
    }
  }, [target, comments.data, inline.data, scope, showAll]);

  const isLive = cl.author.id.startsWith("mega2:");
  const allEntries: Array<CLComment | InlineComment> = [...(comments.data ?? []), ...(inline.data ?? [])];
  const entries = allEntries.filter((entry) => {
    if (scope === "unresolved") return "filePath" in entry && !entry.resolvedAt;
    if (scope === "mine") return isCLViewer(entry.author, viewer) || ("replies" in entry && entry.replies.some((r) => isCLViewer(r.author, viewer)));
    return true;
  }).sort((a, b) => (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * (newestFirst ? -1 : 1));
  const failed = comments.isError || inline.isError;
  const loading = comments.isPending || inline.isPending;
  const filters: DiscussionFilter[] = ["all"];
  if (!isLive) filters.push("unresolved");
  if (viewer) filters.push("mine");

  return (
    <section className={styles.discussion} data-mega-cls="comments" id="cl-discussion">
      <h2 className={styles.sectionTitle}><MessageSquare size={18} aria-hidden /> {activity.title}</h2>
      {allEntries.length > 0 && (
        <div className={styles.toolbar}>
          <div className={styles.filters} role="group" aria-label={activity.filters}>
            {filters.map((filter) => (
              <button aria-pressed={scope === filter} data-mega-cls="discussion-filter" data-filter={filter}
                key={filter} onClick={() => { setScope(filter); setShowAll(false); }} type="button">{activity[filter]}</button>
            ))}
          </div>
          {allEntries.length > 1 && <label className={styles.sort}><ListFilter size={15} aria-hidden />
            <select aria-label={activity.sort} data-mega-cls="discussion-sort" value={newestFirst ? "newest" : "oldest"}
              onChange={(e) => setNewestFirst(e.target.value === "newest")}>
              <option value="oldest">{activity.oldest}</option><option value="newest">{activity.newest}</option>
            </select>
          </label>}
        </div>
      )}

      <div className={styles.feed} data-mega-cls="inline-comments">
        {failed && <div className={styles.feedback} role="alert">{labels.error}
          <button onClick={() => {
            if (comments.isError) void comments.refetch();
            if (inline.isError) void inline.refetch();
          }} type="button">{labels.retry}</button>
        </div>}
        {loading && <WorkspaceLoading label={labels.loading} />}
        {!loading && !failed && entries.length === 0 && <p className={styles.empty} data-mega-cls="inline-empty">
          {scope === "all" ? activity.empty : activity.emptyFilter}
        </p>}
        {(showAll ? entries : entries.slice(0, 5)).map((entry) => {
          const isInline = "filePath" in entry;
          const body = (
            <>
              <Author viewer={viewer} user={entry.author} at={entry.createdAt} dateFormat={dateFormat} />
              <p className={styles.body}>{plainTextFromCommentBody(entry.body)}</p>
              {isInline && entry.replies.map((reply) => <div className={styles.reply} id={`comment-${reply.id}`} key={reply.id}>
                <Author viewer={viewer} user={reply.author} at={reply.createdAt} dateFormat={dateFormat} />
                <p className={styles.body}>{plainTextFromCommentBody(reply.body)}</p>
              </div>)}
            </>
          );
          if (!isInline) return <article className={styles.entry} data-mega-cls="comment" id={`comment-${entry.id}`} key={`comment-${entry.id}`}>{body}</article>;
          return (
            <details className={styles.thread} data-mega-cls="inline-thread" id={`comment-${entry.id}`} key={`inline-${entry.id}`} open={!entry.resolvedAt}>
              <summary><ChevronRight size={15} aria-hidden /><code>{entry.filePath}:{entry.line}</code>
                {entry.resolvedAt && <span className={styles.status}>{labels.thread.resolved}</span>}
              </summary>
              <div className={styles.entry}>{body}</div>
            </details>
          );
        })}
      </div>
      {entries.length > 5 && <button className={styles.moreComments} aria-expanded={showAll}
        onClick={() => setShowAll(!showAll)} type="button">
        {showAll ? activity.lessComments : activity.moreComments.replace("{count}", String(entries.length))}
      </button>}
      <form className={styles.composer} onSubmit={(event) => {
        event.preventDefault();
        if (draft.trim()) post.mutate(draft.trim());
      }}>
        <label htmlFor="cl-comment-draft">{activity.add}</label>
        <textarea id="cl-comment-draft" data-mega-cls="comment-input" onChange={(e) => setDraft(e.target.value)}
          rows={3} required value={draft} />
        {post.isError && <p className={styles.feedback} role="alert">{activity.postError}</p>}
        <button className={styles.formButton} data-mega-cls="comment-submit" disabled={post.isPending || !draft.trim()} type="submit">
          {post.isPending ? labels.composer.submitting : labels.composer.submit}
        </button>
      </form>
      {!isLive && <InlineComposer cl={cl} />}
    </section>
  );
}

export default function CLConversationPage() {
  const cl = useCurrentCL();
  const { data: session } = authClient.useSession();
  const { locale, t } = useTranslation();
  const labels = t.workspace.clDetail.conversation;
  const dateFormat = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }), [locale]);
  const [showPatch, setShowPatch] = useState(false);
  const file = cl.files[0];
  return (
    <div className={styles.overview}>
      <section className={styles.description} data-mega-cls="description" id="cl-description">
        <header className={styles.descriptionHeader}>
          <h2 className={styles.subheading}>{labels.description.badge}</h2>
          <Author viewer={session?.user} user={cl.author} at={cl.createdAt} dateFormat={dateFormat} />
        </header>
        <p className={cl.description ? styles.body : styles.empty}>{cl.description || labels.description.empty}</p>
      </section>
      <CommitActivity number={cl.number} key={cl.publicId} />
      <Discussion cl={cl} viewer={session?.user} dateFormat={dateFormat} key={`discussion-${cl.publicId}`} />
      {file?.patch ? (
        <details className={styles.diff} data-mega-cls="diff" onToggle={(e) => setShowPatch(e.currentTarget.open)}>
          <summary>
            <ChevronRight size={15} aria-hidden /><SquareCode size={16} aria-hidden />
            <span>{labels.activity.preview}</span><code>{file.path}</code>
            {cl.diffStatsAvailable !== false && <>
              <span className={styles.added}>+{file.additions}</span><span className={styles.deleted}>−{file.deletions}</span>
            </>}
          </summary>
          {showPatch && <pre tabIndex={0} data-mega-cls="diff-patch">{file.patch}</pre>}
        </details>
      ) : file ? (
        <Link className={styles.filesLink} href={`/${locale}/workspace/cls/${cl.publicId}/files`}>
          <SquareCode size={16} aria-hidden />{t.workspace.clDetail.chrome.tabs.files}
          <span className={styles.count}>{cl.files.length}</span>
        </Link>
      ) : null}
    </div>
  );
}
