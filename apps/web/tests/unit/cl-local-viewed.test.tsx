// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLocalViewed } from "@/app/[lang]/workspace/cls/[n]/files/use-local-viewed";

const scope = { actorId: "reviewer-1", publicId: "A1b2C3d4E5f6", revision: "a".repeat(40), range: "" };
const path = "src/目录/file:name.rs";
const roots = new Set<Root>();

function mount(onRender?: (viewed: boolean) => void) {
  const root = createRoot(document.createElement("div"));
  roots.add(root);
  let progress: ReturnType<typeof useLocalViewed>;
  function Probe({ input }: { input: typeof scope | undefined }) {
    progress = useLocalViewed(input);
    onRender?.(progress.paths.has(path));
    return null;
  }
  const rerender = (input: typeof scope | undefined) => act(() => root.render(<Probe input={input} />));
  rerender(scope);
  return {
    get current() { return progress; },
    rerender,
    unmount() { act(() => root.unmount()); roots.delete(root); },
  };
}

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("local file review progress", () => {
  it("synchronizes mounted views and reads the same file marks after a remount", () => {
    const first = mount();
    const second = mount();
    act(() => expect(first.current.setViewed(path, true)).toBe(true));
    expect(second.current.paths.has(path)).toBe(true);
    first.unmount();
    const fresh = mount();
    expect(fresh.current.paths.has(path)).toBe(true);
    act(() => expect(fresh.current.setViewed(path, false)).toBe(true));
    expect(second.current.paths.size).toBe(0);
  });

  it("isolates accounts, changes, revisions and ranges on the first render after switching", () => {
    const renders: boolean[] = [];
    const result = mount((viewed) => renders.push(viewed));
    act(() => { result.current.setViewed(path, true); });
    for (const other of [
      { ...scope, actorId: "reviewer-2" }, { ...scope, publicId: "B1b2C3d4E5f6" },
      { ...scope, revision: "b".repeat(40) }, { ...scope, range: "1..2" }, undefined,
    ]) {
      renders.length = 0;
      result.rerender(other);
      expect(renders).not.toContain(true);
      if (!other) expect(result.current.setViewed(path, true)).toBe(false);
      result.rerender(scope);
      expect(result.current.paths.has(path)).toBe(true);
    }
  });

  it("keeps concurrent file marks and reads the latest storage value on delayed cross-tab events", () => {
    const result = mount();
    act(() => { result.current.setViewed("a.rs", true); });
    const key = window.localStorage.key(0)!;
    // Another tab removes a.rs before this tab marks b.rs or receives the event.
    window.localStorage.removeItem(key);
    act(() => { result.current.setViewed("b.rs", true); });
    expect(window.localStorage.getItem(key)).toBeNull();
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key, newValue: "1" })); });
    expect([...result.current.paths]).toEqual(["b.rs"]);
    act(() => {
      window.localStorage.setItem(key, "1");
      window.dispatchEvent(new StorageEvent("storage", { key }));
    });
    expect(result.current.paths.has("a.rs")).toBe(true);
    act(() => {
      window.localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(result.current.paths.size).toBe(0);
  });

  it("reports an unavailable browser store without advancing review progress", () => {
    const result = mount();
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("Quota exceeded"); });
    expect(result.current.setViewed(path, true)).toBe(false);
    expect(result.current.paths.size).toBe(0);
  });
});
