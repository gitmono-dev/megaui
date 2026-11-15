import { describe, expect, it } from "vitest";
import {
  ALL_THEME_CLASSES,
  COLOR_SCHEME_CLASSES,
  COLOR_SCHEMES,
  MEGA_ACCENT_TINTS,
  MEGA_CONSOLE_TOKENS,
  MEGA_DIFF_TOKENS,
  MEGA_KIND_TOKENS,
  MEGA_LAYER_TOKENS,
  MEGA_RADIUS_TOKENS,
  MEGA_SPACING_TOKENS,
  MEGA_TOKENS,
  THEME_CLASSES,
  THEME_CONFIG,
  THEMES,
} from "./index";

// UI-01 AC1: tokens/themes variable names must stay 1:1 with upstream
// (`REF-07 libs/ui/{mega-tokens,themes}.ts`, sha 0ff3a9d) so downstream
// component ports (UI-02..11) can move markup verbatim without a naming
// remap. Every entry below is a snapshot of the upstream key -> CSS var
// name mapping; a diff here is a naming-parity regression, not a false
// positive to silence.
describe("MEGA_TOKENS naming parity with upstream (UI-01 AC1)", () => {
  it("re-exports every --mega-* surface color/text token by its upstream key", () => {
    expect(MEGA_TOKENS).toEqual({
      bg: "var(--mega-bg)",
      subtle: "var(--mega-subtle)",
      border: "var(--mega-border)",
      text: "var(--mega-text)",
      muted: "var(--mega-muted)",
      codeBg: "var(--mega-code-bg)",
      codeText: "var(--mega-code-text)",
      accent: "var(--mega-accent)",
      accentForeground: "var(--mega-accent-foreground)",
      activeBg: "var(--mega-active-bg)",
      activeFg: "var(--mega-active-fg)",
      selectedBorder: "var(--mega-selected-border)",
      success: "var(--mega-success)",
      danger: "var(--mega-danger)",
      warning: "var(--mega-warning)",
      merged: "var(--mega-merged)",
      fontMono: "var(--mega-font-mono)",
    });
  });

  it("keeps the 8-step accent tint scale", () => {
    expect(Object.keys(MEGA_ACCENT_TINTS)).toEqual(["5", "8", "10", "14", "18", "22", "44", "55"]);
    expect(MEGA_ACCENT_TINTS[5]).toBe("var(--mega-accent-tint-5)");
  });

  it("keeps the diff add/del/hunk token groups", () => {
    expect(MEGA_DIFF_TOKENS.add.background).toBe("var(--mega-diff-add-bg)");
    expect(MEGA_DIFF_TOKENS.del.foreground).toBe("var(--mega-diff-del-fg)");
    expect(MEGA_DIFF_TOKENS.hunk.background).toBe("var(--mega-diff-hunk-bg)");
  });

  it("keeps the console, layer, spacing, and radius token groups", () => {
    expect(MEGA_CONSOLE_TOKENS.lineNumber).toBe("var(--mega-console-line-number)");
    expect(MEGA_LAYER_TOKENS.libra).toBe("var(--mega-layer-libra)");
    expect(MEGA_SPACING_TOKENS[8]).toBe("var(--mega-space-8)");
    expect(MEGA_RADIUS_TOKENS.pill).toBe("var(--mega-radius-pill)");
  });

  it("keeps all 16 IntentSpec object-kind tokens", () => {
    expect(Object.keys(MEGA_KIND_TOKENS)).toHaveLength(16);
    expect(MEGA_KIND_TOKENS.ContextFrame).toBe("var(--mega-kind-context-frame)");
  });
});

describe("theme/color-scheme configuration parity with upstream (UI-01 AC1)", () => {
  it("supports exactly light/dark theme modes", () => {
    expect(THEMES).toEqual(["light", "dark"]);
    expect(THEME_CLASSES).toEqual({ light: "", dark: "dark" });
  });

  it("supports the 6 upstream color schemes with their class names", () => {
    expect(COLOR_SCHEMES).toEqual([
      "default",
      "claude",
      "cosmic-night",
      "modern-minimal",
      "ocean-breeze",
      "perplexity",
    ]);
    expect(COLOR_SCHEME_CLASSES).toEqual({
      default: "",
      claude: "theme-claude",
      "cosmic-night": "theme-cosmic-night",
      "modern-minimal": "theme-modern-minimal",
      "ocean-breeze": "theme-ocean-breeze",
      perplexity: "theme-perplexity",
    });
  });

  it("registers display metadata for every non-default color scheme", () => {
    for (const scheme of COLOR_SCHEMES) {
      if (scheme === "default") continue;
      expect(THEME_CONFIG).toHaveProperty(scheme);
    }
  });

  it("ALL_THEME_CLASSES covers every theme + color-scheme class for cleanup", () => {
    for (const cls of Object.values(COLOR_SCHEME_CLASSES)) {
      if (cls) expect(ALL_THEME_CLASSES).toContain(cls);
    }
    expect(ALL_THEME_CLASSES).toContain("dark");
  });
});
