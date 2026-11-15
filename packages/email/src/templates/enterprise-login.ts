// megaui-only (FS-31): enterprise login is a notification, never an auth
// transport.  The input deliberately has no OTP, session token, grant, or
// tokenized URL field.
import { renderTemplate } from "../render";
import { resolveLocale } from "./resolve-locale";
import { renderEmailShell, assertSafeHttpUrl } from "./shell";
import type { EmailTemplate } from "./types";

export interface EnterpriseLoginNotificationParams {
  recipientName: string;
  loginAt: string;
  device: string;
  source: string;
  appName: string;
  /** Ordinary site entry URL only; query strings and fragments are rejected. */
  appUrl: string;
  locale?: string;
}

type EnterpriseLoginCopy = {
  subject: string;
  title: string;
  greeting: string;
  message: string;
  button: string;
  alternativeText: string;
  disclaimer: string;
  signature: string;
  copyright: string;
};

const COPY: Record<"en" | "zh-CN", EnterpriseLoginCopy> = {
  en: {
    subject: "A new enterprise sign-in",
    title: "Enterprise sign-in notification",
    greeting: "Hello {{name}},",
    message: "A sign-in was completed at {{login_at}}. Device: {{device}}. Source: {{source}}.",
    button: "Open Mega",
    alternativeText: "Open the ordinary Mega entry page:",
    disclaimer: "If you did not expect this sign-in, contact your administrator.",
    signature: "The Mega team",
    copyright: "© {{year}} Mega",
  },
  "zh-CN": {
    subject: "新的企业登录通知",
    title: "企业登录通知",
    greeting: "您好，{{name}}：",
    message: "我们在 {{login_at}} 检测到一次登录成功。设备：{{device}}。来源：{{source}}。",
    button: "打开 Mega",
    alternativeText: "打开 Mega 普通入口：",
    disclaimer: "如果这不是您的登录，请联系管理员。",
    signature: "Mega 团队",
    copyright: "© {{year}} Mega",
  },
};

const ALLOWED_KEYS = new Set([
  "recipientName", "loginAt", "device", "source", "appName", "appUrl", "locale",
]);

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`[@megaui/email] ${name} is required`);
  }
  return value;
}

function assertNotificationInput(params: EnterpriseLoginNotificationParams): void {
  if (!params || typeof params !== "object") throw new Error("ENTERPRISE_LOGIN_NOTIFICATION_INPUT_INVALID");
  for (const key of Object.keys(params as unknown as Record<string, unknown>)) {
    if (!ALLOWED_KEYS.has(key)) throw new Error(`ENTERPRISE_LOGIN_NOTIFICATION_FIELD_NOT_ALLOWED:${key}`);
  }
  requireText(params.recipientName, "recipientName");
  requireText(params.loginAt, "loginAt");
  requireText(params.device, "device");
  requireText(params.source, "source");
  requireText(params.appName, "appName");
  const appUrl = assertSafeHttpUrl(requireText(params.appUrl, "appUrl"));
  if (appUrl.username || appUrl.password || appUrl.search || appUrl.hash) {
    throw new Error("ENTERPRISE_LOGIN_NOTIFICATION_URL_NOT_ORDINARY");
  }
}

export function generateEnterpriseLoginEmail(params: EnterpriseLoginNotificationParams): EmailTemplate {
  assertNotificationInput(params);
  const locale = resolveLocale(params.locale);
  const copy = COPY[locale];
  const year = new Date().getFullYear().toString();
  const html = renderEmailShell({
    appName: params.appName,
    title: copy.title,
    greeting: renderTemplate(copy.greeting, { name: params.recipientName }),
    message: renderTemplate(copy.message, {
      login_at: params.loginAt,
      device: params.device,
      source: params.source,
    }),
    ctaLabel: copy.button,
    ctaUrl: params.appUrl,
    alternativeText: copy.alternativeText,
    secondaryLine: "",
    disclaimer: copy.disclaimer,
    signature: copy.signature,
    copyright: renderTemplate(copy.copyright, { year }),
  }, locale);
  return { subject: copy.subject, html };
}
