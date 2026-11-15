// megaui:libs/mega/services/monoengine/user-notifications.ts@0ff3a9d

import {
  userNotificationPreferencesResponseWireSchema,
  type UpdateUserNotificationConfigWire,
  type UpdateWorkspaceNotificationConfig,
  type UserNotificationPreferencesResponseWire,
  type UserNotificationPreferenceWire,
  type UserNotificationSettingsWire,
  type WorkspaceNotificationConfig,
  type WorkspaceNotificationPreference,
  type WorkspaceNotificationSettings,
} from "./types";
import { getCommonResultJson, putCommonResultJson } from "./write-client";

const USER_NOTIFICATION_PREFERENCES_PATH = "/api/v1/user/notification/preferences";

function requestOptions(headers?: HeadersInit) {
  return headers ? { headers } : {};
}

function optionalString(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

export function mapUserNotificationSettings(
  row: UserNotificationSettingsWire,
): WorkspaceNotificationSettings {
  return {
    username: row.username,
    enabled: row.enabled,
    createdAt: optionalString(row.created_at),
    updatedAt: optionalString(row.updated_at),
  };
}

export function mapUserNotificationPreference(
  row: UserNotificationPreferenceWire,
): WorkspaceNotificationPreference {
  return {
    eventTypeCode: row.event_type_code,
    category: row.category,
    description: row.description,
    systemRequired: row.system_required,
    defaultEnabled: row.default_enabled,
    explicitEnabled: row.explicit_enabled ?? undefined,
    enabled: row.enabled,
    updatedAt: optionalString(row.updated_at),
  };
}

export function mapUserNotificationConfig(
  response: UserNotificationPreferencesResponseWire,
): WorkspaceNotificationConfig {
  return {
    settings: mapUserNotificationSettings(response.settings),
    preferences: response.preferences.map(mapUserNotificationPreference),
  };
}

function toUpdateWire(input: UpdateWorkspaceNotificationConfig): UpdateUserNotificationConfigWire {
  return {
    enabled: input.enabled,
    preferences: input.preferences?.map((preference) => ({
      event_type_code: preference.eventTypeCode,
      enabled: preference.enabled,
    })),
  };
}

export async function getUserNotificationPreferences(
  headers?: HeadersInit,
): Promise<WorkspaceNotificationConfig> {
  const response = await getCommonResultJson(
    USER_NOTIFICATION_PREFERENCES_PATH,
    userNotificationPreferencesResponseWireSchema,
    requestOptions(headers),
  );
  return mapUserNotificationConfig(response);
}

export async function updateUserNotificationPreferences(
  input: UpdateWorkspaceNotificationConfig,
  headers?: HeadersInit,
): Promise<WorkspaceNotificationConfig> {
  const response = await putCommonResultJson(
    USER_NOTIFICATION_PREFERENCES_PATH,
    toUpdateWire(input),
    userNotificationPreferencesResponseWireSchema,
    requestOptions(headers),
  );
  return mapUserNotificationConfig(response);
}
