// megaui-only (FSL-129): the Feishu sign-in page, `/[lang]/signin/feishu`, end to end in a
// real browser against a Feishu-mode `next dev` Web, a one-shot PostgreSQL and a real Feishu
// Mock process (the simulator provider), all owned by `helpers/feishu-login-harness.ts`.
//
// AC1 the email step; AC3 a valid email switches to the code step; AC4 an invalid email
// shows the format error; AC5 a known and an unknown email give the same page; AC6 the code
// from the Mock inbox signs in and lands on the workspace (FSL-184), while the home page and
// the signed-in redirect of the sign-in page stay as they were; the email never reaches
// browser storage and a reload starts again at the email step; AC7 the harness releases PG,
// Mock and Web on setup failure, on a failing test body and on success.
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { getTranslation } from "@megaui/i18n";

import {
  FeishuLoginHarnessSetupError,
  listFeishuLoginHarnessLeftovers,
  startFeishuLoginHarness,
  withFeishuLoginHarness,
  type FeishuLoginHarness,
  type FeishuLoginHarnessResources,
} from "./helpers/feishu-login-harness";

const FLOW_COOKIE = "__Host-megaui.feishu-login-flow";
const SESSION_COOKIE = "better-auth.session_token";
const ALICE = { email: "alice@example.com", openId: "ou_mock_alice" };
const BOB = { email: "bob@example.com", openId: "ou_mock_bob" };
const HARNESS_TIMEOUT = 600_000;
const en = getTranslation("en");
const zh = getTranslation("zh-CN");

async function openPage(browser: Browser, origin: string, lang = "en"): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: origin });
  const page = await context.newPage();
  const response = await page.goto(`/${lang}/signin/feishu`);
  expect(response?.status()).toBe(200);
  expect(new URL(page.url()).pathname).toBe(`/${lang}/signin/feishu`);
  return { context, page };
}

/** Fills the email step, submits it and returns the request's answer. */
async function submitEmail(page: Page, email: string): Promise<{ status: number; body: string }> {
  const answer = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/auth/feishu-login/request" && response.request().method() === "POST");
  await page.getByTestId("feishu-login-email").fill(email);
  await page.getByTestId("feishu-login-request").click();
  const response = await answer;
  return { status: response.status(), body: await response.text() };
}

async function cookieNames(context: BrowserContext): Promise<string[]> {
  return (await context.cookies()).map(cookie => cookie.name).sort();
}

/** Everything the page keeps in browser storage, as one string. */
async function browserStorage(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify({
    local: Object.entries(window.localStorage),
    session: Object.entries(window.sessionStorage),
    cookie: document.cookie,
  }));
}

test.describe("FSL-129 harness cleanup (ER-14)", () => {
  test("AC7: a setup failure releases the PG and the Mock already started", async () => {
    test.setTimeout(HARNESS_TIMEOUT);
    let failure: unknown;
    try { await startFeishuLoginHarness({ failAfter: "mock" }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(FeishuLoginHarnessSetupError);
    const resources = (failure as FeishuLoginHarnessSetupError).resources;
    expect(resources.directory).toBeDefined();
    expect(resources.databaseContainer).toBeDefined();
    expect(resources.mockPid).toBeDefined();
    expect(await listFeishuLoginHarnessLeftovers(resources)).toEqual([]);
  });

  test("AC7: a setup failure after the Web is up releases the PG, the Mock and the Web", async () => {
    test.setTimeout(HARNESS_TIMEOUT);
    let failure: unknown;
    try { await startFeishuLoginHarness({ failAfter: "web" }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(FeishuLoginHarnessSetupError);
    const resources = (failure as FeishuLoginHarnessSetupError).resources;
    expect(resources.databaseContainer).toBeDefined();
    expect(resources.mockPid).toBeDefined();
    expect(resources.webPort).toBeDefined();
    expect(resources.webProcessGroup).toBeDefined();
    expect(await listFeishuLoginHarnessLeftovers(resources)).toEqual([]);
  });

  test("AC7: a failing test body releases the PG, the Mock and the Web", async () => {
    test.setTimeout(HARNESS_TIMEOUT);
    const sentinel = new Error("FSL-129 sentinel failure");
    let resources: Readonly<FeishuLoginHarnessResources> | undefined;
    await expect(withFeishuLoginHarness(async harness => {
      resources = harness.resources;
      // While the run is up every part of it is present.
      expect((await fetch(`${harness.origin}/api/health`)).status).toBe(200);
      expect(await listFeishuLoginHarnessLeftovers(resources)).toEqual([
        "source copy directory", "PostgreSQL container", "PostgreSQL listener",
        "Mock process", "Mock listener", "Web listener", "Web process group",
      ]);
      throw sentinel;
    })).rejects.toBe(sentinel);
    expect(resources).toBeDefined();
    expect(await listFeishuLoginHarnessLeftovers(resources!)).toEqual([]);
  });
});

test.describe("FSL-129 Feishu sign-in page", () => {
  let harness: FeishuLoginHarness | undefined;

  test.beforeAll(async () => {
    test.setTimeout(HARNESS_TIMEOUT);
    harness = await startFeishuLoginHarness();
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await harness?.close();
  });

  test("AC1: the email step renders an email input and a submit button, with dictionary texts", async ({ browser }) => {
    for (const [lang, copy] of [["en", en.auth.signin.feishu], ["zh-CN", zh.auth.signin.feishu]] as const) {
      const { context, page } = await openPage(browser, harness!.origin, lang);
      const step = page.getByTestId("feishu-login-email-step");
      await expect(step).toBeVisible();
      await expect(page.getByTestId("feishu-login-card")).toContainText(copy.title);
      await expect(page.getByTestId("feishu-login-card")).toContainText(copy.description);
      await expect(page.getByLabel(copy.email, { exact: true })).toBeVisible();
      await expect(page.getByLabel(copy.email, { exact: true })).toHaveAttribute("type", "email");
      await expect(page.getByRole("button", { name: copy.request, exact: true })).toBeEnabled();
      await expect(page.getByTestId("feishu-login-code-step")).toHaveCount(0);
      await context.close();
    }
    // Only this exact page is public: neighbouring paths still send a guest to sign in.
    const guest = await browser.newContext({ baseURL: harness!.origin });
    for (const path of ["/en/signin/feishu/extra", "/en/signin/feishux", "/en/signin-feishu"]) {
      const response = await guest.request.get(path, { maxRedirects: 0 });
      expect(response.status(), path).toBe(302);
      expect(new URL(response.headers().location ?? "", harness!.origin).pathname, path).toBe("/en/signin");
    }
    await guest.close();
  });

  test("AC3 / AC5: a known and an unknown email both switch to the same code step", async ({ browser }) => {
    const unknown = "nobody-fsl129@example.com";
    const bobBefore = await harness!.inboxSize(BOB.openId);
    const seen: Array<{ request: { status: number; body: string }; step: string; cookies: string[] }> = [];
    for (const email of [BOB.email, unknown]) {
      const { context, page } = await openPage(browser, harness!.origin);
      const request = await submitEmail(page, email);
      expect(request.status).toBe(202);
      const step = page.getByTestId("feishu-login-code-step");
      await expect(step).toBeVisible();
      await expect(page.getByTestId("feishu-login-email-step")).toHaveCount(0);
      await expect(page.getByTestId("feishu-login-code").locator("input")).toHaveCount(8);
      await expect(page.getByTestId("feishu-login-verify")).toHaveCount(0);
      await expect(page.getByTestId("feishu-login-change-email")).toHaveCount(0);
      await expect(page.getByTestId("feishu-login-resend")).toBeVisible();
      await expect(page.getByTestId("feishu-login-code-sent")).toHaveText(
        en.auth.signin.feishu.codeSent.replace("{email}", email));
      seen.push({
        request,
        step: (await step.innerHTML()).replaceAll(email, "{email}"),
        cookies: await cookieNames(context),
      });
      await context.close();
    }
    expect(seen[0]!.request).toEqual({ status: 202, body: JSON.stringify({ status: "accepted" }) });
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[0]!.cookies).toContain(FLOW_COOKIE);
    // The page is the same although only the member received a code.
    await expect.poll(() => harness!.inboxSize(BOB.openId), { timeout: 20_000 }).toBe(bobBefore + 1);
  });

  test("AC4: an invalid email shows the format error and stays on the email step", async ({ browser }) => {
    const { context, page } = await openPage(browser, harness!.origin);
    const request = await submitEmail(page, "not-an-email");
    expect(request.status).toBe(400);
    await expect(page.getByTestId("feishu-login-email-step").getByRole("alert")).toHaveText(en.auth.signin.feishu.invalidEmail);
    await expect(page.getByTestId("feishu-login-email-step")).toBeVisible();
    await expect(page.getByTestId("feishu-login-code-step")).toHaveCount(0);
    expect(await cookieNames(context)).not.toContain(FLOW_COOKIE);
    await context.close();
  });

  test("the email stays out of browser storage and a reload returns to the email step", async ({ browser }) => {
    const email = "reload-fsl129@example.com";
    const { context, page } = await openPage(browser, harness!.origin);
    expect((await submitEmail(page, email)).status).toBe(202);
    await expect(page.getByTestId("feishu-login-code-step")).toBeVisible();
    expect(await browserStorage(page)).not.toContain(email);
    const flow = (await context.cookies()).find(cookie => cookie.name === FLOW_COOKIE);
    expect(flow?.httpOnly).toBe(true);

    await page.reload();
    await expect(page.getByTestId("feishu-login-email-step")).toBeVisible();
    await expect(page.getByTestId("feishu-login-code-step")).toHaveCount(0);
    await expect(page.getByTestId("feishu-login-email")).toHaveValue("");
    expect(await browserStorage(page)).not.toContain(email);
    // The flow cookie is still the same one.
    expect((await context.cookies()).find(cookie => cookie.name === FLOW_COOKIE)?.value).toBe(flow?.value);
    await context.close();
  });

  test("AC6: the code from the Mock inbox signs in and lands on the workspace", async ({ browser }) => {
    const { context, page } = await openPage(browser, harness!.origin);
    const seen = await harness!.inboxSize(ALICE.openId);
    expect((await submitEmail(page, ALICE.email)).status).toBe(202);
    await expect(page.getByTestId("feishu-login-code-step")).toBeVisible();
    const code = await harness!.nextCode(ALICE.openId, seen);

    const verified = page.waitForResponse(response =>
      new URL(response.url()).pathname === "/api/auth/feishu-login/verify" && response.request().method() === "POST");
    // Pasted in lower case with a space in the middle. The boxes keep all 8 characters and
    // submit on their own. The code stays inside `evaluate` (ER-11).
    const accepted = await page.getByTestId("feishu-login-code").evaluate((root: HTMLElement, value: string) => {
      const input = root.querySelector("input");
      if (!input) return false;
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }, `${code.slice(0, 4).toLowerCase()} ${code.slice(4).toLowerCase()}`);
    expect(accepted, "the code boxes received the paste").toBe(true);
    await expect.poll(() => page.getByTestId("feishu-login-code").evaluate((root: HTMLElement, value: string) =>
      [...root.querySelectorAll("input")].map(input => input.value).join("") === value, code)).toBe(true);
    expect((await verified).status()).toBe(200);
    // FSL-184: a successful sign-in goes straight into the workspace.
    await page.waitForURL(url => url.pathname === "/en/workspace");
    expect(await cookieNames(context)).toContain(SESSION_COOKIE);
    // The home page is still there and sees the session: its single CTA leads into the workspace.
    expect((await page.goto("/en"))?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe("/en");
    const cta = page.getByTestId("home-cta");
    await expect(cta).toHaveText(en.home.enterWorkspace);
    await expect(cta).toHaveAttribute("href", "/en/workspace");
    // Signed in, the sign-in page itself redirects into the workspace, like `/en/signin`.
    const again = await context.request.get("/en/signin/feishu", { maxRedirects: 0 });
    expect(again.status()).toBe(302);
    expect(new URL(again.headers().location ?? "", harness!.origin).pathname).toBe("/en/workspace");
    await context.close();
  });

  test("AC7: on success, closing the harness releases the PG, the Mock and the Web", async () => {
    test.setTimeout(120_000);
    const resources = harness!.resources;
    expect(await listFeishuLoginHarnessLeftovers(resources)).toHaveLength(7);
    await harness!.close();
    expect(await listFeishuLoginHarnessLeftovers(resources)).toEqual([]);
  });
});
