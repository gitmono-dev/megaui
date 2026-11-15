import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getAuth } from "@/lib/auth";
import { getRuntimeSecrets } from "@/lib/env";

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubNonEmailRuntimeSecrets() {
  vi.stubEnv("DATABASE_URL", "postgres://megaui:megaui@localhost:5432/website");
  vi.stubEnv("BETTER_AUTH_SECRET", "ci-test-secret-at-least-32-bytes-long!!");
  vi.stubEnv("BETTER_AUTH_URL", "http://127.0.0.1:3000");
}

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("getAuth auth-mail wiring", () => {
  it("constructs the sender only from resolveAuthMailRuntime and has no inline selector branch (new)", () => {
    const authSource = readRepoFile("apps/web/lib/auth.ts");
    expect(authSource).toMatch(/resolveAuthMailRuntime\(\)/);
    expect(authSource).toMatch(/createEmailSender\(\{\s*defaultFrom,\s*provider\s*\}\)/);
    expect(authSource).not.toMatch(/emailProvider\s*===/);
    expect(authSource).not.toMatch(/kind:\s*"smtp"/);
    expect(authSource).not.toMatch(/kind:\s*"resend"/);
  });

  it("fail-closes through the resolver before constructing Auth when auth-mail config is invalid (new)", () => {
    stubNonEmailRuntimeSecrets();
    vi.stubEnv("EMAIL_PROVIDER", "");
    vi.stubEnv("EMAIL_DEFAULT_FROM", "alerts@example.com");
    expect(() => getAuth()).toThrowError("[@megaui/web] auth-mail config invalid: provider_selector");
  });
});

describe("getRuntimeSecrets auth-mail fields", () => {
  it("returns an object without emailDefaultFrom or emailProvider (new)", () => {
    stubNonEmailRuntimeSecrets();
    const secrets = getRuntimeSecrets();
    expect(secrets).not.toHaveProperty("emailDefaultFrom");
    expect(secrets).not.toHaveProperty("emailProvider");
  });
});

describe("auth-mail source guards", () => {
  it("does not read auth-mail env vars from auth.ts (new)", () => {
    const authSource = readRepoFile("apps/web/lib/auth.ts");
    expect(authSource).not.toMatch(/EMAIL_PROVIDER|EMAIL_DEFAULT_FROM|SMTP_|RESEND_API_KEY/);
  });

  it("does not keep auth-mail fallback literals in auth.ts or env.ts (new)", () => {
    const authSource = readRepoFile("apps/web/lib/auth.ts");
    const envSource = readRepoFile("apps/web/lib/env.ts");
    const combined = `${authSource}\n${envSource}`;
    expect(combined).not.toMatch(/noreply@example.com/);
    expect(combined).not.toMatch(/"localhost"/);
    expect(combined).not.toMatch(/"1025"/);
    expect(combined).not.toMatch(/"missing"/);
  });
});
