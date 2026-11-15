"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { megaGet, megaPost } from "@megaui/ui/query";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";
import { authClient } from "@/lib/auth-client";
import { fieldStyle, SettingsCard, SettingsToast } from "./settings-primitives";

type ProfilePrefs = {
  username: string;
  bio: string;
  directoryManaged?: boolean;
  notificationEmail?: string | null;
};

function ensureAuthSuccess(result: unknown, fallback: string): void {
  if (result && typeof result === "object" && "error" in result && result.error) {
    const error = result.error as { message?: string };
    throw new Error(error.message || fallback);
  }
}

type UploadApiErrorCode =
  | "UPLOAD_NO_FILE"
  | "UPLOAD_FILE_TOO_LARGE"
  | "UPLOAD_INVALID_TYPE"
  | "UPLOAD_INVALID_TYPE_AVATAR"
  | "UPLOAD_INVALID_EXTENSION"
  | "UPLOAD_FAILED"
  | "UPLOAD_FORBIDDEN_KEY";

class AvatarUploadError extends Error {
  readonly code: UploadApiErrorCode;
  constructor(code: UploadApiErrorCode, message?: string) {
    super(message || code);
    this.name = "AvatarUploadError";
    this.code = code;
  }
}

async function uploadAvatarFile(file: File): Promise<string> {
  const body = new FormData();
  body.append("file", file);
  body.append("purpose", "avatar");
  const response = await fetch("/api/upload?purpose=avatar", {
    method: "POST",
    body,
    credentials: "include",
  });
  const json = (await response.json()) as {
    data?: { url?: string };
    error?: { code?: string; message?: string };
  };
  if (!response.ok || !json.data?.url) {
    const raw = json.error?.code || "UPLOAD_FAILED";
    const code = (raw === "UPLOAD_INVALID_TYPE" ? "UPLOAD_INVALID_TYPE_AVATAR" : raw) as UploadApiErrorCode;
    throw new AvatarUploadError(code, json.error?.message);
  }
  return json.data.url;
}

export function ProfileForm({ enterprise }: { readonly enterprise?: boolean } = {}) {
  const { t } = useTranslation();
  const text = t.workspace.settings.profile;
  const uploadApiErrors = t.upload.apiErrors;
  const queryClient = useQueryClient();
  const session = authClient.useSession();
  const prefs = useQuery({ queryKey: ["mega", "profile-prefs"], queryFn: () => megaGet<ProfilePrefs>("profile-prefs") });
  const [name, setName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [bio, setBio] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const profileModeReady = enterprise !== undefined || prefs.data !== undefined;
  const directoryManaged = enterprise ?? prefs.data?.directoryManaged ?? false;

  function mapAvatarUploadError(reason: unknown): string {
    if (reason instanceof AvatarUploadError) {
      const template =
        reason.code === "UPLOAD_FILE_TOO_LARGE"
          ? uploadApiErrors.UPLOAD_FILE_TOO_LARGE.replace("{maxMb}", "1")
          : reason.code in uploadApiErrors
            ? uploadApiErrors[reason.code as keyof typeof uploadApiErrors]
            : null;
      if (template) return template;
    }
    return reason instanceof Error ? reason.message : text.avatarSaveError;
  }

  useEffect(() => {
    if (session.data?.user) {
      setName(session.data.user.name ?? "");
    }
  }, [session.data?.user?.id, session.data?.user?.name]);
  // Sync avatar from session only when the server reports a concrete URL.
  // Avoid wiping a just-uploaded preview if the client session briefly lags
  // with `image: null` after updateUser.
  useEffect(() => {
    const image = session.data?.user?.image;
    if (typeof image === "string" && image.length > 0) {
      setAvatarUrl(image);
    }
  }, [session.data?.user?.image]);
  useEffect(() => {
    if (prefs.data) setBio(prefs.data.bio);
  }, [prefs.data]);

  const save = useMutation({
    mutationFn: async () => {
      if (!profileModeReady) throw new Error(text.saveError);
      const trimmedName = name.trim();
      if (!directoryManaged && (!trimmedName || trimmedName.length > 60)) throw new Error(text.displayNameRequired);
      if (bio.length > 280) throw new Error(text.bioTooLong);
      if (!directoryManaged && avatarUrl && !/^https?:\/\/\S+$/i.test(avatarUrl)) throw new Error(text.avatarSaveError);
      if (!directoryManaged) {
        const userResult = await authClient.updateUser({ name: trimmedName, image: avatarUrl || null });
        ensureAuthSuccess(userResult, text.saveError);
      }
      return megaPost<ProfilePrefs>("profile-prefs", { bio });
    },
    onSuccess: () => {
      setError(null);
      setToast(text.saveSuccess);
      void queryClient.invalidateQueries({ queryKey: ["mega", "profile-prefs"] });
    },
    onError: (reason) => {
      setToast(null);
      setError(reason instanceof Error ? reason.message : text.saveError);
    },
  });

  const uploadAvatar = useMutation({
    mutationFn: async (file: File) => {
      if (!profileModeReady || directoryManaged) throw new Error(text.avatarSaveError);
      const url = await uploadAvatarFile(file);
      const userResult = await authClient.updateUser({ image: url });
      ensureAuthSuccess(userResult, text.avatarSaveError);
      return url;
    },
    onSuccess: (url) => {
      setAvatarUrl(url);
      setError(null);
      setToast(text.avatarSaveSuccess);
    },
    onError: (reason) => {
      setToast(null);
      setError(mapAvatarUploadError(reason));
    },
  });

  return (
    <SettingsCard>
      <h1 style={{ marginTop: 0 }}>{text.title}</h1>
      <p style={{ color: MEGA_TOKENS.muted }}>{text.subtitle}</p>
      {toast ? <SettingsToast tone="success">{toast}</SettingsToast> : null}
      {error ? <SettingsToast tone="error">{error}</SettingsToast> : null}
      {directoryManaged ? (
        <div data-mega-settings="directory-managed" role="note" style={{ border: `1px solid ${MEGA_TOKENS.border}`, borderRadius: 8, padding: MEGA_SPACING_TOKENS[8] }}>
          <strong>{text.directoryManagedTitle}</strong>
          <p style={{ color: MEGA_TOKENS.muted, marginBottom: 0 }}>{text.directoryManagedDescription}</p>
        </div>
      ) : null}
      {avatarUrl ? (
        <img alt="" data-mega-settings="avatar-preview" src={avatarUrl} style={{ borderRadius: "50%", height: 64, objectFit: "cover", width: 64 }} />
      ) : null}
      <label>
        {text.avatarUploadCta}
        <input
          accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml,image/bmp"
          data-mega-settings="avatar-file-input"
          disabled={!profileModeReady || directoryManaged || uploadAvatar.isPending}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) uploadAvatar.mutate(file);
          }}
          type="file"
        />
      </label>
      <form
        data-mega-settings="profile-form"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
        style={{ display: "grid", gap: MEGA_SPACING_TOKENS[8] }}
      >
        <label>
          {text.displayName}
          <input disabled={!profileModeReady || directoryManaged} onChange={(event) => setName(event.target.value)} style={fieldStyle} value={name} />
        </label>
        <label>
          {text.avatarUrlLabel}
          <input
            data-mega-settings="field-avatar-url"
            disabled={!profileModeReady || directoryManaged}
            onChange={(event) => setAvatarUrl(event.target.value)}
            placeholder={text.avatarUrlPlaceholder}
            style={fieldStyle}
            type="url"
            value={avatarUrl}
          />
        </label>
        <label>
          {text.username}
          <input disabled readOnly style={fieldStyle} value={prefs.data?.username ?? ""} />
          <small style={{ color: MEGA_TOKENS.muted }}>{text.usernameHint}</small>
        </label>
        <label>
          {text.notificationEmail}
          <input
            data-mega-settings="field-notification-email"
            disabled
            placeholder={text.notificationEmailMissing}
            readOnly
            style={fieldStyle}
            type="email"
            value={prefs.data?.notificationEmail ?? ""}
          />
          <small style={{ color: MEGA_TOKENS.muted }}>{text.notificationEmailHint}</small>
        </label>
        <label>
          {text.bio}
          <textarea
            data-mega-settings="field-bio"
            maxLength={281}
            onChange={(event) => setBio(event.target.value)}
            rows={4}
            style={fieldStyle}
            value={bio}
          />
          <small style={{ color: MEGA_TOKENS.muted }}>{bio.length}/280</small>
        </label>
        <button data-mega-settings="save" disabled={!profileModeReady || save.isPending} type="submit">
          {save.isPending ? text.saving : text.save}
        </button>
      </form>
    </SettingsCard>
  );
}
