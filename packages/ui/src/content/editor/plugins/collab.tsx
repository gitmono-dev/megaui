/**
 * megaui:libs/react-shared/components/mega/content/plugins/collab.tsx@0ff3a9d
 *
 * Lexical CollaborationPlugin + Hocuspocus A-type room + y-indexeddb offline. Adapts
 * Hocuspocus events (`synced`) to Lexical's Provider contract (`sync`).
 *
 * Diffs vs upstream (UI-06 card ACs, not present in the REF-05 source):
 * - `resolveCollabMode` is new: upstream only ever gated collab on all-three-present
 *   (`url && token && documentName`) and silently fell back to plain local/editable mode
 *   otherwise. This card's AC2 requires a *fail-closed* distinction: a configured collab
 *   `url` with a missing `token`/`documentName` means collaboration was intended but auth
 *   is incomplete, so the editor goes **read-only** rather than silently allowing
 *   unsynced local edits that a later successful collab connection could clobber. An unset
 *   `url` still means "local mode" (AC4) — plain editable, autosave-backed, no collab intent.
 * - `createBoundedReconnectScheduler` is new: upstream let `HocuspocusProviderWebsocket`
 *   manage its own (effectively unbounded) reconnect loop. AC2 requires bounded retry, so
 *   the websocket provider's own retry loop is disabled (`maxAttempts: 1` — one attempt per
 *   explicit `connect()` call) and reconnection is driven here with a capped, exponentially
 *   backed-off attempt counter; once exhausted, `onConnectionStatus('offline')` is reported
 *   and no further attempts are scheduled until something calls `connect()` again (e.g. the
 *   browser `online` handler, which also resets the counter).
 * - `awarenessRef` / block-hover-menu focus wiring is dropped (UI-07 / hover-menu concern,
 *   out of this card's write set).
 * - Soft `disconnect` (pause reconnect + websocket close) stays distinct from full
 *   `destroy`. The plugin owns final teardown on unmount, deferred across StrictMode
 *   effect replay, while Lexical may disconnect before the binding connects. Browser
 *   `offline` uses the soft path; `online` → `connect()` resets the reconnect budget.
 */
"use client";

import React, { useCallback, useEffect, useRef } from "react";
import type { Provider as LexicalYjsProvider } from "@lexical/yjs";
import { LexicalCollaboration } from "@lexical/react/LexicalCollaborationContext";
import { CollaborationPlugin } from "@lexical/react/LexicalCollaborationPlugin";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import type { Doc as YDoc } from "yjs";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { buildCollabAwarenessUser, listDocPresencePeers, publishLocalCaretAwareness } from "./caret";

export type DocCollabConnectionStatus = "connecting" | "connected" | "offline" | "auth-failed";

/** AC2/AC4: how {@link MegaContentEditor} should treat a collab config. */
export type CollabMode = "collab" | "readonly" | "local";

export interface MegaDocCollabConfig {
  /** A-type room name, e.g. `container:doc:<id>`. */
  documentName: string;
  /** Browser WS URL (NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL). */
  url: string;
  /** better-auth session token for onAuthenticate. Missing → fail-closed readonly (AC2). */
  token?: string | null;
  username?: string;
  /** Stable id for caret color + presence stack. */
  userId?: string;
  /** Override caret color; defaults to {@link colorFromUserId}(userId). */
  cursorColor?: string;
  /** Lexical JSON seed when the Y root is empty after first sync. */
  initialEditorStateJSON?: string;
  onConnectionStatus?: (status: DocCollabConnectionStatus) => void;
  /** Remote peers in the A-type room (excludes local). */
  onPresenceChange?: (peers: ReturnType<typeof listDocPresencePeers>) => void;
}

/**
 * Fail-closed collab mode resolver (AC2/AC4):
 * - no `url` → `local` (plain editable, autosave-backed; no collab was intended).
 * - `url` set but `token` or `documentName` missing → `readonly` (collab was intended but
 *   auth/room identity is incomplete — never silently allow unsynced local edits).
 * - all three present → `collab`.
 */
export function resolveCollabMode(
  config: Pick<MegaDocCollabConfig, "url" | "token" | "documentName"> | null | undefined,
): CollabMode {
  const url = config?.url?.trim();
  if (!url) {
    return "local";
  }
  const token = config?.token?.trim();
  const documentName = config?.documentName?.trim();
  if (!token || !documentName) {
    return "readonly";
  }
  return "collab";
}

type SyncListener = (isSynced: boolean) => void;

export type LexicalHocuspocusProviderHandle = LexicalYjsProvider & {
  destroy(): void;
};

/** Default bounded-reconnect policy (AC2: "connection failure retry bounded"). */
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
export const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
export const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;

export interface BoundedReconnectScheduler {
  /** Attempts consumed so far (resets to 0 after {@link BoundedReconnectScheduler.reset}). */
  readonly attempts: number;
  /** True once `attempts` has reached the configured cap. */
  readonly exhausted: boolean;
  /**
   * Schedules `connect` after an exponentially backed-off delay (capped at `maxDelayMs`).
   * Returns `false` without scheduling anything once exhausted.
   */
  scheduleAttempt(connect: () => void): boolean;
  /** Clears any pending attempt and zeroes the counter (call on a confirmed successful sync). */
  reset(): void;
  /** Clears any pending attempt without resetting the counter (call on teardown). */
  dispose(): void;
}

/**
 * Deterministic, timer-injectable bounded-reconnect policy (AC2). Kept decoupled from
 * Hocuspocus/WebSocket so it can be unit-tested with fake timers and no network.
 */
export function createBoundedReconnectScheduler(options: {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
} = {}): BoundedReconnectScheduler {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    get attempts() {
      return attempts;
    },
    get exhausted() {
      return maxAttempts > 0 && attempts >= maxAttempts;
    },
    scheduleAttempt(connect) {
      if (maxAttempts > 0 && attempts >= maxAttempts) {
        return false;
      }
      const delay = Math.min(baseDelayMs * 2 ** attempts, maxDelayMs);
      attempts += 1;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, delay);
      return true;
    },
    reset() {
      attempts = 0;
      clearTimer();
    },
    dispose() {
      clearTimer();
    },
  };
}

/**
 * Bridge HocuspocusProvider onto Lexical's yjs Provider interface.
 *
 * Critical: when an explicit `websocketProvider` is passed, Hocuspocus sets
 * `manageSocket=false` and `HocuspocusProvider.connect()` becomes a no-op. Lexical's
 * CollaborationPlugin only calls `provider.connect()`, so we must forward connect/disconnect
 * to the websocket ourselves (autoConnect: false). The websocket's own retry loop is capped
 * at one attempt per `connect()` call (`maxAttempts: 1`); reconnection beyond the first
 * attempt is driven by the bounded scheduler above.
 */
export function createLexicalHocuspocusProvider(options: {
  url: string;
  name: string;
  document: YDoc;
  token: string;
  /** Skip IndexedDB outside browsers (Node integration tests). */
  enableIndexedDb?: boolean;
  /**
   * Test seam: resolves when local persistence has finished loading into `document`.
   * Defaults to IndexeddbPersistence.whenSynced when IDB is enabled.
   */
  localPersistReady?: Promise<void>;
  /** Delay after connect before empty-doc offline bootstrap (must follow local persist). */
  offlineBootstrapMs?: number;
  /** AC2: bounded-reconnect policy override (tests only; defaults are production values). */
  reconnect?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number };
}): LexicalHocuspocusProviderHandle {
  const enableIndexedDb = options.enableIndexedDb ?? typeof indexedDB !== "undefined";
  const offlineBootstrapMs = options.offlineBootstrapMs ?? 2_000;
  const idb = enableIndexedDb ? new IndexeddbPersistence(options.name, options.document) : null;

  const websocketProvider = new HocuspocusProviderWebsocket({
    url: options.url,
    autoConnect: false,
    // One attempt per explicit connect() — we own cross-attempt retry (AC2).
    // After a successful open we force `shouldConnect=false` so Hocuspocus's
    // onClose setTimeout path cannot unboundedly call connect() again.
    maxAttempts: 1,
  });
  const hp = new HocuspocusProvider({
    websocketProvider,
    name: options.name,
    document: options.document,
    token: options.token,
  });
  hp.attach();

  const reconnectScheduler = createBoundedReconnectScheduler(options.reconnect);

  const syncCallbacks = new Set<SyncListener>();
  const syncListeners = new Map<SyncListener, (data: { state: boolean }) => void>();
  let forceSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let lexicalSynced = false;
  // Do not empty-bootstrap until local persist has finished (avoids REST seed racing IDB).
  let localPersistReady = !idb && !options.localPersistReady;
  let offlineTimerElapsed = false;
  /** Full teardown completed — never reconnect. */
  let disposed = false;
  /**
   * Soft-disconnect / browser-offline gate. Distinct from `disposed`: temporary
   * offline must not schedule reconnect attempts (would burn the AC2 budget and
   * fight `navigator.onLine === false`).
   */
  let reconnectEnabled = true;

  const emitLexicalSync = (state: boolean) => {
    if (state) lexicalSynced = true;
    for (const cb of syncCallbacks) cb(state);
  };

  const yDocHasContent = (): boolean => {
    try {
      return options.document.get("root", Y.XmlText).length > 0;
    } catch {
      return false;
    }
  };

  const maybeOfflineBootstrap = () => {
    if (lexicalSynced || hp.isSynced) return;
    if (!localPersistReady || !offlineTimerElapsed) return;
    emitLexicalSync(true);
  };

  const markLocalPersistReady = () => {
    localPersistReady = true;
    // Restored offline edits bind immediately. Empty store waits for WS sync or
    // the offline timer — never seed from REST before local persist settles.
    if (yDocHasContent()) {
      emitLexicalSync(true);
      return;
    }
    maybeOfflineBootstrap();
  };

  const persistSource = options.localPersistReady ?? (idb ? idb.whenSynced : Promise.resolve());
  // Hard ceiling so a hung IndexedDB open cannot block WS forever (Playwright / private modes).
  const persistReady = Promise.race([
    persistSource.then(() => undefined).catch(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, 2_500);
    }),
  ]);

  void persistReady.then(() => {
    markLocalPersistReady();
  });

  const connectWebsocket = (): void => {
    if (disposed || !reconnectEnabled) return;
    void Promise.resolve(websocketProvider.connect()).catch(() => {
      // Connection failures are surfaced via status events; never leave an
      // unhandled rejection (tests + Vitest treat those as hard failures).
    });
  };

  const beginNetwork = () => {
    connectWebsocket();
    if (forceSyncTimer) clearTimeout(forceSyncTimer);
    offlineTimerElapsed = false;
    forceSyncTimer = setTimeout(() => {
      offlineTimerElapsed = true;
      maybeOfflineBootstrap();
    }, offlineBootstrapMs);
  };

  const provider = {
    awareness: hp.awareness!,
    connect(): void {
      if (disposed) return;
      reconnectEnabled = true;
      // Fresh budget on every explicit connect (Lexical remount, browser online).
      reconnectScheduler.reset();
      // Defer WS until local persist has applied — prevents Lexical REST bootstrap
      // from winning over pending IndexedDB offline edits.
      if (localPersistReady) {
        beginNetwork();
        return;
      }
      void persistReady
        .then(() => {
          markLocalPersistReady();
          beginNetwork();
        })
        .catch(() => {
          markLocalPersistReady();
          beginNetwork();
        });
    },
    disconnect(): void {
      // Soft disconnect: Lexical StrictMode cleanup + browser offline both call
      // this. Must NOT destroy Hocuspocus/IndexedDB — CollaborationPlugin's
      // `isProviderInitialized` ref skips recreating the provider on remount.
      reconnectEnabled = false;
      reconnectScheduler.dispose();
      try {
        websocketProvider.disconnect();
      } catch {
        // Lexical disconnect is best-effort.
      }
    },
    destroy(): void {
      disposed = true;
      reconnectEnabled = false;
      if (forceSyncTimer) {
        clearTimeout(forceSyncTimer);
        forceSyncTimer = null;
      }
      reconnectScheduler.dispose();
      try {
        websocketProvider.cancelWebsocketRetry?.();
      } catch {
        // ignore
      }
      websocketProvider.shouldConnect = false;
      try {
        websocketProvider.disconnect();
      } catch {
        // best-effort
      }
      hp.detach();
      void idb?.destroy();
      try {
        websocketProvider.destroy();
      } catch {
        // ignore
      }
      hp.destroy();
    },
    on(type: string, cb: (...args: never[]) => void): void {
      if (type === "sync") {
        const syncCb = cb as SyncListener;
        syncCallbacks.add(syncCb);
        const wrapped = (data: { state: boolean }) => {
          if (!data?.state) return;
          if (forceSyncTimer) {
            clearTimeout(forceSyncTimer);
            forceSyncTimer = null;
          }
          reconnectScheduler.reset();
          // Defense in depth: never surface Lexical sync before local persist.
          if (!localPersistReady) {
            void persistReady.then(() => {
              markLocalPersistReady();
              emitLexicalSync(true);
            });
            return;
          }
          emitLexicalSync(true);
        };
        syncListeners.set(syncCb, wrapped);
        hp.on("synced", wrapped);
        return;
      }
      hp.on(type, cb as (...args: unknown[]) => void);
    },
    off(type: string, cb: (...args: never[]) => void): void {
      if (type === "sync") {
        const syncCb = cb as SyncListener;
        syncCallbacks.delete(syncCb);
        const wrapped = syncListeners.get(syncCb);
        if (wrapped) {
          hp.off("synced", wrapped);
          syncListeners.delete(syncCb);
        }
        return;
      }
      hp.off(type, cb as (...args: unknown[]) => void);
    },
  };

  // AC2 bounded reconnect: own every cross-attempt retry. Hocuspocus's built-in
  // onClose setTimeout reconnect is disabled after each successful open by
  // clearing `shouldConnect` (see status handler below).
  websocketProvider.on("status", ({ status }: { status: string }) => {
    if (status === "connected") {
      // Critical: without this, Hocuspocus schedules unbounded connect() on close
      // once cancelWebsocketRetry is cleared after a successful open.
      websocketProvider.shouldConnect = false;
      return;
    }
    if (status !== "disconnected") return;
    if (disposed || !reconnectEnabled) return;
    reconnectScheduler.scheduleAttempt(() => {
      connectWebsocket();
    });
  });

  return provider as unknown as LexicalHocuspocusProviderHandle;
}

function resolveDocFromMap(id: string, yjsDocMap: Map<string, YDoc>): YDoc {
  let doc = yjsDocMap.get(id);
  if (doc === undefined) {
    doc = new Y.Doc();
    yjsDocMap.set(id, doc);
  } else {
    doc.load();
  }
  return doc;
}

/**
 * Mount Lexical CollaborationPlugin for an A-type doc room. Parent must wrap the
 * LexicalComposer with {@link MegaDocCollabRoot}. Caller (MegaContentEditor) is responsible
 * for only mounting this when {@link resolveCollabMode} returns `"collab"`.
 */
export function MegaDocCollabPlugin({ config }: { config: MegaDocCollabConfig }): React.JSX.Element {
  const configRef = useRef(config);
  const providersRef = useRef(new Set<LexicalHocuspocusProviderHandle>());
  const cleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  configRef.current = config;

  useEffect(() => {
    if (cleanupTimerRef.current !== null) clearTimeout(cleanupTimerRef.current);
    cleanupTimerRef.current = null;
    return () => {
      cleanupTimerRef.current = setTimeout(() => {
        for (const provider of providersRef.current) provider.destroy();
        providersRef.current.clear();
        cleanupTimerRef.current = null;
      }, 0);
    };
  }, []);

  const providerFactory = useCallback((id: string, yjsDocMap: Map<string, YDoc>) => {
    // Lexical calls the factory again when its document or doc map changes.
    // Dispose the old provider before its callbacks can observe the new config.
    for (const previous of providersRef.current) previous.destroy();
    const doc = resolveDocFromMap(id, yjsDocMap);
    const current = configRef.current;
    const provider = createLexicalHocuspocusProvider({
      url: current.url,
      name: id,
      document: doc,
      token: current.token ?? "",
    });
    providersRef.current.add(provider);

    const report = (status: DocCollabConnectionStatus) => {
      configRef.current.onConnectionStatus?.(status);
    };
    report("connecting");

    const awareness = provider.awareness as unknown as
      | {
          clientID: number;
          getStates: () => Map<number, Record<string, unknown>>;
          setLocalStateField: (field: string, value: unknown) => void;
          on: (event: string, cb: () => void) => void;
          off: (event: string, cb: () => void) => void;
        }
      | null
      | undefined;

    const publishLocal = () => {
      if (!awareness) return;
      const cfg = configRef.current;
      const userId = cfg.userId ?? cfg.username ?? "anon";
      const username = cfg.username ?? userId;
      publishLocalCaretAwareness(
        awareness,
        buildCollabAwarenessUser({
          userId,
          username,
          cursorColor: cfg.cursorColor,
        }),
      );
    };

    const emitPresence = () => {
      if (!awareness) return;
      configRef.current.onPresenceChange?.(listDocPresencePeers(awareness));
    };

    if (awareness) {
      publishLocal();
      awareness.on("change", emitPresence);
      emitPresence();
    }

    // UI "Live" must mean Hocuspocus document sync — not Lexical offline bootstrap
    // (`sync`) and not bare WebSocket `connected` (fires before auth / isSynced). Lexical's
    // Provider `on()` typings only list a subset of events; Hocuspocus emits
    // authenticationFailed/synced/status on the same handle.
    type HocuspocusProviderEvents = {
      on(event: "status", cb: (payload: { status: string }) => void): void;
      on(event: "authenticationFailed", cb: () => void): void;
      on(event: "synced", cb: (data: { state?: boolean }) => void): void;
    };
    const hp = provider as LexicalHocuspocusProviderHandle & HocuspocusProviderEvents;
    hp.on("status", ({ status }) => {
      if (status === "disconnected") report("offline");
      else if (status === "connecting") report("connecting");
    });
    hp.on("authenticationFailed", () => {
      report("auth-failed");
    });
    hp.on("synced", (data) => {
      if (!data?.state) return;
      publishLocal();
      report("connected");
      emitPresence();
    });

    // Lexical and browser offline events use soft disconnect. The owning
    // component handles final teardown separately.
    const previousConnect = provider.connect.bind(provider);
    const softDisconnect = provider.disconnect.bind(provider);
    const previousDestroy = provider.destroy.bind(provider);

    const onBrowserOffline = () => {
      report("offline");
      try {
        softDisconnect();
      } catch {
        // best-effort
      }
    };
    const onBrowserOnline = () => {
      report("connecting");
      try {
        previousConnect();
      } catch {
        // best-effort
      }
    };

    const attachBrowserListeners = () => {
      if (typeof window === "undefined") return;
      window.addEventListener("offline", onBrowserOffline);
      window.addEventListener("online", onBrowserOnline);
    };
    const detachBrowserListeners = () => {
      if (typeof window === "undefined") return;
      window.removeEventListener("offline", onBrowserOffline);
      window.removeEventListener("online", onBrowserOnline);
    };

    provider.connect = () => {
      attachBrowserListeners();
      previousConnect();
    };
    provider.disconnect = () => {
      detachBrowserListeners();
      softDisconnect();
    };
    provider.destroy = () => {
      providersRef.current.delete(provider);
      awareness?.off("change", emitPresence);
      detachBrowserListeners();
      previousDestroy();
    };

    return provider;
  }, []);

  // CollaborationPlugin can disconnect before its binding mounts. The parent
  // owns final destruction so a Strict Mode effect replay cannot dispose a
  // provider that Lexical will subsequently connect.

  const resolvedCursorColor = (() => {
    if (config.cursorColor) return config.cursorColor;
    if (config.userId) {
      return buildCollabAwarenessUser({
        userId: config.userId,
        username: config.username ?? config.userId,
      }).color;
    }
    return undefined;
  })();

  return (
    <CollaborationPlugin
      id={config.documentName}
      initialEditorState={config.initialEditorStateJSON}
      providerFactory={providerFactory}
      shouldBootstrap
      username={config.username}
      cursorColor={resolvedCursorColor}
    />
  );
}

/** Collaboration context root — wrap LexicalComposer when collab is enabled. */
export function MegaDocCollabRoot({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <LexicalCollaboration>{children}</LexicalCollaboration>;
}

/** Resolve public collab WS URL for browser clients. */
export function resolveCollabPublicUrl(
  env?: { NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL?: string },
): string | null {
  // Next.js only inlines `process.env.NEXT_PUBLIC_*` on static property access.
  // Do not read via `process.env` as a whole — that stays empty in the browser bundle.
  // When an explicit `env` object is passed (tests), use only that object.
  const raw = (
    env !== undefined
      ? env.NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL
      : process.env.NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL
  )?.trim();
  return raw || null;
}
