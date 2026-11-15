/** FS-24: local enterprise notification projection stays separate from identity binding. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveWebActor = vi.hoisted(() => vi.fn());

vi.mock("@/lib/enterprise-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/enterprise-session")>()),
  resolveWebActor,
}));

import { GET, PUT } from "../../app/api/mega/[...segments]/route";
import type { WebActor } from "../../lib/enterprise-session";

const enterpriseActor: WebActor = {
  kind: "enterprise",
  userId: "fs24-user",
  identityId: "fs24-identity",
  authEpoch: 4,
  backendUsername: "Directory.User",
  email: "notify@example.test",
  sessionId: "fs24-session",
};

function context(segments: string[]) {
  return { params: Promise.resolve({ segments }) };
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`http://127.0.0.1:3000/api/mega${path}`, {
    ...init,
    headers: { Cookie: "fs24=session", ...(init.headers ?? {}) },
  });
}

describe("FS-24 enterprise notification settings contract", () => {
  beforeEach(() => {
    resolveWebActor.mockReset().mockResolvedValue(enterpriseActor);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("projects the local notification email without deriving the public username from it", async () => {
    const response = await GET(request("/profile-prefs"), context(["profile-prefs"]));
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      directoryManaged: true,
      notificationEmail: "notify@example.test",
      username: "Directory.User",
    });
    expect(body.data.username).not.toBe("notify");
  });

  it("keeps an absent notification address non-blocking", async () => {
    resolveWebActor.mockResolvedValue({ ...enterpriseActor, email: null });
    const response = await GET(request("/profile-prefs"), context(["profile-prefs"]));
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Record<string, unknown> };
    expect(body.data.notificationEmail).toBeNull();
  });

  it("rejects identity-binding fields before the mega2 notification adapter is called", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const response = await PUT(
      request("/user/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, email: "attacker@example.test" }),
      }),
      context(["user", "notifications"]),
    );
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards only the pinned enabled/preferences notification contract", async () => {
    const previousBaseUrl = process.env.MEGA2_PUBLIC_BASE_URL;
    process.env.MEGA2_PUBLIC_BASE_URL = "http://127.0.0.1:9";
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        enabled: true,
        preferences: [{ event_type_code: "cl.comment.created", enabled: false }],
      });
      return new Response(JSON.stringify({
        req_result: true,
        data: {
          settings: { username: "Directory.User", enabled: true },
          preferences: [{
            event_type_code: "cl.comment.created",
            category: "cl",
            description: "Comments",
            system_required: false,
            default_enabled: true,
            explicit_enabled: false,
            enabled: false,
          }],
        },
        err_message: "",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const response = await PUT(
        request("/user/notifications", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled: true,
            deliveryMode: "email",
            preferredLocale: "en",
            preferences: [{ eventTypeCode: "cl.comment.created", enabled: false }],
          }),
        }),
        context(["user", "notifications"]),
      );
      expect(response.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (previousBaseUrl === undefined) delete process.env.MEGA2_PUBLIC_BASE_URL;
      else process.env.MEGA2_PUBLIC_BASE_URL = previousBaseUrl;
    }
  });
});
