// @vitest-environment happy-dom
// megaui-only (FS-92): render the actual navigation consumers at the null boundary.
import { createElement, act, StrictMode, type ComponentProps, type ComponentType } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  params: null as Record<string, string | string[]> | null,
  search: null as URLSearchParams | null,
  pathname: null as string | null,
  signedIn: false,
  push: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useParams: () => navigation.params,
  useSearchParams: () => navigation.search,
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: navigation.push, replace: navigation.replace }),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: navigation.signedIn ? { user: { id: "synthetic-user" } } : null, isPending: false }) },
}));

// Stub child presentation/plugin boundaries only. The six tested components,
// their hooks, query/mutation lifecycle and navigation decisions are real.
const callbacks = vi.hoisted(() => ({
  tree: undefined as ComponentProps<typeof import("@/app/[lang]/workspace/code/[...path]/components/code-path-tree").CodePathTree> | undefined,
  header: undefined as ComponentProps<typeof import("@/app/[lang]/workspace/code/[...path]/components/code-path-header").CodePathHeader> | undefined,
  toolbar: undefined as ComponentProps<typeof import("@/app/[lang]/workspace/docs/components/doc-toolbar").DocToolbar> | undefined,
  completed: undefined as ComponentProps<typeof import("@megaui/ui/content/editor").CompletedPageReferencesPlugin> | undefined,
  image: undefined as ComponentProps<typeof import("@megaui/ui/content/editor").ImagePlugin> | undefined,
  focus: undefined as ComponentProps<typeof import("@megaui/ui/content/editor").BlockFocusPlugin> | undefined,
  block: undefined as ComponentProps<typeof import("@megaui/ui/content/editor").BlockContextMenuPlugin> | undefined,
}));
vi.mock("@megaui/ui/code-view", async (importOriginal) => ({
  ...await importOriginal<object>(),
  MegaPatchView: (props: ComponentProps<typeof import("@megaui/ui/code-view").MegaPatchView>) =>
    createElement("pre", null, props.patch),
}));
vi.mock("@/app/[lang]/workspace/code/[...path]/components/code-path-content", () => ({
  CodePathContent: (props: ComponentProps<typeof import("@/app/[lang]/workspace/code/[...path]/components/code-path-content").CodePathContent>) =>
    createElement("div", { "data-content-state": props.state.kind }),
}));
vi.mock("@/app/[lang]/workspace/code/[...path]/components/code-path-tree", () => ({
  CodePathTree: (props: NonNullable<typeof callbacks.tree>) => { callbacks.tree = props; return null; },
}));
vi.mock("@/app/[lang]/workspace/code/[...path]/components/code-path-header", () => ({
  CodePathHeader: (props: NonNullable<typeof callbacks.header>) => { callbacks.header = props; return null; },
}));
vi.mock("@/app/[lang]/workspace/docs/components/doc-toolbar", () => ({
  DocToolbar: (props: NonNullable<typeof callbacks.toolbar>) => { callbacks.toolbar = props; return null; },
}));
vi.mock("@/app/[lang]/workspace/docs/components/doc-writer", async (importOriginal) => ({
  ...await importOriginal<object>(),
  DocWriter: () => createElement("div", { "data-mega-docs": "editor" }),
}));
vi.mock("@megaui/ui/content/editor", async (importOriginal) => ({
  ...await importOriginal<object>(),
  BlockCollapsePlugin: () => null, BlockEmbedPastePlugin: () => null,
  BlockRefsPlugin: () => null, BlockReferenceSyntaxPlugin: () => null,
  EmbedsPlugin: () => null, QuickCommandsPlugin: () => null,
  TodoCheckboxPlugin: () => null, TableControlsPlugin: () => null,
  TrailingMediaBlockPlugin: () => null, WikilinksPlugin: () => null,
  CompletedPageReferencesPlugin: (props: NonNullable<typeof callbacks.completed>) => { callbacks.completed = props; return null; },
  ImagePlugin: (props: NonNullable<typeof callbacks.image>) => { callbacks.image = props; return null; },
  BlockFocusPlugin: (props: NonNullable<typeof callbacks.focus>) => { callbacks.focus = props; return null; },
  BlockContextMenuPlugin: (props: NonNullable<typeof callbacks.block>) => { callbacks.block = props; return null; },
}));

import { megaQueryKeys } from "@megaui/ui/query";
import type { Doc } from "@megaui/core";
import CLFilesPage from "@/app/[lang]/workspace/cls/[n]/files/page";
import CodePathPage from "@/app/[lang]/workspace/code/[...path]/page";
import DocDetailPage from "@/app/[lang]/workspace/docs/[docId]/page";
import { DocRoamShortcuts } from "@/app/[lang]/workspace/docs/components/doc-roam-shortcuts";
import { SettingsNav } from "@/app/[lang]/workspace/settings/components/settings-nav";
import SettingsPage from "@/app/[lang]/workspace/settings/page";

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
const fetchSpy = vi.fn();

beforeEach(() => {
  navigation.signedIn = false;
  navigation.params = null;
  navigation.search = null;
  navigation.pathname = null;
  navigation.push.mockClear();
  navigation.replace.mockClear();
  fetchSpy.mockReset().mockImplementation(() => { throw new Error("Unexpected request before navigation readiness"); });
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
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

function required<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  if (value == null) throw new Error("Expected rendered control");
  return value;
}
function button(selector: string): HTMLButtonElement {
  return required(container.querySelector<HTMLButtonElement>(selector));
}
function known(search = "") {
  navigation.params = { lang: "en", n: "42", path: ["README%20file.md"], docId: "doc_test" };
  navigation.search = new URLSearchParams(search);
  navigation.pathname = "/en/workspace/docs/doc_test";
}
function json(data: unknown) {
  return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
}
const author = { id: "synthetic-user", username: "synthetic", displayName: "Synthetic", email: "synthetic@example.com", avatarInitials: "S" };
const body = JSON.stringify({ root: { type: "root", version: 1, children: [{ type: "paragraph", version: 1, children: [{ type: "text", version: 1, text: "Synthetic content", detail: 0, format: 0, mode: "normal", style: "" }], direction: null, format: "", indent: 0 }], direction: null, format: "", indent: 0 } });
const doc: Doc = {
  id: "doc_test", title: "Synthetic doc", body, excerpt: "", author, collaborators: [], tags: [],
  linkedCLs: [], linkedIssues: [], versions: [{ id: "v1", version: 1, author, body, createdAt: "2026-01-01T00:00:00Z" }],
  starred: false, preview: [], status: "draft", canEdit: true, viewCount: 0, commentCount: 0,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
function docResponse(url: string) {
  if (url.endsWith("/comments")) return json([]);
  if (url.endsWith("/backlinks") || url.endsWith("/unlinked")) return json({ items: [] });
  return json(doc);
}
function seedDoc() {
  queryClient.setQueryData(megaQueryKeys.doc(doc.id), doc);
  queryClient.setQueryData(megaQueryKeys.docBacklinks(doc.id), { items: [] });
  queryClient.setQueryData(megaQueryKeys.docUnlinked(doc.id), { items: [] });
  queryClient.setQueryData(megaQueryKeys.docComments(doc.id), []);
  fetchSpy.mockImplementation(async (url: string) => docResponse(url));
}

const consumers: [string, ComponentType][] = [
  ["CL files", CLFilesPage],
  ["code path", CodePathPage],
  ["doc detail", DocDetailPage],
  ["doc shortcuts", () => createElement(DocRoamShortcuts, { onReferenceCreateError: vi.fn() })],
  ["settings navigation", SettingsNav],
  ["settings page", SettingsPage],
];

async function render(Component: ComponentType) {
  await act(async () => {
    root.render(createElement(StrictMode, null,
      createElement(QueryClientProvider, { client: queryClient }, createElement(Component))));
  });
}

describe("unknown navigation context", () => {
  it.each(consumers)("%s waits without enabling writes or navigation", async (_name, Component) => {
    await render(Component);
    expect(container.querySelector('[data-mega-docs="editor"]')).toBeNull();
    expect(container.querySelector('[data-mega-settings="profile-form"]')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(navigation.push).not.toHaveBeenCalled();
    expect(navigation.replace).not.toHaveBeenCalled();
  });
});

describe("settings readiness transitions", () => {
  it("keeps section navigation after known/null/known transitions under StrictMode", async () => {
    navigation.params = { lang: "en" };
    navigation.search = new URLSearchParams("section=appearance");
    await render(SettingsNav);
    await act(async () => {
      button('[data-mega-settings="section-tokens"]').click();
    });
    expect(navigation.replace).toHaveBeenLastCalledWith("?section=tokens");
    navigation.replace.mockClear();
    navigation.search = null;
    await render(SettingsNav);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(navigation.replace).not.toHaveBeenCalled();
    navigation.search = new URLSearchParams("section=profile");
    await render(SettingsNav);
    await act(async () => {
      button('[data-mega-settings="section-notifications"]').click();
    });
    expect(navigation.replace).toHaveBeenLastCalledWith("?section=notifications");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not treat unknown search as the default editable profile", async () => {
    navigation.params = { lang: "en" };
    await render(SettingsPage);
    expect(container.querySelector('[data-mega-settings="profile-form"]')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ data: { username: "synthetic", bio: "" } }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    navigation.search = new URLSearchParams();
    await render(SettingsPage);
    expect(container.querySelector('[data-mega-settings="profile-form"]')).not.toBeNull();
    fetchSpy.mockClear();
    navigation.search = null;
    await render(SettingsPage);
    expect(container.querySelector('[data-mega-settings="profile-form"]')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(navigation.replace).not.toHaveBeenCalled();
  });
});


const partialContexts: [string, ComponentType, ("params" | "search" | "pathname")[]][] = [
  ["CL", CLFilesPage, ["params", "search"]],
  ["code", CodePathPage, ["params", "search"]],
  ["doc", DocDetailPage, ["params", "search", "pathname"]],
  ["shortcuts", required(consumers[3])[1], ["search", "pathname"]],
];
describe.each(partialContexts)("%s partial context", (_name, Component, fields) => {
  it.each(fields)("waits when only %s is unavailable", async (field) => {
    known();
    navigation[field] = null;
    await render(Component);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.querySelector('[data-mega-docs="editor"]')).toBeNull();
    expect(navigation.push).not.toHaveBeenCalled();
    expect(navigation.replace).not.toHaveBeenCalled();
  });
});

describe("known context preserves behavior and revokes old callbacks", () => {
  it("keeps code path decoding/tab, rejects old navigation after null, and resumes", async () => {
    known("tab=code");
    queryClient.setQueryData(megaQueryKeys.workspace(), { name: "synthetic", defaultBranch: "main" });
    queryClient.setQueryData(megaQueryKeys.codeTree(), [{ path: "README file.md", name: "README file.md", kind: "file" }]);
    queryClient.setQueryData(megaQueryKeys.sourceFile("README file.md"), { content: "# Ready", language: "markdown", path: "README file.md", lines: 1, sizeBytes: 7 });
    await render(CodePathPage);
    const oldTree = required(callbacks.tree);
    const oldHeader = required(callbacks.header);
    expect(oldTree.activePath).toBe("README file.md");
    expect(oldHeader.pathSegments).toEqual(["README file.md"]);
    expect(oldHeader.previewAvailable).toBe(true);
    expect(container.querySelector("[data-content-state]")?.getAttribute("data-content-state")).toBe("blob");
    await act(async () => {
      oldHeader.onTabChange("preview");
      oldTree.onSelect({ path: "src/a b.ts", name: "a b.ts", kind: "file" });
    });
    expect(navigation.replace).toHaveBeenLastCalledWith("?tab=preview");
    expect(navigation.push).toHaveBeenLastCalledWith("/en/workspace/code/src/a%20b.ts");
    navigation.search = null;
    await render(CodePathPage);
    navigation.push.mockClear(); navigation.replace.mockClear();
    await act(async () => {
      oldHeader.onTabChange("code");
      oldTree.onSelect({ path: "stale", name: "stale", kind: "file" });
    });
    expect(navigation.push).not.toHaveBeenCalled();
    expect(navigation.replace).not.toHaveBeenCalled();
    known("tab=code");
    await render(CodePathPage);
    await act(async () => required(callbacks.header).onTabChange("preview"));
    expect(navigation.replace).toHaveBeenLastCalledWith("?tab=preview");
    oldHeader.onTabChange("code");
    expect(navigation.replace).toHaveBeenCalledTimes(1);
  });

  it("keeps CL range/file and viewed writes while known, refuses queued admission after null", async () => {
    known("range=1..2&file=b.ts");
    const selectedPatch = "@@ -1 +1 @@\n-const version = 1;\n+const version = 2;\n";
    const cl = { id: "cl_navigation", number: 42, publicId: "CL0fixture42", revisions: [{ number: 1 }, { number: 2 }], files: [
      { path: "a.ts", status: "added", patch: "first", additions: 1, deletions: 0 },
      { path: "b.ts", status: "modified", patch: "latest", additions: 1, deletions: 1, viewed: false, rangePatches: { "1..2": selectedPatch } },
    ] };
    queryClient.setQueryData(megaQueryKeys.cl("42"), cl);
    fetchSpy.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/viewed") && init?.method === "POST") {
        const { path, viewed } = JSON.parse(init.body);
        return json({ ...required(cl.files.find(file => file.path === path)), viewed });
      }
      return json(cl);
    });
    await render(CLFilesPage);
    const file = '[data-mega-cls="file-card"][data-path="b.ts"]';
    const patch = `${file} [data-mega-cls="diff-patch"]`;
    const viewed = () => required(container.querySelector<HTMLInputElement>(`${file} input[data-mega-cls="file-viewed"]`));
    expect(required(container.querySelector(patch)).textContent).toBe(selectedPatch);
    await act(async () => viewed().click());
    expect(fetchSpy.mock.calls.some(([url, init]) => String(url).endsWith("/cls/42/viewed") && init.body === JSON.stringify({ path: "b.ts", viewed: true }))).toBe(true);
    fetchSpy.mockClear();
    // React Query defers mutationFn; invalidate the rendered lifetime before it enters.
    await act(async () => {
      viewed().click();
      navigation.search = null;
      flushSync(() => root.render(createElement(StrictMode, null,
        createElement(QueryClientProvider, { client: queryClient }, createElement(CLFilesPage)))));
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    known("range=1..2&file=b.ts");
    await render(CLFilesPage);
    expect(required(container.querySelector(patch)).textContent).toBe(selectedPatch);
  });

  it("does not mount a writer for unknown or snapshot navigation; revokes old doc mutations", async () => {
    known(); navigation.signedIn = true; seedDoc();
    await render(DocDetailPage);
    expect(container.querySelector('[data-mega-docs="editor"]')).not.toBeNull();
    const oldToolbar = required(callbacks.toolbar);
    fetchSpy.mockClear();
    navigation.search = null;
    await render(DocDetailPage);
    expect(container.querySelector('[data-mega-docs="editor"]')).toBeNull();
    await act(async () => {
      await expect(required(oldToolbar.onRename)("Stale rename")).rejects.toThrow("Navigation context");
      oldToolbar.onStar();
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    known("v=1");
    await render(DocDetailPage);
    expect(container.querySelector('[data-mega-docs="editor"]')).toBeNull();
    expect(container.querySelector('[data-mega-docs="snapshot-banner"]')).not.toBeNull();
    known();
    await render(DocDetailPage);
    expect(container.querySelector('[data-mega-docs="editor"]')).not.toBeNull();
    fetchSpy.mockClear();
    await act(async () => required(required(callbacks.toolbar).onRename)("Current rename"));
    expect(fetchSpy.mock.calls.some(([url, init]) => String(url).endsWith("/docs/doc_test/rename") && init.body === JSON.stringify({ title: "Current rename" }))).toBe(true);
    fetchSpy.mockClear();
    await act(async () => { await expect(required(oldToolbar.onRename)("Still stale")).rejects.toThrow(); });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["unchanged", "unknown", "changed-query", "changed-path"])("late restore navigation follows its admitted context (%s)", async (context) => {
    known("v=1"); navigation.signedIn = true; seedDoc();
    let finish: ((response: Response) => void) | undefined;
    fetchSpy.mockImplementation((url: string) => url.endsWith("/save")
      ? new Promise<Response>((resolve) => { finish = resolve; }) : Promise.resolve(docResponse(url)));
    await render(DocDetailPage);
    await act(async () => button('[data-mega-docs="restore"]').click());
    expect(finish).toBeDefined();
    if (context === "unknown") navigation.pathname = null;
    if (context === "changed-query") navigation.search = new URLSearchParams("v=1&block=new-focus");
    if (context === "changed-path") { navigation.params = { lang: "zh-CN", docId: "doc_test" }; navigation.pathname = "/zh-CN/workspace/docs/doc_test"; }
    if (context !== "unchanged") await render(DocDetailPage);
    await act(async () => required(finish)(json(doc)));
    if (context !== "unchanged") expect(navigation.replace).not.toHaveBeenCalled();
    else expect(navigation.replace).toHaveBeenCalledWith("/en/workspace/docs/doc_test");
  });

  it("retains block queries and creation/upload behavior, but old shortcuts cannot act after null", async () => {
    known("v=1&block=first&keep=yes");
    const Component = required(consumers[3])[1];
    await render(Component);
    const old = {
      completed: required(callbacks.completed), image: required(callbacks.image),
      focus: required(callbacks.focus), block: required(callbacks.block),
    };
    fetchSpy.mockImplementation(async (url: string) => url.startsWith("/api/upload")
      ? json({ url: "/synthetic.png" }) : json({ targetId: "new-doc", created: true }));
    await expect(required(old.completed.createPage)("A title")).resolves.toEqual({ kind: "doc", targetId: "new-doc", targetTitle: "A title" });
    await expect(required(old.image.upload)(new File(["x"], "x.png"))).resolves.toBe("/synthetic.png");
    old.completed.onNavigate("doc with space");
    expect(navigation.push).toHaveBeenLastCalledWith("/en/workspace/docs/doc%20with%20space");
    required(old.block.onFocusBlock)("next");
    expect(navigation.push).toHaveBeenLastCalledWith("/en/workspace/docs/doc_test?v=1&block=next&keep=yes", { scroll: false });
    old.focus.onExit();
    expect(navigation.replace).toHaveBeenLastCalledWith("/en/workspace/docs/doc_test?v=1&keep=yes", { scroll: false });
    navigation.search = null;
    await render(Component);
    fetchSpy.mockClear(); navigation.push.mockClear(); navigation.replace.mockClear();
    await expect(required(old.completed.createPage)("Stale")).rejects.toThrow("Navigation context");
    await expect(required(old.image.upload)(new File(["x"], "x.png"))).rejects.toThrow("Navigation context");
    old.completed.onNavigate("stale"); required(old.block.onFocusBlock)("stale"); old.focus.onExit();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(navigation.push).not.toHaveBeenCalled(); expect(navigation.replace).not.toHaveBeenCalled();
    known("keep=yes");
    await render(Component);
    required(callbacks.completed).onNavigate("resumed");
    expect(navigation.push).toHaveBeenLastCalledWith("/en/workspace/docs/resumed");
    old.completed.onNavigate("stale");
    expect(navigation.push).toHaveBeenCalledTimes(1);
  });
});


it("revokes sidebar focus overrides with the Roam lifetime", async () => {
  const override = { blockId: "sidebar", onFocus: vi.fn(), onExit: vi.fn() };
  const Component = () => createElement(DocRoamShortcuts, { focusOverride: override, onReferenceCreateError: vi.fn() });
  known();
  await render(Component);
  const focus = required(callbacks.focus);
  const block = required(callbacks.block);
  required(block.onFocusBlock)("current"); focus.onExit();
  expect(override.onFocus).toHaveBeenCalledWith("current");
  expect(override.onExit).toHaveBeenCalledTimes(1);
  navigation.pathname = null;
  await render(Component);
  override.onFocus.mockClear(); override.onExit.mockClear();
  required(block.onFocusBlock)("stale"); focus.onExit();
  expect(override.onFocus).not.toHaveBeenCalled(); expect(override.onExit).not.toHaveBeenCalled();
  expect(navigation.push).not.toHaveBeenCalled(); expect(navigation.replace).not.toHaveBeenCalled();
});

it("allows an admitted page creation to finish while rejecting its late navigation", async () => {
  known();
  const Component = required(consumers[3])[1];
  await render(Component);
  const completed = required(callbacks.completed);
  let finish: ((response: Response) => void) | undefined;
  fetchSpy.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
  const result = required(completed.createPage)("Admitted title");
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  navigation.search = null;
  await render(Component);
  required(finish)(json({ targetId: "created", created: true }));
  await expect(result).resolves.toEqual({ kind: "doc", targetId: "created", targetTitle: "Admitted title" });
  completed.onNavigate("created");
  expect(navigation.push).not.toHaveBeenCalled();
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});


it("rejects a queued restore if the known query changes before admission", async () => {
  known("v=1"); navigation.signedIn = true; seedDoc();
  await render(DocDetailPage);
  fetchSpy.mockClear();
  await act(async () => {
    button('[data-mega-docs="restore"]').click();
    navigation.search = new URLSearchParams("v=1&block=other");
    flushSync(() => root.render(createElement(StrictMode, null,
      createElement(QueryClientProvider, { client: queryClient }, createElement(DocDetailPage)))));
  });
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(navigation.replace).not.toHaveBeenCalled();
});
