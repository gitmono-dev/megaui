// megaui:apps/next-app/.../tags/page.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-16): lean releases list + draft dialog + publish
// (engine publishRelease via BFF); no asset upload (WA-19).
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { Release } from "@megaui/core";
import { MegaApiError, megaGet, megaPost, megaQueryKeys } from "@megaui/ui/query";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";

export default function TagsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const tags = t.workspace.tags;
  const [draftOpen, setDraftOpen] = useState(false);
  const [tag, setTag] = useState("");
  const [title, setTitle] = useState("");
  const [toast, setToast] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  const listQuery = useQuery({
    queryKey: megaQueryKeys.releases(),
    queryFn: () => megaGet<{ items: Release[]; total: number; offset: number; limit: number }>("releases"),
  });

  const createMutation = useMutation({
    mutationFn: () => megaPost<Release>("releases", { tag: tag.trim(), title: title.trim() }),
    onSuccess: () => {
      setDraftOpen(false);
      setTag("");
      setTitle("");
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
        <p style={{ color: MEGA_TOKENS.muted, padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>{tags.loading}</p>
      </main>
    );
  }

  if (listQuery.isError) {
    return (
      <main data-mega-tags="page">
        <div role="alert" style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8], padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>
          <p style={{ margin: 0 }}>{tags.error}</p>
          <button data-mega-tags="retry" onClick={() => void listQuery.refetch()} type="button">
            {tags.retry}
          </button>
        </div>
      </main>
    );
  }

  const releases = listQuery.data?.items ?? [];

  return (
    <main data-mega-tags="page" style={{ padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>
      <header style={{ alignItems: "center", display: "flex", gap: MEGA_SPACING_TOKENS[8], marginBottom: MEGA_SPACING_TOKENS[8] }}>
        <div>
          <h1 style={{ fontSize: "1.4rem", fontWeight: 700, margin: 0 }}>{tags.title}</h1>
          <p style={{ color: MEGA_TOKENS.muted, margin: 0 }}>{tags.subtitle}</p>
        </div>
        <button data-mega-tags="open-draft" onClick={() => setDraftOpen(true)} style={{ marginLeft: "auto" }} type="button">
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
            border: `1px solid ${MEGA_TOKENS.border}`,
            borderRadius: MEGA_RADIUS_TOKENS.md,
            display: "flex",
            flexDirection: "column",
            gap: MEGA_SPACING_TOKENS[8],
            marginBottom: MEGA_SPACING_TOKENS[8],
            padding: MEGA_SPACING_TOKENS[8],
          }}
        >
          <h2 style={{ margin: 0 }}>{tags.draftDialog.title}</h2>
          <label>
            {tags.draftDialog.tagLabel}
            <input data-mega-tags="draft-tag" onChange={(event) => setTag(event.target.value)} placeholder={tags.draftDialog.tagPlaceholder} required value={tag} />
          </label>
          <label>
            {tags.draftDialog.titleLabel}
            <input data-mega-tags="draft-title" onChange={(event) => setTitle(event.target.value)} placeholder={tags.draftDialog.titlePlaceholder} required value={title} />
          </label>
          <div style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
            <button data-mega-tags="draft-cancel" onClick={() => setDraftOpen(false)} type="button">
              {tags.draftDialog.cancel}
            </button>
            <button data-mega-tags="draft-submit" disabled={createMutation.isPending || !tag.trim() || !title.trim()} type="submit">
              {createMutation.isPending ? tags.draftDialog.submitting : tags.draftDialog.submit}
            </button>
          </div>
        </form>
      ) : null}

      <ul data-mega-tags="list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {releases.map((release) => (
          <li
            data-mega-tags="card"
            data-status={release.state}
            key={release.id}
            style={{ border: `1px solid ${MEGA_TOKENS.border}`, borderRadius: MEGA_RADIUS_TOKENS.md, marginBottom: MEGA_SPACING_TOKENS[8], padding: MEGA_SPACING_TOKENS[8] }}
          >
            <strong data-mega-tags="card-tag">{release.tag}</strong> — {release.title}
            {release.state === "draft" ? (
              <span data-mega-tags="draft-badge" style={{ color: MEGA_TOKENS.muted, marginLeft: MEGA_SPACING_TOKENS[8] }}>
                {tags.card.draft}
              </span>
            ) : (
              <span data-mega-tags="published-badge" style={{ color: MEGA_TOKENS.muted, marginLeft: MEGA_SPACING_TOKENS[8] }}>
                {tags.pillLatest}
              </span>
            )}
            <button
              data-mega-tags="publish"
              data-state={release.state}
              disabled={publishMutation.isPending}
              onClick={() => publishMutation.mutate(release.id)}
              style={{ marginLeft: MEGA_SPACING_TOKENS[8] }}
              type="button"
            >
              {tags.publish}
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
