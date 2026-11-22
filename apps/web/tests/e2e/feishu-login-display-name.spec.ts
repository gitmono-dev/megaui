// megaui-only (FSL-182): the signed-in Feishu member's own name in the workspace shell rail
// (name and avatar initials), the home greeting and the profile form, end to end in a real
// browser against a Feishu-mode `next dev` Web, a one-shot PostgreSQL and a real Feishu Mock
// process, all owned by `helpers/feishu-login-harness.ts`. Nothing on the page is
// intercepted: the expected values come from the real `get-session` projection.
//
// AC1 rail name = `sessionDisplayName(displayName)` (trimmed), initials = `getInitials` of
// it; AC2 greeting = the same name; AC3 the profile form's name input starts from the raw
// `displayName`. Both FSL-153 branches are covered: the Mock name contains the login
// email's local part (`displayName` is the user ID), and a local name that does not
// (`displayName` is that name as stored, here with surrounding whitespace).
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { feishuUserDisplayName } from "@megaui/engine";
import { getTranslation } from "@megaui/i18n";
import { getInitials } from "@megaui/ui/shell";

import {
  FeishuLoginHarnessSetupError,
  startFeishuLoginHarness,
  type FeishuLoginHarness,
} from "./helpers/feishu-login-harness";

// The Mock fixture member (`apps/feishu-mock/src/state.ts`, `SYNTHETIC_USERS`).
const ALICE = { email: "alice@example.com", openId: "ou_mock_alice", name: "Mock Alice" };
const RENAMED = "  Synthetic Display  ";
const HARNESS_TIMEOUT = 600_000;
const home = getTranslation("en").workspace.home;

function isPost(path: string) {
  return (response: { url(): string; request(): { method(): string } }) =>
    new URL(response.url()).pathname === path && response.request().method() === "POST";
}

/**
 * Puts `code` into the code field as one input event (as a paste does), submits it and
 * answers the verify status. The code is passed only as an `evaluate` argument and compared
 * inside the page: `locator.fill` would write it into Playwright's call log, and
 * `toHaveValue` into its failure message (ER-11, FSL-130).
 */
async function submitCode(page: Page, code: string): Promise<number> {
  const field = page.getByTestId("feishu-login-code");
  const accepted = await field.evaluate((input: HTMLInputElement, value: string) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input.value === value;
  }, code);
  expect(accepted, "the code field holds the submitted code").toBe(true);
  await expect.poll(() => field.evaluate((input: HTMLInputElement, value: string) => input.value === value, code)).toBe(true);
  const verified = page.waitForResponse(isPost("/api/auth/feishu-login/verify"));
  await page.getByTestId("feishu-login-verify").click();
  return (await verified).status();
}

/**
 * Signs `member` in through the Mock inbox in a new browser context and runs `work` on the
 * signed-in page. The page is closed before its context when `work` returns or throws. A
 * test timeout may skip this `finally`; the failure page snapshot is switched off for that
 * case by `PLAYWRIGHT_NO_COPY_PROMPT` below (ER-11).
 */
async function signedIn(
  browser: Browser,
  harness: FeishuLoginHarness,
  member: { email: string; openId: string },
  work: (context: BrowserContext, page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({ baseURL: harness.origin });
  const page = await context.newPage();
  try {
    expect((await page.goto("/en/signin/feishu"))?.status()).toBe(200);
    const seen = await harness.inboxSize(member.openId);
    const requested = page.waitForResponse(isPost("/api/auth/feishu-login/request"));
    await page.getByTestId("feishu-login-email").fill(member.email);
    await page.getByTestId("feishu-login-request").click();
    expect((await requested).status()).toBe(202);
    await expect(page.getByTestId("feishu-login-code-step")).toBeVisible();
    expect(await submitCode(page, await harness.nextCode(member.openId, seen))).toBe(200);
    await page.waitForURL(url => url.pathname === "/en/workspace");
    await work(context, page);
  } finally {
    await page.close();
    await context.close();
  }
}

interface ProjectedUser {
  readonly id: string;
  readonly name: string;
  readonly displayName?: unknown;
}

async function projectedUser(context: BrowserContext): Promise<ProjectedUser> {
  const response = await context.request.get("/api/auth/get-session");
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { user?: ProjectedUser } | null;
  expect(body?.user).toBeDefined();
  return body!.user!;
}

/** The rail, the greeting and the profile form show `displayName` as FSL-182 specifies. */
async function expectOwnName(page: Page, displayName: string): Promise<void> {
  // `sessionDisplayName(displayName, undefined, fallback)`: a non-blank input, trimmed.
  const shown = displayName.trim();
  expect(shown).not.toBe("");

  expect((await page.goto("/en/workspace"))?.status()).toBe(200);
  const profileLink = page.locator('[data-mega-shell="rail-profile-link"]');
  await expect(profileLink.locator("span:not([data-mega-atom])")).toHaveText(shown);
  await expect(profileLink.locator('[data-mega-atom="shell-avatar"]')).toHaveText(getInitials(shown));
  const greeting = page.locator('[data-mega-home="hero-greeting"]');
  await expect(greeting).toBeVisible();
  const greetings = Object.values(home.greetings).map(template => template.replace("{name}", shown));
  await expect.poll(async () => greetings.includes((await greeting.textContent()) ?? "")).toBe(true);

  expect((await page.goto("/en/workspace/settings"))?.status()).toBe(200);
  const nameInput = page.locator('[data-mega-settings="profile-form"] label').first().locator("input");
  // The raw value, surrounding whitespace included (`toHaveValue` trims nothing).
  await expect(nameInput).toHaveValue(displayName);
}

/**
 * Playwright writes an ARIA snapshot of a failed test's page into `error-context.md`, and
 * on the code step that snapshot shows the code field's value. Closing the page in
 * `signedIn` covers a thrown failure, but not a test timeout, so the snapshot is switched
 * off while `PLAYWRIGHT_NO_COPY_PROMPT` is set (ER-11, as in FSL-130). It is set when this
 * file loads and kept for the rest of the worker, which runs only the Feishu login specs.
 */
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

test.describe("FSL-182 own display name in the workspace", () => {
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

  test("AC1-AC3: rail, greeting and profile form show the projection displayName", async ({ browser }) => {
    test.setTimeout(240_000);
    await signedIn(browser, harness!, ALICE, async (context, page) => {
      const user = await projectedUser(context);
      expect(user.name).toBe(`fs_${user.id}`);
      const { rows } = await harness!.database.pool.query<{ name: string; email: string }>(
        `select name, email from "user" where id = $1`, [user.id],
      );
      expect(rows).toEqual([{ name: ALICE.name, email: ALICE.email }]);
      // FSL-153: "Mock Alice" contains the local part "alice", so the display name is the user ID.
      const expected = feishuUserDisplayName({ id: user.id, name: ALICE.name, email: ALICE.email });
      expect(expected).toBe(user.id);
      expect(user.displayName).toBe(expected);
      await expectOwnName(page, expected);

      // A local name that reveals nothing of the login is kept as stored, whitespace included.
      await harness!.database.pool.query(`update "user" set name = $2 where id = $1`, [user.id, RENAMED]);
      const renamed = await projectedUser(context);
      expect(renamed.name).toBe(`fs_${user.id}`);
      expect(renamed.displayName).toBe(feishuUserDisplayName({ id: user.id, name: RENAMED, email: ALICE.email }));
      expect(renamed.displayName).toBe(RENAMED);
      await expectOwnName(page, RENAMED);
      await expect(page.locator("body")).not.toContainText(`fs_${user.id}`);
    });
  });
});
