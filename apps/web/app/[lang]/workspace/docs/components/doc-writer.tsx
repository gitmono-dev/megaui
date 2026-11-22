// megaui-only (RO-01): writable outliner extracted from WA-13 /edit so the
// detail route owns MegaContentEditor. Save / conflict / collab ticket
// semantics are unchanged. Not a port of the REF-RO-02 /edit page (DEBT-RO-01).
"use client";

import dynamic from "next/dynamic";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { Doc } from "@megaui/core";
import { buildDocContainerRoomName } from "@megaui/core";
import { MegaApiError, megaGet, megaPost, megaQueryKeys } from "@megaui/ui/query";
import {
  DocumentEmptyStatePlugin,
  EditorMirrorPlugin,
  resolveCollabMode,
  resolveCollabPublicUrl,
  type CollabMode,
  type MegaDocCollabConfig,
} from "@megaui/ui/content/editor";

import { authClient } from "@/lib/auth-client";
import { selfDisplayName } from "@/lib/self-display-name";
import { bodyHasVisibleContent } from "./doc-outline";
import { DocRoamShortcuts } from "./doc-roam-shortcuts";

const MegaContentEditor = dynamic(
  () => import("@megaui/ui/content/editor").then((mod) => mod.MegaContentEditor),
  { ssr: false },
);

export type DocWriterSaveState = "idle" | "saving" | "saved" | "conflict" | "error";

export interface DocWriterChrome {
  collabLabel: string;
  collabMode: CollabMode;
  saveLabel: string;
  saveState: DocWriterSaveState;
  canPublish: boolean;
}

type CollabTokenPayload = {
  token: string;
  userId: string;
  expiresAtMs: number;
};

export interface DocWriterLabels {
  autoSaveHint: string;
  collabConnecting: string;
  collabLive: string;
  collabOffline: string;
  collabReadonly: string;
  placeholder: string;
  saved: string;
  saving: string;
}

export interface DocWriterProps {
  conflictMessage: string;
  doc: Doc;
  forbiddenError: string;
  genericError: string;
  labels: DocWriterLabels;
  publicationFlushRef?: RefObject<(() => Promise<void>) | null>;
  sidebar?: { target: HTMLElement; blockId: string; onClose: () => void; onFocus: (blockId: string) => void };
  onChromeChange?(chrome: DocWriterChrome): void;
  onBodyChange?(body: string): void;
  onOpenBlock?(blockId: string): void;
  onToast: (toast: { tone: "success" | "error"; message: string }) => void;
}

/** ADR-RO-01.4: mount editor only when signed in and the URL has no `v`. */
export function canMountDocWriter(userId: string | undefined, hasVersionQuery: boolean): boolean {
  return Boolean(userId) && !hasVersionQuery;
}

function saveChipLabel(
  saveState: DocWriterSaveState,
  collabMode: CollabMode,
  labels: DocWriterLabels,
  conflictMessage: string,
): string {
  if (collabMode === "collab") return labels.collabLive;
  switch (saveState) {
    case "saving":
      return labels.saving;
    case "saved":
      return labels.saved;
    case "conflict":
      return conflictMessage;
    case "error":
    case "idle":
      return labels.autoSaveHint;
    default: {
      const _exhaustive: never = saveState;
      return _exhaustive;
    }
  }
}

function collabChipLabel(
  collabMode: CollabMode,
  tokenPending: boolean,
  labels: DocWriterLabels,
): string {
  switch (collabMode) {
    case "collab":
      return labels.collabLive;
    case "readonly":
      return tokenPending ? labels.collabConnecting : labels.collabReadonly;
    case "local":
      return labels.collabOffline;
    default: {
      const _exhaustive: never = collabMode;
      return _exhaustive;
    }
  }
}

export function DocWriter({
  conflictMessage,
  doc,
  forbiddenError,
  genericError,
  labels,
  onChromeChange,
  publicationFlushRef,
  sidebar,
  onBodyChange,
  onOpenBlock,
  onToast,
}: DocWriterProps) {
  const queryClient = useQueryClient();
  const [saveState, setSaveState] = useState<DocWriterSaveState>("idle");
  const [draftBody, setDraftBody] = useState<string | null>(null);
  const pendingBodyRef = useRef<string | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const [collabFailed, setCollabFailed] = useState(false);
  const [collabSynced, setCollabSynced] = useState(false);
  const readStateRef = useRef<(() => string) | null>(null);
  const session = authClient.useSession();
  const collabPublicUrl = resolveCollabPublicUrl();
  const docId = doc.id;
  const [isEditorEmpty, setIsEditorEmpty] = useState(() => !bodyHasVisibleContent(doc.body));
  const onEditorEmptyChange = useCallback((isEmpty: boolean) => {
    setIsEditorEmpty(isEmpty);
  }, []);

  const collabTokenQuery = useQuery({
    queryKey: ["mega", "collab-token", docId],
    queryFn: () => megaGet<CollabTokenPayload>(["collab", "token"]),
    enabled: Boolean(docId && collabPublicUrl && !collabFailed),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const profilePrefsQuery = useQuery({
    queryKey: ["mega", "profile-prefs"],
    queryFn: () => megaGet<{ username?: string }>("profile-prefs"),
    enabled: Boolean(session.data?.user),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // FSL-183: the presence username (seen by other collaborators) reads the own name only
  // through `selfDisplayName` (the Feishu projection `displayName`, else the session name); not trimmed.
  const selfName = selfDisplayName(session.data?.user);

  const collabConfig = useMemo<MegaDocCollabConfig | undefined>(() => {
    // Only terminal auth failure drops collab (not transient WS offline / soft disconnect).
    if (!collabPublicUrl || !docId || collabFailed) return undefined;
    return {
      url: collabPublicUrl,
      documentName: buildDocContainerRoomName(docId),
      token: collabTokenQuery.data?.token ?? null,
      userId: collabTokenQuery.data?.userId ?? session.data?.user?.id,
      username: selfName ?? profilePrefsQuery.data?.username ?? undefined,
      initialEditorStateJSON: draftBody ?? doc.body,
      onConnectionStatus: (status) => {
        setCollabSynced(status === "connected");
        if (status !== "auth-failed") return;
        const snapshot = readStateRef.current?.();
        if (snapshot) setDraftBody(snapshot);
        setCollabFailed(true);
      },
    };
  }, [
    collabFailed,
    collabPublicUrl,
    collabTokenQuery.data?.token,
    collabTokenQuery.data?.userId,
    doc.body,
    docId,
    draftBody,
    profilePrefsQuery.data?.username,
    selfName,
    session.data?.user?.id,
  ]);

  const collabMode = resolveCollabMode(collabConfig);

  // Publication awaits the same queue as autosave, including edits queued while
  // an earlier request is in flight. Failed content stays available for retry.
  const flushSave = useCallback((): Promise<void> => {
    if (inFlightRef.current) return inFlightRef.current;
    const drain = async () => {
      while (pendingBodyRef.current !== null) {
        const body = pendingBodyRef.current;
        pendingBodyRef.current = null;
        setSaveState("saving");
        try {
          const saved = await megaPost<Doc>(["docs", docId, "save"], { body });
          void queryClient.invalidateQueries({ queryKey: megaQueryKeys.embedResolves() });
          void queryClient.invalidateQueries({ queryKey: megaQueryKeys.docBacklinks(docId) });
          if (pendingBodyRef.current === null) {
            queryClient.setQueryData(megaQueryKeys.doc(docId), saved);
            void queryClient.invalidateQueries({ queryKey: megaQueryKeys.docs() });
            setDraftBody(null);
            setSaveState("saved");
          }
        } catch (error) {
          if (pendingBodyRef.current === null) pendingBodyRef.current = body;
          const conflict = error instanceof MegaApiError && error.status === 409;
          setSaveState(conflict ? "conflict" : "error");
          onToast({ tone: "error", message: conflict ? conflictMessage
            : error instanceof MegaApiError && error.status === 403 ? forbiddenError : genericError });
          throw error;
        }
      }
    };
    inFlightRef.current = drain().finally(() => { inFlightRef.current = null; });
    return inFlightRef.current;
  }, [conflictMessage, docId, forbiddenError, genericError, onToast, queryClient]);

  const canPublish = collabMode !== "readonly" && (collabMode !== "collab" || collabSynced);
  useEffect(() => {
    if (!publicationFlushRef) return;
    publicationFlushRef.current = async () => {
      if (!canPublish || !readStateRef.current) throw new Error("Editor is not ready for publication");
      pendingBodyRef.current = readStateRef.current();
      await flushSave();
    };
    return () => { publicationFlushRef.current = null; };
  }, [canPublish, flushSave, publicationFlushRef]);

  const onAutoSave = useCallback(
    (bodyJSON: string) => {
      if (collabMode === "readonly" || (collabMode === "collab" && !collabSynced)) return;
      if (collabMode === "local") setDraftBody(bodyJSON);
      onBodyChange?.(bodyJSON);
      pendingBodyRef.current = bodyJSON;
      void flushSave().catch(() => undefined);
    },
    [collabMode, collabSynced, flushSave, onBodyChange],
  );

  const saveLabel = saveChipLabel(saveState, collabMode, labels, conflictMessage);
  const collabLabel = collabChipLabel(collabMode, collabTokenQuery.isPending, labels);

  useEffect(() => {
    onChromeChange?.({
      canPublish,
      collabLabel,
      collabMode,
      saveLabel,
      saveState,
    });
  }, [canPublish, collabLabel, collabMode, onChromeChange, saveLabel, saveState]);

  return (
    <div
      data-mega-docs="editor"
      data-mega-content="outliner"
      style={{
        background: "transparent",
        border: "none",
        margin: 0,
        minHeight: 240,
        padding: 0,
        position: "relative",
      }}
    >
      {isEditorEmpty ? <div aria-hidden="true" data-mega-docs="empty-block-hint">{labels.placeholder}</div> : null}
      <MegaContentEditor
        collab={collabConfig}
        initialStateJSON={draftBody ?? doc.body}
        key={`${doc.id}-${collabMode}`}
        onAutoSave={onAutoSave}
        onChange={onBodyChange}
        placeholder={labels.placeholder}
        preset="document"
        registerStateReader={(readStateJSON) => {
          readStateRef.current = readStateJSON;
        }}
      >
        <DocumentEmptyStatePlugin onEmptyChange={onEditorEmptyChange} />
        <DocRoamShortcuts
          onOpenBlock={onOpenBlock}
          onReferenceCreateError={() => onToast({ tone: "error", message: genericError })}
        />
        {sidebar && collabMode !== "readonly" ? (
          <EditorMirrorPlugin target={sidebar.target} placeholder={labels.placeholder}>
            <DocRoamShortcuts
              focusOverride={{ blockId: sidebar.blockId, onFocus: sidebar.onFocus, onExit: sidebar.onClose }}
              onOpenBlock={sidebar.onFocus}
              onReferenceCreateError={() => onToast({ tone: "error", message: genericError })}
            />
          </EditorMirrorPlugin>
        ) : null}
      </MegaContentEditor>
    </div>
  );
}
