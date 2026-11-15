/**
 * megaui:libs/react-shared/components/mega/collab/use-collection-room.ts@0ff3a9d
 * megaui:libs/mega/collab/collection.ts@0ff3a9d (constants/helpers only)
 *
 * Subscribe to a B-type collection room: live childIds + typing awareness + last-read
 * receipts. No-ops when `NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL` is unset (autosave / REST-only
 * mode — same "local mode, no silent data loss" contract as AC4 on the editor itself).
 * Room names come from `@megaui/core` (RT-02 / GC-02). This file observes
 * `revision` in addition to `childIds` (RT-08 megaui-only extension).
 */
"use client";

import {
  buildCollectionRoomName,
  COLLECTION_CHILD_IDS_KEY,
  COLLECTION_REVISION_KEY,
  COLLECTION_TYPE_CHANNEL,
} from "@megaui/core";
import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { ownBoundedWebsocketReconnect } from "./bounded-ws";

/** Doc comment timeline collection (DEFER-RT-03 — not opened by collab-server). */
const COLLECTION_TYPE_DOC = "doc" as const;
/** Per-user Inbox badge room (DEFER-RT-02 — not opened by collab-server). */
const COLLECTION_TYPE_INBOX = "inbox" as const;

const AWARENESS_TYPING_KEY = "typing" as const;
const AWARENESS_TYPING_AT_KEY = "typingAt" as const;
const AWARENESS_USER_KEY = "user" as const;
/** Peer-visible watermark for DM/channel read receipts. */
const AWARENESS_LAST_READ_KEY = "lastReadMessageId" as const;
const TYPING_IDLE_MS = 5_000;

/** Y.Map on inbox rooms: absolute unread count + bump clock. */
const INBOX_INDICATORS_MAP_KEY = "indicators" as const;
const INBOX_UNREAD_COUNT_FIELD = "unreadCount" as const;

export interface CollectionRevision {
  kind: string;
  messageId: string;
  at: number;
}

export function readCollectionRevision(map: Y.Map<unknown>): CollectionRevision | null {
  const kind = map.get("kind");
  const messageId = map.get("messageId");
  const at = map.get("at");
  if (typeof kind !== "string" || typeof messageId !== "string" || typeof at !== "number") {
    return null;
  }
  return { kind, messageId, at };
}

function clearTypingAwarenessPatch() {
  return {
    [AWARENESS_TYPING_KEY]: false,
    [AWARENESS_TYPING_AT_KEY]: 0,
  } as const;
}

export interface CollectionTypingPeer {
  clientId: number;
  userId: string;
  name?: string;
}

export interface CollectionPeerLastRead {
  userId: string;
  messageId: string;
}

export interface UseCollectionRoomOptions {
  collectionType: typeof COLLECTION_TYPE_CHANNEL | typeof COLLECTION_TYPE_DOC | string;
  collectionId: string;
  /** Session token for Hocuspocus auth (better-auth session token). */
  token: string | null | undefined;
  enabled?: boolean;
  /** Called when the remote childIds array changes (after initial sync). */
  onChildIdsChange?: (childIds: string[]) => void;
  /** Called when the remote revision map changes (after initial sync). */
  onRevisionChange?: (revision: CollectionRevision | null) => void;
  localUser?: { id: string; name?: string };
}

function resolveCollabPublicUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL?.trim();
  return raw || null;
}

/** Live B-type collection subscription (channel / doc comments / …). */
export function useCollectionRoom(options: UseCollectionRoomOptions): {
  connected: boolean;
  childIds: string[];
  revision: CollectionRevision | null;
  typingPeers: CollectionTypingPeer[];
  peerLastReads: CollectionPeerLastRead[];
  setTyping: (typing: boolean) => void;
  setLastRead: (messageId: string) => void;
} {
  const {
    collectionType,
    collectionId,
    token,
    enabled = true,
    onChildIdsChange,
    onRevisionChange,
    localUser,
  } = options;

  const [connected, setConnected] = useState(false);
  const [childIds, setChildIds] = useState<string[]>([]);
  const [revision, setRevision] = useState<CollectionRevision | null>(null);
  const [typingPeers, setTypingPeers] = useState<CollectionTypingPeer[]>([]);
  const [peerLastReads, setPeerLastReads] = useState<CollectionPeerLastRead[]>([]);
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const onChildIdsChangeRef = useRef(onChildIdsChange);
  onChildIdsChangeRef.current = onChildIdsChange;
  const onRevisionChangeRef = useRef(onRevisionChange);
  onRevisionChangeRef.current = onRevisionChange;
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localUserRef = useRef(localUser);
  localUserRef.current = localUser;
  /** Queue watermark if mark-read wins the race before provider connects. */
  const pendingLastReadRef = useRef<string | null>(null);

  const clearTypingTimers = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const publishLastRead = useCallback((messageId: string) => {
    const provider = providerRef.current;
    const user = localUserRef.current;
    const trimmed = messageId.trim();
    if (!provider || !user || !trimmed) return false;
    const awareness = provider.awareness;
    if (!awareness) return false;
    awareness.setLocalStateField(AWARENESS_USER_KEY, { id: user.id, name: user.name });
    awareness.setLocalStateField(AWARENESS_LAST_READ_KEY, trimmed);
    return true;
  }, []);

  const setTyping = useCallback(
    (typing: boolean) => {
      const provider = providerRef.current;
      const user = localUserRef.current;
      if (!provider || !user) return;
      const awareness = provider.awareness;
      if (!awareness) return;

      if (typing) {
        awareness.setLocalStateField(AWARENESS_USER_KEY, { id: user.id, name: user.name });
        awareness.setLocalStateField(AWARENESS_TYPING_KEY, true);
        awareness.setLocalStateField(AWARENESS_TYPING_AT_KEY, Date.now());
        clearTypingTimers();
        idleTimerRef.current = setTimeout(() => {
          awareness.setLocalStateField(AWARENESS_TYPING_KEY, false);
          awareness.setLocalStateField(AWARENESS_TYPING_AT_KEY, 0);
          idleTimerRef.current = null;
        }, TYPING_IDLE_MS);
      } else {
        clearTypingTimers();
        const clear = clearTypingAwarenessPatch();
        awareness.setLocalStateField(AWARENESS_TYPING_KEY, clear[AWARENESS_TYPING_KEY]);
        awareness.setLocalStateField(AWARENESS_TYPING_AT_KEY, clear[AWARENESS_TYPING_AT_KEY]);
      }
    },
    [clearTypingTimers],
  );

  const setLastRead = useCallback(
    (messageId: string) => {
      const trimmed = messageId.trim();
      if (!trimmed) return;
      pendingLastReadRef.current = trimmed;
      if (publishLastRead(trimmed)) {
        pendingLastReadRef.current = null;
      }
    },
    [publishLastRead],
  );

  useEffect(() => {
    const url = resolveCollabPublicUrl();
    if (!enabled || !url || !token || !collectionId || !collectionType) {
      setConnected(false);
      return;
    }

    const ydoc = new Y.Doc();
    const roomName = buildCollectionRoomName(collectionType, collectionId);
    const websocketProvider = new HocuspocusProviderWebsocket({
      url,
      autoConnect: false,
      maxAttempts: 1,
    });
    const provider = new HocuspocusProvider({
      websocketProvider,
      name: roomName,
      document: ydoc,
      token,
    });
    provider.attach();
    providerRef.current = provider;
    const lifecycle = ownBoundedWebsocketReconnect(websocketProvider);

    const childArray = ydoc.getArray<string>(COLLECTION_CHILD_IDS_KEY);
    const revisionMap = ydoc.getMap<unknown>(COLLECTION_REVISION_KEY);
    const syncChildren = () => {
      const next = childArray.toArray();
      setChildIds(next);
      onChildIdsChangeRef.current?.(next);
    };
    const syncRevision = () => {
      const next = readCollectionRevision(revisionMap);
      setRevision(next);
      onRevisionChangeRef.current?.(next);
    };
    childArray.observe(syncChildren);
    revisionMap.observe(syncRevision);

    const flushPendingLastRead = () => {
      const pending = pendingLastReadRef.current;
      if (!pending) return;
      if (publishLastRead(pending)) pendingLastReadRef.current = null;
    };

    const onSync = ({ state }: { state: boolean }) => {
      if (state) {
        setConnected(true);
        syncChildren();
        syncRevision();
        flushPendingLastRead();
      }
    };
    const onWsStatus = ({ status }: { status: string }) => {
      if (status === "disconnected") setConnected(false);
    };
    provider.on("synced", onSync);
    websocketProvider.on("status", onWsStatus);
    // Provider may already be connected by the time mark-read fires; also flush on status.
    provider.on("status", flushPendingLastRead);

    const refreshAwareness = () => {
      const awareness = provider.awareness;
      if (!awareness) return;
      const now = Date.now();
      const peers: CollectionTypingPeer[] = [];
      const reads: CollectionPeerLastRead[] = [];
      const localId = awareness.clientID;
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === localId) return;
        if (!state || typeof state !== "object") return;
        const record = state as Record<string, unknown>;
        const user = record[AWARENESS_USER_KEY];
        if (!user || typeof user !== "object") return;
        const userRecord = user as { id?: unknown; name?: unknown };
        if (typeof userRecord.id !== "string") return;

        const lastRead = record[AWARENESS_LAST_READ_KEY];
        if (typeof lastRead === "string" && lastRead.trim()) {
          reads.push({ userId: userRecord.id, messageId: lastRead.trim() });
        }

        if (record[AWARENESS_TYPING_KEY] !== true) return;
        const at = typeof record[AWARENESS_TYPING_AT_KEY] === "number" ? (record[AWARENESS_TYPING_AT_KEY] as number) : 0;
        if (!at || now - at >= TYPING_IDLE_MS) return;
        peers.push({
          clientId,
          userId: userRecord.id,
          name: typeof userRecord.name === "string" ? userRecord.name : undefined,
        });
      });
      setTypingPeers(peers);
      setPeerLastReads(reads);
    };

    provider.awareness?.on("change", refreshAwareness);
    const pruneTimer = setInterval(refreshAwareness, 1_000);

    return () => {
      clearInterval(pruneTimer);
      clearTypingTimers();
      childArray.unobserve(syncChildren);
      revisionMap.unobserve(syncRevision);
      provider.awareness?.off("change", refreshAwareness);
      provider.off("synced", onSync);
      provider.off("status", flushPendingLastRead);
      try {
        websocketProvider.off("status", onWsStatus);
      } catch {
        // ignore
      }
      lifecycle.dispose();
      void provider.destroy();
      try {
        websocketProvider.destroy();
      } catch {
        // ignore
      }
      ydoc.destroy();
      providerRef.current = null;
      setConnected(false);
      setChildIds([]);
      setRevision(null);
      setTypingPeers([]);
      setPeerLastReads([]);
    };
  }, [clearTypingTimers, collectionId, collectionType, enabled, publishLastRead, token]);

  return { connected, childIds, revision, typingPeers, peerLastReads, setTyping, setLastRead };
}

/** Live B-type channel collection subscription. */
export function useChannelCollectionRoom(options: {
  channelId: string;
  token: string | null | undefined;
  enabled?: boolean;
  onChildIdsChange?: (childIds: string[]) => void;
  onRevisionChange?: (revision: CollectionRevision | null) => void;
  localUser?: { id: string; name?: string };
}): ReturnType<typeof useCollectionRoom> {
  return useCollectionRoom({
    collectionType: COLLECTION_TYPE_CHANNEL,
    collectionId: options.channelId,
    token: options.token,
    enabled: options.enabled,
    onChildIdsChange: options.onChildIdsChange,
    onRevisionChange: options.onRevisionChange,
    localUser: options.localUser,
  });
}

/** Doc comment timeline typing. */
export function useDocCollectionRoom(options: {
  docId: string;
  token: string | null | undefined;
  enabled?: boolean;
  localUser?: { id: string; name?: string };
}): ReturnType<typeof useCollectionRoom> {
  return useCollectionRoom({
    collectionType: COLLECTION_TYPE_DOC,
    collectionId: options.docId,
    token: options.token,
    enabled: options.enabled,
    localUser: options.localUser,
  });
}

/** Shell Inbox badge room: observes absolute unreadCount on `collection:inbox:{userId}`. */
export function useInboxIndicatorsRoom(options: {
  userId: string | null | undefined;
  token: string | null | undefined;
  enabled?: boolean;
  onUnreadCount?: (count: number) => void;
}): {
  connected: boolean;
  unreadCount: number | null;
} {
  const { userId, token, enabled = true, onUnreadCount } = options;
  const [connected, setConnected] = useState(false);
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  const onUnreadCountRef = useRef(onUnreadCount);
  onUnreadCountRef.current = onUnreadCount;

  useEffect(() => {
    const url = resolveCollabPublicUrl();
    const trimmedUser = userId?.trim();
    if (!enabled || !url || !token || !trimmedUser) {
      setConnected(false);
      setUnreadCount(null);
      return;
    }

    const ydoc = new Y.Doc();
    const roomName = buildCollectionRoomName(COLLECTION_TYPE_INBOX, trimmedUser);
    const websocketProvider = new HocuspocusProviderWebsocket({
      url,
      autoConnect: false,
      maxAttempts: 1,
    });
    const provider = new HocuspocusProvider({
      websocketProvider,
      name: roomName,
      document: ydoc,
      token,
    });
    provider.attach();
    const lifecycle = ownBoundedWebsocketReconnect(websocketProvider);

    const map = ydoc.getMap<unknown>(INBOX_INDICATORS_MAP_KEY);
    const syncCount = () => {
      const raw = map.get(INBOX_UNREAD_COUNT_FIELD);
      if (typeof raw !== "number" || !Number.isFinite(raw)) return;
      const next = Math.max(0, Math.floor(raw));
      setUnreadCount(next);
      onUnreadCountRef.current?.(next);
    };
    map.observe(syncCount);

    const onSync = ({ state }: { state: boolean }) => {
      if (state) {
        setConnected(true);
        syncCount();
      }
    };
    const onWsStatus = ({ status }: { status: string }) => {
      if (status === "disconnected") setConnected(false);
    };
    provider.on("synced", onSync);
    websocketProvider.on("status", onWsStatus);

    return () => {
      map.unobserve(syncCount);
      provider.off("synced", onSync);
      try {
        websocketProvider.off("status", onWsStatus);
      } catch {
        // ignore
      }
      lifecycle.dispose();
      void provider.destroy();
      try {
        websocketProvider.destroy();
      } catch {
        // ignore
      }
      ydoc.destroy();
      setConnected(false);
      setUnreadCount(null);
    };
  }, [enabled, token, userId]);

  return { connected, unreadCount };
}
