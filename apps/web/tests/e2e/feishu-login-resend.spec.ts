// megaui-only (FSL-155): "resend" and "change email" on the Feishu sign-in page's code step,
// end to end in a real browser against a Feishu-mode `next dev` Web, a one-shot PostgreSQL and
// a real Feishu Mock process, all owned by `helpers/feishu-login-harness.ts`. Every answer is
// the real request or verify endpoint's; the page's fetch is never intercepted.
//
// No fake clock: AC1 / AC2 really wait 61 seconds after the code step appears, so both the
// page's countdown and the server's 60-second per-email cooldown have run out before the
// resend (the test timeout is 120 seconds). AC1 a forced click before then sends nothing;
// AC2 the button is then usable; AC3 / AC4 the resend reserves a new row of the same flow
// (the old one is void before the 202), the Mock inbox gets a second message, the old code
// answers 401 and the new one signs in. A resend the server fails (503, from an insert failure
// injected into the run's database) shows the request failure, keeps the code and starts the
// 60 seconds again. AC5 "change email" goes back to the email step in the
// same flow; AC6 the request for the next email voids the first email's code, once for a
// member (a hit) and once for an unknown email (a miss).
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { getTranslation } from "@megaui/i18n";

import {
  FeishuLoginHarnessSetupError,
  startFeishuLoginHarness,
  type FeishuLoginHarness,
} from "./helpers/feishu-login-harness";

const REQUEST_PATH = "/api/auth/feishu-login/request";
const VERIFY_PATH = "/api/auth/feishu-login/verify";
const FLOW_COOKIE = "__Host-megaui.feishu-login-flow";
const SESSION_COOKIE = "better-auth.session_token";
const ALICE = { email: "alice@example.com", openId: "ou_mock_alice" };
const BOB = { email: "bob@example.com", openId: "ou_mock_bob" };
const DAVE = { email: "dave@corp.example.com", openId: "ou_mock_dave" };
const UNKNOWN = "nobody@example.com";
const MEMBERS = [ALICE, BOB, DAVE];
const HARNESS_TIMEOUT = 600_000;
/** The resend test waits 61 seconds for real. */
const RESEND_TEST_TIMEOUT = 120_000;
const en = getTranslation("en").auth.signin.feishu;
const zh = getTranslation("zh-CN").auth.signin.feishu;

type Copy = typeof en;

function isPost(path: string) {
  return (response: { url(): string; request(): { method(): string } }) =>
    new URL(response.url()).pathname === path && response.request().method() === "POST";
}

/**
 * Runs `work` on a new page in a new browser context. The page is closed before its context
 * when `work` returns or throws, so no context is left with a page. A test timeout may skip
 * this `finally`; the failure page snapshot is switched off for that case by
 * `PLAYWRIGHT_NO_COPY_PROMPT` below (ER-11).
 */
async function withPage(
  browser: Browser,
  harness: FeishuLoginHarness,
  work: (context: BrowserContext, page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({ baseURL: harness.origin });
  const page = await context.newPage();
  try {
    await work(context, page);
  } finally {
    await page.close();
    await context.close();
  }
}

/**
 * Submits `email` on the email step and waits for the code step. The email is synthetic
 * fixture data (a reserved test domain), so `fill` may log it.
 */
async function requestOnEmailStep(page: Page, email: string): Promise<void> {
  const requested = page.waitForResponse(isPost(REQUEST_PATH));
  await page.getByTestId("feishu-login-email").fill(email);
  await page.getByTestId("feishu-login-request").click();
  expect((await requested).status()).toBe(202);
  await expect(page.getByTestId("feishu-login-code-step")).toBeVisible();
}

/**
 * Puts `code` into the code field as one input event (as a paste does), submits it and
 * answers the verify status. The code is passed only as an `evaluate` argument and compared
 * inside the page: `locator.fill` would write the value into Playwright's call log, and
 * `toHaveValue` into its failure message (ER-11).
 */
async function submitCode(page: Page, code: string): Promise<number> {
  await putCode(page, code);
  const verified = page.waitForResponse(isPost(VERIFY_PATH));
  await page.getByTestId("feishu-login-verify").click();
  return (await verified).status();
}

/** Puts `code` into the code field as one input event; the value goes only into `evaluate`. */
async function putCode(page: Page, code: string): Promise<void> {
  const field = page.getByTestId("feishu-login-code");
  const accepted = await field.evaluate((input: HTMLInputElement, value: string) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input.value === value;
  }, code);
  expect(accepted, "the code field holds the code").toBe(true);
  // React has rendered the controlled value before anything reads it.
  await expect.poll(() => fieldHolds(page, code)).toBe(true);
}

/** Whether the code field holds `code`, compared in the page (ER-11). */
async function fieldHolds(page: Page, code: string): Promise<boolean> {
  return page.getByTestId("feishu-login-code").evaluate((input: HTMLInputElement, value: string) => input.value === value, code);
}

/** The code step shows "invalid or expired" and stays usable, without a session. */
async function expectCodeInvalid(page: Page, context: BrowserContext, copy: Copy): Promise<void> {
  const step = page.getByTestId("feishu-login-code-step");
  await expect(step.getByRole("alert")).toHaveText(copy.codeInvalid);
  await expect(step).toBeVisible();
  await expect(page.getByTestId("feishu-login-code")).toBeEnabled();
  expect((await context.cookies()).map(cookie => cookie.name)).not.toContain(SESSION_COOKIE);
}

/** The code field is empty, checked in the page so no value reaches a failure message. */
async function fieldIsEmpty(page: Page, testId: string): Promise<boolean> {
  return page.getByTestId(testId).evaluate((input: HTMLInputElement) => input.value === "");
}

/** The SHA-256 of the context's flow cookie, as the request endpoint stores it; never logged. */
async function flowHash(context: BrowserContext): Promise<string> {
  const flow = (await context.cookies()).find(cookie => cookie.name === FLOW_COOKIE);
  expect(flow, "the flow cookie is set").toBeDefined();
  return createHash("sha256").update(flow!.value, "utf8").digest("hex");
}

/** The flow's rows, oldest first: only their order and state, never an email or code HMAC. */
async function flowRows(harness: FeishuLoginHarness, hash: string): Promise<Array<{ seq: number; state: string }>> {
  const { rows } = await harness.database.pool.query<{ seq: number; state: string }>(
    "select flow_seq as seq, state from feishu_login_codes where flow_hash = $1 order by flow_seq",
    [hash],
  );
  return rows;
}

async function inboxSizes(harness: FeishuLoginHarness): Promise<number[]> {
  return Promise.all(MEMBERS.map(member => harness.inboxSize(member.openId)));
}

/** Waits until `Date.now()` reaches `at`. */
async function until(at: number): Promise<void> {
  await delay(Math.max(0, at - Date.now()));
}

/**
 * Playwright (1.62.1, `ArtifactsRecorder._takePageSnapshot`) writes an ARIA snapshot of a
 * failed test's page into `error-context.md`, and that snapshot shows the code field's value.
 * Closing the page in `withPage` covers a thrown failure, but not a test timeout (the runner
 * tears down without waiting for the test body), so the snapshot is switched off: the
 * recorder skips it while `PLAYWRIGHT_NO_COPY_PROMPT` is set, read on every failure (ER-11).
 * It is set when this file loads and kept for the rest of the worker, which runs only the
 * Feishu login specs of this config; it switches off nothing else.
 */
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

test.describe("FSL-155 code step resend and change email", () => {
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

  test("AC1-AC4: resend is usable after 60 seconds and replaces the code", async ({ browser }) => {
    test.setTimeout(RESEND_TEST_TIMEOUT);
    await withPage(browser, harness!, async (context, page) => {
      let requests = 0;
      page.on("request", request => {
        if (request.method() === "POST" && new URL(request.url()).pathname === REQUEST_PATH) requests += 1;
      });
      expect((await page.goto("/en/signin/feishu"))?.status()).toBe(200);
      const seen = await harness!.inboxSize(ALICE.openId);
      await requestOnEmailStep(page, ALICE.email);
      const entered = Date.now();
      const first = await harness!.nextCode(ALICE.openId, seen);
      const flow = await flowHash(context);
      await expect.poll(() => flowRows(harness!, flow)).toEqual([{ seq: 1, state: "active" }]);

      // AC1: within 60 seconds the button shows the countdown and is not usable; a click
      // forced onto it sends no request and leaves the flow's code as it was.
      const resend = page.getByTestId("feishu-login-resend");
      const countdown = new RegExp(`^${en.resendWait.replace("{seconds}", "(\\d+)")}$`);
      await expect(resend).toBeDisabled();
      await expect(resend).toHaveText(countdown);
      await until(entered + 57_000);
      await expect(resend).toBeDisabled();
      await expect(resend).toHaveText(countdown);
      await resend.click({ force: true });
      expect(requests).toBe(1);
      expect(await flowRows(harness!, flow)).toEqual([{ seq: 1, state: "active" }]);
      expect(await harness!.inboxSize(ALICE.openId)).toBe(seen + 1);

      // AC2: 61 seconds after the step appeared, the button is usable.
      await until(entered + 61_000);
      await expect(resend).toBeEnabled({ timeout: 1_000 });
      await expect(resend).toHaveText(en.resend);

      // The resend: the same flow, a new row reserved before the 202, the old row void. The
      // field holds the first code until then.
      await putCode(page, first);
      const resent = page.waitForResponse(isPost(REQUEST_PATH));
      await resend.click();
      expect((await resent).status()).toBe(202);
      expect(requests).toBe(2);
      expect(await flowHash(context) === flow, "the resend keeps the flow").toBe(true);
      const reserved = await flowRows(harness!, flow);
      expect(reserved.map(row => row.seq)).toEqual([1, 2]);
      expect(reserved[0]!.state).toBe("void");
      expect(["reserved", "active"]).toContain(reserved[1]!.state);
      const second = await harness!.nextCode(ALICE.openId, seen + 1);
      expect(await harness!.inboxSize(ALICE.openId), "the Mock inbox has a second message").toBe(seen + 2);
      await expect.poll(() => flowRows(harness!, flow)).toEqual([{ seq: 1, state: "void" }, { seq: 2, state: "active" }]);
      expect(first !== second, "the resend sent a different code").toBe(true);

      // The page says so, clears the field and starts a new countdown.
      await expect(page.getByTestId("feishu-login-code-resent")).toHaveText(en.codeResent);
      await expect.poll(() => fieldIsEmpty(page, "feishu-login-code")).toBe(true);
      await expect(resend).toBeDisabled();
      await expect(resend).toHaveText(countdown);

      // AC3: the old code is now invalid.
      expect(await submitCode(page, first)).toBe(401);
      await expectCodeInvalid(page, context, en);

      // AC4: the new code signs in.
      expect(await submitCode(page, second)).toBe(200);
      await page.waitForURL(url => url.pathname === "/en/workspace");
      expect((await context.cookies()).map(cookie => cookie.name)).toContain(SESSION_COOKIE);
    });
  });

  test("a failed resend keeps the code and waits 60 seconds again", async ({ browser }) => {
    test.setTimeout(RESEND_TEST_TIMEOUT);
    // Alice's email is out of the cooldown of the previous test's requests.
    await harness!.database.pool.query("update feishu_login_codes set created_at = created_at - interval '1 hour'");
    await withPage(browser, harness!, async (context, page) => {
      expect((await page.goto("/en/signin/feishu"))?.status()).toBe(200);
      const seen = await harness!.inboxSize(ALICE.openId);
      await requestOnEmailStep(page, ALICE.email);
      const entered = Date.now();
      const code = await harness!.nextCode(ALICE.openId, seen);
      const flow = await flowHash(context);
      await expect.poll(() => flowRows(harness!, flow)).toEqual([{ seq: 1, state: "active" }]);

      const resend = page.getByTestId("feishu-login-resend");
      const countdown = new RegExp(`^${en.resendWait.replace("{seconds}", "(\\d+)")}$`);
      await until(entered + 61_000);
      await expect(resend).toBeEnabled({ timeout: 1_000 });
      await putCode(page, code);

      // The reservation fails inside its transaction, so the request answers 503 and nothing
      // of the flow changes.
      await harness!.database.pool.query(`create or replace function fsl155_inject_failure() returns trigger
        language plpgsql as $$ begin raise exception 'FSL-155 injected reservation failure'; end $$`);
      await harness!.database.pool.query(
        "create trigger fsl155_inject_failure before insert on feishu_login_codes for each row execute function fsl155_inject_failure()",
      );
      try {
        const resent = page.waitForResponse(isPost(REQUEST_PATH));
        await resend.click();
        expect((await resent).status()).toBe(503);
      } finally {
        await harness!.database.pool.query("drop trigger if exists fsl155_inject_failure on feishu_login_codes");
        await harness!.database.pool.query("drop function if exists fsl155_inject_failure()");
      }
      const step = page.getByTestId("feishu-login-code-step");
      await expect(step.getByRole("alert")).toHaveText(en.requestFailed);
      await expect(page.getByTestId("feishu-login-code-resent")).toHaveCount(0);
      // The failure does not prove that nothing was reserved, so the countdown starts again.
      await expect(resend).toBeDisabled();
      await expect(resend).toHaveText(countdown);
      expect(await fieldHolds(page, code), "the field keeps the code").toBe(true);
      expect(await flowRows(harness!, flow)).toEqual([{ seq: 1, state: "active" }]);
      expect(await harness!.inboxSize(ALICE.openId)).toBe(seen + 1);

      // Nothing was reserved here, so the code still signs in.
      expect(await submitCode(page, code)).toBe(200);
      await page.waitForURL(url => url.pathname === "/en/workspace");
    });
  });

  test("AC5 / AC6 (hit): change email goes back, and a member's request voids the first code", async ({ browser }) => {
    await withPage(browser, harness!, async (context, page) => {
      expect((await page.goto("/zh-CN/signin/feishu"))?.status()).toBe(200);
      const bobSeen = await harness!.inboxSize(BOB.openId);
      await requestOnEmailStep(page, BOB.email);
      const bobCode = await harness!.nextCode(BOB.openId, bobSeen);
      const flow = await flowHash(context);
      await expect.poll(() => flowRows(harness!, flow)).toEqual([{ seq: 1, state: "active" }]);

      // AC5: "change email" shows the empty email step again, in the same flow.
      const changeEmail = page.getByTestId("feishu-login-change-email");
      await expect(changeEmail).toHaveText(zh.changeEmail);
      await changeEmail.click();
      await expect(page.getByTestId("feishu-login-email-step")).toBeVisible();
      await expect(page.getByTestId("feishu-login-code-step")).toHaveCount(0);
      await expect(page.getByTestId("feishu-login-email")).toBeEnabled();
      expect(await fieldIsEmpty(page, "feishu-login-email")).toBe(true);
      expect(new URL(page.url()).pathname).toBe("/zh-CN/signin/feishu");
      expect(await flowHash(context) === flow, "changing the email keeps the flow").toBe(true);
      // Going back alone sends nothing: the first code is still the flow's only row.
      expect(await flowRows(harness!, flow)).toEqual([{ seq: 1, state: "active" }]);

      // AC6 (hit): the next email is a member's; its request voids Bob's code before the 202.
      const daveSeen = await harness!.inboxSize(DAVE.openId);
      await requestOnEmailStep(page, DAVE.email);
      await expect(page.getByTestId("feishu-login-code-sent")).toHaveText(zh.codeSent.replace("{email}", DAVE.email));
      const daveCode = await harness!.nextCode(DAVE.openId, daveSeen);
      await expect.poll(() => flowRows(harness!, flow)).toEqual([{ seq: 1, state: "void" }, { seq: 2, state: "active" }]);
      expect(await harness!.inboxSize(BOB.openId)).toBe(bobSeen + 1);

      expect(await submitCode(page, bobCode)).toBe(401);
      await expectCodeInvalid(page, context, zh);
      expect(await submitCode(page, daveCode)).toBe(200);
      await page.waitForURL(url => url.pathname === "/zh-CN/workspace");
      expect((await context.cookies()).map(cookie => cookie.name)).toContain(SESSION_COOKIE);
    });
  });

  test("AC6 (miss): a request for an unknown email voids the first code", async ({ browser }) => {
    // Bob's email is out of its 60-second cooldown for this flow's first request.
    await harness!.database.pool.query("update feishu_login_codes set created_at = created_at - interval '1 hour'");
    await withPage(browser, harness!, async (context, page) => {
      expect((await page.goto("/en/signin/feishu"))?.status()).toBe(200);
      const bobSeen = await harness!.inboxSize(BOB.openId);
      await requestOnEmailStep(page, BOB.email);
      const bobCode = await harness!.nextCode(BOB.openId, bobSeen);
      const flow = await flowHash(context);
      await expect.poll(() => flowRows(harness!, flow)).toEqual([{ seq: 1, state: "active" }]);

      await page.getByTestId("feishu-login-change-email").click();
      await expect(page.getByTestId("feishu-login-email-step")).toBeVisible();
      await expect(page.getByTestId("feishu-login-email")).toBeEnabled();

      // The next email belongs to no member: the page still shows the code step, the request
      // voids Bob's code, and its own row is voided by the lookup without any message.
      const before = await inboxSizes(harness!);
      await requestOnEmailStep(page, UNKNOWN);
      await expect.poll(() => flowRows(harness!, flow)).toEqual([{ seq: 1, state: "void" }, { seq: 2, state: "void" }]);
      expect(await inboxSizes(harness!)).toEqual(before);

      expect(await submitCode(page, bobCode)).toBe(401);
      await expectCodeInvalid(page, context, en);
    });
  });
});
