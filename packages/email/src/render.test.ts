import { describe, expect, it } from "vitest";
import { EmailTemplateRenderError, renderTemplate } from "./render";

describe("renderTemplate (PK-07 AC 3)", () => {
  it("HTML-escapes double-brace interpolation", () => {
    const html = renderTemplate("Hello {{name}}!", { name: '<b>"Al"</b> & Co' });
    expect(html).toBe("Hello &lt;b&gt;&quot;Al&quot;&lt;/b&gt; &amp; Co!");
  });

  it("does not escape triple-brace interpolation (trusted raw values)", () => {
    const html = renderTemplate("<a href=\"{{{url}}}\">link</a>", { url: "https://example.com/a?x=1&y=2" });
    expect(html).toBe('<a href="https://example.com/a?x=1&y=2">link</a>');
  });

  it("resolves dot-path lookups", () => {
    const html = renderTemplate("{{a.b.c}}", { a: { b: { c: "deep" } } });
    expect(html).toBe("deep");
  });

  it("renders an explicit empty string without throwing", () => {
    expect(renderTemplate("[{{note}}]", { note: "" })).toBe("[]");
  });

  it("fail-closes with EmailTemplateRenderError when a variable is missing (GC-11)", () => {
    expect(() => renderTemplate("Hello {{name}}!", {})).toThrow(EmailTemplateRenderError);
    expect(() => renderTemplate("Hello {{name}}!", {})).toThrow(/missing template variable: "name"/);
  });

  it("fail-closes when a variable resolves to undefined", () => {
    expect(() => renderTemplate("{{x}}", { x: undefined })).toThrow(EmailTemplateRenderError);
  });

  it("fail-closes when a variable resolves to null", () => {
    expect(() => renderTemplate("{{x}}", { x: null })).toThrow(EmailTemplateRenderError);
  });

  it("fail-closes for a missing nested dot-path segment", () => {
    expect(() => renderTemplate("{{a.missing.c}}", { a: { b: 1 } })).toThrow(/"a\.missing\.c"/);
  });

  it("fail-closes for a missing variable inside triple braces too", () => {
    expect(() => renderTemplate("{{{url}}}", {})).toThrow(EmailTemplateRenderError);
  });
});
