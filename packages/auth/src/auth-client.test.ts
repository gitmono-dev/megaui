import { afterEach, describe, expect, it, vi } from "vitest";
import * as clientEntry from "./client";
import { createAuthClient } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createAuthClient (@megaui/auth/client)", () => {
  it("creates a react auth client with optional baseURL", () => {
    const client = createAuthClient({ baseURL: "http://localhost:3000" });
    expect(client).toBeTruthy();
    expect(client.signIn).toBeTruthy();
    expect(client.signUp).toBeTruthy();
    expect(typeof client.signOut).toBe("function");
    expect(typeof client.getSession).toBe("function");
  });

  it("FSL-133 AC7: the client entry exports no enterprise API", () => {
    expect(Object.keys(clientEntry).sort()).toEqual(["createAuthClient"]);
    for (const name of Object.keys(clientEntry)) expect(name).not.toMatch(/enterprise/i);
  });

  it("FSL-133 AC7: getSession reads /get-session, with no enterprise route rewrite", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return new Response("null", { status: 200, headers: { "content-type": "application/json" } });
    }));
    const client = createAuthClient({ baseURL: "http://localhost:3000" });
    await client.getSession();
    expect(urls.map(url => new URL(url).pathname)).toEqual(["/api/auth/get-session"]);
  });
});
