/**
 * Auth-mail configuration resolver (EM-01 / EM-05).
 *
 * Better Auth wiring is EM-02. This module is the only allowed reader of
 * auth-mail env vars after the family is published.
 */

import type { EmailProviderConfig, ResendProviderConfig, SmtpProviderConfig } from "@megaui/email";

export type AuthMailProviderKind = "test" | "smtp" | "resend";

export type AuthMailConfigErrorCategory =
  | "provider_selector"
  | "default_from"
  | "smtp_host"
  | "smtp_port"
  | "smtp_auth"
  | "resend_api_key";

export type AuthMailRuntime = {
  defaultFrom: string;
  provider: EmailProviderConfig;
};

const SMTP_PORT_PATTERN = /^[0-9]+$/;

export function authMailConfigError(category: AuthMailConfigErrorCategory): Error {
  return new Error(`[@megaui/web] auth-mail config invalid: ${category}`);
}

export function parseAuthMailSelector(raw: string | undefined): AuthMailProviderKind {
  const value = raw?.trim();
  if (!value) {
    throw authMailConfigError("provider_selector");
  }
  switch (value) {
    case "test":
    case "smtp":
    case "resend":
      return value;
    default:
      throw authMailConfigError("provider_selector");
  }
}

export function parseAuthMailDefaultFrom(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) {
    throw authMailConfigError("default_from");
  }
  return value;
}

export function resolveAuthMailRuntime(
  source: NodeJS.Dict<string> = process.env,
): AuthMailRuntime {
  const kind = parseAuthMailSelector(readEnv(source, "EMAIL_PROVIDER"));
  const defaultFrom = parseAuthMailDefaultFrom(readEnv(source, "EMAIL_DEFAULT_FROM"));

  switch (kind) {
    case "test":
      return { defaultFrom, provider: { kind: "test" } };
    case "smtp":
      return { defaultFrom, provider: { kind: "smtp", config: parseSelectedSmtp(source) } };
    case "resend":
      return { defaultFrom, provider: { kind: "resend", config: parseSelectedResend(source) } };
    default: {
      const exhaustive: never = kind;
      void exhaustive;
      throw authMailConfigError("provider_selector");
    }
  }
}

function readEnv(source: NodeJS.Dict<string>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function parseSelectedSmtp(source: NodeJS.Dict<string>): SmtpProviderConfig {
  const host = readEnv(source, "SMTP_HOST")?.trim();
  if (!host) {
    throw authMailConfigError("smtp_host");
  }

  const portRaw = readEnv(source, "SMTP_PORT")?.trim();
  if (!portRaw || !SMTP_PORT_PATTERN.test(portRaw)) {
    throw authMailConfigError("smtp_port");
  }
  const port = Number(portRaw);
  if (port < 1 || port > 65535) {
    throw authMailConfigError("smtp_port");
  }

  const user = readEnv(source, "SMTP_USER")?.trim() ?? "";
  const pass = readEnv(source, "SMTP_PASS")?.trim() ?? "";
  const hasUser = user.length > 0;
  const hasPass = pass.length > 0;
  if (hasUser !== hasPass) {
    throw authMailConfigError("smtp_auth");
  }

  return hasUser ? { host, port, auth: { user, pass } } : { host, port };
}

function parseSelectedResend(source: NodeJS.Dict<string>): ResendProviderConfig {
  const apiKey = readEnv(source, "RESEND_API_KEY")?.trim();
  if (!apiKey) {
    throw authMailConfigError("resend_api_key");
  }
  return { apiKey };
}
