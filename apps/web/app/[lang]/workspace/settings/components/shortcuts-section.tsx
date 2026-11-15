"use client";

import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";
import { useTranslation } from "@/hooks/use-translation";
import { SettingsCard } from "./settings-primitives";

export function ShortcutsSection() {
  const { t } = useTranslation();
  const text = t.workspace.settings.shortcutsPage;
  const rows = [
    ["commandPalette", "⌘ K", "Ctrl K"],
    ["goCode", "G C", "G C"],
    ["goIssues", "G I", "G I"],
    ["goCls", "G L", "G L"],
  ] as const;
  return <SettingsCard>
    <h1 style={{ marginTop: 0 }}>{text.pageTitle}</h1><p style={{ color: MEGA_TOKENS.muted }}>{text.pageDesc}</p>
    <table style={{ borderCollapse: "collapse", width: "100%" }}><thead><tr><th>{text.groups.navigation}</th><th>{text.macColumn}</th><th>{text.windowsColumn}</th></tr></thead>
      <tbody>{rows.map(([action, mac, windows]) => <tr key={action}><td style={{ padding: MEGA_SPACING_TOKENS[8] }}>{text.actions[action]}</td><td>{mac}</td><td>{windows}</td></tr>)}</tbody>
    </table>
  </SettingsCard>;
}
