// megaui-only (FS-19): enterprise Better Auth exposes a fixed operation set.
import { expect, test } from "@playwright/test";

import { createEnterpriseAuthFlowFixture, type EnterpriseAuthFlowFixture } from "./helpers/enterprise-auth-flow";

test.describe("FS-19 enterprise auth operation policy", () => {
  let fixture: EnterpriseAuthFlowFixture;

  test.beforeAll(async () => {
    fixture = await createEnterpriseAuthFlowFixture();
  }, 240_000);

  test.afterAll(async () => {
    await fixture?.close();
  }, 120_000);

  test("rejects unregistered, admin, delete and path-variant operations before authentication", async ({ request }) => {
    for (const path of ["/api/auth/sign-in/email", "/api/auth/admin/update-user", "/api/auth/delete-user", "/api/auth/enterprise/request/"]) {
      const response = await request.post(`${fixture.web.origin}${path}`, {
        data: { alias: "fs89-alice" },
      });
      expect(response.status(), path).toBe(404);
    }
    expect((await request.post(`${fixture.web.origin}/api/auth/enterprise/request`, {
      data: { alias: "fs89-alice" },
    })).status()).toBe(202);
  });
});
