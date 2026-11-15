"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { megaGet, megaPut } from "@megaui/ui/query";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";
import { SettingsCard, SettingsToast } from "./settings-primitives";

type WorkspaceNotificationConfig = {
  settings: {
    enabled: boolean;
    deliveryMode?: "in_app" | "email" | string;
    preferredLocale?: string;
  };
  preferences: Array<{
    eventTypeCode: string;
    enabled: boolean;
    systemRequired?: boolean;
  }>;
};

type Draft = {
  enabled: boolean;
  deliveryMode: "in_app" | "email";
  preferredLocale: string;
  preferences: Array<{ eventTypeCode: string; enabled: boolean; systemRequired?: boolean }>;
};

export function NotificationsSection() {
  const { t } = useTranslation();
  const text = t.workspace.settings.notificationsPage;
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["mega", "user", "notifications"],
    queryFn: () => megaGet<WorkspaceNotificationConfig>(["user", "notifications"]),
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [toast, setToast] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    if (!query.data) return;
    setDraft({
      enabled: query.data.settings.enabled,
      deliveryMode: query.data.settings.deliveryMode === "email" ? "email" : "in_app",
      preferredLocale: query.data.settings.preferredLocale ?? "en",
      preferences: query.data.preferences.map((preference) => ({
        eventTypeCode: preference.eventTypeCode,
        enabled: preference.enabled,
        systemRequired: preference.systemRequired,
      })),
    });
  }, [query.data]);

  const save = useMutation({
    mutationFn: () => {
      if (!draft) throw new Error("missing draft");
      return megaPut<WorkspaceNotificationConfig>(["user", "notifications"], {
        enabled: draft.enabled,
        deliveryMode: draft.deliveryMode,
        preferredLocale: draft.preferredLocale,
        preferences: draft.preferences.map(({ eventTypeCode, enabled }) => ({ eventTypeCode, enabled })),
      });
    },
    onSuccess: () => {
      setToast({ tone: "success", message: text.saveSuccess });
      void client.invalidateQueries({ queryKey: ["mega", "user", "notifications"] });
    },
    onError: () => setToast({ tone: "error", message: text.saveError }),
  });

  if (query.isPending || !draft) {
    return <p aria-busy="true">{text.loading}</p>;
  }

  if (query.isError) {
    return (
      <div role="alert">
        <p>{text.loadError}</p>
        <button onClick={() => void query.refetch()} type="button">{text.retry}</button>
      </div>
    );
  }

  return (
    <SettingsCard>
      <h1 style={{ marginTop: 0 }}>{text.pageTitle}</h1>
      <p style={{ color: MEGA_TOKENS.muted }}>{text.pageDesc}</p>
      {toast ? <SettingsToast tone={toast.tone}>{toast.message}</SettingsToast> : null}
      <label>
        <input
          checked={draft.enabled}
          data-mega-settings="notifications-enabled"
          onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
          type="checkbox"
        />{" "}
        {text.globalTitle}
      </label>
      <p style={{ color: MEGA_TOKENS.muted }}>{text.globalDesc}</p>
      <label>
        {text.deliveryMode}{" "}
        <select
          data-mega-settings="notifications-delivery"
          onChange={(event) =>
            setDraft({ ...draft, deliveryMode: event.target.value as Draft["deliveryMode"] })
          }
          value={draft.deliveryMode}
        >
          <option value="in_app">{text.deliveryModeLabels.in_app}</option>
          <option value="email">{text.deliveryModeLabels.email}</option>
        </select>
      </label>
      <div style={{ display: "grid", gap: MEGA_SPACING_TOKENS[3], margin: `${MEGA_SPACING_TOKENS[8]} 0` }}>
        {draft.preferences.map((preference) => (
          <label key={preference.eventTypeCode}>
            <input
              checked={preference.enabled}
              disabled={preference.systemRequired}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  preferences: draft.preferences.map((item) =>
                    item.eventTypeCode === preference.eventTypeCode
                      ? { ...item, enabled: event.target.checked }
                      : item,
                  ),
                })
              }
              type="checkbox"
            />{" "}
            {text.eventLabels[preference.eventTypeCode as keyof typeof text.eventLabels] ??
              preference.eventTypeCode}
          </label>
        ))}
      </div>
      <button
        data-mega-settings="notifications-save"
        disabled={save.isPending}
        onClick={() => save.mutate()}
        type="button"
      >
        {save.isPending ? text.saving : text.save}
      </button>
    </SettingsCard>
  );
}
