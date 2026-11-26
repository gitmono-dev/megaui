"use client";

// megaui-only: admin settings for the Markdown shown under the Code root list.
// mega2's admin group decides who may edit (BFF `admin/me`, fail-closed); the
// server re-checks on save, so this page only hides the editor from others.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { MEGA_CODE_README_MAX_LENGTH, type ProseBlock } from "@megaui/core";
import { MegaApiError, megaGet, megaPut, megaQueryKeys } from "@megaui/ui/query";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";
import { ReadmeProse } from "../../code/components/readme-prose";
import { fieldStyle, SettingsCard, SettingsToast } from "./settings-primitives";

interface CodeReadmeView {
  markdown: string;
  updatedAt: string | null;
  updatedBy: string | null;
  blocks: ProseBlock[];
}

interface AdminStatus {
  isAdmin: boolean;
}

export function CodeReadmeSection() {
  const { t } = useTranslation();
  const text = t.workspace.settings.codeReadmePage;
  const client = useQueryClient();

  const adminQuery = useQuery({
    queryKey: megaQueryKeys.adminMe(),
    queryFn: () => megaGet<AdminStatus>(["admin", "me"]),
  });
  const readmeQuery = useQuery({
    queryKey: megaQueryKeys.codeReadme(),
    queryFn: () => megaGet<CodeReadmeView>("code-readme"),
  });

  const [draft, setDraft] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    if (readmeQuery.data) setDraft(readmeQuery.data.markdown);
  }, [readmeQuery.data]);

  const save = useMutation({
    mutationFn: (markdown: string) => megaPut<CodeReadmeView>(["admin", "code-readme"], { markdown }),
    onSuccess: (saved) => {
      client.setQueryData(megaQueryKeys.codeReadme(), saved);
      setToast({ tone: "success", message: text.saveSuccess });
    },
    onError: (error) => {
      const forbidden = error instanceof MegaApiError && error.status === 403;
      setToast({ tone: "error", message: forbidden ? text.forbidden : text.saveError });
      if (forbidden) void adminQuery.refetch();
    },
  });

  if (adminQuery.isError || readmeQuery.isError) {
    return (
      <div data-mega-settings="code-readme-error" role="alert">
        <p>{text.loadError}</p>
        <button
          onClick={() => {
            if (adminQuery.isError) void adminQuery.refetch();
            if (readmeQuery.isError) void readmeQuery.refetch();
          }}
          type="button"
        >
          {text.retry}
        </button>
      </div>
    );
  }

  if (adminQuery.isPending || readmeQuery.isPending || draft === null) {
    return <p aria-busy="true">{text.loading}</p>;
  }

  if (!adminQuery.data.isAdmin) {
    return (
      <SettingsCard>
        <h1 style={{ marginTop: 0 }}>{text.pageTitle}</h1>
        <p data-mega-settings="code-readme-forbidden" role="alert" style={{ color: MEGA_TOKENS.muted }}>
          {text.forbidden}
        </p>
      </SettingsCard>
    );
  }

  const saved = readmeQuery.data;
  const tooLong = draft.length > MEGA_CODE_README_MAX_LENGTH;
  const unchanged = draft === saved.markdown;
  const maxLabel = MEGA_CODE_README_MAX_LENGTH.toLocaleString();

  return (
    <SettingsCard>
      <h1 style={{ marginTop: 0 }}>{text.pageTitle}</h1>
      <p style={{ color: MEGA_TOKENS.muted }}>{text.pageDesc}</p>
      {toast ? <SettingsToast tone={toast.tone}>{toast.message}</SettingsToast> : null}

      <label style={{ display: "grid", gap: MEGA_SPACING_TOKENS[3] }}>
        <span style={{ fontWeight: 600 }}>{text.editorLabel}</span>
        <textarea
          aria-invalid={tooLong}
          data-mega-settings="code-readme-editor"
          onChange={(event) => setDraft(event.target.value)}
          placeholder={text.editorPlaceholder}
          rows={16}
          spellCheck={false}
          style={{ ...fieldStyle, fontFamily: MEGA_TOKENS.fontMono, resize: "vertical" }}
          value={draft}
        />
      </label>
      <p
        data-mega-settings="code-readme-length"
        style={{ color: tooLong ? MEGA_TOKENS.danger : MEGA_TOKENS.muted, margin: `${MEGA_SPACING_TOKENS[3]} 0` }}
      >
        {tooLong
          ? text.tooLong.replace("{max}", maxLabel)
          : text.lengthHint.replace("{count}", draft.length.toLocaleString()).replace("{max}", maxLabel)}
      </p>
      {saved.updatedAt ? (
        <p style={{ color: MEGA_TOKENS.muted, margin: `0 0 ${MEGA_SPACING_TOKENS[8]}` }}>
          {text.lastUpdated.replace("{time}", new Date(saved.updatedAt).toLocaleString())}
        </p>
      ) : null}

      <button
        data-mega-settings="code-readme-save"
        disabled={save.isPending || tooLong || unchanged}
        onClick={() => save.mutate(draft)}
        type="button"
      >
        {save.isPending ? text.saving : text.save}
      </button>

      <h2 style={{ fontSize: "1rem", marginTop: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}>{text.previewTitle}</h2>
      <div
        data-mega-settings="code-readme-preview"
        style={{ border: `1px solid ${MEGA_TOKENS.border}`, borderRadius: MEGA_RADIUS_TOKENS.md }}
      >
        {saved.blocks.length > 0 ? (
          <ReadmeProse blocks={saved.blocks} />
        ) : (
          <p style={{ color: MEGA_TOKENS.muted, margin: 0, padding: MEGA_SPACING_TOKENS[8] }}>{text.previewEmpty}</p>
        )}
      </div>
    </SettingsCard>
  );
}
