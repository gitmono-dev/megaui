/**
 * megaui:libs/react-shared/components/mega/collab/use-doc-presence.ts@0ff3a9d
 * megaui:libs/mega/collab/container.ts@0ff3a9d (buildDocContainerRoomName only)
 *
 * Subscribe to an A-type doc room's awareness for the docs toolbar AvatarStack. Does not
 * bind Lexical — editors already join via `MegaDocCollabPlugin`. `buildDocContainerRoomName`
 * is inlined from an engine-core `libs/mega/collab/container.ts` module outside this card's
 * copy paths (a two-line room-naming helper, not worth a cross-package dependency for).
 */
"use client";

import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { buildCollabAwarenessUser, listDocPresencePeers, publishLocalCaretAwareness, type DocPresencePeer } from "../plugins/caret";
import { ownBoundedWebsocketReconnect } from "./bounded-ws";

export type { DocPresencePeer };

const CONTAINER_ROOM_PREFIX = "container:" as const;
const CONTAINER_TYPE_DOC = "doc" as const;

function buildDocContainerRoomName(docId: string): string {
  return `${CONTAINER_ROOM_PREFIX}${CONTAINER_TYPE_DOC}:${docId}`;
}

function resolveCollabPublicUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL?.trim();
  return raw || null;
}

export interface UseDocPresenceOptions {
  docId: string;
  token: string | null | undefined;
  enabled?: boolean;
  localUser?: { id: string; name?: string };
}

/** Live presence peers for `container:doc:<id>` (excludes local client). */
export function useDocPresenceRoom(options: UseDocPresenceOptions): {
  connected: boolean;
  peers: DocPresencePeer[];
} {
  const { docId, token, enabled = true, localUser } = options;
  const [connected, setConnected] = useState(false);
  const [peers, setPeers] = useState<DocPresencePeer[]>([]);
  const localUserRef = useRef(localUser);
  localUserRef.current = localUser;

  useEffect(() => {
    const url = resolveCollabPublicUrl();
    if (!enabled || !url || !token || !docId) {
      setConnected(false);
      setPeers([]);
      return;
    }

    const ydoc = new Y.Doc();
    const roomName = buildDocContainerRoomName(docId);
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

    const refresh = () => {
      const awareness = provider.awareness;
      if (!awareness) return;
      setPeers(listDocPresencePeers(awareness));
    };

    const onSync = ({ state }: { state: boolean }) => {
      if (state) setConnected(true);
      const user = localUserRef.current;
      if (state && user && provider.awareness) {
        publishLocalCaretAwareness(
          provider.awareness,
          buildCollabAwarenessUser({
            userId: user.id,
            username: user.name ?? user.id,
          }),
        );
      }
      refresh();
    };

    const onWsStatus = ({ status }: { status: string }) => {
      if (status === "disconnected") setConnected(false);
    };

    provider.on("synced", onSync);
    websocketProvider.on("status", onWsStatus);
    provider.awareness?.on("change", refresh);

    return () => {
      provider.awareness?.off("change", refresh);
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
      setPeers([]);
    };
  }, [docId, enabled, token]);

  return { connected, peers };
}
