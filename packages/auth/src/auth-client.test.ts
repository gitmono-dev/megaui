import { describe, expect, it } from "vitest";
import { createAuthClient } from "./client";

describe("createAuthClient (@megaui/auth/client)", () => {
  it("creates a react auth client with optional baseURL", () => {
    const client = createAuthClient({ baseURL: "http://localhost:3000" });
    expect(client).toBeTruthy();
    expect(client.signIn).toBeTruthy();
    expect(client.signUp).toBeTruthy();
    expect(typeof client.signOut).toBe("function");
    expect(typeof client.getSession).toBe("function");
    expect(typeof client.enterprise.request).toBe("function");
    expect(typeof client.enterprise.status).toBe("function");
    expect(typeof client.enterprise.verify).toBe("function");
  });
});
