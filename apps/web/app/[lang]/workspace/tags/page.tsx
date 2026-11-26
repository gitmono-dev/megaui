// megaui:apps/next-app/.../tags/page.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-16): lean releases list + draft dialog + publish
// (engine publishRelease via BFF); no asset upload (WA-19).
"use client";

import { WorkspaceLoading } from "../components/workspace-loading";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { Release } from "@megaui/core";
import { MegaApiError, megaGet, megaPost, megaQueryKeys } from "@megaui/ui/query";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";

const bodyFont = {
  color: MEGA_TOKENS.text,
  fontSize: "var(--mega-density-font-size)",
  fontWeight: 400,
} as const;

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export default function TagsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const tags = t.workspace.tags;
  const [draftOpen, setDraftOpen] = useState(false);
  const [tag, setTag] = useState("");
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [toast, setToast] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  const listQuery = useQuery({
    queryKey: megaQueryKeys.releases(),
    queryFn: () => megaGet<{ items: Release[]; total: number; offset: number; limit: number }>("releases"),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      megaPost<Release>("releases", {
        tag: tag.trim(),
        title: title.trim(),
        ...(notes.trim() ? { notes: [notes.trim()] } : {}),
      }),
    onSuccess: () => {
      setDraftOpen(false);
      setTag("");
      setTitle("");
      setNotes("");
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.releases() });
    },
    onError: () => setToast({ tone: "error", message: tags.draftDialog.genericError }),
  });

  const publishMutation = useMutation({
    mutationFn: (id: string) => megaPost<Release>(["releases", id, "publish"]),
    onSuccess: () => {
      setToast({ tone: "success", message: tags.publishSuccess });
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.releases() });
    },
    onError: (error) => {
      if (error instanceof MegaApiError && error.status === 409) {
        setToast({ tone: "error", message: tags.publishConflict });
        return;
      }
      setToast({ tone: "error", message: tags.publishError });
    },
  });

  if (listQuery.isPending) {
    return (
      <main aria-busy="true" data-mega-tags="page">
        <WorkspaceLoading label={tags.loading} variant="page" />
      </main>
    );
  }

  if (listQuery.isError) {
    return (
      <main data-mega-tags="page">
        <div role="alert" style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8], padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>
          <p style={{ ...bodyFont, margin: 0 }}>{tags.error}</p>
          <button data-mega-tags="retry" onClick={() => void listQuery.refetch()} type="button">
            {tags.retry}
          </button>
        </div>
      </main>
    );
  }

  const releases = listQuery.data?.items ?? [];

  return (
    <main data-mega-tags="page" style={{ ...bodyFont, padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>
      <header style={{ alignItems: "flex-start", display: "flex", gap: MEGA_SPACING_TOKENS[8], marginBottom: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: 0 }}>{tags.title}</h1>
          <p style={{ color: MEGA_TOKENS.muted, fontSize: "var(--mega-density-font-size)", fontWeight: 400, margin: `${MEGA_SPACING_TOKENS[4]} 0 0` }}>{tags.subtitle}</p>
        </div>
        <button data-mega-tags="open-draft" onClick={() => setDraftOpen(true)} type="button">
          {tags.draftRelease}
        </button>
      </header>

      {toast ? (
        <div
          data-mega-tags="toast"
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

      {draftOpen ? (
        <form
          data-mega-tags="draft-form"
          onSubmit={(event) => {
            event.preventDefault();
            createMutation.mutate();
          }}
          style={{
            background: MEGA_TOKENS.bg,
            border: `1px solid ${MEGA_TOKENS.border}`,
            borderRadius: MEGA_RADIUS_TOKENS.md,
            display: "grid",
            gap: MEGA_SPACING_TOKENS[8],
            marginBottom: `calc(${MEGA_SPACING_TOKENS[8]} * 2)`,
            padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2)`,
          }}
        >
          <h2 style={{ fontSize: "var(--mega-section-title-size)", fontWeight: 650, margin: 0 }}>{tags.draftDialog.title}</h2>
          <label style={{ display: "grid", gap: MEGA_SPACING_TOKENS[4] }}>
            {tags.draftDialog.tagLabel}
            <input data-mega-tags="draft-tag" onChange={(event) => setTag(event.target.value)} placeholder={tags.draftDialog.tagPlaceholder} required style={{ font: "inherit" }} value={tag} />
          </label>
          <label style={{ display: "grid", gap: MEGA_SPACING_TOKENS[4] }}>
            {tags.draftDialog.titleLabel}
            <input data-mega-tags="draft-title" onChange={(event) => setTitle(event.target.value)} placeholder={tags.draftDialog.titlePlaceholder} required style={{ font: "inherit" }} value={title} />
          </label>
          <label style={{ display: "grid", gap: MEGA_SPACING_TOKENS[4] }}>
            {tags.draftDialog.notesLabel}
            <textarea data-mega-tags="draft-notes" onChange={(event) => setNotes(event.target.value)} placeholder={tags.draftDialog.notesPlaceholder} rows={5} style={{ font: "inherit" }} value={notes} />
          </label>
          <div style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8], justifyContent: "flex-end" }}>
            <button data-mega-tags="draft-cancel" onClick={() => setDraftOpen(false)} type="button">
              {tags.draftDialog.cancel}
            </button>
            <button data-mega-tags="draft-submit" disabled={createMutation.isPending || !tag.trim() || !title.trim()} type="submit">
              {createMutation.isPending ? tags.draftDialog.submitting : tags.draftDialog.submit}
            </button>
          </div>
        </form>
      ) : null}

      <ul data-mega-tags="list" style={{ background: "transparent", border: 0, display: "grid", gap: `calc(${MEGA_SPACING_TOKENS[8]} * 2)`, listStyle: "none", margin: 0, padding: 0 }}>
        {releases.map((release) => (
          <li
            data-mega-tags="card"
            data-status={release.state}
            key={release.id}
            style={{
              display: "grid",
              gap: MEGA_SPACING_TOKENS[8],
              gridTemplateColumns: "minmax(140px, 200px) minmax(0, 1fr)",
            }}
          >
            <div style={{ paddingTop: MEGA_SPACING_TOKENS[8] }}>
              <div data-mega-tags="card-tag" style={{ fontWeight: 650 }}>{release.tag}</div>
              {release.targetSha ? (
                <div style={{ color: MEGA_TOKENS.muted, fontFamily: MEGA_TOKENS.fontMono, marginTop: MEGA_SPACING_TOKENS[4] }}>{shortSha(release.targetSha)}</div>
              ) : null}
              {release.publishedAt ? (
                <div style={{ color: MEGA_TOKENS.muted, marginTop: MEGA_SPACING_TOKENS[4] }}>{new Date(release.publishedAt).toLocaleDateString()}</div>
              ) : null}
            </div>
            <div
              style={{
                background: MEGA_TOKENS.bg,
                border: `1px solid ${MEGA_TOKENS.border}`,
                borderRadius: MEGA_RADIUS_TOKENS.md,
                minWidth: 0,
              }}
            >
              <div style={{ borderBottom: `1px solid ${MEGA_TOKENS.border}`, display: "flex", flexWrap: "wrap", gap: MEGA_SPACING_TOKENS[8], padding: MEGA_SPACING_TOKENS[8] }}>
                <h2 style={{ flex: 1, fontSize: "var(--mega-section-title-size)", fontWeight: 650, margin: 0, minWidth: 0 }}>{release.title}</h2>
                {release.state === "draft" ? (
                  <span data-mega-tags="draft-badge" style={{ color: MEGA_TOKENS.muted }}>{tags.card.draft}</span>
                ) : (
                  <span data-mega-tags="published-badge" style={{ color: MEGA_TOKENS.muted }}>{tags.pillLatest}</span>
                )}
                {release.state === "draft" ? (
                  <button
                    data-mega-tags="publish"
                    data-state={release.state}
                    disabled={publishMutation.isPending}
                    onClick={() => publishMutation.mutate(release.id)}
                    type="button"
                  >
                    {tags.publish}
                  </button>
                ) : null}
              </div>
              <div style={{ padding: MEGA_SPACING_TOKENS[8] }}>
                <p style={{ margin: `0 0 ${MEGA_SPACING_TOKENS[8]}` }}>
                  {release.author.displayName}
                  {release.publishedAt ? ` · ${new Date(release.publishedAt).toLocaleString()}` : ""}
                </p>
                {release.commitsSince > 0 ? (
                  <p style={{ color: MEGA_TOKENS.muted, margin: `0 0 ${MEGA_SPACING_TOKENS[8]}` }}>
                    {tags.card.commitsSince.replace("{count}", String(release.commitsSince)).replace("{since}", release.sinceTag ?? release.tag)}
                  </p>
                ) : null}
                {release.notes.length > 0 ? (
                  <ul style={{ margin: `0 0 ${MEGA_SPACING_TOKENS[8]}`, paddingLeft: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}>
                    {release.notes.map((note) => (
                      <li key={note.id}>{note.text}</li>
                    ))}
                  </ul>
                ) : null}
                {release.assets.length > 0 ? (
                  <div>
                    <h3 style={{ fontSize: "var(--mega-density-font-size)", fontWeight: 650, margin: `0 0 ${MEGA_SPACING_TOKENS[6]}` }}>{tags.card.assets.title}</h3>
                    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                      {release.assets.map((asset) => (
                        <li key={asset.id} style={{ alignItems: "center", borderTop: `1px solid ${MEGA_TOKENS.border}`, display: "flex", gap: MEGA_SPACING_TOKENS[8], padding: `${MEGA_SPACING_TOKENS[6]} 0` }}>
                          <a href={asset.downloadUrl}>{asset.name}</a>
                          <span style={{ color: MEGA_TOKENS.muted, marginLeft: "auto" }}>{formatBytes(asset.sizeBytes)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
