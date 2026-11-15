"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useLayoutEffect, useRef } from "react";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";
import { ENABLED_SETTINGS_SECTIONS, parseSettingsSection } from "../settings-section";

// megaui-only (FS-92): wait for navigation before mounting actionable content.
export function SettingsNav() {
  const params = useSearchParams();
  const { t } = useTranslation();
  if (params === null) {
    return <nav aria-busy="true" aria-label={t.workspace.settings.nav.navAriaLabel} data-mega-settings="nav" />;
  }
  return <ReadySettingsNav active={parseSettingsSection(params.get("section"))} />;
}

function ReadySettingsNav({ active }: { active: ReturnType<typeof parseSettingsSection> }) {
  const { t } = useTranslation();
  const router = useRouter();
  const activeLifetime = useRef(false);
  useLayoutEffect(() => {
    activeLifetime.current = true;
    return () => { activeLifetime.current = false; };
  }, []);
  const labels = {
    profile: t.workspace.settings.nav.profile,
    "account-security": t.workspace.settings.nav.accountSecurity,
    "ssh-keys": t.workspace.settings.nav.keys,
    tokens: t.workspace.settings.nav.tokens,
    appearance: t.workspace.settings.nav.appearance,
    notifications: t.workspace.settings.nav.notifications,
    shortcuts: t.workspace.settings.nav.shortcuts,
  };

  return (
    <nav aria-label={t.workspace.settings.nav.navAriaLabel} data-mega-settings="nav" style={{ display: "flex", flexDirection: "column", gap: MEGA_SPACING_TOKENS[3], minWidth: 180 }}>
      {ENABLED_SETTINGS_SECTIONS.map((section) => (
        <button
          data-mega-settings={`section-${section}`}
          key={section}
          onClick={() => {
            if (activeLifetime.current) router.replace(`?section=${section}`);
          }}
          style={{ background: active === section ? MEGA_TOKENS.activeBg : "transparent", border: 0, color: MEGA_TOKENS.text, cursor: "pointer", font: "inherit", padding: MEGA_SPACING_TOKENS[8], textAlign: "left" }}
          type="button"
        >
          {labels[section]}
        </button>
      ))}
    </nav>
  );
}
