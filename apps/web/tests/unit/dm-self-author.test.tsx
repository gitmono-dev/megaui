// @vitest-environment happy-dom
// megaui-only (FSL-183): the real direct-message page hands `useChatCollectionSync` the
// local optimistic author name `selfDisplayName(session.user) ?? undefined`. Only
// `useChatCollectionSync` (replaced by a double that records `localUser`),
// `authClient.useSession` and the BFF requests (`fetch`) are test doubles (plus the
// Next.js routing hooks, which have no router outside the app).
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirectMessageChannel } from "@megaui/core";

type SyncOptions = { channelId: string; enabled: boolean; localUser?: { id: string; name?: string } };

const boundary = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  syncCalls: [] as SyncOptions[],
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ lang: "en", id: "synthetic-peer" }),
  usePathname: () => "/en/workspace/dm/synthetic-peer",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: boundary.user ? { user: boundary.user } : null, isPending: false }),
  },
}));
vi.mock("@/app/[lang]/workspace/channels/hooks/use-chat-collection-sync", () => ({
  useChatCollectionSync: (options: SyncOptions) => {
    boundary.syncCalls.push(options);
    return { refetchInterval: false, connected: false };
  },
}));

import DmPage from "@/app/[lang]/workspace/dm/[id]/page";

const FEISHU_USER_ID = "ou_synthetic_member";
const dmChannel: DirectMessageChannel = {
  id: "dm_synthetic",
  name: "dm",
  kind: "dm",
  unreadCount: 0,
  mentionCount: 0,
  participant: { id: "synthetic-peer-id", username: "synthetic-peer", displayName: "Synthetic Peer", avatarInitials: "SP" },
};

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
}

const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "http://127.0.0.1");
  switch (url.pathname) {
    case "/api/mega/channels":
      return json([dmChannel]);
    case `/api/mega/channels/${dmChannel.id}/messages`:
      return json([]);
    default:
      throw new Error(`Unexpected request ${url.pathname}`);
  }
});

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
  boundary.user = null;
  boundary.syncCalls.length = 0;
  fetchSpy.mockClear();
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
});

/** Renders the page until the DM is resolved and returns the last options the sync hook got. */
async function renderPage(): Promise<SyncOptions> {
  await act(async () => {
    root.render(createElement(StrictMode, null,
      createElement(QueryClientProvider, { client: queryClient }, createElement(DmPage))));
  });
  for (let tick = 0; tick < 6; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  expect(queryClient.isFetching()).toBe(0);
  expect(container.querySelector('[data-mega-chat="dm-title"]')?.textContent).toBe("Synthetic Peer");
  const last = boundary.syncCalls.at(-1);
  expect(last).toBeDefined();
  if (!last) throw new Error("useChatCollectionSync was not called");
  expect(last.channelId).toBe(dmChannel.id);
  expect(last.enabled).toBe(true);
  return last;
}

function feishuUser(displayName: string) {
  return { id: FEISHU_USER_ID, name: `fs_${FEISHU_USER_ID}`, displayName, email: "member@example.test", image: null };
}

/** The expression before FSL-183, with the session `user.name` as its input. */
function previousLocalUser(user: { id?: string; name?: string } | null) {
  return user?.id ? { id: user.id, name: user.name ?? undefined } : undefined;
}

describe("Feishu session: optimistic author name from the projection displayName", () => {
  it.each([
    { label: "plain name", displayName: "Synthetic Person" },
    { label: "surrounding whitespace", displayName: "  Synthetic Person  " },
    { label: "blank", displayName: "   " },
  ])("localUser.name is the raw displayName ($label)", async ({ displayName }) => {
    boundary.user = feishuUser(displayName);
    const { localUser } = await renderPage();
    expect(localUser).toEqual({ id: FEISHU_USER_ID, name: displayName });
    expect(localUser?.name).not.toContain("fs_");
  });
});

describe("legacy session: unchanged optimistic author name", () => {
  it.each([
    { label: "plain name", user: { id: "legacy-user", name: "Legacy Person", email: "legacy@example.test" } },
    { label: "surrounding whitespace", user: { id: "legacy-user", name: "  Legacy Person  ", email: "legacy@example.test" } },
    { label: "blank", user: { id: "legacy-user", name: "   ", email: "legacy@example.test" } },
    { label: "no name", user: { id: "legacy-user", email: "legacy@example.test" } as { id: string; name?: string; email: string } },
  ])("localUser equals the earlier value for user.name ($label)", async ({ user }) => {
    boundary.user = user;
    const { localUser } = await renderPage();
    expect(localUser).toEqual(previousLocalUser(user));
    expect(localUser?.name).toBe(user.name);
  });

  it("without a session there is no localUser, as before", async () => {
    const { localUser } = await renderPage();
    expect(localUser).toBeUndefined();
    expect(previousLocalUser(null)).toBeUndefined();
  });
});
