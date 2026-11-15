"use client";

import { buildChannelCollectionRoomName } from "@megaui/core";
import { useChannelCollectionRoom } from "@megaui/ui/content/editor";
import { megaGet, megaQueryKeys } from "@megaui/ui/query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

const POLL_MS = 15_000;

export function useChatCollectionSync(options: {
  channelId: string;
  enabled: boolean;
  localUser?: { id: string; name?: string };
  threadRootId?: string | null;
}): { refetchInterval: number | false; connected: boolean } {
  const queryClient = useQueryClient();
  const collabUrl = process.env.NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL?.trim() ?? "";
  const roomName = options.channelId ? buildChannelCollectionRoomName(options.channelId) : "";
  const threadRootId = options.threadRootId ?? null;

  const tokenQuery = useQuery({
    queryKey: ["mega", "collab-token", roomName],
    queryFn: () => megaGet<{ token: string }>(["collab", "token"], { room: roomName }),
    enabled: Boolean(collabUrl) && Boolean(options.channelId) && options.enabled,
    staleTime: 30 * 60 * 1000,
  });

  const invalidate = useCallback(() => {
    if (!options.channelId) return;
    void queryClient.invalidateQueries({ queryKey: megaQueryKeys.channelMessages(options.channelId) });
    void queryClient.invalidateQueries({ queryKey: megaQueryKeys.channelThreads(options.channelId) });
    void queryClient.invalidateQueries({ queryKey: megaQueryKeys.channels() });
    if (threadRootId) {
      void queryClient.invalidateQueries({ queryKey: megaQueryKeys.chatThread(threadRootId) });
    }
  }, [options.channelId, queryClient, threadRootId]);

  const room = useChannelCollectionRoom({
    channelId: options.channelId,
    token: tokenQuery.data?.token,
    enabled: Boolean(collabUrl) && options.enabled && Boolean(options.channelId),
    onChildIdsChange: invalidate,
    onRevisionChange: invalidate,
    localUser: options.localUser,
  });

  return {
    refetchInterval: collabUrl && room.connected ? false : POLL_MS,
    connected: room.connected,
  };
}
