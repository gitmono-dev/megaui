// megaui:libs/mega/services/monoengine/types.ts@0ff3a9d (credentials + notifications wire)
//
// Diff vs upstream (GC-03 / WA-05):
// - Scoped to user-credentials / user-notifications adapters only; code-backend
//   wire types remain in `@megaui/engine`.

import { z } from "zod";

export const listSshKeyWireSchema = z.object({
  id: z.number(),
  title: z.string(),
  ssh_key: z.string(),
  finger: z.string(),
  created_at: z.number(),
});
export type ListSSHKeyWire = z.output<typeof listSshKeyWireSchema>;

export const listTokenWireSchema = z.object({
  id: z.number(),
  token: z.string(),
  created_at: z.number(),
});
export type ListTokenWire = z.output<typeof listTokenWireSchema>;

export const userNotificationSettingsWireSchema = z.object({
  username: z.string(),
  enabled: z.boolean(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
});
export type UserNotificationSettingsWire = z.output<typeof userNotificationSettingsWireSchema>;

export const userNotificationPreferenceWireSchema = z.object({
  event_type_code: z.string(),
  category: z.string(),
  description: z.string(),
  system_required: z.boolean(),
  default_enabled: z.boolean(),
  explicit_enabled: z.boolean().nullable().optional(),
  enabled: z.boolean(),
  updated_at: z.string().nullable().optional(),
});
export type UserNotificationPreferenceWire = z.output<typeof userNotificationPreferenceWireSchema>;

export const userNotificationPreferencesResponseWireSchema = z.object({
  settings: userNotificationSettingsWireSchema,
  preferences: z.array(userNotificationPreferenceWireSchema),
});
export type UserNotificationPreferencesResponseWire = z.output<
  typeof userNotificationPreferencesResponseWireSchema
>;

export const updateUserNotificationConfigWireSchema = z.object({
  enabled: z.boolean().optional(),
  preferences: z
    .array(
      z.object({
        event_type_code: z.string(),
        enabled: z.boolean(),
      }),
    )
    .optional(),
});
export type UpdateUserNotificationConfigWire = z.output<
  typeof updateUserNotificationConfigWireSchema
>;

export interface SshKey {
  id: number;
  title: string;
  publicKey: string;
  fingerprint: string;
  createdAt: string;
}

export interface PersonalAccessToken {
  id: number;
  maskedToken: string;
  createdAt: string;
}

export interface GeneratedPersonalAccessToken {
  token: string;
}

export interface WorkspaceNotificationSettings {
  username: string;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkspaceNotificationPreference {
  eventTypeCode: string;
  category: string;
  description: string;
  systemRequired: boolean;
  defaultEnabled: boolean;
  explicitEnabled?: boolean;
  enabled: boolean;
  updatedAt?: string;
}

export interface WorkspaceNotificationConfig {
  settings: WorkspaceNotificationSettings;
  preferences: WorkspaceNotificationPreference[];
}

export interface UpdateWorkspaceNotificationConfig {
  enabled?: boolean;
  preferences?: readonly {
    eventTypeCode: string;
    enabled: boolean;
  }[];
}
