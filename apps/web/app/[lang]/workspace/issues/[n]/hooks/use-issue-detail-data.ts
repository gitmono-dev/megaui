import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Issue, IssueComment } from "@megaui/core";
import { MegaApiError, megaGet, megaPost, megaQueryKeys } from "@megaui/ui/query";

import { issueErrorMessage, type MegaErrorMessages } from "../lib/issue-error-message";

interface IssueActionMessages {
  readonly actionFailed: string;
  readonly closed: string;
  readonly commentAdded: string;
  readonly reopened: string;
  readonly watchOff: string;
  readonly watchOn: string;
}

interface UseIssueDetailDataOptions {
  readonly actionMessages: IssueActionMessages;
  readonly errorMessages: MegaErrorMessages;
  readonly issueNumber: string;
  readonly sessionUserId: string | undefined;
  readonly validNumber: boolean;
  readonly onCommentAdded: () => void;
  readonly onToast: (tone: "error" | "success", message: string) => void;
}

export function useIssueDetailData({
  actionMessages,
  errorMessages,
  issueNumber,
  sessionUserId,
  validNumber,
  onCommentAdded,
  onToast,
}: UseIssueDetailDataOptions) {
  const queryClient = useQueryClient();
  const retry = (count: number, error: Error) =>
    !(error instanceof MegaApiError && error.status === 404) && count < 2;
  const issueQuery = useQuery({
    queryKey: megaQueryKeys.issue(issueNumber),
    queryFn: () => megaGet<Issue>(["issues", String(issueNumber)]),
    enabled: validNumber,
    retry,
  });
  const commentsQuery = useQuery({
    queryKey: megaQueryKeys.issueComments(issueNumber),
    queryFn: () => megaGet<IssueComment[]>(["issues", String(issueNumber), "comments"]),
    enabled: validNumber && issueQuery.isSuccess,
    retry,
  });
  const actionError = (error: unknown) =>
    onToast("error", issueErrorMessage(error, actionMessages.actionFailed, errorMessages));
  const refreshIssueList = () =>
    void queryClient.invalidateQueries({ queryKey: megaQueryKeys.issues() });
  const refreshIssueDetail = () => {
    void queryClient.invalidateQueries({ queryKey: megaQueryKeys.issue(issueNumber) });
    void queryClient.invalidateQueries({ queryKey: megaQueryKeys.issueComments(issueNumber) });
    refreshIssueList();
  };
  const closeMutation = useMutation({
    mutationFn: () => megaPost<Issue>(["issues", String(issueNumber), "close"]),
    onSuccess: (issue) => {
      queryClient.setQueryData(megaQueryKeys.issue(issueNumber), issue);
      refreshIssueList();
      onToast("success", actionMessages.closed);
    },
    onError: actionError,
  });
  const reopenMutation = useMutation({
    mutationFn: () => megaPost<Issue>(["issues", String(issueNumber), "reopen"]),
    onSuccess: (issue) => {
      queryClient.setQueryData(megaQueryKeys.issue(issueNumber), issue);
      refreshIssueList();
      onToast("success", actionMessages.reopened);
    },
    onError: actionError,
  });
  const watchMutation = useMutation({
    mutationFn: () => megaPost<Issue>(["issues", String(issueNumber), "watch"]),
    onSuccess: (issue) => {
      queryClient.setQueryData(megaQueryKeys.issue(issueNumber), issue);
      const watching = Boolean(sessionUserId && issue.watcherIds.includes(sessionUserId));
      onToast("success", watching ? actionMessages.watchOn : actionMessages.watchOff);
    },
    onError: actionError,
  });
  const commentMutation = useMutation({
    mutationFn: (body: string) =>
      megaPost<IssueComment>(["issues", String(issueNumber), "comments"], { body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.issueComments(issueNumber) });
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.issue(issueNumber) });
      onCommentAdded();
      onToast("success", actionMessages.commentAdded);
    },
    onError: actionError,
  });
  const issueReactionMutation = useMutation({
    mutationFn: (emoji: string) =>
      megaPost<Issue>(["issues", String(issueNumber), "reactions"], { emoji }),
    onSuccess: (issue) => {
      queryClient.setQueryData(megaQueryKeys.issue(issueNumber), issue);
      refreshIssueDetail();
    },
    onError: actionError,
  });
  const commentReactionMutation = useMutation({
    mutationFn: ({ commentId, emoji }: { readonly commentId: string; readonly emoji: string }) =>
      megaPost<IssueComment>(["issue-comments", commentId, "reactions"], { emoji }),
    onSuccess: (comment) => {
      queryClient.setQueryData<IssueComment[]>(
        megaQueryKeys.issueComments(issueNumber),
        (current) =>
          current?.map((entry) => (entry.id === comment.id ? comment : entry)) ?? [comment],
      );
      refreshIssueDetail();
    },
    onError: actionError,
  });

  return {
    closeMutation,
    commentMutation,
    commentReactionMutation,
    commentsQuery,
    issueQuery,
    issueReactionMutation,
    reopenMutation,
    watchMutation,
  };
}
