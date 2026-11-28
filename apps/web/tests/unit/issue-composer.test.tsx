// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTranslation } from "@megaui/i18n";

const mocks = vi.hoisted(() => ({ post: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock("@/hooks/use-translation", async () => {
  const { getTranslation } = await import("@megaui/i18n");
  return { useTranslation: () => ({ t: getTranslation("zh-CN"), locale: "zh-CN" }) };
});
vi.mock("@/lib/auth-client", () => ({ authClient: { useSession: () => ({ data: { user: { id: "self" } } }) } }));
vi.mock("@megaui/ui/query", async (original) => ({
  ...await original<typeof import("@megaui/ui/query")>(),
  megaGet: vi.fn().mockResolvedValue({ members: [], labels: [], projects: [], milestones: [] }),
  megaPost: mocks.post,
}));
import { IssueComposer } from "@/app/[lang]/workspace/issues/new/issue-composer";

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

describe("issue composer", () => {
  it("adds a successful attachment to the Markdown draft", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { url: "https://example.test/picture.png" } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    const node = document.createElement("div"); document.body.append(node);
    const root = createRoot(node);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => { root.render(<QueryClientProvider client={client}><IssueComposer listQuery="" /></QueryClientProvider>); });
    const file = new File(["bytes"], "picture.png", { type: "image/png" });
    const transfer = new DataTransfer(); transfer.items.add(file);
    const input = node.querySelector<HTMLInputElement>('input[type="file"]')!;
    input.files = transfer.files;
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(fetcher).toHaveBeenCalledWith("/api/upload?purpose=attachment", expect.objectContaining({ method: "POST" }));
    expect(node.querySelector<HTMLTextAreaElement>("textarea")!.value).toContain("![picture.png](https://example.test/picture.png)");
    await act(async () => root.unmount()); client.clear();
  });
  it("formats selected text and renders it in preview", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const node = document.createElement("div"); document.body.append(node);
    const root = createRoot(node);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => { root.render(<QueryClientProvider client={client}><IssueComposer listQuery="" /></QueryClientProvider>); });
    const field = node.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Important");
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.setSelectionRange(0, 9);
    });
    await act(async () => { node.querySelector<HTMLButtonElement>('button[aria-label="粗体"]')!.click(); });
    expect(field.value).toBe("**Important**");
    await act(async () => { [...node.querySelectorAll("button")].find(button => button.textContent?.includes("预览"))!.click(); });
    expect(node.querySelector("strong")?.textContent).toBe("Important");
    await act(async () => root.unmount()); client.clear();
  });
  it("keeps creating after a successful save and resets the draft", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.post.mockResolvedValue({ number: 123 });
    const node = document.createElement("div"); document.body.append(node);
    const root = createRoot(node);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => { root.render(<QueryClientProvider client={client}><IssueComposer listQuery="" /></QueryClientProvider>); });
    const title = node.querySelector<HTMLInputElement>('#issue-title')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "First");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const checkbox = node.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => { checkbox.click(); });
    await act(async () => { node.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(mocks.post).toHaveBeenCalledWith("issues", expect.objectContaining({ title: "First" }));
    expect(title.value).toBe("");
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(node.querySelector<HTMLButtonElement>('[data-mega-issues="new-submit"]')!.disabled).toBe(true);
    expect(node.textContent).toContain(getTranslation("zh-CN").workspace.issues.create.createMore);
    await act(async () => root.unmount()); client.clear();
  });
});
