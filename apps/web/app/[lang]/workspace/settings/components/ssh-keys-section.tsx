"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useId, useState } from "react";
import { megaDelete, megaGet, megaPost } from "@megaui/ui/query";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";
import { fieldStyle, SettingsCard, SettingsToast } from "./settings-primitives";

type GpgKey = { id: string; fingerprint: string; createdAt: string; expiresAt: string | null };

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

type KeyKind = "ssh" | "gpg";

function KeyList<T extends { id: string | number; title?: string; fingerprint: string; createdAt: string }>({
  kind, rows, status, onRetry, onDelete,
}: {
  kind: KeyKind;
  rows: T[];
  status: "pending" | "error" | "success";
  onRetry: () => void;
  onDelete: (row: T) => void;
}) {
  const { t } = useTranslation();
  const text = t.workspace.settings.ssh;
  if (status === "pending") return <p aria-busy="true">{kind === "ssh" ? text.title : text.gpgSection}…</p>;
  if (status === "error") {
    return (
      <div role="alert">
        <p>{text.loadError}</p>
        <button type="button" onClick={onRetry}>{text.retry}</button>
      </div>
    );
  }
  if (rows.length === 0) {
    return <p data-mega-settings={`${kind}-empty`}>{kind === "ssh" ? text.emptyDesc : text.gpgEmpty}</p>;
  }
  return (
    <div data-mega-settings={`${kind}-list`} style={{ border: `1px solid ${MEGA_TOKENS.border}`, borderRadius: 6, overflow: "hidden" }}>
      {rows.map((row) => (
        <div key={row.id} data-mega-settings={`${kind}-row`} style={{
          alignItems: "center",
          borderTop: `1px solid ${MEGA_TOKENS.border}`,
          display: "grid",
          gap: MEGA_SPACING_TOKENS[8],
          gridTemplateColumns: "minmax(0, 1fr) auto",
          padding: 16,
        }}>
          <div style={{ overflowWrap: "anywhere" }}>
            <strong>{row.title ?? row.id}</strong>
            <div data-mega-settings={`${kind}-fingerprint`} style={{ color: MEGA_TOKENS.muted, fontFamily: "monospace" }}>{row.fingerprint}</div>
            <small style={{ color: MEGA_TOKENS.muted }}>{text.addedOn.replace("{date}", formatDate(row.createdAt))}</small>
          </div>
          <button data-mega-settings={`${kind}-delete`} onClick={() => onDelete(row)} type="button">{text.deleteConfirm}</button>
        </div>
      ))}
    </div>
  );
}

function AddKeyForm({ kind, value, onChange, pending, onSubmit, children }: {
  kind: KeyKind;
  value: string;
  onChange: (value: string) => void;
  pending: boolean;
  onSubmit: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const text = t.workspace.settings.ssh;
  const fieldId = useId();
  const hintId = `${fieldId}-hint`;
  return (
    <form
      data-mega-settings={`${kind}-add-form`}
      onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
      style={{ display: "grid", gap: MEGA_SPACING_TOKENS[8], marginTop: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}
    >
      {children}
      <div style={{ fontSize: "var(--mega-density-font-size)" }}>
        <label htmlFor={fieldId}>{text.publicKeyField}</label>
        <textarea
          id={fieldId}
          aria-describedby={hintId}
          data-mega-settings={`${kind}-add-key`}
          required
          rows={4}
          style={fieldStyle}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <small id={hintId} style={{ color: MEGA_TOKENS.muted }}>{kind === "ssh" ? text.publicKeyHint : text.gpgPublicKeyHint}</small>
      </div>
      <button data-mega-settings={`${kind}-add`} disabled={pending} type="submit">
        {kind === "ssh" ? text.addConfirm : text.gpgAdd}
      </button>
    </form>
  );
}

export function SshKeysSection() {
  const { t } = useTranslation();
  const text = t.workspace.settings.ssh;
  const client = useQueryClient();
  const [gpgPublicKey, setGpgPublicKey] = useState("");
  const [showSshForm, setShowSshForm] = useState(false);
  const [showGpgForm, setShowGpgForm] = useState(false);
  const [deleteGpgTarget, setDeleteGpgTarget] = useState<GpgKey | null>(null);
  const [title, setTitle] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SshKey | null>(null);
  const [toast, setToast] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  const keys = useQuery({
    queryKey,
    queryFn: () => megaGet<SshKey[]>(["user", "ssh"]),
  });

  const gpgKeys = useQuery({ queryKey: ["mega", "user", "gpg"], queryFn: () => megaGet<GpgKey[]>(["user", "gpg"]) });
  const addGpg = useMutation({
    mutationFn: () => megaPost(["user", "gpg"], { publicKey: gpgPublicKey.trim() }),
    onSuccess: () => { setGpgPublicKey(""); setShowGpgForm(false); void client.invalidateQueries({ queryKey: ["mega", "user", "gpg"] }); },
    onError: reason => setToast({ tone: "error", message: reason instanceof Error ? reason.message : text.gpgError }),
  });
  const removeGpg = useMutation({
    mutationFn: (id: string) => megaDelete(["user", "gpg", id]),
    onSuccess: () => { setDeleteGpgTarget(null); void client.invalidateQueries({ queryKey: ["mega", "user", "gpg"] }); },
    onError: reason => setToast({ tone: "error", message: reason instanceof Error ? reason.message : text.gpgError }),
  });

  const add = useMutation({
    mutationFn: () => megaPost<{ added: true }>(["user", "ssh"], { title: title.trim(), publicKey: publicKey.trim() }),
    onSuccess: () => {
      setShowSshForm(false);
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

  return (
    <div data-mega-settings="ssh-keys" style={{ display: "grid", gap: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}>
      <h1 className="sr-only">{text.pageTitle}</h1>
      {toast ? <SettingsToast tone={toast.tone}>{toast.message.trimEnd().replace(/[.。]+$/u, "")}</SettingsToast> : null}
      <SettingsCard>
        <header>
          <h2>{text.title}</h2>
          <button type="button" aria-expanded={showSshForm} onClick={() => setShowSshForm(!showSshForm)}>{text.add}</button>
        </header>
        <p style={{ color: MEGA_TOKENS.muted }}>{text.pageDesc}</p>
        <h3>{text.sectionLabel}</h3>
        <KeyList kind="ssh" rows={keys.data ?? []} status={keys.status} onRetry={() => void keys.refetch()} onDelete={setDeleteTarget} />
        {showSshForm && (
          <AddKeyForm kind="ssh" value={publicKey} onChange={setPublicKey} pending={add.isPending} onSubmit={() => add.mutate()}>
            <label>
              {text.titleField}
              <input data-mega-settings="ssh-add-title" onChange={(event) => setTitle(event.target.value)} required style={fieldStyle} value={title} />
            </label>
          </AddKeyForm>
        )}
      </SettingsCard>
      <SettingsCard>
        <header>
          <h2>{text.gpgSection}</h2>
          <button type="button" aria-expanded={showGpgForm} onClick={() => setShowGpgForm(!showGpgForm)}>{text.gpgAdd}</button>
        </header>
        <p style={{ color: MEGA_TOKENS.muted }}>{text.gpgDesc}</p>
        <KeyList kind="gpg" rows={gpgKeys.data ?? []} status={gpgKeys.status} onRetry={() => void gpgKeys.refetch()} onDelete={setDeleteGpgTarget} />
        {showGpgForm && (
          <AddKeyForm kind="gpg" value={gpgPublicKey} onChange={setGpgPublicKey} pending={addGpg.isPending} onSubmit={() => addGpg.mutate()} />
        )}
      </SettingsCard>
      {deleteGpgTarget && (
        <SettingsCard>
          <h2 style={{ marginTop: 0 }}>{text.gpgDeleteTitle}</h2>
          <p>{deleteGpgTarget.id}</p>
          <div style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
            <button type="button" onClick={() => setDeleteGpgTarget(null)}>{text.cancel}</button>
            <button data-mega-settings="gpg-delete-confirm" type="button" disabled={removeGpg.isPending} onClick={() => removeGpg.mutate(deleteGpgTarget.id)}>{text.deleteConfirm}</button>
          </div>
        </SettingsCard>
      )}
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
