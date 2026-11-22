// @vitest-environment happy-dom
// megaui-only (FSL-182): the real profile form re-initialises its name input when the
// session switches to another account, even when both accounts share the same display
// name, and so drops an unsaved edit (as before FSL-182). Only `authClient.useSession`
// (an external store, like the real hook) and the BFF requests are test doubles.
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionStore = vi.hoisted(() => {
  let user: Record<string, unknown> | null = null;
  let snapshot: { data: { user: Record<string, unknown> } | null; isPending: boolean } = { data: null, isPending: false };
  const listeners = new Set<() => void>();
  return {
    set(next: Record<string, unknown> | null) {
      user = next;
      snapshot = { data: user ? { user } : null, isPending: false };
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
vi.mock("next/navigation", () => ({
  useParams: () => ({ lang: "en" }),
  usePathname: () => "/en/workspace/settings",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth-client", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    authClient: {
      useSession: () => useSyncExternalStore(sessionStore.subscribe, sessionStore.get, sessionStore.get),
      updateUser: vi.fn(),
    },
  };
});

import { ProfileForm } from "@/app/[lang]/workspace/settings/components/profile-form";

const SHARED_NAME = "Shared Person";
const EDIT = "Unsaved edit";

const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "http://127.0.0.1");
  if (url.pathname === "/api/mega/profile-prefs") {
    return new Response(JSON.stringify({ data: { username: "synthetic-handle", bio: "" } }), {
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error(`Unexpected request ${url.pathname}`);
});

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
  sessionStore.set(null);
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

function nameInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('[data-mega-settings="profile-form"] label input');
  expect(input).not.toBeNull();
  if (!input) throw new Error("name input missing");
  return input;
}

async function flush(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

async function renderForm(): Promise<void> {
  await act(async () => {
    root.render(createElement(StrictMode, null,
      createElement(QueryClientProvider, { client: queryClient }, createElement(ProfileForm))));
  });
  await flush();
  expect(queryClient.isFetching()).toBe(0);
  expect(nameInput().disabled).toBe(false);
}

async function typeName(value: string): Promise<void> {
  const input = nameInput();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function switchTo(user: Record<string, unknown>): Promise<void> {
  await act(async () => {
    sessionStore.set(user);
  });
  await flush();
}

const accounts = {
  feishu: {
    a: { id: "ou_synthetic_a", name: "fs_ou_synthetic_a", displayName: SHARED_NAME, email: "a@example.test", image: null },
    b: { id: "ou_synthetic_b", name: "fs_ou_synthetic_b", displayName: SHARED_NAME, email: "b@example.test", image: null },
  },
  legacy: {
    a: { id: "legacy-a", name: SHARED_NAME, email: "a@example.test", image: null },
    b: { id: "legacy-b", name: SHARED_NAME, email: "b@example.test", image: null },
  },
} as const;

describe("profile form account switch with the same display name", () => {
  it.each(["feishu", "legacy"] as const)("%s: switching account drops the unsaved edit", async (mode) => {
    const { a, b } = accounts[mode];
    sessionStore.set({ ...a });
    await renderForm();
    expect(nameInput().value).toBe(SHARED_NAME);

    await typeName(EDIT);
    expect(nameInput().value).toBe(EDIT);

    // Control: a fresh session object for the same account keeps the edit.
    await switchTo({ ...a });
    expect(nameInput().value).toBe(EDIT);

    await switchTo({ ...b });
    expect(nameInput().value).toBe(SHARED_NAME);
  });
});
