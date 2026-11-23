// megaui-only (FSL-130): the error messages of the Feishu sign-in page's code step, end to
// end in a real browser against a Feishu-mode `next dev` Web, a one-shot PostgreSQL and a
// real Feishu Mock process, all owned by `helpers/feishu-login-harness.ts`. Every status is
// the real verify endpoint's answer; the page's fetch is never intercepted.
//
// AC1 / AC2 a wrong code shows "invalid or expired" and the step stays usable (the right
// code then signs in); AC3 a 409, from a local user preset with the member's email, shows
// the account conflict; AC4 a 503, from a session insert failure injected by a trigger in
// the run's database, asks for a new code. A used code answers 401 and shows the same text
// as a wrong one (the page does not tell wrong, expired, voided and used codes apart).
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { getTranslation } from "@megaui/i18n";

import {
  FeishuLoginHarnessSetupError,
  startFeishuLoginHarness,
  type FeishuLoginHarness,
} from "./helpers/feishu-login-harness";

const SESSION_COOKIE = "better-auth.session_token";
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const ALICE = { email: "alice@example.com", openId: "ou_mock_alice" };
const BOB = { email: "bob@example.com", openId: "ou_mock_bob" };
const DAVE = { email: "dave@corp.example.com", openId: "ou_mock_dave" };
const HARNESS_TIMEOUT = 600_000;
const en = getTranslation("en").auth.signin.feishu;
const zh = getTranslation("zh-CN").auth.signin.feishu;

type Copy = typeof en;

function isPost(path: string) {
  return (response: { url(): string; request(): { method(): string } }) =>
    new URL(response.url()).pathname === path && response.request().method() === "POST";
}

interface CodeStep {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly code: string;
}

/**
 * Opens the page in `lang` in a new browser context, requests a code for `member`, reads it
 * from the Mock inbox and runs `work` with the code step on screen. The page is closed
 * before its context when `work` returns or throws, so no context is left with a page. A
 * test timeout may skip this `finally`; the failure page snapshot is switched off for that
 * case by `PLAYWRIGHT_NO_COPY_PROMPT` below (ER-11).
 */
async function onCodeStep(
  browser: Browser,
  harness: FeishuLoginHarness,
  member: { email: string; openId: string },
  lang: "en" | "zh-CN",
  work: (step: CodeStep) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({ baseURL: harness.origin });
  const page = await context.newPage();
  try {
    expect((await page.goto(`/${lang}/signin/feishu`))?.status()).toBe(200);
    const seen = await harness.inboxSize(member.openId);
    const requested = page.waitForResponse(isPost("/api/auth/feishu-login/request"));
    await page.getByTestId("feishu-login-email").fill(member.email);
    await page.getByTestId("feishu-login-request").click();
    expect((await requested).status()).toBe(202);
    await expect(page.getByTestId("feishu-login-code-step")).toBeVisible();
    await work({ context, page, code: await harness.nextCode(member.openId, seen) });
  } finally {
    await page.close();
    await context.close();
  }
}

/** Whether the eight boxes join to `code`, compared in the page (ER-11). */
function codeIs(page: Page, code: string): Promise<boolean> {
  return page.getByTestId("feishu-login-code").evaluate((root: HTMLElement, value: string) =>
    [...root.querySelectorAll("input")].map(input => input.value).join("") === value, code);
}

/**
 * Pastes `code` into the boxes as one input event. A complete code submits itself and this
 * answers the verify status. The code is passed only as an `evaluate` argument and compared
 * inside the page: `locator.fill` would write the value into Playwright's call log, and
 * `toHaveValue` into its failure message (ER-11).
 */
async function submitCode(page: Page, code: string): Promise<number> {
  const verified = page.waitForResponse(isPost("/api/auth/feishu-login/verify"));
  const field = page.getByTestId("feishu-login-code");
  const accepted = await field.evaluate((root: HTMLElement, value: string) => {
    const input = root.querySelector("input");
    if (!input) return false;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, code);
  expect(accepted, "the code boxes received the code").toBe(true);
  await expect.poll(() => codeIs(page, code)).toBe(true);
  return (await verified).status();
}

/** The page shows `text` as the code step's only alert and is still on the code step. */
async function expectCodeStepError(page: Page, context: BrowserContext, text: string): Promise<void> {
  const step = page.getByTestId("feishu-login-code-step");
  await expect(step.getByRole("alert")).toHaveText(text);
  await expect(step).toBeVisible();
  await expect(page.getByTestId("feishu-login-email-step")).toHaveCount(0);
  await expect(page.getByTestId("feishu-login-code").locator("input").first()).toBeEnabled();
  await expect(page.getByTestId("feishu-login-resend")).toBeVisible();
  expect(new URL(page.url()).pathname).toMatch(/\/signin\/feishu$/);
  expect((await context.cookies()).map(cookie => cookie.name)).not.toContain(SESSION_COOKIE);
}

/** A well-formed code that differs from `code` in every position. */
function wrongCode(code: string): string {
  return [...code].map(char => CODE_ALPHABET[(CODE_ALPHABET.indexOf(char) + 1) % CODE_ALPHABET.length]).join("");
}

async function userRows(harness: FeishuLoginHarness): Promise<unknown[]> {
  return (await harness.database.pool.query(`select * from "user" order by id`)).rows;
}

/**
 * Playwright (1.62.1, `ArtifactsRecorder._takePageSnapshot`) writes an ARIA snapshot of a
 * failed test's page into `error-context.md`, and that snapshot shows the code field's value.
 * Closing the page in `onCodeStep` covers a thrown failure, but not a test timeout (the
 * runner tears down without waiting for the test body), so the snapshot is switched off: the recorder skips it while `PLAYWRIGHT_NO_COPY_PROMPT` is
 * set, read on every failure (ER-11). It is set when this file loads and kept for the rest
 * of the worker, which runs only the Feishu login specs of this config; it switches off
 * nothing else.
 */
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

test.describe("FSL-130 code step error messages", () => {
  let harness: FeishuLoginHarness | undefined;
  // The start itself, kept so that `afterAll` still closes a harness whose start outlived a
  // `beforeAll` timeout (Playwright does not wait for a timed-out hook). A start that fails
  // releases what it started on its own (`FeishuLoginHarnessSetupError`), ER-14.
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

  test("AC1 / AC2: a wrong code shows invalid-or-expired and stays on the code step", async ({ browser }) => {
    await onCodeStep(browser, harness!, ALICE, "en", async ({ context, page, code }) => {
      expect(await submitCode(page, wrongCode(code))).toBe(401);
      await expectCodeStepError(page, context, en.codeInvalid);

      // A complete code outside the alphabet is answered 400 and shows the same text.
      expect(await submitCode(page, "00000000")).toBe(400);
      await expectCodeStepError(page, context, en.codeInvalid);

      // Still the same step and flow: the right code now signs in.
      expect(await submitCode(page, code)).toBe(200);
      await page.waitForURL(url => url.pathname === "/en/workspace");
      expect((await context.cookies()).map(cookie => cookie.name)).toContain(SESSION_COOKIE);
    });
  });

  test("AC3: a 409 for a local user with the member's email shows the account conflict", async ({ browser }) => {
    await harness!.database.pool.query(
      `insert into "user" (id, name, email, email_verified) values ('fsl130-local-bob', 'Local', $1, false)`,
      [BOB.email],
    );
    const before = await userRows(harness!);
    const locales: Array<["en" | "zh-CN", Copy]> = [["zh-CN", zh], ["en", en]];
    for (const [lang, copy] of locales) {
      await onCodeStep(browser, harness!, BOB, lang, async ({ context, page, code }) => {
        expect(await submitCode(page, code)).toBe(409);
        await expectCodeStepError(page, context, copy.accountConflict);
        expect(await userRows(harness!)).toEqual(before);
        // The code was used by the 409: submitted again it answers 401 and the generic code text.
        expect(await submitCode(page, code)).toBe(401);
        await expectCodeStepError(page, context, copy.codeInvalid);
      });
      // The next request in a new flow is out of the email's 60-second cooldown.
      await harness!.database.pool.query("update feishu_login_codes set created_at = created_at - interval '1 hour'");
    }
  });

  test("AC4: a 503 from a failed session issue asks for a new code", async ({ browser }) => {
    await onCodeStep(browser, harness!, DAVE, "en", async ({ context, page, code }) => {
      await harness!.database.pool.query(`create or replace function fsl130_inject_failure() returns trigger
        language plpgsql as $$ begin raise exception 'FSL-130 injected session failure'; end $$`);
      await harness!.database.pool.query(
        "create trigger fsl130_inject_failure before insert on session for each row execute function fsl130_inject_failure()",
      );
      const sessions = async () => (await harness!.database.pool.query("select id from session order by id")).rows;
      const before = await sessions();
      try {
        expect(await submitCode(page, code)).toBe(503);
        await expectCodeStepError(page, context, en.codeRetry);
        expect(await sessions()).toEqual(before);
      } finally {
        await harness!.database.pool.query("drop trigger if exists fsl130_inject_failure on session");
        await harness!.database.pool.query("drop function if exists fsl130_inject_failure()");
      }
      // The code was consumed before the session failed: submitted again it answers 401.
      expect(await submitCode(page, code)).toBe(401);
      await expectCodeStepError(page, context, en.codeInvalid);
    });
  });
});
