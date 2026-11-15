import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import type { Issue } from "@megaui/core";
import { megaPost, megaQueryKeys } from "@megaui/ui/query";

export type IssueBodySaveState = "idle" | "saving" | "saved" | "error";

interface UseIssueBodyEditorOptions {
  readonly issueBody: string | undefined;
  readonly issueNumber: number;
  readonly onSaveError: (error: unknown) => void;
}

export function useIssueBodyEditor({
  issueBody,
  issueNumber,
  onSaveError,
}: UseIssueBodyEditorOptions) {
  const queryClient = useQueryClient();
  const [editingBody, setEditingBody] = useState(false);
  const [bodyDraft, setBodyDraft] = useState("");
  const [bodySaveState, setBodySaveState] = useState<IssueBodySaveState>("idle");
  const saveBodyMutation = useMutation({
    mutationFn: (body: string) =>
      megaPost<{ readonly body: string }>(["issues", String(issueNumber), "body"], { body }),
    onMutate: () => setBodySaveState("saving"),
    onSuccess: (payload) => {
      setBodySaveState("saved");
      queryClient.setQueryData<Issue>(megaQueryKeys.issue(issueNumber), (current) =>
        current ? { ...current, body: payload.body } : current,
      );
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.issueBody(issueNumber) });
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.issue(issueNumber) });
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.issues() });
    },
    onError: (error) => {
      setBodySaveState("error");
      onSaveError(error);
    },
  });
  const persistBodyRef = useRef(saveBodyMutation.mutate);
  persistBodyRef.current = saveBodyMutation.mutate;

  useEffect(() => {
    if (!editingBody) return;
    const currentBody = issueBody ?? "";
    const handle = window.setTimeout(() => {
      const trimmed = bodyDraft.trim();
      if (trimmed && trimmed !== currentBody.trim()) persistBodyRef.current(trimmed);
    }, 2000);
    return () => window.clearTimeout(handle);
  }, [bodyDraft, editingBody, issueBody]);

  const changeBody = (value: string) => {
    setBodyDraft(value);
    setBodySaveState("idle");
  };
  const toggleBodyEditor = () => {
    if (!editingBody) {
      setBodyDraft(issueBody ?? "");
      setBodySaveState("idle");
      setEditingBody(true);
      return;
    }
    const trimmed = bodyDraft.trim();
    if (trimmed && trimmed !== (issueBody ?? "").trim()) {
      saveBodyMutation.mutate(trimmed, { onSuccess: () => setEditingBody(false) });
      return;
    }
    setEditingBody(false);
  };

  return {
    bodyDraft,
    bodySaveState,
    changeBody,
    editingBody,
    saveBodyMutation,
    toggleBodyEditor,
  };
}
