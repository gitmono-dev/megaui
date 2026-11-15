// megaui:apps/next-app/app/[lang]/workspace/issues/[n]/page.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-11): lean issue detail with plain body editing,
// reactions, comments, state transitions, and watch behavior through the BFF.
"use client";

import { useParams } from "next/navigation";
import { useState } from "react";

import { MegaApiError } from "@megaui/ui/query";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";
import { authClient } from "@/lib/auth-client";

import { IssueBodyPanel } from "./components/issue-body-panel";
import { IssueCommentComposer } from "./components/issue-comment-composer";
import { IssueDetailHeader } from "./components/issue-detail-header";
import { IssueSidebar } from "./components/issue-sidebar";
import {
  IssueDetailError,
  IssueDetailLoading,
  IssueDetailNotFound,
} from "./components/issue-detail-state";
import { IssueTimeline } from "./components/issue-timeline";
import { useIssueBodyEditor } from "./hooks/use-issue-body-editor";
import { useIssueDetailData } from "./hooks/use-issue-detail-data";
import { issueErrorMessage } from "./lib/issue-error-message";

export default function IssueDetailPage() {
  const params = useParams<{ n: string }>();
  const { locale, t } = useTranslation();
  const { data: session } = authClient.useSession();
  const issuesText = t.workspace.issues;
  const detail = issuesText.detail;
  const workspaceBase = `/${locale}/workspace`;
  const issueNumber = Number(params?.n);
  const validNumber = Number.isInteger(issueNumber) && issueNumber > 0;
  const [commentDraft, setCommentDraft] = useState("");
  const [toast, setToast] = useState<{
    readonly message: string;
    readonly tone: "success" | "error";
  } | null>(null);
  const showToast = (tone: "success" | "error", message: string) => setToast({ tone, message });
  const sessionUserId = session?.user?.id;
  const data = useIssueDetailData({
    actionMessages: detail.toasts,
    errorMessages: t.errors.mega,
    issueNumber,
    onCommentAdded: () => setCommentDraft(""),
    onToast: showToast,
    sessionUserId,
    validNumber,
  });
  const bodyEditor = useIssueBodyEditor({
    issueBody: data.issueQuery.data?.body,
    issueNumber,
    onSaveError: (error) => {
      showToast("error", issueErrorMessage(error, detail.body.saveFailed, t.errors.mega));
    },
  });

  const notFound =
    !validNumber ||
    (data.issueQuery.isError &&
      data.issueQuery.error instanceof MegaApiError &&
      data.issueQuery.error.status === 404);
  if (notFound) {
    return (
      <IssueDetailNotFound
        backToListLabel={detail.backToList}
        body={detail.notFoundBody.replace("{number}", String(params?.n ?? ""))}
        title={detail.notFoundTitle}
        workspaceBase={workspaceBase}
      />
    );
  }
  if (data.issueQuery.isPending) {
    return <IssueDetailLoading label={issuesText.loading} />;
  }
  if (data.issueQuery.isError) {
    return (
      <IssueDetailError
        label={issuesText.error}
        onRetry={() => void data.issueQuery.refetch()}
        retryLabel={issuesText.retry}
      />
    );
  }
  if (!data.issueQuery.data) {
    return <IssueDetailLoading label={issuesText.loading} />;
  }

  const issue = data.issueQuery.data;
  const canAct = Boolean(sessionUserId);
  const canEdit = Boolean(
    sessionUserId &&
    (issue.author.id === sessionUserId ||
      issue.assignees.some((assignee) => assignee.id === sessionUserId)),
  );
  const watching = Boolean(sessionUserId && issue.watcherIds.includes(sessionUserId));
  const transitionPending = data.closeMutation.isPending || data.reopenMutation.isPending;
  return (
    <main
      data-mega-issues="detail"
      style={{
        padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2) calc(${MEGA_SPACING_TOKENS[8]} * 3.5)`,
      }}
    >
      {toast ? (
        <div
          data-mega-issues="toast"
          data-mega-toast={toast.tone}
          role="status"
          style={{
            background: toast.tone === "error" ? MEGA_TOKENS.danger : MEGA_TOKENS.success,
            borderRadius: MEGA_RADIUS_TOKENS.md,
            color: MEGA_TOKENS.accentForeground,
            marginBottom: MEGA_SPACING_TOKENS[8],
            padding: MEGA_SPACING_TOKENS[8],
          }}
        >
          {toast.message}
        </div>
      ) : null}
      <IssueDetailHeader
        backToListLabel={detail.backToList}
        canAct={canAct}
        closedLabel={detail.header.closedPill}
        issue={issue}
        metaTemplate={detail.header.meta}
        onWatch={() => data.watchMutation.mutate()}
        openLabel={detail.header.openPill}
        watchLabel={detail.header.watch}
        watchPending={data.watchMutation.isPending}
        watching={watching}
        watchingLabel={detail.header.watching}
        workspaceBase={workspaceBase}
      />
      <IssueBodyPanel
        addReactionLabel={detail.timeline.addReaction}
        autoSaveHint={detail.body.autoSaveHint}
        bodyDraft={bodyEditor.bodyDraft}
        bodySaveState={bodyEditor.bodySaveState}
        canEdit={canEdit}
        canReact={canAct}
        editLabel={detail.body.edit}
        editingBody={bodyEditor.editingBody}
        emptyLabel={detail.body.empty}
        finishEditingLabel={detail.body.finishEditing}
        issue={issue}
        onBodyChange={bodyEditor.changeBody}
        onEditToggle={bodyEditor.toggleBodyEditor}
        onReaction={(emoji) => data.issueReactionMutation.mutate(emoji)}
        placeholder={detail.body.placeholder}
        savePending={bodyEditor.saveBodyMutation.isPending}
        savedLabel={detail.body.saved}
        saveFailedLabel={detail.body.saveFailed}
        savingLabel={detail.body.saving}
        title={detail.body.title}
      />
      <IssueTimeline
        addReactionLabel={detail.timeline.addReaction}
        authorRoleLabel={detail.timeline.authorRole}
        canReact={canAct}
        comments={data.commentsQuery.data}
        errorLabel={issuesText.error}
        isError={data.commentsQuery.isError}
        isPending={data.commentsQuery.isPending}
        issueAuthorId={issue.author.id}
        loadingLabel={issuesText.loading}
        onCommentReaction={(input) => data.commentReactionMutation.mutate(input)}
        onRetry={() => void data.commentsQuery.refetch()}
        retryLabel={issuesText.retry}
      />
      {canAct ? (
        <IssueCommentComposer
          closeLabel={
            data.closeMutation.isPending ? detail.composer.closing : detail.composer.close
          }
          closePending={transitionPending}
          comment={commentDraft}
          commentPending={data.commentMutation.isPending}
          onClose={() => data.closeMutation.mutate()}
          onCommentChange={setCommentDraft}
          onReopen={() => data.reopenMutation.mutate()}
          onSubmit={() => data.commentMutation.mutate(commentDraft.trim())}
          placeholder={detail.composer.placeholder}
          reopenLabel={
            data.reopenMutation.isPending ? detail.composer.reopening : detail.composer.reopen
          }
          reopenPending={transitionPending}
          state={issue.state}
          submitLabel={detail.composer.submit}
          submittingLabel={detail.composer.submitting}
        />
      ) : null}
      <IssueSidebar
        issue={issue}
        linkedClsLabel={detail.sidebar.linkedCls}
        noneLabel={detail.sidebar.none}
        packageLabel={detail.sidebar.package}
      />
    </main>
  );
}
