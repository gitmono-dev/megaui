import { afterEach, describe, expect, it, vi } from "vitest";
import { addGpgKey, deleteGpgKey, listGpgKeys } from "@/lib/adapter/mega2/user-credentials";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Mega2 GPG credentials", () => {
  it("maps the list and sends add and delete using the Mega2 wire contract", async () => {
    vi.stubEnv("MEGA2_PUBLIC_BASE_URL", "http://127.0.0.1:19180");
    const response = (data: unknown) => new Response(JSON.stringify({ req_result: true, err_message: "", data }), { status: 200 });
    const fetcher = vi.fn().mockResolvedValueOnce(response([{ key_id: "ABC", fingerprint: "123", created_at: "2026-01-01T00:00:00Z", expires_at: null }])).mockImplementation(async () => response(null));
    vi.stubGlobal("fetch", fetcher);
    const headers = { cookie: "better-auth.session_token=synthetic" };
    expect(await listGpgKeys(headers)).toEqual([{ id: "ABC", fingerprint: "123", createdAt: "2026-01-01T00:00:00Z", expiresAt: null }]);
    await addGpgKey("synthetic public key", headers);
    await deleteGpgKey("ABC", headers);
    expect(fetcher.mock.calls.map(([url, init]) => [String(url), init.method])).toEqual([
      ["http://127.0.0.1:19180/api/v1/gpg/list", "GET"],
      ["http://127.0.0.1:19180/api/v1/gpg/add", "POST"],
      ["http://127.0.0.1:19180/api/v1/gpg/remove", "DELETE"],
    ]);
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ gpg_content: "synthetic public key" });
    expect(JSON.parse(fetcher.mock.calls[2]![1].body)).toEqual({ key_id: "ABC" });
    for (const [, init] of fetcher.mock.calls) expect(init.headers.get("cookie")).toBe(headers.cookie);
  });
});
