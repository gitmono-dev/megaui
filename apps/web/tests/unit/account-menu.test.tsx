// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { signOut, replace, refresh } = vi.hoisted(() => ({
  signOut: vi.fn(async () => ({ error: null })),
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: { signOut },
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ lang: "zh-CN" }),
  useRouter: () => ({ replace, refresh }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) =>
    createElement("a", { href, ...props }, children),
}));

import { AccountMenu } from "@/app/[lang]/workspace/account-menu";
import { MegaSettingsProvider } from "@/lib/mega-settings/provider";
import { MEGA_SETTINGS_STORAGE_KEY } from "@/lib/mega-settings/model";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  document.documentElement.className = "";
  signOut.mockClear();
  replace.mockClear();
  refresh.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function item(name: string): HTMLElement {
  const found = [...document.querySelectorAll("[role='menuitem'], [role='menuitemradio']")]
    .find(node => node.textContent === name);
  if (!(found instanceof HTMLElement)) throw new Error(`missing menu item ${name}`);
  return found;
}

async function openMenu(): Promise<void> {
  await act(async () => {
    root.render(createElement(MegaSettingsProvider, null,
      createElement(AccountMenu, {
        displayName: "Mock Alice",
        initials: "MA",
        settingsHref: "/zh-CN/workspace/settings",
      })));
  });
  expect(container.querySelector("script")).toBeNull();
  const button = document.querySelector("[data-mega-shell='rail-profile-link']");
  if (!(button instanceof HTMLElement)) throw new Error("missing account button");
  await act(async () => {
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    button.click();
  });
}

describe("account menu", () => {
  it("opens setting, theme, and logout from the bottom-left control", async () => {
    await openMenu();
    const menu = document.querySelector("[data-mega-shell='account-menu']");
    expect(menu).not.toBeNull();
    const settings = item("设置");
    expect(settings.getAttribute("href")).toBe("/zh-CN/workspace/settings");
    expect(item("主题")).not.toBeNull();
    expect(item("退出登录")).not.toBeNull();

    await act(async () => {
      item("主题").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      item("主题").click();
    });
    await act(async () => {
      item("深色").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      item("深色").click();
    });
    expect(JSON.parse(localStorage.getItem(MEGA_SETTINGS_STORAGE_KEY) ?? "{}").mode).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    const button = document.querySelector("[data-mega-shell='rail-profile-link']");
    if (!(button instanceof HTMLElement)) throw new Error("missing account button");
    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      button.click();
    });
    await act(async () => {
      item("退出登录").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      item("退出登录").click();
    });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/zh-CN/signin");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
