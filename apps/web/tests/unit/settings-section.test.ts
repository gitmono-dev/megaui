import { describe, expect, it } from "vitest";

import {
  ADMIN_SETTINGS_SECTIONS,
  ENABLED_SETTINGS_SECTIONS,
  parseSettingsSection,
} from "@/app/[lang]/workspace/settings/settings-section";

describe("parseSettingsSection", () => {
  it("accepts user and admin sections", () => {
    for (const section of [...ENABLED_SETTINGS_SECTIONS, ...ADMIN_SETTINGS_SECTIONS]) {
      expect(parseSettingsSection(section)).toBe(section);
    }
    expect(parseSettingsSection("code-readme")).toBe("code-readme");
  });

  it("falls back to profile for missing or unknown sections", () => {
    expect(parseSettingsSection(null)).toBe("profile");
    expect(parseSettingsSection("admin")).toBe("profile");
  });
});
