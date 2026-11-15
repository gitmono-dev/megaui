import { describe, expect, it } from "vitest";
import * as icons from "./index";

// UI-01 AC2: icon components must be tree-shake importable (one named
// export per module, no side effects) and the icon set must be the
// upstream brand-SVG set minus `wechat` (domain strip, see plan Reference
// source "图标集裁剪 wechat（域剥离）") plus the megaui-only logo placeholder.
const EXPECTED_ICON_NAMES = [
  "AppleIcon",
  "AuthIcon",
  "GithubIcon",
  "GoogleIcon",
  "NextjsIcon",
  "PhoneIcon",
  "PostgresqlIcon",
  "ReactIcon",
  "TailwindIcon",
  "TypescriptIcon",
] as const;

describe("icon barrel is tree-shake friendly (UI-01 AC2)", () => {
  it("exports exactly the expected ported brand icons plus the megaui logo, each as a standalone named function", () => {
    const exportedNames = Object.keys(icons).filter((key) => key !== "IconProps");
    expect(exportedNames.sort()).toEqual([...EXPECTED_ICON_NAMES, "MegauiLogo"].sort());

    for (const name of exportedNames) {
      const value = (icons as Record<string, unknown>)[name];
      expect(typeof value).toBe("function");
    }
  });

  it("does not export a wechat icon (domain strip)", () => {
    expect(Object.keys(icons)).not.toContain("WechatIcon");
  });

  it("does not export a single aggregate object/array of icons (that would defeat tree-shaking)", () => {
    for (const [name, value] of Object.entries(icons)) {
      if (name === "IconProps") continue;
      expect(Array.isArray(value)).toBe(false);
      expect(typeof value).not.toBe("object");
    }
  });

  it("every icon renders an <svg> root element when invoked with no props", () => {
    for (const name of [...EXPECTED_ICON_NAMES, "MegauiLogo"] as const) {
      const IconComponent = (icons as Record<string, (props: Record<string, unknown>) => { type: unknown }>)[name]!;
      const element = IconComponent({});
      expect(element.type).toBe("svg");
    }
  });

  it("every icon forwards extra props (e.g. className) onto the <svg> root", () => {
    for (const name of [...EXPECTED_ICON_NAMES, "MegauiLogo"] as const) {
      const IconComponent = (
        icons as Record<string, (props: Record<string, unknown>) => { props: Record<string, unknown> }>
      )[name]!;
      const element = IconComponent({ className: "h-4 w-4", "data-testid": name });
      expect(element.props.className).toBe("h-4 w-4");
      expect(element.props["data-testid"]).toBe(name);
    }
  });
});
