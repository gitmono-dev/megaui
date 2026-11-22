// megaui:apps/next-app/.../channels/[id]/page.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-14 / RT-09): collection-room hints plus
// polling fallback; plain-text composer; invite by userId; MessageList
// virtualizes via UI-08 fixed-row virtualizer.
"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import type { Channel, ChannelMember, ChatMessage, Thread, WorkspaceChannel } from "@megaui/core";
import { MegaApiError, megaDelete, megaGet, megaPost, megaQueryKeys } from "@megaui/ui/query";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";
import { authClient } from "@/lib/auth-client";
import { selfDisplayName } from "@/lib/self-display-name";

import { ChatComposer } from "../components/chat-composer";
import { MembersPanel } from "../components/members-panel";
import { MessageList } from "../components/message-list";
import { ThreadPanel } from "../components/thread-panel";
import { useChatCollectionSync } from "../hooks/use-chat-collection-sync";

export default function ChannelPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { locale, t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();
  const chat = t.workspace.chat;
  const workspaceBase = `/${locale}/workspace`;
  const channelId = decodeURIComponent(params?.id ?? "");
  const threadRootId = searchParams?.get("thread") ?? null;
  const [membersOpen, setMembersOpen] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  const selfUserId = session?.user?.id;

  const { refetchInterval } = useChatCollectionSync({
    channelId,
    enabled: Boolean(channelId),
    // FSL-183: the optimistic author name reads the own name only through `selfDisplayName`.
    localUser: selfUserId ? { id: selfUserId, name: selfDisplayName(session?.user) ?? undefined } : undefined,
    threadRootId,
  });

  const channelsQuery = useQuery({
    queryKey: megaQueryKeys.channels(),
    queryFn: () => megaGet<Channel[]>("channels"),
  });

  const channel = useMemo(() => {
    const found = channelsQuery.data?.find((item) => item.id === channelId);
    return found?.kind === "channel" ? (found as WorkspaceChannel) : undefined;
  }, [channelsQuery.data, channelId]);

  const messagesQuery = useQuery({
    queryKey: megaQueryKeys.channelMessages(channelId),
    queryFn: () => megaGet<ChatMessage[]>(["channels", channelId, "messages"]),
    enabled: Boolean(channelId) && channelsQuery.isSuccess && Boolean(channel),
    refetchInterval,
  });

  const threadsQuery = useQuery({
    queryKey: megaQueryKeys.channelThreads(channelId),
    queryFn: () => megaGet<Thread[]>(["channels", channelId, "threads"]),
    enabled: Boolean(channelId) && Boolean(channel),
    refetchInterval,
  });

  const membersQuery = useQuery({
    queryKey: megaQueryKeys.channelMembers(channelId),
    queryFn: () => megaGet<ChannelMember[]>(["channels", channelId, "members"]),
    enabled: Boolean(channelId) && membersOpen,
  });

  const threadQuery = useQuery({
    queryKey: megaQueryKeys.chatThread(threadRootId ?? ""),
    queryFn: () => megaGet<Thread>(["chat-threads", threadRootId!]),
    enabled: Boolean(threadRootId),
    refetchInterval: threadRootId ? refetchInterval : false,
    retry: (count, error) => !(error instanceof MegaApiError && error.status === 404) && count < 2,
  });

  const selfMember = membersQuery.data?.find((member) => member.userId === selfUserId);
  const canInvite = selfMember?.role === "admin";

  const threadRoots = useMemo(() => {
    const map = new Map<string, number>();
    for (const thread of threadsQuery.data ?? []) {
      // Engine Thread.messages is replies-only (root stays in channel list).
      map.set(thread.rootMessageId, thread.messages.length);
    }
    return map;
  }, [threadsQuery.data]);

  const invalidateChat = () => {
    void queryClient.invalidateQueries({ queryKey: megaQueryKeys.channelMessages(channelId) });
    void queryClient.invalidateQueries({ queryKey: megaQueryKeys.channelThreads(channelId) });
    void queryClient.invalidateQueries({ queryKey: megaQueryKeys.channels() });
    if (threadRootId) {
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.chatThread(threadRootId) });
    }
  };

  const sendMutation = useMutation({
    mutationFn: (body: string) => megaPost<ChatMessage>(["channels", channelId, "messages"], { body }),
    onSuccess: () => invalidateChat(),
    onError: () => setToast({ tone: "error", message: chat.sendError }),
  });

  const replyMutation = useMutation({
    mutationFn: (body: string) => megaPost<ChatMessage>(["chat-threads", threadRootId!, "reply"], { body }),
    onSuccess: () => invalidateChat(),
    onError: () => setToast({ tone: "error", message: chat.thread.replyError }),
  });

  const reactionMutation = useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) =>
      megaPost<ChatMessage>(["chat-messages", messageId, "reactions"], { emoji }),
    onSuccess: () => invalidateChat(),
    onError: () => setToast({ tone: "error", message: chat.reactionError }),
  });

  const editMutation = useMutation({
    mutationFn: ({ messageId, body }: { messageId: string; body: string }) =>
      megaPost<ChatMessage>(["chat-messages", messageId, "edit"], { body }),
    onSuccess: () => invalidateChat(),
    onError: () => setToast({ tone: "error", message: chat.editError }),
  });

  const inviteMutation = useMutation({
    mutationFn: (userId: string) =>
      megaPost<ChannelMember>(["channels", channelId, "members", "invite"], { userId }),
    onSuccess: () => {
      setInviteError(null);
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.channelMembers(channelId) });
    },
    onError: () => setInviteError(chat.members.inviteError),
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => megaDelete<{ removed: true }>(["channels", channelId, "members", userId]),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.channelMembers(channelId) });
    },
    onError: () => setToast({ tone: "error", message: chat.members.removeError }),
  });

  const leaveMutation = useMutation({
    mutationFn: () => megaPost<{ removed: true }>(["channels", channelId, "members", "leave"]),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.channels() });
      router.push(workspaceBase);
    },
    onError: () => setToast({ tone: "error", message: chat.members.removeError }),
  });

  const openThread = (rootMessageId: string) => {
    router.replace(`${workspaceBase}/channels/${encodeURIComponent(channelId)}?thread=${encodeURIComponent(rootMessageId)}`);
  };

  const closeThread = () => {
    router.replace(`${workspaceBase}/channels/${encodeURIComponent(channelId)}`);
  };

  if (!channelId || (channelsQuery.isSuccess && !channel)) {
    return (
      <main data-mega-chat="channel">
        <div data-mega-chat="not-found" role="alert" style={{ padding: `calc(${MEGA_SPACING_TOKENS[8]} * 4)` }}>
          <h1 style={{ fontWeight: 700, margin: 0 }}>{chat.notFound}</h1>
          <Link href={`${workspaceBase}/channels/new`}>{chat.create.title}</Link>
        </div>
      </main>
    );
  }

  if (channelsQuery.isPending || messagesQuery.isPending) {
    return (
      <main aria-busy="true" data-mega-chat="channel">
        <p style={{ color: MEGA_TOKENS.muted, padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>{chat.loading}</p>
      </main>
    );
  }

  if (channelsQuery.isError || messagesQuery.isError) {
    return (
      <main data-mega-chat="channel">
        <div role="alert" style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8], padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>
          <p style={{ margin: 0 }}>{chat.notFound}</p>
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

  const messages = messagesQuery.data ?? [];
  const rootMessage = threadRootId ? messages.find((message) => message.id === threadRootId) : undefined;
  const threadMessages = (() => {
    if (!threadRootId) return [];
    // Engine getChatThread returns replies only — prepend the channel root for panel context.
    if (threadQuery.data) {
      const replies = threadQuery.data.messages;
      return rootMessage ? [rootMessage, ...replies.filter((message) => message.id !== rootMessage.id)] : [...replies];
    }
    return rootMessage ? [rootMessage] : [];
  })();

  return (
    <main
      data-mega-chat="channel"
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

      <header
        style={{
          alignItems: "center",
          borderBottom: `1px solid ${MEGA_TOKENS.border}`,
          display: "flex",
          flexWrap: "wrap",
          gap: MEGA_SPACING_TOKENS[8],
          paddingBottom: MEGA_SPACING_TOKENS[8],
        }}
      >
        <h1 data-mega-chat="channel-title" style={{ fontSize: "1.2rem", fontWeight: 700, margin: 0 }}>
          #{channel!.name}
        </h1>
        {channel!.visibility === "private" ? (
          <span data-mega-chat="private-badge" style={{ color: MEGA_TOKENS.muted }}>
            {chat.header.privateBadge}
          </span>
        ) : null}
        <button
          aria-label={chat.header.openMembersAriaLabel}
          data-mega-chat="open-members"
          onClick={() => setMembersOpen(true)}
          style={{ marginLeft: "auto" }}
          type="button"
        >
          {chat.members.title}
        </button>
      </header>

      <div style={{ display: "flex", flex: 1, gap: MEGA_SPACING_TOKENS[8], minHeight: 0 }}>
        <div style={{ display: "flex", flex: 1, flexDirection: "column", minWidth: 0 }}>
          <MessageList
            cancelEditLabel={chat.list.cancelEdit}
            editedLabel={chat.list.edited}
            editLabel={chat.list.edit}
            jumpToLatestLabel={chat.list.jumpToLatest}
            listAriaLabel={chat.list.listAriaLabel}
            messages={messages}
            onEdit={(messageId, body) => editMutation.mutateAsync({ messageId, body })}
            onOpenThread={openThread}
            onReaction={(messageId, emoji) => reactionMutation.mutate({ messageId, emoji })}
            reactionAddLabel="+"
            saveEditLabel={chat.list.saveEdit}
            selfUserId={selfUserId}
            threadRepliesLabel={(count) => chat.list.threadReplies.replace("{count}", String(count))}
            threadRoots={threadRoots}
          />
          <ChatComposer
            disabled={sendMutation.isPending}
            onSend={async (body) => {
              await sendMutation.mutateAsync(body);
            }}
            placeholder={chat.composer.placeholder.replace("{name}", channel!.name)}
            sendAriaLabel={chat.composer.sendAriaLabel}
          />
        </div>

        {threadRootId ? (
          <ThreadPanel
            closeLabel={chat.thread.closeAriaLabel}
            loading={threadQuery.isPending}
            loadingLabel={chat.thread.loading}
            onClose={closeThread}
            onReply={async (body) => {
              await replyMutation.mutateAsync(body);
            }}
            replyAriaLabel={chat.thread.replyAriaLabel}
            replyPlaceholder={chat.thread.replyPlaceholder}
            sendAriaLabel={chat.thread.sendAriaLabel}
            sending={replyMutation.isPending}
            threadMessages={threadMessages}
            title={chat.thread.title}
          />
        ) : null}

        {membersOpen ? (
          <MembersPanel
            canInvite={Boolean(canInvite)}
            closeLabel={chat.members.close}
            emptyLabel={chat.members.empty}
            errorMessage={membersQuery.isError ? t.errors.mega.internal : null}
            inviteButtonLabel={chat.members.inviteButton}
            inviteError={inviteError}
            inviteHeading={chat.members.inviteHeading}
            invitePlaceholder={chat.members.inviteSearchPlaceholder}
            leaveLabel={chat.members.leave}
            loading={membersQuery.isPending}
            loadingLabel={chat.loading}
            members={membersQuery.data ?? []}
            onClose={() => setMembersOpen(false)}
            onInvite={async (userId) => {
              await inviteMutation.mutateAsync(userId);
            }}
            onLeave={async () => {
              await leaveMutation.mutateAsync();
            }}
            onRemove={async (userId) => {
              await removeMutation.mutateAsync(userId);
            }}
            onRetry={() => void membersQuery.refetch()}
            removeLabel={chat.members.remove}
            retryLabel={chat.retry}
            roleAdminLabel={chat.members.roleAdmin}
            roleMemberLabel={chat.members.roleMember}
            selfUserId={selfUserId}
            title={chat.members.title}
          />
        ) : null}
      </div>
    </main>
  );
}
