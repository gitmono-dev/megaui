/**
 * Shared lifecycle for non-Lexical Hocuspocus rooms (presence / collection / inbox).
 *
 * HocuspocusProviderWebsocket's onClose path re-arms unbounded connect() after a
 * successful open (clears cancelWebsocketRetry while shouldConnect stays true).
 * We own retries via createBoundedReconnectScheduler and force shouldConnect=false
 * on each successful open — same contract as MegaDocCollabPlugin's doc provider.
 */
"use client";

import type { HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import {
  createBoundedReconnectScheduler,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_RECONNECT_BASE_DELAY_MS,
  DEFAULT_RECONNECT_MAX_DELAY_MS,
} from "../plugins/collab";

export function ownBoundedWebsocketReconnect(websocketProvider: HocuspocusProviderWebsocket): {
  dispose: () => void;
} {
  const scheduler = createBoundedReconnectScheduler({
    maxAttempts: DEFAULT_MAX_RECONNECT_ATTEMPTS,
    baseDelayMs: DEFAULT_RECONNECT_BASE_DELAY_MS,
    maxDelayMs: DEFAULT_RECONNECT_MAX_DELAY_MS,
  });
  let disposed = false;

  const connect = (): void => {
    if (disposed) return;
    void Promise.resolve(websocketProvider.connect()).catch(() => {
      // Status events report failure; never leave an unhandled rejection.
    });
  };

  const onStatus = ({ status }: { status: string }): void => {
    if (status === "connected") {
      websocketProvider.shouldConnect = false;
      scheduler.reset();
      return;
    }
    if (status === "disconnected" && !disposed) {
      scheduler.scheduleAttempt(connect);
    }
  };

  websocketProvider.on("status", onStatus);
  connect();

  return {
    dispose: () => {
      disposed = true;
      scheduler.dispose();
      try {
        websocketProvider.off("status", onStatus);
      } catch {
        // ignore
      }
      try {
        websocketProvider.cancelWebsocketRetry?.();
      } catch {
        // ignore
      }
      websocketProvider.shouldConnect = false;
    },
  };
}
