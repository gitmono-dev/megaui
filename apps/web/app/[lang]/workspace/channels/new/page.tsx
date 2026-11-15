// megaui:apps/next-app/.../channels/new/page.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-14): lean create form — name/visibility/topic
// only; no Lexical topic editor or package picker.
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { WorkspaceChannel } from "@megaui/core";
import { MegaApiError, megaPost, megaQueryKeys } from "@megaui/ui/query";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";

export default function CreateChannelPage() {
  const { locale, t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const createText = t.workspace.chat.create;
  const workspaceBase = `/${locale}/workspace`;
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () =>
      megaPost<WorkspaceChannel>("channels", {
        name: name.trim(),
        visibility,
        ...(topic.trim() ? { topic: topic.trim() } : {}),
      }),
    onSuccess: (channel) => {
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.channels() });
      router.push(`${workspaceBase}/channels/${encodeURIComponent(channel.id)}`);
    },
    onError: (err) => {
      setError(
        err instanceof MegaApiError && err.status === 403
          ? t.errors.mega.forbidden
          : createText.error,
      );
    },
  });

  return (
    <main data-mega-chat="create" style={{ maxWidth: 480, padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>
      <Link href={`${workspaceBase}`}>{t.workspace.nav.channels}</Link>
      <h1 style={{ fontSize: "1.4rem", fontWeight: 700 }}>{createText.title}</h1>

      <form
        data-mega-chat="create-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          setError(null);
          createMutation.mutate();
        }}
        style={{ display: "flex", flexDirection: "column", gap: MEGA_SPACING_TOKENS[8] }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {createText.nameLabel}
          <input
            data-mega-chat="create-name"
            onChange={(event) => setName(event.target.value)}
            required
            style={{
              border: `1px solid ${MEGA_TOKENS.border}`,
              borderRadius: MEGA_RADIUS_TOKENS.md,
              padding: MEGA_SPACING_TOKENS[8],
            }}
            value={name}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {createText.topicLabel}
          <input
            data-mega-chat="create-topic"
            onChange={(event) => setTopic(event.target.value)}
            style={{
              border: `1px solid ${MEGA_TOKENS.border}`,
              borderRadius: MEGA_RADIUS_TOKENS.md,
              padding: MEGA_SPACING_TOKENS[8],
            }}
            value={topic}
          />
        </label>

        <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
          <legend>{createText.visibilityLabel}</legend>
          <label style={{ marginRight: MEGA_SPACING_TOKENS[8] }}>
            <input
              checked={visibility === "public"}
              data-mega-chat="create-visibility-public"
              name="visibility"
              onChange={() => setVisibility("public")}
              type="radio"
            />{" "}
            {createText.visibilityPublic}
          </label>
          <label>
            <input
              checked={visibility === "private"}
              data-mega-chat="create-visibility-private"
              name="visibility"
              onChange={() => setVisibility("private")}
              type="radio"
            />{" "}
            {createText.visibilityPrivate}
          </label>
        </fieldset>

        {error ? (
          <p data-mega-chat="create-error" role="alert" style={{ color: MEGA_TOKENS.danger }}>
            {error}
          </p>
        ) : null}

        <button data-mega-chat="create-submit" disabled={createMutation.isPending || !name.trim()} type="submit">
          {createText.submit}
        </button>
      </form>
    </main>
  );
}
