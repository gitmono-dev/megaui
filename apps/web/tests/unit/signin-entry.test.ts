// megaui-only (FSL-131, FSL-132): the sign-in entry outside Feishu mode.
//
// AC6 `legacy` (and AUTH_MODE / AUTH_PROVIDER unset): `/[lang]/signin` renders the email and
// password form with its forgot-password and sign-up links, the middleware lets a guest reach
// it and the sign-up page, and nothing redirects to the Feishu page. FSL-132 AC22/AC23:
// `maintenance` and `enterprise` without AUTH_PROVIDER are refused, so the Web refuses to
// start (`register()` throws `INVALID_AUTH_PROVIDER`) and the session entry is `invalid`.
// Feishu mode itself (the 307 to `/[lang]/signin/feishu`) is asserted here at the page level
// and end to end in `tests/e2e/feishu-login-entry.spec.ts`.
//
// The server component is awaited and its element tree rendered to static markup. No
// database or socket: Better Auth and the shared Pool are replaced by spies, and
// `next/navigation` by a stub whose `redirect` throws like the real one.
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getTranslation } from "@megaui/i18n";

const navigation = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(readonly path: string) { super(`redirect ${path}`); }
  }
  return {
    lang: "en",
    RedirectSignal,
    redirect: vi.fn((path: string): never => { throw new RedirectSignal(path); }),
  };
});
vi.mock("next/navigation", () => ({
  redirect: navigation.redirect,
  notFound: vi.fn((): never => { throw new Error("notFound"); }),
  useParams: () => ({ lang: navigation.lang }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => `/${navigation.lang}/signin`,
}));
vi.mock("@/lib/auth-client", () => ({ authClient: {} }));

const getSession = vi.hoisted(() => vi.fn(async () => null));
const getPool = vi.hoisted(() => vi.fn(() => ({ query: vi.fn(async () => ({ rows: [] })) })));
vi.mock("@/lib/auth", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAuth: vi.fn(() => ({ api: { getSession } })),
}));
vi.mock("@megaui/database", async importOriginal => ({
  ...(await importOriginal<typeof import("@megaui/database")>()),
  getPool,
}));

import { AuthModeError } from "@megaui/core";

import SigninPage from "@/app/[lang]/(auth)/signin/page";
import { register } from "@/instrumentation";
import { resolveWebSessionEntry } from "@/lib/enterprise-session";
import { authMiddleware } from "@/middlewares/auth";

const ORIGIN = "http://127.0.0.1:3000";
const MANAGED = ["NEXT_RUNTIME", "AUTH_MODE", "AUTH_PROVIDER", "DATABASE_URL", "ENTERPRISE_PROCESS_ROLE", "ENTERPRISE_OWNER_FINGERPRINT",
  "ENTERPRISE_DB_INSTANCE_ID", "ENTERPRISE_DEPLOYMENT_ROLE", "ENTERPRISE_APPROVED_TARGETS", "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"] as const;
const saved = new Map(MANAGED.map(key => [key, process.env[key]]));

function setEnvironment(values: Partial<Record<(typeof MANAGED)[number], string>>): void {
  for (const key of MANAGED) delete process.env[key];
  process.env.DATABASE_URL = "postgres://owned:synthetic@127.0.0.1:5432/owned";
  Object.assign(process.env, values);
}

async function renderSignin(lang: string, query: Record<string, string> = {}): Promise<string> {
  navigation.lang = lang;
  const element = await SigninPage({ params: Promise.resolve({ lang }), searchParams: Promise.resolve(query) });
  return renderToStaticMarkup(element);
}

function request(path: string): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`);
}

afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

beforeEach(() => {
  navigation.redirect.mockClear();
  getSession.mockClear();
});

const LOCALES = ["en", "zh-CN"] as const;

describe("FSL-131 AC6: legacy keeps the password sign-in page and its sign-up link", () => {
  const legacyEnvironments = [
    ["AUTH_MODE and AUTH_PROVIDER unset", {}],
    ["AUTH_MODE=legacy", { AUTH_MODE: "legacy" }],
    ["AUTH_MODE=legacy, AUTH_PROVIDER=local", { AUTH_MODE: "legacy", AUTH_PROVIDER: "local" }],
  ] as const;

  it.each(legacyEnvironments)("%s: the page renders the email and password form with its links", async (_label, values) => {
    setEnvironment(values);
    expect(resolveWebSessionEntry()).toBe("existing");
    for (const lang of LOCALES) {
      const copy = getTranslation(lang).auth.signin;
      const html = await renderSignin(lang, { callbackUrl: `/${lang}/workspace` });
      expect(html).toContain('data-testid="signin-card"');
      expect(html).toContain(copy.welcomeBack);
      expect(html).toContain(copy.socialLogin);
      expect(html).toMatch(/<input[^>]*id="email"/);
      expect(html).toMatch(/<input[^>]*type="password"/);
      expect(html).toContain(`href="/${lang}/forgot-password"`);
      expect(html).toContain(copy.forgotPassword);
      expect(html).toContain(`href="/${lang}/signup"`);
      expect(html).toContain(copy.signupLink);
      expect(html).not.toContain('data-testid="enterprise-login"');
      expect(html).not.toContain("feishu-login");
    }
    expect(navigation.redirect).not.toHaveBeenCalled();
  });

  it("the configured OAuth buttons are still offered", async () => {
    setEnvironment({ GITHUB_CLIENT_ID: "synthetic-id", GITHUB_CLIENT_SECRET: "synthetic-secret" });
    const html = await renderSignin("en");
    expect(html).toContain(getTranslation("en").auth.signin.continueWith);
    expect(navigation.redirect).not.toHaveBeenCalled();
  });

  it.each(legacyEnvironments)("%s: a guest reaches the sign-in and sign-up pages without a redirect", async (_label, values) => {
    setEnvironment(values);
    for (const path of ["/en/signin", "/en/signin?callbackUrl=%2Fen%2Fworkspace", "/zh-CN/signin", "/en/signup",
      "/en/forgot-password", "/en/reset-password"]) {
      expect(await authMiddleware(request(path)), path).toBeUndefined();
    }
    // A guest on a protected page is still sent to `/[lang]/signin`, which renders the form.
    const page = await authMiddleware(request("/en/workspace"));
    expect(page?.status).toBe(302);
    expect(new URL(page!.headers.get("location")!).pathname).toBe("/en/signin");
    // The Feishu page is not public outside Feishu mode.
    expect((await authMiddleware(request("/en/signin/feishu")))?.status).toBe(302);
  });
});

async function startupError(): Promise<unknown> {
  process.env.NEXT_RUNTIME = "nodejs";
  try {
    await register();
    return undefined;
  } catch (error) {
    return error;
  } finally {
    delete process.env.NEXT_RUNTIME;
  }
}

describe("FSL-132 AC22/AC23: maintenance and enterprise without AUTH_PROVIDER refuse to start", () => {
  const refused = [
    ["AC22 AUTH_MODE=maintenance", { AUTH_MODE: "maintenance" }],
    ["AC22 AUTH_MODE=maintenance, AUTH_PROVIDER=local", { AUTH_MODE: "maintenance", AUTH_PROVIDER: "local" }],
    ["AC23 AUTH_MODE=enterprise, AUTH_PROVIDER unset", { AUTH_MODE: "enterprise" }],
    ["AC23 AUTH_MODE=enterprise, blank AUTH_PROVIDER", { AUTH_MODE: "enterprise", AUTH_PROVIDER: "  " }],
  ] as const;

  it.each(refused)("%s: register() throws INVALID_AUTH_PROVIDER and the session entry is invalid", async (_label, values) => {
    setEnvironment(values);
    const error = await startupError();
    expect(error).toBeInstanceOf(AuthModeError);
    expect((error as AuthModeError).code).toBe("INVALID_AUTH_PROVIDER");
    expect(resolveWebSessionEntry()).toBe("invalid");
    // No session is read for a refused pair, so no actor and no redirect to the workspace.
    const page = await authMiddleware(request("/en/workspace"));
    expect(page?.status).toBe(302);
    expect(new URL(page!.headers.get("location")!).pathname).toBe("/en/signin");
    expect(getSession).not.toHaveBeenCalled();
    // The legacy password pages are not offered either.
    expect((await authMiddleware(request("/en/signup")))?.status).toBe(404);
  });

  it.each([
    ["AUTH_MODE and AUTH_PROVIDER unset", {}],
    ["AUTH_MODE=legacy", { AUTH_MODE: "legacy" }],
    ["AUTH_MODE=legacy, AUTH_PROVIDER=local", { AUTH_MODE: "legacy", AUTH_PROVIDER: "local" }],
  ] as const)("%s: legacy still starts", async (_label, values) => {
    setEnvironment(values);
    expect(await startupError()).toBeUndefined();
  });
});

describe("FSL-131 Feishu mode: the sign-in page renders nothing and redirects", () => {
  it("redirects to `/[lang]/signin/feishu` keeping every query parameter", async () => {
    setEnvironment({ AUTH_MODE: "enterprise", AUTH_PROVIDER: "feishu" });
    expect(resolveWebSessionEntry()).toBe("feishu");
    await expect(renderSignin("en")).rejects.toMatchObject({ path: "/en/signin/feishu" });
    await expect(renderSignin("zh-CN", { callbackUrl: "/zh-CN/workspace" }))
      .rejects.toMatchObject({ path: "/zh-CN/signin/feishu?callbackUrl=%2Fzh-CN%2Fworkspace" });
    // A repeated parameter keeps all its values in order (Next passes them as an array).
    navigation.lang = "en";
    await expect(SigninPage({
      params: Promise.resolve({ lang: "en" }),
      searchParams: Promise.resolve({ a: ["1", "3"], b: "2" }),
    })).rejects.toMatchObject({ path: "/en/signin/feishu?a=1&a=3&b=2" });
    expect(navigation.redirect).toHaveBeenCalledTimes(3);
  });

  it("a refused AUTH_MODE / AUTH_PROVIDER pair is not Feishu mode and does not redirect", async () => {
    setEnvironment({ AUTH_MODE: "legacy", AUTH_PROVIDER: "feishu" });
    expect(resolveWebSessionEntry()).toBe("invalid");
    await renderSignin("en");
    expect(navigation.redirect).not.toHaveBeenCalled();
  });
});
