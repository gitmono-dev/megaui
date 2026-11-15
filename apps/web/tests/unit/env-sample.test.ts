import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const AUTH_MAIL_KEYS = [
  "EMAIL_PROVIDER",
  "EMAIL_DEFAULT_FROM",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "RESEND_API_KEY",
] as const;

const ALLOWED_PROVIDERS = ["test", "smtp", "resend"] as const;
const SENSITIVE_AUTH_MAIL_KEYS = new Set(["SMTP_USER", "SMTP_PASS", "RESEND_API_KEY"]);
const PLACEHOLDER = /^(replace-with-|REPLACE_WITH_)/;
const MATERIAL_SECRET = /(?:sk_live|sk_test|re_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}|password|secret)/i;

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

function parseAssignments(file: string): Map<string, string> {
  const assignments = new Map<string, string>();
  for (const line of file.split("\n")) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    assignments.set(key, value);
  }
  return assignments;
}

function commentAbove(file: string, key: string): string {
  const lines = file.split("\n");
  const assignment = lines.findIndex((line) => line.startsWith(`${key}=`));
  expect(assignment, `missing ${key}=`).toBeGreaterThanOrEqual(0);
  const comments: string[] = [];
  for (let i = assignment - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;
    if (!line.startsWith("#")) break;
    comments.unshift(line.replace(/^#\s?/, ""));
  }
  expect(comments.length, `missing comment above ${key}=`).toBeGreaterThan(0);
  return comments.join(" ");
}

function parseAllowedProviders(comment: string): string[] {
  const match = comment.match(/Allowed values:\s*([^.]+)\./i);
  expect(match, "EMAIL_PROVIDER comment must list Allowed values: ...").not.toBeNull();
  return match?.[1]
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean) ?? [];
}

describe("env.example auth-mail matrix", () => {
  it("documents the strict Better Auth matrix without material secrets (new)", () => {
    const sample = readRepoFile("env.example");
    const assignments = parseAssignments(sample);
    const authMailKeys = [...assignments.keys()]
      .filter((key) => /^(EMAIL_|SMTP_|RESEND_)/.test(key))
      .sort();

    expect(authMailKeys).toEqual([...AUTH_MAIL_KEYS].sort());

    const providers = parseAllowedProviders(commentAbove(sample, "EMAIL_PROVIDER"));
    expect([...providers].sort()).toEqual([...ALLOWED_PROVIDERS].sort());
    expect(ALLOWED_PROVIDERS).toContain(assignments.get("EMAIL_PROVIDER"));

    const providerComment = commentAbove(sample, "EMAIL_PROVIDER");
    expect(providerComment).toMatch(/Required/i);
    expect(providerComment).toMatch(/fail closed|fail-closed/i);
    expect(providerComment).toMatch(/no default/i);

    const fromComment = commentAbove(sample, "EMAIL_DEFAULT_FROM");
    expect(fromComment).toMatch(/Required/i);
    expect(fromComment).toMatch(/fail closed|fail-closed/i);
    expect(fromComment).toMatch(/noreply@example.com/);
    expect(assignments.get("EMAIL_DEFAULT_FROM")?.trim()).toBeTruthy();

    const smtpHostComment = commentAbove(sample, "SMTP_HOST");
    expect(smtpHostComment).toMatch(/EMAIL_PROVIDER=smtp/);
    expect(smtpHostComment).toMatch(/Ignored/i);

    const smtpPortComment = commentAbove(sample, "SMTP_PORT");
    expect(smtpPortComment).toMatch(/EMAIL_PROVIDER=smtp/);
    expect(smtpPortComment).toMatch(/1\.\.65535/);

    const smtpUserComment = commentAbove(sample, "SMTP_USER");
    expect(smtpUserComment).toMatch(/EMAIL_PROVIDER=smtp/);
    expect(smtpUserComment).toMatch(/pair|omit auth/i);

    const smtpPassComment = commentAbove(sample, "SMTP_PASS");
    expect(smtpPassComment).toMatch(/EMAIL_PROVIDER=smtp/);

    const resendComment = commentAbove(sample, "RESEND_API_KEY");
    expect(resendComment).toMatch(/EMAIL_PROVIDER=resend/);
    expect(resendComment).toMatch(/Ignored/i);

    for (const key of AUTH_MAIL_KEYS) {
      const value = assignments.get(key) ?? "";
      if (SENSITIVE_AUTH_MAIL_KEYS.has(key)) {
        expect(PLACEHOLDER.test(value), `${key} must be a placeholder`).toBe(true);
        continue;
      }
      expect(MATERIAL_SECRET.test(value), `${key} looks like a material secret`).toBe(false);
    }
  });
});

describe("configuration auth-mail matrix", () => {
  it("documents the strict matrix and the retired internal notification boundary (FS-50)", () => {
    const readme = readRepoFile("README.md");
    const config = readRepoFile("docs/configuration.md");
    expect(readme).toMatch(/docs\/configuration\.md/);
    expect(config).toMatch(/`EMAIL_PROVIDER`/);
    expect(config).toMatch(/`test` \/ `smtp` \/ `resend`/);
    expect(config).toMatch(/fail-closed/);
    expect(config).toMatch(/`EMAIL_DEFAULT_FROM`/);
    expect(config).toMatch(/noreply@example\.com/);
    expect(config).toMatch(/`SMTP_HOST` \/ `SMTP_PORT`/);
    expect(config).toMatch(/`RESEND_API_KEY`/);
    expect(config).toMatch(/旧内部通知邮件路由/);
    expect(config).toMatch(/`AUTH_MODE=legacy`/);
    expect(config).toMatch(/HTTP 410/);
    expect(config).not.toMatch(/视部署/);
  });
});
