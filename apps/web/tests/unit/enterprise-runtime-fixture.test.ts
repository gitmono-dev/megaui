// megaui-only (FS-88): real auxiliary-process composition with owned resources.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isDockerAvailable } from "@megaui/database/test-support";
import { createEnterpriseRuntimeFixture, type EnterpriseRuntimeFixture } from "../e2e/helpers/enterprise-runtime";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable && process.env.CI === "true") {
  throw new Error("[@megaui/web] enterprise-runtime-fixture.test.ts requires Docker in CI");
}

describe.skipIf(!dockerAvailable)("FS-88 enterprise auxiliary runtime fixture", () => {
  let fixture: EnterpriseRuntimeFixture;

  beforeAll(async () => {
    fixture = await createEnterpriseRuntimeFixture();
  }, 240_000);

  afterAll(async () => {
    await fixture?.close();
  }, 120_000);

  it("uses the fixed Web→Mock→projection→restart sequence and real auxiliary processes", async () => {
    expect(fixture.mock.runtime.callbackUrl).toBe(`${fixture.web.origin}/api/integrations/feishu/events`);
    expect(fixture.web.server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(fixture.projection.FEISHU_PROVIDER).toBe("simulator");
    expect(fixture.projection.FEISHU_SIMULATOR_ORIGIN).toBe(fixture.mock.baseUrl);
    expect(fixture.projection.FEISHU_EVENT_VERIFICATION_TOKEN).not.toBe(fixture.adminToken);
    expect(fixture.collab).toHaveLength(2);
    for (const collab of fixture.collab) {
      expect(collab.port).toBeGreaterThan(0);
      expect((await (await fetch(`http://127.0.0.1:${collab.port}/health`)).json() as { ok?: boolean }).ok).toBe(true);
      expect(Object.values(collab.env)).not.toContain(fixture.adminToken);
    }
    expect(fixture.worker.pid).toBeGreaterThan(0);
    expect(Object.values(fixture.worker.env)).not.toContain(fixture.adminToken);
    await fixture.smtp.sendProbe();

    const callback = await fetch(`${fixture.mock.baseUrl}/__mock/verify-callback`, {
      method: "POST",
      headers: { authorization: `Bearer ${fixture.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ encrypted: false }),
    });
    expect(callback.status).toBe(200);
    expect((await callback.json() as { data?: { verified?: boolean } }).data?.verified).toBe(true);
    const health = await fetch(`${fixture.web.origin}/api/health`);
    expect(health.status).toBe(200);
  });
});

