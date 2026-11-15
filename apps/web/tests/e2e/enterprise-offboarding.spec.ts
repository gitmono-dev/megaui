// megaui-only (FS-30): revoke an enterprise identity and prove every Web
// consumer rejects the still-present Better Auth Cookie.
import { expect, test } from "@playwright/test";

import {
  createEnterpriseAuthFlowFixture,
  type EnterpriseAuthFlowFixture,
} from "./helpers/enterprise-auth-flow";

test.describe("FS-30 enterprise offboarding access consumers", () => {
  let fixture: EnterpriseAuthFlowFixture;

  test.beforeAll(async () => {
    fixture = await createEnterpriseAuthFlowFixture();
  }, 240_000);

  test.afterAll(async () => {
    await fixture?.close();
  }, 120_000);

  test("rejects protected consumers after identity deactivation and epoch advance", async ({ page }) => {
    await page.goto(`${fixture.web.origin}/en/signin`);
    const request = await page.evaluate(async () => {
      const response = await fetch("/api/auth/enterprise/request", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alias: "fs89-alice" }),
      });
      return { status: response.status, body: await response.json() as { pairingId?: string; pairingToken?: string } };
    });
    expect(request.status).toBe(202);
    const flowCookie = (await page.context().cookies()).find(
      cookie => cookie.name === "__Host-megaui.enterprise-flow",
    );
    expect(flowCookie?.value).toBeTruthy();

    const challenge = await fixture.login({
      pairingId: request.body.pairingId!,
      pairingToken: request.body.pairingToken!,
      flowCookie: flowCookie!.value,
    });
    const verify = await page.evaluate(async input => {
      const response = await fetch("/api/auth/enterprise/verify", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      return response.status;
    }, challenge);
    expect(verify).toBe(200);

    const before = await page.request.get(`${fixture.web.origin}/api/mega/home`);
    expect(before.status()).toBe(200);

    await fixture.web.admin.pool.query(
      "update enterprise_identity set status='resigned', identity_version=identity_version + 1 where id=$1",
      [`fs89-identity-${fixture.web.database.runId}`],
    );
    await fixture.web.admin.pool.query(
      "update enterprise_policy set auth_epoch=auth_epoch + 1 where scope=$1",
      [fixture.web.database.runId],
    );

    const staleApi = await page.request.get(`${fixture.web.origin}/api/mega/home`);
    expect(staleApi.status()).toBe(401);

    const staleUpload = await page.request.post(`${fixture.web.origin}/api/upload?purpose=avatar`, {
      multipart: { file: { name: "avatar.png", mimeType: "image/png", buffer: Buffer.from([1, 2, 3]) } },
    });
    expect(staleUpload.status()).toBe(401);

    const staleSettings = await page.request.get(`${fixture.web.origin}/api/mega/profile-prefs`);
    expect(staleSettings.status()).toBe(401);

    const staleTicket = await page.request.get(`${fixture.web.origin}/api/mega/collab/token`);
    expect(staleTicket.status()).toBe(401);

    const staleHome = await page.request.get(`${fixture.web.origin}/en`, { maxRedirects: 0 });
    expect(staleHome.status()).toBe(200);
    expect(await staleHome.text()).toContain("/en/signin");

    const stalePage = await page.request.get(`${fixture.web.origin}/en/workspace`, { maxRedirects: 0 });
    expect(stalePage.status()).toBe(302);
    expect(stalePage.headers().location).toContain("/en/signin");
  });
});
