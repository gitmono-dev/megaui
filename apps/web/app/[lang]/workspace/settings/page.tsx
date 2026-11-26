"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { MEGA_SPACING_TOKENS } from "@megaui/ui/tokens";
import { SettingsNav } from "./components/settings-nav";
import { ProfileForm } from "./components/profile-form";
import { AccountSecuritySection } from "./components/account-security-section";
import { AppearanceSection } from "./components/appearance-section";
import { CodeReadmeSection } from "./components/code-readme-section";
import { NotificationsSection } from "./components/notifications-section";
import { ShortcutsSection } from "./components/shortcuts-section";
import { SshKeysSection } from "./components/ssh-keys-section";
import { TokensSection } from "./components/tokens-section";
import { parseSettingsSection } from "./settings-section";

// megaui-only (FS-92): wait for navigation before mounting actionable content.
function SettingsContent() {
  const searchParams = useSearchParams();
  if (searchParams === null) {
    return <main aria-busy="true" data-mega-settings="page">Loading settings</main>;
  }
  const section = parseSettingsSection(searchParams.get("section"));
  const content = {
    profile: <ProfileForm />,
    "account-security": <AccountSecuritySection />,
    "ssh-keys": <SshKeysSection />,
    tokens: <TokensSection />,
    appearance: <AppearanceSection />,
    notifications: <NotificationsSection />,
    shortcuts: <ShortcutsSection />,
    "code-readme": <CodeReadmeSection />,
  }[section];
  return <main data-mega-settings="page" style={{ display: "flex", gap: `calc(${MEGA_SPACING_TOKENS[8]} * 3)`, minHeight: 480, padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>
    <SettingsNav /><div style={{ flex: 1, maxWidth: 760 }}>{content}</div>
  </main>;
}

export default function SettingsPage() {
  return <Suspense fallback={<main data-mega-settings="page">Loading settings</main>}><SettingsContent /></Suspense>;
}
