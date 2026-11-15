// Shared HTML shell for every transactional email this package renders.
//
// Diff vs upstream (GC-03, registered on the PK-07 task card): upstream
// hand-writes near-identical MJML documents and compiles via `mjml`.
// This port uses one hand-written HTML shell (no mjml dependency).
//
// Escaping: copy fields that are already HTML-safe from i18n /
// `renderTemplate` use triple-brace. CTA URLs are validated as absolute
// http(s) then HTML-escaped via double-brace (attribute + text).
import { renderTemplate } from "../render";

export interface EmailShellData {
  /** Plain-text product name shown in the header/footer. */
  appName: string;
  title: string;
  greeting: string;
  message: string;
  ctaLabel: string;
  ctaUrl: string;
  alternativeText: string;
  /** Optional secondary line under the CTA link. Pass `""` when N/A. */
  secondaryLine: string;
  disclaimer: string;
  signature: string;
  copyright: string;
}

const EMAIL_SHELL_TEMPLATE = `<!doctype html>
<html lang="{{lang}}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{{{title}}}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Roboto,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;padding:20px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;">
            <tr>
              <td align="center" style="padding:20px 0;font-size:18px;font-weight:500;color:#333333;">{{app_name}}</td>
            </tr>
            <tr>
              <td style="background-color:#ffffff;border-radius:8px;padding:40px 30px;">
                <p style="margin:0 0 20px;font-size:24px;font-weight:500;color:#333333;text-align:center;">{{{title}}}</p>
                <p style="margin:0 0 10px;font-size:16px;line-height:24px;color:#000000;">{{{greeting}}}</p>
                <p style="margin:0 0 20px;font-size:16px;line-height:24px;color:#000000;">{{{message}}}</p>
                <p style="text-align:center;margin:0 0 15px;">
                  <a href="{{cta_url}}" style="display:inline-block;background-color:#4A6CF7;color:#ffffff;border-radius:4px;font-weight:500;font-size:16px;padding:12px 20px;text-decoration:none;">{{{cta_label}}}</a>
                </p>
                <p style="margin:0 0 15px;font-size:14px;color:#000000;">{{{alternative_text}}}<br /><a href="{{cta_url}}">{{cta_url}}</a></p>
                <p style="margin:0 0 15px;font-size:14px;color:#000000;">{{{secondary_line}}}</p>
                <hr style="border:none;border-top:1px solid #f0f0f0;margin:20px 0;" />
                <p style="margin:0 0 8px;font-size:14px;color:#000000;">{{{disclaimer}}}</p>
                <p style="margin:0;font-size:14px;color:#000000;">{{{signature}}}</p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:20px 0;font-size:12px;color:#888888;">{{{copyright}}}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

export class UnsafeEmailCtaUrlError extends Error {
  constructor(url: string) {
    super(
      `[@megaui/email] ctaUrl must be an absolute http(s) URL (got ${JSON.stringify(url)})`,
    );
    this.name = "UnsafeEmailCtaUrlError";
  }
}

/** Fail-closed: only absolute http(s) URLs may be used as CTA hrefs (GC-07). */
export function assertSafeHttpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeEmailCtaUrlError(url);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UnsafeEmailCtaUrlError(url);
  }
  return parsed;
}

export function renderEmailShell(data: EmailShellData, lang: string): string {
  const safeUrl = assertSafeHttpUrl(data.ctaUrl).toString();
  return renderTemplate(EMAIL_SHELL_TEMPLATE, {
    lang,
    app_name: data.appName,
    title: data.title,
    greeting: data.greeting,
    message: data.message,
    cta_label: data.ctaLabel,
    cta_url: safeUrl,
    alternative_text: data.alternativeText,
    secondary_line: data.secondaryLine,
    disclaimer: data.disclaimer,
    signature: data.signature,
    copyright: data.copyright,
  });
}
