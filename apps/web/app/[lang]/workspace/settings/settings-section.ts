export const ENABLED_SETTINGS_SECTIONS = [
  "profile",
  "account-security",
  "ssh-keys",
  "tokens",
  "appearance",
  "notifications",
  "shortcuts",
] as const;

export type SettingsSection = (typeof ENABLED_SETTINGS_SECTIONS)[number];

export function parseSettingsSection(value: string | null): SettingsSection {
  return ENABLED_SETTINGS_SECTIONS.includes(value as SettingsSection)
    ? value as SettingsSection
    : "profile";
}
