// @vitest-environment happy-dom
// megaui-only (FSL-183): the real `DocWriter` hands the collab presence username (seen by
// other collaborators) from `selfDisplayName(session.user) ?? profilePrefs.username`. Only
// the editor boundary (the `next/dynamic` editor, replaced by a double that records the
// collab config it receives), `authClient.useSession` (an external store, like the real
// hook) and the BFF requests (`fetch`) are test doubles.
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Doc } from "@megaui/core";
import type { MegaDocCollabConfig } from "@megaui/ui/content/editor";

const boundary = vi.hoisted(() => {
  let snapshot: { data: { user: Record<string, unknown> } | null; isPending: boolean } = { data: null, isPending: true };
  const listeners = new Set<() => void>();
  return {
    collab: [] as (MegaDocCollabConfig | undefined)[],
    prefsUsername: undefined as string | undefined,
    setUser(user: Record<string, unknown> | null, isPending = false) {
      snapshot = { data: user ? { user } : null, isPending };
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => snapshot,
  };
});
vi.mock("next/dynamic", () => ({
  default: () =>
    function EditorDouble(props: { collab?: MegaDocCollabConfig }) {
      boundary.collab.push(props.collab);
      return null;
    },
}));
vi.mock("@/lib/auth-client", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    authClient: {
      useSession: () => useSyncExternalStore(boundary.subscribe, boundary.get, boundary.get),
    },
  };
});

import { DocWriter } from "@/app/[lang]/workspace/docs/components/doc-writer";

const COLLAB_URL = "ws://127.0.0.1:1/collab";
const PREFS_USERNAME = "synthetic-handle";
const FEISHU_USER_ID = "ou_synthetic_member";

const author = { id: "synthetic-author", username: "synthetic", displayName: "Synthetic", avatarInitials: "S" };
const body = JSON.stringify({ root: { type: "root", version: 1, children: [], direction: null, format: "", indent: 0 } });
const doc: Doc = {
  id: "doc_synthetic", title: "Synthetic doc", body, excerpt: "", author, collaborators: [], tags: [],
  linkedCLs: [], linkedIssues: [], versions: [], starred: false, preview: [], status: "draft", canEdit: true,
  viewCount: 0, commentCount: 0, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
const labels = {
  autoSaveHint: "auto", collabConnecting: "connecting", collabLive: "live", collabOffline: "offline",
  collabReadonly: "readonly", placeholder: "placeholder", saved: "saved", saving: "saving",
};

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
}

const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "http://127.0.0.1");
  switch (url.pathname) {
    case "/api/mega/collab/token":
      return json({ token: "synthetic-token", userId: "synthetic-collab-user", expiresAtMs: Date.now() + 60_000 });
    case "/api/mega/profile-prefs":
      return json(boundary.prefsUsername === undefined ? { bio: "" } : { username: boundary.prefsUsername, bio: "" });
    default:
      throw new Error(`Unexpected request ${url.pathname}`);
  }
});

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
  boundary.collab.length = 0;
  boundary.prefsUsername = PREFS_USERNAME;
  boundary.setUser(null, true);
  fetchSpy.mockClear();
  vi.stubEnv("NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL", COLLAB_URL);
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function flush(): Promise<void> {
  for (let tick = 0; tick < 6; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  expect(queryClient.isFetching()).toBe(0);
}

async function renderWriter(): Promise<void> {
  await act(async () => {
    root.render(createElement(StrictMode, null,
      createElement(QueryClientProvider, { client: queryClient },
        createElement(DocWriter, {
          conflictMessage: "conflict", doc, forbiddenError: "forbidden", genericError: "error", labels, onToast: vi.fn(),
        }))));
  });
  await flush();
}

async function setSession(user: Record<string, unknown> | null): Promise<void> {
  await act(async () => {
    boundary.setUser(user);
  });
  await flush();
}

/** The collab config the editor double received last. */
function lastCollab(): MegaDocCollabConfig {
  const config = boundary.collab.at(-1);
  expect(config).toBeDefined();
  if (!config) throw new Error("editor received no collab config");
  expect(config.url).toBe(COLLAB_URL);
  return config;
}

function feishuUser(displayName: string) {
  return { id: FEISHU_USER_ID, name: `fs_${FEISHU_USER_ID}`, displayName, email: "member@example.test", image: null };
}

function legacyUser(name: string) {
  return { id: "legacy-user", name, email: "legacy@example.test", image: null };
}

/** The expression before FSL-183, with the session `user.name` as its input. */
function previousUsername(user: { name?: string } | null, prefs: string | undefined): string | undefined {
  return user?.name ?? prefs ?? undefined;
}

describe("Feishu session: presence username from the projection displayName", () => {
  it.each([
    { label: "plain name", displayName: "Synthetic Person" },
    { label: "surrounding whitespace", displayName: "  Synthetic Person  " },
    { label: "blank", displayName: "   " },
  ])("presence username is the raw displayName ($label)", async ({ displayName }) => {
    boundary.setUser(feishuUser(displayName));
    await renderWriter();
    const config = lastCollab();
    expect(config.username).toBe(displayName);
    expect(config.username).not.toBe(PREFS_USERNAME);
    expect(config.username).not.toContain("fs_");
    expect(config.token).toBe("synthetic-token");
  });

  it("follows a displayName change of the same session user", async () => {
    boundary.setUser(feishuUser("Synthetic Person"));
    await renderWriter();
    expect(lastCollab().username).toBe("Synthetic Person");
    await setSession(feishuUser("Renamed Person"));
    expect(lastCollab().username).toBe("Renamed Person");
  });
});

describe("legacy session: unchanged presence username", () => {
  it.each([
    { label: "plain name", name: "Legacy Person" },
    { label: "surrounding whitespace", name: "  Legacy Person  " },
    { label: "blank", name: "   " },
  ])("presence username equals the earlier value for user.name ($label)", async ({ name }) => {
    const user = legacyUser(name);
    boundary.setUser(user);
    await renderWriter();
    const config = lastCollab();
    expect(config.username).toBe(name);
    expect(config.username).toBe(previousUsername(user, PREFS_USERNAME));
  });

  it("a session user without a name falls back to profilePrefs.username, as before", async () => {
    const user: { id: string; name?: string; email: string } = { id: "legacy-user", email: "legacy@example.test" };
    boundary.setUser(user);
    await renderWriter();
    expect(lastCollab().username).toBe(PREFS_USERNAME);
    expect(lastCollab().username).toBe(previousUsername(user, PREFS_USERNAME));
  });
});

describe("before the session is ready", () => {
  it.each(["feishu", "legacy"] as const)(
    "%s: falls back to the cached profilePrefs.username, then takes the session name",
    async (mode) => {
      queryClient.setQueryData(["mega", "profile-prefs"], { username: PREFS_USERNAME });
      await renderWriter();
      expect(lastCollab().username).toBe(PREFS_USERNAME);
      expect(lastCollab().username).toBe(previousUsername(null, PREFS_USERNAME));

      const user = mode === "feishu" ? feishuUser("Synthetic Person") : legacyUser("Legacy Person");
      await setSession(user);
      expect(lastCollab().username).toBe(mode === "feishu" ? "Synthetic Person" : "Legacy Person");
    },
  );

  it("without a session or cached profilePrefs the username is undefined, as before", async () => {
    await renderWriter();
    expect(lastCollab().username).toBeUndefined();
    expect(previousUsername(null, undefined)).toBeUndefined();
  });
});
