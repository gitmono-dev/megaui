// megaui-only: minimal, dependency-free renderer for email template strings.
//
// Placeholders are dot-paths into a data object:
//   {{path}}    value is HTML-escaped
//   {{{path}}}  value is inserted verbatim (for trusted values such as full URLs)
//
// A placeholder that cannot be resolved (missing key, `undefined`, `null`)
// throws instead of rendering blank text, so a broken template fails loudly
// (GC-11, fail-closed). An explicit empty string is a legitimate value.

export class EmailTemplateRenderError extends Error {
  constructor(public readonly path: string) {
    super(`[@megaui/email] missing template variable: "${path}" (GC-11 fail-closed)`);
    this.name = "EmailTemplateRenderError";
  }
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch] ?? ch);
}

/** Follows `path` through own properties of nested objects; `undefined` if any step is absent. */
function lookup(data: Record<string, unknown>, path: string): unknown {
  let node: unknown = data;
  for (const segment of path.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    if (!Object.prototype.hasOwnProperty.call(node, segment)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

// Group 1 = raw (triple-brace) path, group 2 = escaped (double-brace) path.
const PLACEHOLDER = /\{\{\{\s*([^{}]+?)\s*\}\}\}|\{\{\s*([^{}]+?)\s*\}\}/g;

export function renderTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER, (_match, rawPath: string | undefined, escapedPath: string | undefined) => {
    const isRaw = rawPath !== undefined;
    const path = (isRaw ? rawPath : escapedPath) as string;
    const value = lookup(data, path);
    if (value === undefined || value === null) throw new EmailTemplateRenderError(path);
    const text = String(value);
    return isRaw ? text : escapeHtml(text);
  });
}
