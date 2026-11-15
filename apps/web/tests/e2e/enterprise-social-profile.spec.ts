// megaui-only (FS-23): member, chat, and release DTOs use public profiles.
import { expect, test } from "@playwright/test";
import { createEnterpriseAuthFlowFixture, type EnterpriseAuthFlowFixture } from "./helpers/enterprise-auth-flow";

interface Envelope<T> {
  data: T;
}

async function readData<T>(response: { status(): number; json(): Promise<unknown> }): Promise<T> {
  const body = await response.json() as Envelope<T>;
  expect(response.status()).toBe(200);
  return body.data;
}

test.describe("FS-23 enterprise social profile", () => {
  let fixture: EnterpriseAuthFlowFixture;

  test.beforeAll(async () => {
    fixture = await createEnterpriseAuthFlowFixture();
    const historyUserId = `fs89-history-${fixture.web.database.runId}`;
    const now = new Date();
    await fixture.web.admin.pool.query(
      `insert into enterprise_profile
         (user_id, tenant_key, login_name, backend_username, display_name, notification_email, created_at, updated_at)
       values ($1, 'fs40-tenant', 'fs89-history', $2, 'FS89 Historical Bob', 'alice@example.com', $3, $3)`,
      [historyUserId, `mgu_fs89_history_${fixture.web.database.runId}`, now],
    );
    await fixture.web.admin.pool.query(
      `insert into enterprise_identity
         (id, local_user_id, tenant_key, app_id, open_id, union_id, status, identity_version, created_at, updated_at)
       values ($1, $2, 'fs40-tenant', 'fs40-app', $3, $4, 'active', 1, $5, $5)`,
      [`fs89-history-identity-${fixture.web.database.runId}`, historyUserId, `fs89-history-open-${fixture.web.database.runId}`, `fs89-history-union-${fixture.web.database.runId}`, now],
    );
  }, 240_000);

  test.afterAll(async () => {
    await fixture?.close();
  }, 120_000);

  test("keeps same-notification-email members separate and hides compatibility fields", async ({ page }) => {
    await page.goto(`${fixture.web.origin}/en/signin`);
    const pairingResponse = await page.evaluate(async () => {
      const response = await fetch("/api/auth/enterprise/request", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alias: "fs89-alice" }),
      });
      return { status: response.status, body: await response.json() as { pairingId?: string; pairingToken?: string } };
    });
    expect(pairingResponse.status).toBe(202);
    const flowCookie = (await page.context().cookies()).find(cookie => cookie.name === "__Host-megaui.enterprise-flow");
    expect(flowCookie?.value).toBeTruthy();
    const challenge = await fixture.login({
      pairingId: pairingResponse.body.pairingId!,
      pairingToken: pairingResponse.body.pairingToken!,
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

    const api = (path: string): string => `${fixture.web.origin}${path}`;
    const historyUserId = `fs89-history-${fixture.web.database.runId}`;
    const channel = await readData<{ id: string }>(
      await page.request.post(api("/api/mega/channels"), { data: { name: "FS-23 social", visibility: "private" } }),
    );
    await readData(
      await page.request.post(api(`/api/mega/channels/${channel.id}/members/invite`), { data: { userId: historyUserId } }),
    );
    const members = await readData<Array<{ userId: string; user: Record<string, unknown> }>>(
      await page.request.get(api(`/api/mega/channels/${channel.id}/members`)),
    );
    expect(members.map(member => member.userId)).toEqual([fixture.userId, historyUserId]);
    for (const member of members) {
      expect(member.user).not.toHaveProperty("email");
      expect(member.user).not.toHaveProperty("notificationEmail");
      expect(member.user).not.toHaveProperty("backendUsername");
    }
    expect(members[0]?.user).toMatchObject({ id: fixture.userId, username: "fs89-alice" });
    expect(members[1]?.user).toMatchObject({ id: historyUserId, username: "fs89-history" });

    const message = await readData<{ author: Record<string, unknown> }>(
      await page.request.post(api(`/api/mega/channels/${channel.id}/messages`), { data: { body: "FS-23 social message" } }),
    );
    expect(message.author).toMatchObject({ id: fixture.userId, username: "fs89-alice" });
    expect(message.author).not.toHaveProperty("email");

    const release = await readData<{ id: string; author: Record<string, unknown> }>(
      await page.request.post(api("/api/mega/releases"), { data: { tag: "v0.23.0-fs23", title: "FS-23 social release" } }),
    );
    expect(release.author).toMatchObject({ id: fixture.userId, username: "fs89-alice" });
    expect(release.author).not.toHaveProperty("email");
    expect(release.author).not.toHaveProperty("notificationEmail");
    expect(release.author).not.toHaveProperty("backendUsername");

    await fixture.web.admin.pool.query(
      `update enterprise_identity set status = 'suspended', identity_version = identity_version + 1 where local_user_id = $1`,
      [historyUserId],
    );
    const membersAfterSuspension = await readData<Array<{ userId: string; user: Record<string, unknown> }>>(
      await page.request.get(api(`/api/mega/channels/${channel.id}/members`)),
    );
    expect(membersAfterSuspension.find(member => member.userId === historyUserId)?.user).toMatchObject({
      id: historyUserId,
      username: "fs89-history",
      displayName: "FS89 Historical Bob",
    });
  });
});
