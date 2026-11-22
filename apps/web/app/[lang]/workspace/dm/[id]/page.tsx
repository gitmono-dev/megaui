// megaui:apps/next-app/.../dm/[username]/page.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-14 / RT-09): resolve DM by participant
// username; collection-room hints plus polling fallback.
"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import type { Channel, ChatMessage, DirectMessageChannel } from "@megaui/core";
import { megaGet, megaPost, megaQueryKeys } from "@megaui/ui/query";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { ChatComposer } from "../../channels/components/chat-composer";
import { MessageList } from "../../channels/components/message-list";
import { useChatCollectionSync } from "../../channels/hooks/use-chat-collection-sync";
import { useTranslation } from "@/hooks/use-translation";
import { authClient } from "@/lib/auth-client";
import { selfDisplayName } from "@/lib/self-display-name";

export default function DmPage() {
  const params = useParams<{ id: string }>();
  const { locale, t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();
  const chat = t.workspace.chat;
  const dmText = chat.dm;
  const workspaceBase = `/${locale}/workspace`;
  const username = decodeURIComponent(params?.id ?? "");
  const [toast, setToast] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  const channelsQuery = useQuery({
    queryKey: megaQueryKeys.channels(),
    queryFn: () => megaGet<Channel[]>("channels"),
  });

  const channel = useMemo(() => {
    return channelsQuery.data?.find(
      (item): item is DirectMessageChannel =>
        item.kind === "dm" && item.participant.username.toLowerCase() === username.toLowerCase(),
    );
  }, [channelsQuery.data, username]);

  const channelId = channel?.id ?? "";
  const selfUserId = session?.user?.id;
  const { refetchInterval } = useChatCollectionSync({
    channelId,
    enabled: Boolean(channelId),
    // FSL-183: the optimistic author name reads the own name only through `selfDisplayName`.
    localUser: selfUserId ? { id: selfUserId, name: selfDisplayName(session?.user) ?? undefined } : undefined,
  });

  const messagesQuery = useQuery({
    queryKey: megaQueryKeys.channelMessages(channelId),
    queryFn: () => megaGet<ChatMessage[]>(["channels", channelId, "messages"]),
    enabled: Boolean(channelId),
    refetchInterval,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: megaQueryKeys.channelMessages(channelId) });
    void queryClient.invalidateQueries({ queryKey: megaQueryKeys.channels() });
  };

  const sendMutation = useMutation({
    mutationFn: (body: string) => megaPost<ChatMessage>(["channels", channelId, "messages"], { body }),
    onSuccess: () => invalidate(),
    onError: () => setToast({ tone: "error", message: chat.sendError }),
  });

  const reactionMutation = useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) =>
      megaPost<ChatMessage>(["chat-messages", messageId, "reactions"], { emoji }),
    onSuccess: () => invalidate(),
    onError: () => setToast({ tone: "error", message: chat.reactionError }),
  });

  const editMutation = useMutation({
    mutationFn: ({ messageId, body }: { messageId: string; body: string }) =>
      megaPost<ChatMessage>(["chat-messages", messageId, "edit"], { body }),
    onSuccess: () => invalidate(),
    onError: () => setToast({ tone: "error", message: chat.editError }),
  });

  if (!username || (channelsQuery.isSuccess && !channel)) {
    return (
      <main data-mega-chat="dm">
        <div data-mega-chat="not-found" role="alert" style={{ padding: `calc(${MEGA_SPACING_TOKENS[8]} * 4)` }}>
          <h1 style={{ fontWeight: 700, margin: 0 }}>{dmText.notFound}</h1>
          <Link href={workspaceBase}>{t.workspace.nav.chat}</Link>
        </div>
      </main>
    );
  }

  if (channelsQuery.isPending || (channelId && messagesQuery.isPending)) {
    return (
      <main aria-busy="true" data-mega-chat="dm">
        <p style={{ color: MEGA_TOKENS.muted, padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>{chat.loading}</p>
      </main>
    );
  }

  if (channelsQuery.isError || messagesQuery.isError) {
    return (
      <main data-mega-chat="dm">
        <div role="alert" style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8], padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>
          <p style={{ margin: 0 }}>{dmText.notFound}</p>
          <button
            data-mega-chat="retry"
            onClick={() => {
              void channelsQuery.refetch();
              void messagesQuery.refetch();
            }}
            type="button"
          >
            {chat.retry}
          </button>
        </div>
      </main>
    );
  }

  const peer = channel!.participant;

  return (
    <main
      data-mega-chat="dm"
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 480, padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}
    >
      {toast ? (
        <div
          data-mega-chat="toast"
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

      <header style={{ borderBottom: `1px solid ${MEGA_TOKENS.border}`, paddingBottom: MEGA_SPACING_TOKENS[8] }}>
        <h1 data-mega-chat="dm-title" style={{ fontSize: "1.2rem", fontWeight: 700, margin: 0 }}>
          {peer.displayName}
        </h1>
        <p style={{ color: MEGA_TOKENS.muted, margin: 0 }}>@{peer.username}</p>
      </header>

      <MessageList
        cancelEditLabel={chat.list.cancelEdit}
        editedLabel={chat.list.edited}
        editLabel={chat.list.edit}
        jumpToLatestLabel={chat.list.jumpToLatest}
        listAriaLabel={chat.list.listAriaLabel}
        messages={messagesQuery.data ?? []}
        onEdit={(messageId, body) => editMutation.mutateAsync({ messageId, body })}
        onReaction={(messageId, emoji) => reactionMutation.mutate({ messageId, emoji })}
        reactionAddLabel="+"
        saveEditLabel={chat.list.saveEdit}
        selfUserId={selfUserId}
        threadRepliesLabel={(count) => chat.list.threadReplies.replace("{count}", String(count))}
      />

      <ChatComposer
        disabled={sendMutation.isPending}
        onSend={async (body) => {
          await sendMutation.mutateAsync(body);
        }}
        placeholder={dmText.placeholder.replace("{name}", peer.displayName)}
        sendAriaLabel={chat.composer.sendAriaLabel}
      />
    </main>
  );
}
