import { expect, test } from "@playwright/test";

import { mintResetToken } from "./helpers/reset-token";
import { mintSessionCookies } from "./helpers/session";
import { e2eBaseURL } from "./helpers/base-url";
import { resolvePostAuthPath } from "../../lib/post-auth-redirect";

/**
 * WA-02 e2e: auth pages render, form validate/submit/error, logged-in
 * redirect, OAuth hidden when unset, reset-password full flow.
 *
 * AC-1 Four pages render + form validate/submit/error.
 * AC-2 Logged-in visit to auth pages redirects to workspace (middleware).
 * AC-3 Metadata titles are locale-correct (spot-checked via page.title()).
 * AC-4 OAuth buttons hidden when providers unset.
 */

// ---------------------------------------------------------------------------
// AC-1a  Signin page renders + client-side validation
// ---------------------------------------------------------------------------

test.describe("WA-02 signin page", () => {
  test("post-auth redirect rejects external and protocol-relative targets", () => {
    expect(resolvePostAuthPath(new URLSearchParams("callbackUrl=https%3A%2F%2Fevil.example"), "en"))
      .toBe("/en/workspace");
    expect(resolvePostAuthPath(new URLSearchParams("callbackUrl=%2F%2Fevil.example"), "en"))
      .toBe("/en/workspace");
  });

  test("renders sign-in card en", async ({ page }) => {
    await page.goto("/en/signin");
    await expect(page.getByTestId("signin-card")).toBeVisible();
    await expect(page).toHaveTitle(/Sign In/i);
  });

  test("renders sign-in card zh-CN", async ({ page }) => {
    await page.goto("/zh-CN/signin");
    await expect(page.getByTestId("signin-card")).toBeVisible();
  });

  test("email required validation on submit", async ({ page }) => {
    await page.goto("/en/signin");
    await page.getByRole("button", { name: /sign in/i }).click();
    // Should show inline validation error for email
    await expect(
      page.locator("span.text-destructive").first(),
    ).toBeVisible();
  });

  test("invalid email format validation on blur", async ({ page }) => {
    await page.goto("/en/signin");
    await page.fill("input#email", "notanemail");
    await page.locator("input#email").blur();
    await expect(page.locator("span.text-destructive")).toBeVisible();
  });

  test("bad credentials shows auth error", async ({ page }) => {
    await page.goto("/en/signin");
    await page.fill("input#email", "nobody@example.com");
    await page.fill("input#password", "wrongpassword");
    await page.getByRole("button", { name: /sign in/i }).click();
    // FormError should appear
    await expect(page.locator("[data-slot=alert]")).toBeVisible({
      timeout: 8000,
    });
  });
});

// ---------------------------------------------------------------------------
// AC-1b  Signup page renders + form validation
// ---------------------------------------------------------------------------

test.describe("WA-02 signup page", () => {
  test("renders sign-up card en", async ({ page }) => {
    await page.goto("/en/signup");
    await expect(page.getByTestId("signup-card")).toBeVisible();
    await expect(page).toHaveTitle(/Create Account/i);
  });

  test("missing required fields shows validation errors", async ({ page }) => {
    await page.goto("/en/signup");
    await page.getByRole("button", { name: /create account/i }).click();
    await expect(
      page.locator("span.text-destructive").first(),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// AC-1c  Full register → login → workspace flow
// ---------------------------------------------------------------------------

test.describe("WA-02 register → login flow", () => {
  test("signup then signin lands on workspace", async ({ page }) => {
    const ts = Date.now();
    const email = `wa02-e2e-${ts}@example.com`;
    const password = "WA02-e2e-pass-9x!";
    const name = "WA02 E2E User";

    // ── Register ──────────────────────────────────────────────────────────
    await page.goto("/en/signup");
    await page.fill("input#name", name);
    await page.fill("input#email", email);
    await page.fill("input#password", password);
    await page.getByRole("button", { name: /create account/i }).click();

    // Should redirect to /en/workspace (no email verification in dev)
    await page.waitForURL(/\/en\/workspace/, { timeout: 10_000 });

    // ── Sign out by clearing auth cookies ────────────────────────────────
    await page.context().clearCookies();
    await page.goto("/en/signin");
    await expect(page.getByTestId("signin-card")).toBeVisible();

    // ── Login ─────────────────────────────────────────────────────────────
    await page.fill("input#email", email);
    await page.fill("input#password", password);
    await page.getByRole("button", { name: /sign in/i }).click();

    await page.waitForURL(/\/en\/workspace/, { timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// AC-1d  Forgot-password page renders + success state
// ---------------------------------------------------------------------------

test.describe("WA-02 forgot-password page", () => {
  test("renders forgot-password card en", async ({ page }) => {
    await page.goto("/en/forgot-password");
    await expect(page.getByTestId("forgot-password-card")).toBeVisible();
    await expect(page).toHaveTitle(/Reset Password/i);
  });

  test("email validation on blur", async ({ page }) => {
    await page.goto("/en/forgot-password");
    await page.fill("input#email", "bad");
    await page.locator("input#email").blur();
    await expect(page.locator("span.text-destructive")).toBeVisible();
  });

  test("valid email shows success message", async ({ page }) => {
    await page.goto("/en/forgot-password");
    await page.fill("input#email", "anyuser@example.com");
    await page.getByRole("button", { name: /send reset/i }).click();
    // Server always returns 200 even for non-existent emails (security)
    await expect(
      page.getByText(/check your email/i),
    ).toBeVisible({ timeout: 8000 });
  });
});

// ---------------------------------------------------------------------------
// AC-1e  Reset-password page renders + invalid-token state
// ---------------------------------------------------------------------------

test.describe("WA-02 reset-password page", () => {
  test("renders reset-password card en", async ({ page }) => {
    await page.goto("/en/reset-password?token=dummy");
    await expect(page.getByTestId("reset-password-card")).toBeVisible();
    await expect(page).toHaveTitle(/New Password/i);
  });

  test("missing token shows error immediately", async ({ page }) => {
    await page.goto("/en/reset-password");
    // FormError should appear on mount
    await expect(page.locator("[data-slot=alert]")).toBeVisible({
      timeout: 5000,
    });
  });

  test("password mismatch shows field error", async ({ page }) => {
    await page.goto("/en/reset-password?token=dummy");
    await page.fill("input#password", "NewPass123!");
    await page.fill("input#confirmPassword", "Different1!");
    await page.getByRole("button", { name: /reset password/i }).click();
    await expect(page.locator("span.text-destructive")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// AC-1e  Full reset-password flow with real token
// ---------------------------------------------------------------------------

test.describe("WA-02 reset-password with real token", () => {
  test("can set a new password with a valid token", async ({ page }) => {
    // Skip if DB/server is unavailable (CI without DB)
    let resetData: { email: string; token: string };
    try {
      resetData = mintResetToken();
    } catch (err) {
      test.skip(true, `mintResetToken failed: ${String(err)}`);
      return;
    }

    const newPassword = "WA02-new-pass-9x!";
    await page.goto(
      `/en/reset-password?token=${encodeURIComponent(resetData.token)}`,
    );
    await expect(page.getByTestId("reset-password-card")).toBeVisible();

    await page.fill("input#password", newPassword);
    await page.fill("input#confirmPassword", newPassword);
    await page.getByRole("button", { name: /reset password/i }).click();

    // Success state
    await expect(page.getByText(/password updated/i)).toBeVisible({ timeout: 8000 });
    await expect(
      page.getByRole("link", { name: /back to sign in/i }),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// AC-2  Logged-in users visiting auth pages are redirected to workspace
// ---------------------------------------------------------------------------

test.describe("WA-02 logged-in redirect from auth pages", () => {
  test("signed-in user visiting /signin redirects to /workspace", async ({
    browser,
  }) => {
    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({
      baseURL: e2eBaseURL(),
    });
    await context.addCookies(cookies);
    const page = await context.newPage();

    const response = await page.goto("/en/signin", {
      waitUntil: "commit",
    });
    // Middleware should redirect to /en/workspace
    expect(response?.url()).toMatch(/\/en\/workspace/);
    await context.close();
  });

  test("signed-in user visiting /signup redirects to /workspace", async ({
    browser,
  }) => {
    const { cookies } = mintSessionCookies();
    const context = await browser.newContext({
      baseURL: e2eBaseURL(),
    });
    await context.addCookies(cookies);
    const page = await context.newPage();

    const response = await page.goto("/en/signup", {
      waitUntil: "commit",
    });
    expect(response?.url()).toMatch(/\/en\/workspace/);
    await context.close();
  });
});

// ---------------------------------------------------------------------------
// AC-4  OAuth buttons are absent when providers are not configured
// ---------------------------------------------------------------------------

test.describe("WA-02 OAuth providers", () => {
  test("no social buttons rendered when env vars unset", async ({ page }) => {
    // The running dev build has no GOOGLE_CLIENT_ID/GITHUB_CLIENT_ID in .env
    await page.goto("/en/signin");
    await expect(page.getByTestId("signin-card")).toBeVisible();
    // SocialButton renders as <button> elements with provider-specific icons;
    // if unset the SocialAuth component returns null and no buttons appear.
    const socialButtons = page.locator(
      "[data-slot=card-content] button[type=button]",
    );
    await expect(socialButtons).toHaveCount(0);
  });
});
