"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { megaDelete, megaGet, megaPost } from "@megaui/ui/query";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";
import { SettingsCard, SettingsToast } from "./settings-primitives";

type PersonalAccessToken = {
  id: number;
  maskedToken: string;
  createdAt: string;
};

const queryKey = ["mega", "user", "tokens"] as const;

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

export function TokensSection() {
  const { t } = useTranslation();
  const text = t.workspace.settings.tokens;
  const client = useQueryClient();
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PersonalAccessToken | null>(null);
  const [toast, setToast] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  const tokens = useQuery({
    queryKey,
    queryFn: () => megaGet<PersonalAccessToken[]>(["user", "tokens"]),
  });

  const generate = useMutation({
    mutationFn: () => megaPost<{ token: string }>(["user", "tokens", "generate"], {}),
    onSuccess: ({ token }) => {
      setPlaintext(token);
      setToast({ tone: "success", message: text.generateSuccess });
      void client.invalidateQueries({ queryKey });
    },
    onError: (reason) => setToast({
      tone: "error",
      message: reason instanceof Error ? reason.message : text.generateError,
    }),
  });

  const revoke = useMutation({
    mutationFn: (id: number) => megaDelete<{ deleted: true }>(["user", "tokens", String(id)]),
    onSuccess: (_, id) => {
      client.setQueryData<PersonalAccessToken[]>(queryKey, (rows) => rows?.filter((row) => row.id !== id) ?? []);
      setDeleteTarget(null);
      setToast({ tone: "success", message: text.deleteSuccess });
      void client.invalidateQueries({ queryKey });
    },
    onError: (reason) => setToast({
      tone: "error",
      message: reason instanceof Error ? reason.message : text.deleteError,
    }),
  });

  if (tokens.isPending) return <p aria-busy="true">{text.pageTitle}…</p>;
  if (tokens.isError) {
    return <div role="alert"><p>{text.loadError}</p><button onClick={() => void tokens.refetch()} type="button">{text.retry}</button></div>;
  }

  const rows = tokens.data ?? [];
  return (
    <div data-mega-settings="tokens" style={{ display: "grid", gap: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}>
      {toast ? <SettingsToast tone={toast.tone}>{toast.message}</SettingsToast> : null}
      <SettingsCard>
        <h1 style={{ marginTop: 0 }}>{text.pageTitle}</h1>
        <p style={{ color: MEGA_TOKENS.muted }}>{text.pageDesc}</p>
        <p style={{ color: MEGA_TOKENS.danger }}>{text.securityHint}</p>
        <button data-mega-settings="tokens-generate" disabled={generate.isPending} onClick={() => generate.mutate()} type="button">{text.generate}</button>
        <h2>{text.sectionLabel}</h2>
        {rows.length === 0 ? <p data-mega-settings="tokens-empty">{text.emptyDesc}</p> : (
          <div data-mega-settings="tokens-list" style={{ display: "grid", gap: MEGA_SPACING_TOKENS[3] }}>
            {rows.map((token) => (
              <div data-mega-settings="token-row" key={token.id} style={{ alignItems: "center", borderTop: `1px solid ${MEGA_TOKENS.border}`, display: "grid", gap: MEGA_SPACING_TOKENS[8], gridTemplateColumns: "1fr auto" }}>
                <div>
                  <code>{token.maskedToken}</code>
                  <small style={{ color: MEGA_TOKENS.muted, display: "block" }}>{text.created} {formatDate(token.createdAt)}</small>
                </div>
                <button data-mega-settings="token-delete" onClick={() => setDeleteTarget(token)} type="button">{text.deleteConfirm}</button>
              </div>
            ))}
          </div>
        )}
      </SettingsCard>
      {plaintext ? (
        <div data-mega-settings="tokens-reveal-modal">
        <SettingsCard>
          <h2 style={{ marginTop: 0 }}>{text.revealTitle}</h2>
          <p>{text.revealHint}</p>
          <code data-mega-settings="token-plaintext">{plaintext}</code>
          <div style={{ marginTop: MEGA_SPACING_TOKENS[8] }}>
            <button data-mega-settings="token-reveal-done" onClick={() => setPlaintext(null)} type="button">{text.revealConfirm}</button>
          </div>
        </SettingsCard>
        </div>
      ) : null}
      {deleteTarget ? (
        <SettingsCard>
          <h2 style={{ marginTop: 0 }}>{text.deleteModalTitle}</h2>
          <p>{text.deleteWarning}</p>
          <code>{deleteTarget.maskedToken}</code>
          <div style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8], marginTop: MEGA_SPACING_TOKENS[8] }}>
            <button onClick={() => setDeleteTarget(null)} type="button">{text.cancel}</button>
            <button data-mega-settings="token-delete-confirm" disabled={revoke.isPending} onClick={() => revoke.mutate(deleteTarget.id)} type="button">{text.deleteConfirm}</button>
          </div>
        </SettingsCard>
      ) : null}
    </div>
  );
}
