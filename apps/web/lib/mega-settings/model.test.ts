import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEGA_SETTINGS,
  MEGA_ACCENTS,
  MEGA_SETTINGS_STORAGE_KEY,
  MEGA_THEME_MODE_STORAGE_KEY,
  createMegaSettingsInitScript,
} from "./model";

describe("createMegaSettingsInitScript", () => {
  it("embeds the settings constants as static literals", () => {
    const script = createMegaSettingsInitScript();

    expect(script).toContain(`localStorage.getItem(${JSON.stringify(MEGA_SETTINGS_STORAGE_KEY)})`);
    expect(script).toContain(`localStorage.setItem(${JSON.stringify(MEGA_THEME_MODE_STORAGE_KEY)},s.mode)`);
    expect(script).toContain(`var s=${JSON.stringify(DEFAULT_MEGA_SETTINGS)}`);
    expect(script).toContain(`${JSON.stringify(MEGA_ACCENTS.map(({ id }) => id))}.indexOf(p.accent)`);
    expect(script.includes("${")).toBe(false);
  });
});
