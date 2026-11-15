import { expect, test } from "@playwright/test";

test.describe("FS-73 enterprise pairing request", () => {
  test("browser stores the secure __Host flow cookie and sends it on the next request", async ({ page, context }) => {
    await page.goto("/en/signin");
    const first = await page.evaluate(async () => {
      const response = await fetch("/api/auth/enterprise/request", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alias: "unknown" }),
      });
      return { status: response.status, body: await response.json() as unknown };
    });
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(first.body).toMatchObject({ expiresIn: 120, resendAfter: 60 });

    const cookies = await context.cookies();
    const flow = cookies.find(cookie => cookie.name === "__Host-megaui.enterprise-flow");
    expect(flow).toBeDefined();
    expect(flow).toMatchObject({ path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
    expect(flow?.domain).toBe("127.0.0.1");

    const requestSeen = page.waitForRequest(request => request.url().endsWith("/api/auth/enterprise/request") && request.method() === "POST");
    const second = await page.evaluate(async () => {
      const response = await fetch("/api/auth/enterprise/request", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alias: "unknown" }),
      });
      return { status: response.status, body: await response.json() as unknown };
    });
    expect((await (await requestSeen).allHeaders()).cookie).toContain("__Host-megaui.enterprise-flow=");
    expect(second).toEqual({ status: 429, body: { error: "RATE_LIMITED" } });
  });
});
