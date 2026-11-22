// @vitest-environment happy-dom
// megaui-only (FSL-182): the workspace shell rail, the home greeting and the profile form
// read the signed-in user's own name only through `selfDisplayName`. The real components
// render; only `authClient.useSession` and the BFF requests (`fetch`) are test doubles
// (plus the Next.js routing hooks, which have no router outside the app).
import { act, createElement, StrictMode, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  prefsUsername: undefined as string | undefined,
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ lang: "en" }),
  usePathname: () => "/en/workspace",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: boundary.user ? { user: boundary.user } : null, isPending: false }),
    updateUser: vi.fn(),
  },
}));

import { getTranslation } from "@megaui/i18n";
import { getInitials } from "@megaui/ui/shell";
import WorkspaceHomePage from "@/app/[lang]/workspace/page";
import { ProfileForm } from "@/app/[lang]/workspace/settings/components/profile-form";
import { sessionDisplayName, WorkspaceShellClient } from "@/app/[lang]/workspace/workspace-shell-client";

const en = getTranslation("en");
const RAIL_FALLBACK = en.workspace.nav.currentUser;
const HOME_FALLBACK = en.workspace.home.fallbackName;
const PREFS_USERNAME = "synthetic-handle";
const FEISHU_USER_ID = "ou_synthetic_member";

const dashboard = {
  kpis: { reviewsRequested: 0, mentions: 0, myOpenIssues: 0, mainCI: "skipped", agentSessionsToday: 0 },
  cards: { reviewRequests: [], assignedIssues: [], activity: [], releases: [], agentThreads: [], docs: [], channels: [], quickLinks: [] },
};

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
}

const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "http://127.0.0.1");
  switch (url.pathname) {
    case "/api/mega/profile-prefs":
      return json(boundary.prefsUsername === undefined ? { bio: "" } : { username: boundary.prefsUsername, bio: "" });
    case "/api/mega/home":
      return json(dashboard);
    case "/api/mega/workspace":
      return json({ id: "ws", name: "Synthetic" });
    case "/api/mega/notifications/unread-count":
      return json({ count: 0 });
    case "/api/mega/cls":
    case "/api/mega/channels":
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
  boundary.prefsUsername = undefined;
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

async function renderSettled(Component: ComponentType, ready: () => boolean): Promise<void> {
  await act(async () => {
    root.render(createElement(StrictMode, null,
      createElement(QueryClientProvider, { client: queryClient }, createElement(Component))));
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (ready() && queryClient.isFetching() === 0) break;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  // React Query notifies observers on a timer: flush it so the settled data is rendered.
  for (let tick = 0; tick < 3; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  expect(ready()).toBe(true);
  expect(queryClient.isFetching()).toBe(0);
  const prefsRequested = fetchSpy.mock.calls.some(([input]) => String(input).startsWith("/api/mega/profile-prefs"));
  expect(prefsRequested).toBe(true);
}

function Shell() {
  return createElement(WorkspaceShellClient, null, createElement("div", { "data-test": "child" }));
}

async function renderRail(): Promise<{ name: string; initials: string }> {
  await renderSettled(Shell, () => container.querySelector('[data-mega-shell="rail-profile-link"]') !== null);
  const link = container.querySelector('[data-mega-shell="rail-profile-link"]');
  const avatar = link?.querySelector('[data-mega-atom="shell-avatar"]');
  const nameSpan = link?.querySelector("span:not([data-mega-atom])");
  return { name: nameSpan?.textContent ?? "<missing>", initials: avatar?.textContent ?? "<missing>" };
}

async function renderGreeting(): Promise<string> {
  await renderSettled(WorkspaceHomePage, () => container.querySelector('[data-mega-home="hero-greeting"]') !== null);
  return container.querySelector('[data-mega-home="hero-greeting"]')?.textContent ?? "<missing>";
}

function greetingsFor(name: string): string[] {
  return Object.values(en.workspace.home.greetings).map((template) => template.replace("{name}", name));
}

async function renderFormName(): Promise<string> {
  await renderSettled(ProfileForm, () => container.querySelector('[data-mega-settings="profile-form"]') !== null);
  const input = container.querySelector<HTMLInputElement>('[data-mega-settings="profile-form"] label input');
  expect(input).not.toBeNull();
  return input?.value ?? "<missing>";
}

function feishuUser(displayName: string) {
  return {
    id: FEISHU_USER_ID,
    name: `fs_${FEISHU_USER_ID}`,
    displayName,
    email: "member@example.test",
    image: null,
    emailVerified: true,
  };
}

function legacyUser(name: string) {
  return { id: "legacy-user", name, email: "legacy@example.test", image: null, emailVerified: true };
}

// Feishu: the projection `user.name` is the Mega2 principal; `displayName` is the input.
const feishuCases = [
  { label: "plain name", displayName: "Synthetic Person", prefs: PREFS_USERNAME, rail: "Synthetic Person", home: "Synthetic Person" },
  { label: "surrounding whitespace", displayName: "  Synthetic Person  ", prefs: PREFS_USERNAME, rail: "Synthetic Person", home: "Synthetic Person" },
  { label: "blank with profile username", displayName: "   ", prefs: PREFS_USERNAME, rail: PREFS_USERNAME, home: PREFS_USERNAME },
  { label: "blank without profile username", displayName: "   ", prefs: undefined, rail: RAIL_FALLBACK, home: HOME_FALLBACK },
] as const;

describe("Feishu session: own name from the projection displayName", () => {
  it.each(feishuCases)("rail name and initials ($label)", async ({ displayName, prefs, rail }) => {
    boundary.user = feishuUser(displayName);
    boundary.prefsUsername = prefs;
    const shown = await renderRail();
    expect(shown.name).toBe(rail);
    expect(shown.name).toBe(sessionDisplayName(displayName, undefined, prefs ?? RAIL_FALLBACK));
    expect(shown.initials).toBe(getInitials(rail));
    expect(container.textContent).not.toContain("fs_");
  });

  it.each(feishuCases)("home greeting ($label)", async ({ displayName, prefs, home }) => {
    boundary.user = feishuUser(displayName);
    boundary.prefsUsername = prefs;
    const greeting = await renderGreeting();
    expect(home).toBe(sessionDisplayName(displayName, undefined, prefs ?? HOME_FALLBACK));
    expect(greetingsFor(home)).toContain(greeting);
    expect(greeting).not.toContain("fs_");
  });

  it.each(feishuCases)("profile form name starts from the raw displayName ($label)", async ({ displayName, prefs }) => {
    boundary.user = feishuUser(displayName);
    boundary.prefsUsername = prefs;
    expect(await renderFormName()).toBe(displayName);
  });

  it("initials of a plain display name", async () => {
    boundary.user = feishuUser("Synthetic Person");
    boundary.prefsUsername = PREFS_USERNAME;
    expect((await renderRail()).initials).toBe("SP");
  });
});

// Legacy: no `displayName`, so the output equals the earlier result for `user.name`.
const legacyCases = [
  { label: "plain name, profile username", name: "Legacy Person", prefs: PREFS_USERNAME, rail: "Legacy Person", home: "Legacy Person", initials: "LP" },
  { label: "plain name, no profile username", name: "Legacy Person", prefs: undefined, rail: "Legacy Person", home: "Legacy Person", initials: "LP" },
  { label: "surrounding whitespace, profile username", name: "  Legacy Person  ", prefs: PREFS_USERNAME, rail: "Legacy Person", home: "Legacy Person", initials: "LP" },
  { label: "surrounding whitespace, no profile username", name: "  Legacy Person  ", prefs: undefined, rail: "Legacy Person", home: "Legacy Person", initials: "LP" },
] as const;

describe("legacy session: unchanged own name", () => {
  it.each(legacyCases)("rail, greeting and form ($label)", async ({ name, prefs, rail, home, initials }) => {
    boundary.user = legacyUser(name);
    boundary.prefsUsername = prefs;
    const shown = await renderRail();
    expect(shown.name).toBe(rail);
    expect(shown.name).toBe(sessionDisplayName(name, undefined, prefs ?? RAIL_FALLBACK));
    expect(shown.initials).toBe(initials);
    await act(async () => root.unmount());
    root = createRoot(container);

    const greeting = await renderGreeting();
    expect(home).toBe(sessionDisplayName(name, undefined, prefs ?? HOME_FALLBACK));
    expect(greetingsFor(home)).toContain(greeting);
    await act(async () => root.unmount());
    root = createRoot(container);

    expect(await renderFormName()).toBe(name);
  });
});
