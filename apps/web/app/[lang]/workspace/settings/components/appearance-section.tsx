"use client";

import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";
import { useTranslation } from "@/hooks/use-translation";
import { MEGA_ACCENTS } from "@/lib/mega-settings/model";
import { useMegaSettings } from "@/lib/mega-settings/provider";
import { SettingsCard } from "./settings-primitives";

export function AppearanceSection() {
  const { t } = useTranslation();
  const text = t.workspace.settings.appearance;
  const { settings, updateSettings } = useMegaSettings();
  return <SettingsCard>
    <h1 style={{ marginTop: 0 }}>{text.title}</h1>
    <h2>{text.theme}</h2>
    <div aria-label={text.modeAriaLabel} style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
      {(["light", "dark", "system"] as const).map((mode) => <button data-mega-settings={`mode-${mode}`} key={mode} onClick={() => updateSettings({ mode })} aria-pressed={settings.mode === mode} type="button">{mode === "light" ? text.modeLight : mode === "dark" ? text.modeDark : text.modeSystem}</button>)}
    </div>
    <h2>{text.density}</h2>
    <div style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
      {(["comfortable", "compact"] as const).map((density) => <button data-mega-settings={`density-${density}`} key={density} onClick={() => updateSettings({ density })} aria-pressed={settings.density === density} type="button">{density === "compact" ? text.densityCompact : text.densityComfortable}</button>)}
    </div>
    <h2>{text.accent}</h2>
    <div style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
      {MEGA_ACCENTS.map(({ id, color }) => <button data-mega-settings="accent-swatch" aria-label={text.accentSwatchAriaLabel.replace("{color}", id)} aria-pressed={settings.accent === id} key={id} onClick={() => updateSettings({ accent: id })} style={{ background: color, border: `2px solid ${settings.accent === id ? MEGA_TOKENS.text : "transparent"}`, borderRadius: "50%", height: 28, width: 28 }} type="button" />)}
    </div>
  </SettingsCard>;
}
