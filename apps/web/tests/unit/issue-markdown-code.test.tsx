// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IssueMarkdown } from "@/app/[lang]/workspace/issues/components/issue-markdown";

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; });

describe("issue Markdown code", () => {
  it("highlights fenced code while preserving inline and unknown-language text", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const node = document.createElement("div"); document.body.append(node);
    const root = createRoot(node);
    const markdown = "Inline `name`\n\n```typescript\nconst answer: number = 42;\n```\n\n```javascript\nconst message = \"hello\";\n```\n\n```unknownlang\nplain fallback\n```\n\n```\nno language\n```";
    await act(async () => { root.render(<IssueMarkdown text={markdown} />); });
    expect(node.querySelector("p code")?.textContent).toBe("name");
    const typed = node.querySelector('[data-mega-code-block="typescript"]');
    expect(typed).not.toBeNull();
    expect(node.querySelector('[data-mega-code-block="javascript"]')).not.toBeNull();
    expect(node.querySelector('[data-mega-code-block="unknownlang"]')).not.toBeNull();
    expect(node.querySelector('[data-mega-code-block="plain"]')).not.toBeNull();
    await vi.waitFor(() => {
      const shadow = typed?.querySelector("diffs-container")?.shadowRoot;
      expect(shadow?.textContent).toContain("answer");
      expect(shadow?.querySelectorAll("[data-line] span[style]").length).toBeGreaterThan(1);
      const javascript = node.querySelector('[data-mega-code-block="javascript"] diffs-container')?.shadowRoot;
      expect(javascript?.textContent).toContain("message");
      expect(javascript?.querySelectorAll("[data-line] span[style]").length).toBeGreaterThan(1);
      const fallback = node.querySelector('[data-mega-code-block="unknownlang"] diffs-container')?.shadowRoot;
      expect(fallback?.textContent).toContain("plain fallback");
    }, { timeout: 5000 });
    await act(async () => root.unmount());
  });
});
