// megaui-only (FSL-131): the sign-in entry in Feishu mode, end to end against a Feishu-mode
// `next dev` Web, a one-shot PostgreSQL and a real Feishu Mock process, all owned by
// `helpers/feishu-login-harness.ts`.
//
// AC1 a guest's `/[lang]/signin` answers 307 to `/[lang]/signin/feishu` (query keys and values kept) and
// renders no password form or sign-up link; AC2 a guest on a protected page is sent to
// `/[lang]/signin` and from there lands on the Feishu sign-in page; AC3 / AC4 / AC5
// `/[lang]/signup`, `/[lang]/forgot-password` and `/[lang]/reset-password` answer 404.
// Nothing here enters an email or a code.
import { expect, test, type Browser, type Page } from "@playwright/test";

import { getTranslation } from "@megaui/i18n";

import {
  FeishuLoginHarnessSetupError,
  startFeishuLoginHarness,
  type FeishuLoginHarness,
} from "./helpers/feishu-login-harness";

const HARNESS_TIMEOUT = 600_000;
const LOCALES = ["en", "zh-CN"] as const;

/**
 * The failure page snapshot (`error-context.md`) is switched off for this worker, as in the
 * other Feishu login specs, so a failed test never writes a page snapshot (ER-11).
 */
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

/**
 * Runs `work` on a new page in a new context. The context is closed when the page cannot be
 * created, when `work` returns or throws, and also when closing the page throws.
 */
async function withPage(browser: Browser, harness: FeishuLoginHarness, work: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ baseURL: harness.origin });
  try {
    const page = await context.newPage();
    try {
      await work(page);
    } finally {
      await page.close();
    }
  } finally {
    await context.close();
  }
}

/** The page is the Feishu sign-in page, without the password form or the sign-up link. */
async function expectFeishuPage(page: Page, lang: (typeof LOCALES)[number]): Promise<void> {
  const copy = getTranslation(lang).auth.signin;
  await expect(page.getByTestId("feishu-login-card")).toContainText(copy.feishu.title);
  await expect(page.getByTestId("feishu-login-email-step")).toBeVisible();
  await expect(page.getByTestId("signin-card")).toHaveCount(0);
  await expect(page.getByTestId("enterprise-login")).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.locator(`a[href^="/${lang}/signup"]`)).toHaveCount(0);
  await expect(page.locator(`a[href^="/${lang}/forgot-password"]`)).toHaveCount(0);
  await expect(page.getByText(copy.signupLink, { exact: true })).toHaveCount(0);
}

test.describe("FSL-131 Feishu-mode sign-in entry", () => {
  let harness: FeishuLoginHarness | undefined;
  // The start itself, kept so that `afterAll` still closes a harness whose start outlived a
  // `beforeAll` timeout (Playwright does not wait for a timed-out hook). A start that fails
  // releases what it started on its own (`FeishuLoginHarnessSetupError`), ER-14 / EX-17.
  let starting: Promise<FeishuLoginHarness> | undefined;

  test.beforeAll(async () => {
    test.setTimeout(HARNESS_TIMEOUT);
    starting = startFeishuLoginHarness();
    harness = await starting;
  });

  test.afterAll(async () => {
    test.setTimeout(HARNESS_TIMEOUT);
    let started: FeishuLoginHarness | undefined;
    try {
      started = await starting;
    } catch (error) {
      // A setup error has already released what it started. Anything else, and a setup
      // error whose cause is an AggregateError (an inner setup whose own cleanup may also
      // have failed), is reported here.
      if (!(error instanceof FeishuLoginHarnessSetupError) || error.cause instanceof AggregateError) throw error;
    }
    await started?.close();
  });

  test("AC1: a guest's /[lang]/signin answers 307 to /[lang]/signin/feishu", async ({ browser }) => {
    const guest = await browser.newContext({ baseURL: harness!.origin });
    try {
      for (const lang of LOCALES) {
        const plain = await guest.request.get(`/${lang}/signin`, { maxRedirects: 0 });
        expect(plain.status(), lang).toBe(307);
        const target = new URL(plain.headers().location ?? "", harness!.origin);
        expect(target.origin).toBe(harness!.origin);
        expect(`${target.pathname}${target.search}`).toBe(`/${lang}/signin/feishu`);
        // The query parameter (here the guest redirect's callbackUrl) keeps its value.
        const query = await guest.request.get(`/${lang}/signin?callbackUrl=%2F${lang}%2Fworkspace`, { maxRedirects: 0 });
        expect(query.status(), lang).toBe(307);
        const queried = new URL(query.headers().location ?? "", harness!.origin);
        expect(queried.pathname).toBe(`/${lang}/signin/feishu`);
        expect(queried.searchParams.get("callbackUrl")).toBe(`/${lang}/workspace`);
        // The redirect itself carries no sign-in form.
        expect(await plain.text()).not.toContain('type="password"');
      }
    } finally {
      await guest.close();
    }
    // In a browser the sign-in page is the Feishu page, with no password form or sign-up link.
    for (const lang of LOCALES) {
      await withPage(browser, harness!, async page => {
        await page.goto(`/${lang}/signin`);
        expect(new URL(page.url()).pathname).toBe(`/${lang}/signin/feishu`);
        await expectFeishuPage(page, lang);
      });
    }
  });

  test("AC2: a guest on a protected page ends on the Feishu sign-in page", async ({ browser }) => {
    const guest = await browser.newContext({ baseURL: harness!.origin });
    try {
      // The middleware's first hop is unchanged: 302 to /[lang]/signin with the callbackUrl.
      const first = await guest.request.get("/en/workspace", { maxRedirects: 0 });
      expect(first.status()).toBe(302);
      const signin = new URL(first.headers().location ?? "", harness!.origin);
      expect(signin.pathname).toBe("/en/signin");
      expect(signin.searchParams.get("callbackUrl")).toBe("/en/workspace");
      const second = await guest.request.get(`${signin.pathname}${signin.search}`, { maxRedirects: 0 });
      expect(second.status()).toBe(307);
      expect(new URL(second.headers().location ?? "", harness!.origin).pathname).toBe("/en/signin/feishu");
    } finally {
      await guest.close();
    }
    for (const [lang, path] of [["en", "/en/workspace"], ["zh-CN", "/zh-CN/workspace/issues"]] as const) {
      await withPage(browser, harness!, async page => {
        const response = await page.goto(path);
        expect(response?.status(), path).toBe(200);
        const landed = new URL(page.url());
        expect(landed.pathname, path).toBe(`/${lang}/signin/feishu`);
        expect(landed.searchParams.get("callbackUrl"), path).toBe(path);
        await expectFeishuPage(page, lang);
      });
    }
  });

  for (const [ac, name] of [["AC3", "signup"], ["AC4", "forgot-password"], ["AC5", "reset-password"]] as const) {
    test(`${ac}: /[lang]/${name} answers 404`, async ({ browser }) => {
      const guest = await browser.newContext({ baseURL: harness!.origin });
      try {
        for (const lang of LOCALES) {
          for (const path of [`/${lang}/${name}`, `/${lang}/${name}/`]) {
            const response = await guest.request.get(path, { maxRedirects: 0 });
            expect(response.status(), path).toBe(404);
            expect(response.headers()["cache-control"], path).toBe("no-store");
            expect(await response.text(), path).not.toContain("<form");
          }
        }
      } finally {
        await guest.close();
      }
      await withPage(browser, harness!, async page => {
        const response = await page.goto(`/en/${name}`);
        expect(response?.status()).toBe(404);
        expect(new URL(page.url()).pathname).toBe(`/en/${name}`);
        await expect(page.locator("form")).toHaveCount(0);
      });
    });
  }
});
