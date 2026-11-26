// megaui:apps/next-app/app/[lang]/workspace/cls/[n]/page.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-09): client-only conversation; first-file patch
// as preformatted text (pierre SSR preload deferred); commits via BFF.
"use client";

import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import type { CL, CLComment, InlineComment } from "@megaui/core";
import { MegaApiError, megaGet, megaPost, megaQueryKeys } from "@megaui/ui/query";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";
import { plainTextFromCommentBody } from "@/lib/comment-plain-text";

interface ClCommit {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
}

export default function CLConversationPage() {
  const params = useParams<{ n: string }>();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const detail = t.workspace.clDetail;
  const clNumber = Number(params?.n);
  const [commentDraft, setCommentDraft] = useState("");
  const [inlinePath, setInlinePath] = useState("");
  const [inlineLine, setInlineLine] = useState(1);
  const [inlineBody, setInlineBody] = useState("");

  const clQuery = useQuery({
    queryKey: megaQueryKeys.cl(clNumber),
    queryFn: () => megaGet<CL>(["cls", String(clNumber)]),
    enabled: Number.isInteger(clNumber) && clNumber > 0,
  });
  const commentsQuery = useQuery({
    queryKey: megaQueryKeys.clComments(clNumber),
    queryFn: () => megaGet<CLComment[]>(["cls", String(clNumber), "comments"]),
    enabled: Boolean(clQuery.data),
  });
  const inlineQuery = useQuery({
    queryKey: megaQueryKeys.clInlineComments(clNumber),
    queryFn: () => megaGet<InlineComment[]>(["cls", String(clNumber), "inline-comments"]),
    enabled: Boolean(clQuery.data),
  });
  const commitsQuery = useQuery({
    queryKey: megaQueryKeys.clCommits(clNumber),
    queryFn: () => megaGet<ClCommit[]>(["cls", String(clNumber), "commits"]),
    enabled: Boolean(clQuery.data),
    retry: (count, error) => !(error instanceof MegaApiError && error.status === 404) && count < 2,
  });


  useEffect(() => {
    const path = clQuery.data?.files[0]?.path;
    if (path) setInlinePath((current) => current || path);
  }, [clQuery.data?.files]);

  const commentMutation = useMutation({
    mutationFn: (body: string) => megaPost<CLComment>(["cls", String(clNumber), "comments"], { body }),
    onSuccess: () => {
      setCommentDraft("");
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.clComments(clNumber) });
    },
  });
  const inlineMutation = useMutation({
    mutationFn: (input: { body: string; filePath: string; line: number }) =>
      megaPost<InlineComment>(["cls", String(clNumber), "inline-comments"], input),
    onSuccess: () => {
      setInlineBody("");
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.clInlineComments(clNumber) });
    },
  });

  if (!clQuery.data) return null;

  const cl = clQuery.data;
  const firstFile = cl.files[0];
  const commitsLabels = detail.revisions.clCommits;

  return (
    <div style={{ display: "grid", gap: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}>
      <section data-mega-cls="description" style={{ border: `1px solid ${MEGA_TOKENS.border}`, borderRadius: MEGA_RADIUS_TOKENS.md, padding: MEGA_SPACING_TOKENS[8] }}>
        <h2 style={{ fontSize: "var(--mega-density-font-size)", margin: 0 }}>{detail.conversation.description.badge}</h2>
        <p style={{ color: MEGA_TOKENS.muted, margin: `${MEGA_SPACING_TOKENS[6]} 0 0`, whiteSpace: "pre-wrap" }}>
          {cl.description || detail.conversation.description.empty}
        </p>
      </section>

      {firstFile ? (
        <section data-mega-cls="diff" style={{ border: `1px solid ${MEGA_TOKENS.border}`, borderRadius: MEGA_RADIUS_TOKENS.md, overflow: "auto" }}>
          <header style={{ borderBottom: `1px solid ${MEGA_TOKENS.border}`, padding: MEGA_SPACING_TOKENS[8] }}>
            <strong>{firstFile.path}</strong>
            <span style={{ color: MEGA_TOKENS.muted }}> +{firstFile.additions}/−{firstFile.deletions}</span>
          </header>
          <pre
            data-mega-cls="diff-patch"
            style={{
              fontFamily: MEGA_TOKENS.fontMono,
              fontSize: "calc(var(--mega-density-font-size) - 1px)",
              margin: 0,
              padding: MEGA_SPACING_TOKENS[8],
              whiteSpace: "pre-wrap",
            }}
          >
            {firstFile.patch || detail.conversation.emptyPatch}
          </pre>
        </section>
      ) : null}

      <section data-mega-cls="inline-comments">
        <h2 style={{ fontSize: "var(--mega-density-font-size)", margin: 0 }}>{detail.conversation.inlineSection.title}</h2>
        {(inlineQuery.data ?? []).length === 0 ? (
          <p data-mega-cls="inline-empty" style={{ color: MEGA_TOKENS.muted }}>
            {detail.conversation.inlineSection.empty}
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {(inlineQuery.data ?? []).map((thread) => (
              <li data-mega-cls="inline-thread" key={thread.id} style={{ borderBottom: `1px solid ${MEGA_TOKENS.border}`, padding: `${MEGA_SPACING_TOKENS[6]} 0` }}>
                <code>
                  {thread.filePath}:{thread.line}
                </code>
                <p style={{ margin: `${MEGA_SPACING_TOKENS[4]} 0 0` }}>{plainTextFromCommentBody(thread.body)}</p>
              </li>
            ))}
          </ul>
        )}
        <form
          data-mega-cls="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!inlineBody.trim() || !inlinePath.trim() || inlineLine < 1) return;
            inlineMutation.mutate({
              body: inlineBody.trim(),
              filePath: inlinePath.trim(),
              line: inlineLine,
            });
          }}
          style={{ display: "grid", gap: MEGA_SPACING_TOKENS[6], marginTop: MEGA_SPACING_TOKENS[8] }}
        >
          <label>
            {detail.conversation.inlineSection.filePath}
            <input data-mega-cls="inline-path" onChange={(e) => setInlinePath(e.target.value)} required value={inlinePath} style={{ display: "block", width: "100%" }} />
          </label>
          <label>
            {detail.conversation.inlineSection.line}
            <input data-mega-cls="inline-line" min={1} onChange={(e) => setInlineLine(Number(e.target.value) || 1)} required type="number" value={inlineLine} style={{ display: "block", width: "100%" }} />
          </label>
          <label>
            {detail.conversation.inlineSection.body}
            <textarea data-mega-cls="inline-body" onChange={(e) => setInlineBody(e.target.value)} required rows={2} value={inlineBody} style={{ display: "block", width: "100%" }} />
          </label>
          <button data-mega-cls="inline-submit" disabled={inlineMutation.isPending} type="submit">
            {inlineMutation.isPending ? detail.conversation.inlineSection.submitting : detail.conversation.inlineSection.submit}
          </button>
        </form>
      </section>

      <section data-mega-cls="comments">
        <h2 style={{ fontSize: "var(--mega-density-font-size)", margin: 0 }}>{detail.chrome.tabs.conversation}</h2>
        {(commentsQuery.data ?? []).map((comment) => (
          <article data-mega-cls="comment" key={comment.id} style={{ borderBottom: `1px solid ${MEGA_TOKENS.border}`, padding: `${MEGA_SPACING_TOKENS[6]} 0` }}>
            <strong>{comment.author.displayName}</strong>
            <p style={{ margin: `${MEGA_SPACING_TOKENS[4]} 0 0`, whiteSpace: "pre-wrap" }}>{plainTextFromCommentBody(comment.body)}</p>
          </article>
        ))}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!commentDraft.trim()) return;
            commentMutation.mutate(commentDraft.trim());
          }}
          style={{ marginTop: MEGA_SPACING_TOKENS[8] }}
        >
          <textarea
            data-mega-cls="comment-input"
            onChange={(event) => setCommentDraft(event.target.value)}
            placeholder={detail.conversation.composer.placeholder}
            rows={3}
            style={{ display: "block", width: "100%" }}
            value={commentDraft}
          />
          <button data-mega-cls="comment-submit" disabled={commentMutation.isPending} type="submit">
            {commentMutation.isPending ? detail.conversation.composer.submitting : detail.conversation.composer.submit}
          </button>
        </form>
      </section>

      <section data-mega-cls="commits" style={{ border: `1px solid ${MEGA_TOKENS.border}`, borderRadius: MEGA_RADIUS_TOKENS.md, padding: MEGA_SPACING_TOKENS[8] }}>
        <h2 style={{ fontSize: "var(--mega-density-font-size)", margin: 0 }}>{commitsLabels.title}</h2>
        {commitsQuery.isPending ? (
          <p aria-busy="true">{commitsLabels.loading}</p>
        ) : commitsQuery.isError ? (
          <div role="alert" style={{ alignItems: "center", display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
            <p style={{ margin: 0 }}>{commitsLabels.error}</p>
            <button data-mega-cls="commits-retry" onClick={() => void commitsQuery.refetch()} type="button">
              {commitsLabels.retry}
            </button>
          </div>
        ) : (commitsQuery.data ?? []).length === 0 ? (
          <p data-mega-cls="commits-empty" style={{ color: MEGA_TOKENS.muted }}>
            {commitsLabels.empty}
          </p>
        ) : (
          <ul data-mega-cls="commits-list" style={{ listStyle: "none", margin: `${MEGA_SPACING_TOKENS[6]} 0 0`, padding: 0 }}>
            {(commitsQuery.data ?? []).map((commit) => (
              <li data-mega-cls="commit" key={commit.sha} style={{ fontFamily: MEGA_TOKENS.fontMono, marginBottom: MEGA_SPACING_TOKENS[4] }}>
                <code>{commit.sha.slice(0, 7)}</code> {commit.message} · {commit.authorName}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
