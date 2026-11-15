"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";
import { authClient } from "@/lib/auth-client";
import { fieldStyle, SettingsCard, SettingsToast } from "./settings-primitives";

type AuthSession = {
  id: string;
  token?: string;
  createdAt?: string;
  expiresAt?: string;
  userAgent?: string;
  ipAddress?: string;
};

function ensureAuthSuccess(result: unknown, fallback: string): void {
  if (result && typeof result === "object" && "error" in result && result.error) {
    const error = result.error as { message?: string };
    throw new Error(error.message || fallback);
  }
}

export function AccountSecuritySection() {
  const { t } = useTranslation();
  const text = t.workspace.settings.accountSecurity;
  const client = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [toast, setToast] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  const sessions = useQuery({
    queryKey: ["auth", "sessions"],
    queryFn: async () => {
      const result = await authClient.listSessions();
      ensureAuthSuccess(result, text.loadError);
      return (result.data ?? []) as unknown as AuthSession[];
    },
  });

  const password = useMutation({
    mutationFn: async () => {
      if (newPassword.length < 8) throw new Error(text.passwordTooShort);
      if (newPassword !== confirmPassword) throw new Error(text.passwordMismatch);
      ensureAuthSuccess(
        await authClient.changePassword({
          currentPassword,
          newPassword,
          revokeOtherSessions: true,
        }),
        text.changePasswordError,
      );
    },
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setToast({ tone: "success", message: text.changePasswordSuccess });
      void client.invalidateQueries({ queryKey: ["auth", "sessions"] });
    },
    onError: (reason) =>
      setToast({
        tone: "error",
        message: reason instanceof Error ? reason.message : text.changePasswordError,
      }),
  });

  const revoke = useMutation({
    mutationFn: async () => {
      ensureAuthSuccess(await authClient.revokeOtherSessions(), text.revokeOtherError);
    },
    onSuccess: () => {
      setToast({ tone: "success", message: text.revokeOtherSuccess });
      void client.invalidateQueries({ queryKey: ["auth", "sessions"] });
    },
    onError: (reason) =>
      setToast({
        tone: "error",
        message: reason instanceof Error ? reason.message : text.revokeOtherError,
      }),
  });

  if (sessions.isPending) {
    return <p aria-busy="true">{text.pageTitle}…</p>;
  }

  if (sessions.isError) {
    return (
      <div role="alert" style={{ display: "grid", gap: MEGA_SPACING_TOKENS[8] }}>
        <p>{text.loadError}</p>
        <button data-mega-settings="sessions-retry" onClick={() => void sessions.refetch()} type="button">
          {text.retry}
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}>
      {toast ? <SettingsToast tone={toast.tone}>{toast.message}</SettingsToast> : null}
      <SettingsCard>
        <h1 style={{ marginTop: 0 }}>{text.pageTitle}</h1>
        <p style={{ color: MEGA_TOKENS.muted }}>{text.pageDesc}</p>
        <h2>{text.changePasswordTitle}</h2>
        <p style={{ color: MEGA_TOKENS.muted }}>{text.changePasswordDesc}</p>
        <form
          data-mega-settings="change-password-form"
          onSubmit={(event) => {
            event.preventDefault();
            password.mutate();
          }}
          style={{ display: "grid", gap: MEGA_SPACING_TOKENS[8] }}
        >
          <label>
            {text.currentPassword}
            <input
              autoComplete="current-password"
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
              style={fieldStyle}
              type="password"
              value={currentPassword}
            />
          </label>
          <label>
            {text.newPassword}
            <input
              autoComplete="new-password"
              onChange={(event) => setNewPassword(event.target.value)}
              required
              style={fieldStyle}
              type="password"
              value={newPassword}
            />
          </label>
          <label>
            {text.confirmPassword}
            <input
              autoComplete="new-password"
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
              style={fieldStyle}
              type="password"
              value={confirmPassword}
            />
          </label>
          <button disabled={password.isPending} type="submit">
            {text.changePasswordSubmit}
          </button>
        </form>
      </SettingsCard>
      <SettingsCard>
        <h2 style={{ marginTop: 0 }}>{text.sessionSection}</h2>
        <p style={{ color: MEGA_TOKENS.muted }}>
          {text.sessionSummary.replace("{count}", String(sessions.data?.length ?? 0))}
        </p>
        {sessions.data?.map((session) => (
          <div
            data-mega-settings="session-row"
            key={session.id}
            style={{ borderTop: `1px solid ${MEGA_TOKENS.border}`, padding: MEGA_SPACING_TOKENS[8] }}
          >
            {session.userAgent ?? session.ipAddress ?? session.id}
          </div>
        ))}
        <button
          data-mega-settings="revoke-other-sessions"
          disabled={revoke.isPending}
          onClick={() => revoke.mutate()}
          type="button"
        >
          {text.sessionAction}
        </button>
      </SettingsCard>
    </div>
  );
}
