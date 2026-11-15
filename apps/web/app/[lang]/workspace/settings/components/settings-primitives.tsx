import type { ReactNode } from "react";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

export function SettingsCard({ children }: { children: ReactNode }) {
  return <section data-mega-settings="card">{children}</section>;
}

export function SettingsToast({ tone, children }: { tone: "success" | "error"; children: ReactNode }) {
  return <div data-mega-settings="toast" data-mega-toast={tone} role="status" style={{ background: tone === "success" ? MEGA_TOKENS.success : MEGA_TOKENS.danger, borderRadius: MEGA_RADIUS_TOKENS.md, color: MEGA_TOKENS.accentForeground, marginBottom: MEGA_SPACING_TOKENS[8], padding: MEGA_SPACING_TOKENS[8] }}>{children}</div>;
}

export const fieldStyle = {
  background: MEGA_TOKENS.bg,
  border: `1px solid ${MEGA_TOKENS.border}`,
  borderRadius: MEGA_RADIUS_TOKENS.md,
  color: MEGA_TOKENS.text,
  font: "inherit",
  padding: MEGA_SPACING_TOKENS[8],
  width: "100%",
} as const;
