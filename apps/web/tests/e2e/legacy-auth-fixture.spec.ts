// megaui-only (FS-89): legacy keeps its normal Better Auth Cookie path.
import { expect, test } from "@playwright/test";
import { createLegacyAuthFlowFixture, type LegacyAuthFlowFixture } from "./helpers/enterprise-auth-flow";

test.describe("FS-89 legacy normal Cookie flow", () => {
  let fixture: LegacyAuthFlowFixture;

  test.beforeAll(async () => {
    fixture = await createLegacyAuthFlowFixture();
  }, 240_000);

  test.afterAll(async () => {
    await fixture?.close();
  }, 120_000);

  test("signs up and signs in through the existing normal login route", async ({ page, context }) => {
    const password = "FS89-legacy-pass-9x!";
    await page.goto(`${fixture.web.origin}/en/signup`);
    await page.fill("input#name", "FS89 Legacy Synthetic");
    await page.fill("input#email", fixture.email);
    await page.fill("input#password", password);
    await page.getByRole("button", { name: /create account/i }).click();
    await page.waitForURL(/\/en\/workspace/, { timeout: 15_000 });
    await context.clearCookies();
    await page.goto(`${fixture.web.origin}/en/signin`);
    await page.fill("input#email", fixture.email);
    await page.fill("input#password", password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(/\/en\/workspace/, { timeout: 15_000 });
    const session = await page.evaluate(async () => {
      const response = await fetch("/api/auth/get-session", { credentials: "include" });
      return { status: response.status, body: await response.json() as { user?: { email?: string } } };
    });
    expect(session.status).toBe(200);
    expect(session.body.user?.email).toBe(fixture.email);
    expect((await context.cookies()).some(cookie => cookie.name.includes("session") && cookie.value.length > 0)).toBe(true);
    const persisted = await fixture.web.admin.pool.query<{ user_id: string; enterprise_grant_id: string | null; auth_method: string | null }>(
      `select user_id, enterprise_grant_id, auth_method from session
        where user_id=(select id from "user" where email=$1)
        order by created_at desc limit 1`, [fixture.email],
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]).toMatchObject({ enterprise_grant_id: null, auth_method: null });
    await fixture.smtp.sendProbe();
  });
});
