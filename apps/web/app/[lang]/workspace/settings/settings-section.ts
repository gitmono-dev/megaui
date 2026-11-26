export const ENABLED_SETTINGS_SECTIONS = [
  "profile",
  "account-security",
  "ssh-keys",
  "tokens",
  "appearance",
  "notifications",
  "shortcuts",
] as const;

/** Workspace-wide settings; the section itself checks mega2 admin status (no nav fetch, FS-92). */
export const ADMIN_SETTINGS_SECTIONS = ["code-readme"] as const;

export type SettingsSection =
  | (typeof ENABLED_SETTINGS_SECTIONS)[number]
  | (typeof ADMIN_SETTINGS_SECTIONS)[number];

const ALL_SETTINGS_SECTIONS: readonly SettingsSection[] = [
  ...ENABLED_SETTINGS_SECTIONS,
  ...ADMIN_SETTINGS_SECTIONS,
];

export function parseSettingsSection(value: string | null): SettingsSection {
  return ALL_SETTINGS_SECTIONS.includes(value as SettingsSection)
    ? value as SettingsSection
    : "profile";
}
