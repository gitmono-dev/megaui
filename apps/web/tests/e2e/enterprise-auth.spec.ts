// FS-20: enterprise sign-in is a private Feishu pairing flow, not signup/password auth.
import { expect, test } from "@playwright/test";

import {
  createEnterpriseAuthFlowFixture,
  type EnterpriseAuthFlowFixture,
} from "./helpers/enterprise-auth-flow";

test.describe("FS-20 enterprise private-chat sign-in", () => {
  let fixture: EnterpriseAuthFlowFixture;

  test.beforeAll(async () => {
    fixture = await createEnterpriseAuthFlowFixture();
  }, 240_000);

  test.afterAll(async () => {
    await fixture?.close();
  }, 120_000);

  test("guides private pairing, verifies an 8-character code, and keeps redirects internal", async ({ page, context }) => {
    await page.goto(`${fixture.web.origin}/en/signin?callbackUrl=https://evil.example/steal`);
    await expect(page.getByTestId("enterprise-login")).toBeVisible();
    await expect(page.getByTestId("enterprise-alias")).toBeVisible();

    const responsePromise = page.waitForResponse(response =>
      response.url().endsWith("/api/auth/enterprise/request") && response.request().method() === "POST");
    await page.getByTestId("enterprise-alias").fill("fs89-alice");
    await page.getByTestId("enterprise-request").click();
    const response = await responsePromise;
    const pairing = await response.json() as { pairingId: string; pairingToken: string };
    expect(response.status(), JSON.stringify(pairing)).toBe(202);
    expect(pairing.pairingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(pairing.pairingToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const flowCookie = (await context.cookies()).find(cookie => cookie.name === "__Host-megaui.enterprise-flow");
    expect(flowCookie).toBeDefined();
    const challenge = await fixture.login({
      pairingId: pairing.pairingId,
      pairingToken: pairing.pairingToken,
      flowCookie: flowCookie!.value,
    });

    await expect(page.getByTestId("enterprise-status")).toContainText(/confirmed|确认/);
    await expect(page.getByTestId("enterprise-command")).toContainText(`/login ${pairing.pairingToken}`);
    await expect(page.getByTestId("enterprise-command")).not.toContainText(challenge.code);
    const status = await page.evaluate(async (pairingId) => {
      const result = await fetch("/api/auth/enterprise/status", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pairingId }),
      });
      return { status: result.status, body: await result.json() as Record<string, unknown> };
    }, pairing.pairingId);
    expect(status.status).toBe(200);
    expect(status.body).not.toHaveProperty("code");
    expect(status.body).not.toHaveProperty("otp");
    expect(status.body).not.toHaveProperty("pairingToken");

    await page.getByTestId("enterprise-code").fill(challenge.code);
    await page.getByTestId("enterprise-verify").click();
    await page.waitForURL(/\/en\/workspace$/, { timeout: 15_000 });
  });

  test("disables legacy signup and recovery pages in enterprise mode", async ({ request }) => {
    for (const path of ["/en/signup", "/en/forgot-password", "/en/reset-password"]) {
      expect((await request.get(`${fixture.web.origin}${path}`)).status(), path).toBe(404);
    }
  });
});
