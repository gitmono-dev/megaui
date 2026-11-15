import { expect, test } from "@playwright/test";

import { mintSessionCookies } from "./helpers/session";
import { e2eBaseURL } from "./helpers/base-url";

/**
 * WA-01 e2e: locale redirect, homepage two-state CTA, fail-closed protection.
 */

test.describe("WA-01 home / locale / protection", () => {
  test("GET / redirects to default locale (en)", async ({ request }) => {
    const response = await request.get("/", { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    const location = response.headers().location ?? "";
    expect(location).toMatch(/\/en\/?$/);
  });

  test("locale negotiation: cookie NEXT_LOCALE=zh-CN wins", async ({
    request,
  }) => {
    const response = await request.get("/", {
      maxRedirects: 0,
      headers: {
        Cookie: "NEXT_LOCALE=zh-CN",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    expect(response.status()).toBe(302);
    const location = response.headers().location ?? "";
    expect(location).toMatch(/\/zh-CN\/?$/);
  });

  test("locale negotiation: Accept-Language when no cookie", async ({
    request,
  }) => {
    const response = await request.get("/", {
      maxRedirects: 0,
      headers: {
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
    expect(response.status()).toBe(302);
    const location = response.headers().location ?? "";
    expect(location).toMatch(/\/zh-CN\/?$/);
  });

  test("guest homepage shows Login CTA", async ({ page }) => {
    await page.goto("/en");
    const cta = page.getByTestId("home-cta");
    await expect(cta).toBeVisible();
    await expect(cta).toHaveText("Login");
    await expect(cta).toHaveAttribute("href", "/en/signin");
  });

  test("guest homepage zh-CN shows 登录 CTA", async ({ page }) => {
    await page.goto("/zh-CN");
    const cta = page.getByTestId("home-cta");
    await expect(cta).toBeVisible();
    await expect(cta).toHaveText("登录");
    await expect(cta).toHaveAttribute("href", "/zh-CN/signin");
  });

  test("signed-in homepage shows Enter Workspace CTA", async ({ browser }) => {
    const { cookies } = await mintSessionCookies();
    const context = await browser.newContext({
      baseURL: e2eBaseURL(),
    });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto("/en");
    const cta = page.getByTestId("home-cta");
    await expect(cta).toBeVisible();
    await expect(cta).toHaveText("Enter Workspace");
    await expect(cta).toHaveAttribute("href", "/en/workspace");
    await context.close();
  });

  test("fail-closed: unlisted page redirects to signin", async ({
    request,
  }) => {
    const response = await request.get("/en/workspace", { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    const location = response.headers().location ?? "";
    expect(location).toContain("/en/signin");
  });

  test("fail-closed: unlisted API returns 401 with mega envelope", async ({
    request,
  }) => {
    const response = await request.get("/api/mega/anything");
    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body.error?.code).toBe("UNAUTHORIZED");
    expect(body.error?.messageKey).toBe("errors.auth.unauthorized");
    expect(typeof body.error?.message).toBe("string");
  });

  test("fail-closed: dotted API path still requires auth", async ({
    request,
  }) => {
    const response = await request.get("/api/mega/anything.json");
    expect(response.status()).toBe(401);
  });

  test("fail-closed: case-variant API path still requires auth", async ({
    request,
  }) => {
    const response = await request.get("/API/mega/anything.json");
    expect(response.status()).toBe(401);
  });

  test("/api/health returns DB status without connection string", async ({
    request,
  }) => {
    const response = await request.get("/api/health");
    expect([200, 503]).toContain(response.status());
    const body = await response.json();
    expect(body).toHaveProperty("checks.database.status");
    expect(JSON.stringify(body)).not.toMatch(/postgres(ql)?:\/\//i);
    expect(JSON.stringify(body)).not.toContain("DATABASE_URL");
  });
});
