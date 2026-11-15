// megaui-only (FS-40): only the actual Web/PG runtime is asserted here.
import { expect, test } from "@playwright/test";
import { withEnterpriseWebFixture, type WebHarnessMode } from "./helpers/enterprise-fixture";

test("starts an isolated Web and PG and restarts on the same origin", async ({ request }) => {
  const mode = (process.env.MEGAUI_FS40_MODE ?? "enterprise") as WebHarnessMode;
  await withEnterpriseWebFixture(mode, async fixture => {
    expect(fixture.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const before = await request.get(`${fixture.origin}/api/health`);
    expect(before.status()).toBe(200);
    const payload = await before.json() as { status?: string; checks?: { database?: { status?: string } } };
    expect(payload.status).toBe("healthy");
    expect(payload.checks?.database?.status).toBe("healthy");
    const sourceFiles = await fixture.server.hasEnvironmentFiles();
    expect(sourceFiles).toEqual([]);
    const beforeOrigin = fixture.origin;
    await fixture.restart();
    expect(fixture.origin).toBe(beforeOrigin);
    const after = await request.get(`${fixture.origin}/api/health`);
    expect(after.status()).toBe(200);
    expect((await after.json() as { status?: string }).status).toBe("healthy");
  });
});

