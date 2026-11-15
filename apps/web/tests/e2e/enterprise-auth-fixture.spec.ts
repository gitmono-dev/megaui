// megaui-only (FS-89): browser obtains the enterprise Cookie through normal HTTP.
import { expect, test } from "@playwright/test";
import { createEnterpriseAuthFlowFixture, type EnterpriseAuthFlowFixture } from "./helpers/enterprise-auth-flow";

test.describe("FS-89 enterprise normal Cookie flow", () => {
  let fixture: EnterpriseAuthFlowFixture;

  test.beforeAll(async () => {
    fixture = await createEnterpriseAuthFlowFixture();
  }, 240_000);

  test.afterAll(async () => {
    await fixture?.close();
  }, 120_000);

  test("pairs through Web → Mock DM → OTP verify and receives a server Cookie", async ({ page, context }) => {
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
    expect(request.body.pairingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.body.pairingToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const flowCookie = (await context.cookies()).find(cookie => cookie.name === "__Host-megaui.enterprise-flow");
    expect(flowCookie).toMatchObject({ path: "/", httpOnly: true, secure: true, sameSite: "Lax" });

    const challenge = await fixture.login({ pairingId: request.body.pairingId!, pairingToken: request.body.pairingToken!, flowCookie: flowCookie!.value });
    const verify = await page.evaluate(async (input) => {
      const response = await fetch("/api/auth/enterprise/verify", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      return { status: response.status, text: await response.text() };
    }, challenge);
    expect(verify.status).toBe(200);
    expect(JSON.parse(verify.text)).toEqual({ ok: true });
    expect(verify.text).not.toContain("token");

    const session = await page.evaluate(async () => {
      const response = await fetch("/api/auth/get-session", { credentials: "include" });
      return { status: response.status, body: await response.json() as { user?: { id?: string; email?: string } } };
    });
    expect(session.status).toBe(200);
    expect(session.body.user).toMatchObject({ id: fixture.userId, email: "alice@example.com" });
    const cookies = await context.cookies();
    expect(cookies.some(cookie => cookie.name.includes("session") && cookie.value.length > 0)).toBe(true);
    const persisted = await fixture.web.admin.pool.query<{ user_id: string; enterprise_grant_id: string | null; auth_method: string | null }>(
      `select user_id, enterprise_grant_id, auth_method from session where user_id=$1`, [fixture.userId],
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]).toMatchObject({ user_id: fixture.userId, auth_method: "enterprise" });
    expect(persisted.rows[0]?.enterprise_grant_id).toMatch(/^[0-9a-f-]{36}$/);
    const syntheticHistory = await fixture.web.admin.pool.query<{ accounts: number; actors: number; inventories: number; approvals: number }>(
      `select
         (select count(*)::int from account where user_id like 'fs89-history-%') as accounts,
         (select count(*)::int from enterprise_actor_reservations where id like 'fs89-actor-reservation-%') as actors,
         (select count(*)::int from enterprise_actor_inventory where scope=$1) as inventories,
         (select count(*)::int from enterprise_admin_operations where id like 'fs89-operation-row-%') as approvals`,
      [fixture.web.database.runId],
    );
    expect(syntheticHistory.rows[0]).toEqual({ accounts: 1, actors: 1, inventories: 1, approvals: 1 });
  });
});
