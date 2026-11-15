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

function readPlaceholder(template: string, start: number): { end: number; raw: boolean; path: string } | undefined {
  const raw = template.startsWith("{{{", start);
  const openLength = raw ? 3 : 2;
  const close = raw ? "}}}" : "}}";
  const end = template.indexOf(close, start + openLength);
  if (end < 0) return undefined;
  const path = template.slice(start + openLength, end).trim();
  if (!path || path.includes("{") || path.includes("}")) return undefined;
  return { end: end + close.length, raw, path };
}

export function renderTemplate(template: string, data: Record<string, unknown>): string {
  let output = "";
  let cursor = 0;
  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);
    if (start < 0) {
      output += template.slice(cursor);
      break;
    }
    output += template.slice(cursor, start);
    const placeholder = readPlaceholder(template, start);
    if (!placeholder) {
      output += "{{";
      cursor = start + 2;
      continue;
    }
    const value = lookup(data, placeholder.path);
    if (value === undefined || value === null) throw new EmailTemplateRenderError(placeholder.path);
    const text = String(value);
    output += placeholder.raw ? text : escapeHtml(text);
    cursor = placeholder.end;
  }
  return output;
}
