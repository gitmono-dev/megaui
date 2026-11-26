import { afterEach, describe, expect, it, vi } from "vitest";
import "@/lib/adapter/handlers/images";
import { dispatchMegaRequest } from "@/lib/adapter/dispatch";

const request = (segments: string[], params = "") => dispatchMegaRequest({ method: "GET", segments, searchParams: new URLSearchParams(params), headers: new Headers(), body: undefined });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("image registry adapter", () => {
  it("reads a paginated catalog and forwards search", async () => {
    vi.stubEnv("MEGA2_PUBLIC_BASE_URL", "http://127.0.0.1:19180");
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ repositories: ["team/image"] }), { headers: { link: "next" } }));
    vi.stubGlobal("fetch", fetcher);
    expect(await request(["images"], "q=team")).toEqual({ items: ["team/image"], next: "team/image" });
    expect(String(fetcher.mock.calls[0]![0])).toContain("/v2/_catalog?n=100&q=team");
  });
  it("reads tags and rejects unsafe repository paths", async () => {
    vi.stubEnv("MEGA2_PUBLIC_BASE_URL", "http://127.0.0.1:19180");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ name: "team/image", tags: ["latest"] }))));
    expect(await request(["images", "tags"], "repository=team%2Fimage")).toEqual({ items: ["latest"], next: null });
    await expect(request(["images", "tags"], "repository=..%2Fadmin")).rejects.toThrow();
  });
  it("does not turn registry failures into empty results", async () => {
    vi.stubEnv("MEGA2_PUBLIC_BASE_URL", "http://127.0.0.1:19180");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    await expect(request(["images"])).rejects.toThrow();
  });
  it("supports a separate registry origin without forwarding session cookies", async () => {
    vi.stubEnv("MEGA2_PUBLIC_BASE_URL", "http://127.0.0.1:19180");
    vi.stubEnv("MEGA2_OCI_BASE_URL", "http://127.0.0.1:19181");
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ repositories: [] })));
    vi.stubGlobal("fetch", fetcher);
    await request(["images"]);
    expect(String(fetcher.mock.calls[0]![0])).toContain("http://127.0.0.1:19181/v2/_catalog");
    expect(fetcher.mock.calls[0]![1].headers).toBeUndefined();
  });
});
