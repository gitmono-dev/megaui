// megaui-only (FS-22): authenticated content endpoints use enterprise public profiles.
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

test.describe("FS-22 enterprise content profile", () => {
  let fixture: EnterpriseAuthFlowFixture;

  test.beforeAll(async () => {
    fixture = await createEnterpriseAuthFlowFixture();
  }, 240_000);

  test.afterAll(async () => {
    await fixture?.close();
  }, 120_000);

  test("projects the stable login name through docs, comments, issues, and CLs", async ({ page }) => {
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

    const doc = await readData<{ id: string; author: { id: string; username: string; displayName: string } }>(
      await page.request.post(api("/api/mega/docs"), { data: { title: "FS-22 E2E document" } }),
    );
    const docComment = await readData<{ author: { id: string; username: string; displayName: string } }>(
      await page.request.post(api(`/api/mega/docs/${doc.id}/comments`), { data: { body: "FS-22 E2E comment" } }),
    );
    const issue = await readData<{ number: number; author: { id: string; username: string; displayName: string } }>(
      await page.request.post(api("/api/mega/issues"), { data: { title: "FS-22 E2E issue", packageId: "pkg_engine", priority: "P2" } }),
    );
    const issueComment = await readData<{ author: { id: string; username: string; displayName: string } }>(
      await page.request.post(api(`/api/mega/issues/${issue.number}/comments`), { data: { body: "FS-22 E2E issue comment" } }),
    );
    const cl = await readData<{ number: number; author: { id: string; username: string; displayName: string } }>(
      await page.request.post(api("/api/mega/cls"), { data: { title: "FS-22 E2E CL", packageId: "pkg_engine", branch: "fs22-e2e" } }),
    );
    const clComment = await readData<{ author: { id: string; username: string; displayName: string } }>(
      await page.request.post(api(`/api/mega/cls/${cl.number}/comments`), { data: { body: "FS-22 E2E CL comment" } }),
    );

    const projections = [doc.author, docComment.author, issue.author, issueComment.author, cl.author, clComment.author];
    for (const author of projections) {
      expect(author).toMatchObject({ id: fixture.userId, username: "fs89-alice", displayName: "FS89 Synthetic Alice" });
      expect(author).not.toHaveProperty("email");
      expect(author).not.toHaveProperty("notificationEmail");
      expect(author).not.toHaveProperty("backendUsername");
    }

    await fixture.web.admin.pool.query(
      `update enterprise_profile set notification_email = 'replacement@notify.test', display_name = 'FS89 Renamed Alice' where user_id = $1`,
      [fixture.userId],
    );
    const updatedDoc = await readData<{ author: { id: string; username: string; displayName: string } }>(
      await page.request.get(api(`/api/mega/docs/${doc.id}`)),
    );
    expect(updatedDoc.author).toMatchObject({ id: fixture.userId, username: "fs89-alice", displayName: "FS89 Renamed Alice" });
  });
});
