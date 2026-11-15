"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { megaDelete, megaGet, megaPost } from "@megaui/ui/query";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";
import { fieldStyle, SettingsCard, SettingsToast } from "./settings-primitives";

type SshKey = {
  id: number;
  title: string;
  fingerprint: string;
  createdAt: string;
};

const queryKey = ["mega", "user", "ssh"] as const;

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

export function SshKeysSection() {
  const { t } = useTranslation();
  const text = t.workspace.settings.ssh;
  const client = useQueryClient();
  const [title, setTitle] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SshKey | null>(null);
  const [toast, setToast] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  const keys = useQuery({
    queryKey,
    queryFn: () => megaGet<SshKey[]>(["user", "ssh"]),
  });

  const add = useMutation({
    mutationFn: () => megaPost<{ added: true }>(["user", "ssh"], { title: title.trim(), publicKey: publicKey.trim() }),
    onSuccess: () => {
      setTitle("");
      setPublicKey("");
      setToast({ tone: "success", message: text.addSuccess });
      void client.invalidateQueries({ queryKey });
    },
    onError: (reason) => setToast({
      tone: "error",
      message: reason instanceof Error ? reason.message : text.addError,
    }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => megaDelete<{ deleted: true }>(["user", "ssh", String(id)]),
    onSuccess: (_, id) => {
      client.setQueryData<SshKey[]>(queryKey, (rows) => rows?.filter((row) => row.id !== id) ?? []);
      setDeleteTarget(null);
      setToast({ tone: "success", message: text.deleteSuccess });
      void client.invalidateQueries({ queryKey });
    },
    onError: (reason) => setToast({
      tone: "error",
      message: reason instanceof Error ? reason.message : text.deleteError,
    }),
  });

  if (keys.isPending) return <p aria-busy="true">{text.pageTitle}…</p>;
  if (keys.isError) {
    return <div role="alert"><p>{text.loadError}</p><button onClick={() => void keys.refetch()} type="button">{text.retry}</button></div>;
  }

  const rows = keys.data ?? [];
  return (
    <div data-mega-settings="ssh-keys" style={{ display: "grid", gap: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}>
      {toast ? <SettingsToast tone={toast.tone}>{toast.message}</SettingsToast> : null}
      <SettingsCard>
        <h1 style={{ marginTop: 0 }}>{text.pageTitle}</h1>
        <p style={{ color: MEGA_TOKENS.muted }}>{text.pageDesc}</p>
        <h2>{text.sectionLabel}</h2>
        {rows.length === 0 ? <p data-mega-settings="ssh-empty">{text.emptyDesc}</p> : (
          <div data-mega-settings="ssh-list" style={{ display: "grid", gap: MEGA_SPACING_TOKENS[3] }}>
            {rows.map((key) => (
              <div data-mega-settings="ssh-row" key={key.id} style={{ alignItems: "center", borderTop: `1px solid ${MEGA_TOKENS.border}`, display: "grid", gap: MEGA_SPACING_TOKENS[8], gridTemplateColumns: "1fr auto" }}>
                <div>
                  <strong>{key.title}</strong>
                  <div data-mega-settings="ssh-fingerprint" style={{ color: MEGA_TOKENS.muted, fontFamily: "monospace" }}>{key.fingerprint}</div>
                  <small style={{ color: MEGA_TOKENS.muted }}>{text.addedOn.replace("{date}", formatDate(key.createdAt))}</small>
                </div>
                <button data-mega-settings="ssh-delete" onClick={() => setDeleteTarget(key)} type="button">{text.deleteConfirm}</button>
              </div>
            ))}
          </div>
        )}
        <form
          data-mega-settings="ssh-add-form"
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate();
          }}
          style={{ display: "grid", gap: MEGA_SPACING_TOKENS[8], marginTop: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}
        >
          <label>{text.titleField}<input data-mega-settings="ssh-add-title" onChange={(event) => setTitle(event.target.value)} required style={fieldStyle} value={title} /></label>
          <label>
            {text.publicKeyField}
            <textarea data-mega-settings="ssh-add-key" onChange={(event) => setPublicKey(event.target.value)} required rows={4} style={fieldStyle} value={publicKey} />
            <small style={{ color: MEGA_TOKENS.muted }}>{text.publicKeyHint}</small>
          </label>
          <button data-mega-settings="ssh-add" disabled={add.isPending} type="submit">{text.addConfirm}</button>
        </form>
      </SettingsCard>
      {deleteTarget ? (
        <SettingsCard>
          <h2 style={{ marginTop: 0 }}>{text.deleteModalTitle}</h2>
          <p>{text.deleteWarning.replace("{title}", deleteTarget.title)}</p>
          <div style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
            <button onClick={() => setDeleteTarget(null)} type="button">{text.cancel}</button>
            <button data-mega-settings="ssh-delete-confirm" disabled={remove.isPending} onClick={() => remove.mutate(deleteTarget.id)} type="button">{text.deleteConfirm}</button>
          </div>
        </SettingsCard>
      ) : null}
    </div>
  );
}
