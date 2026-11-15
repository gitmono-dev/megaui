// megaui:libs/mega/services/monoengine/user-mappers.ts@0ff3a9d

import type {
  GeneratedPersonalAccessToken,
  ListSSHKeyWire,
  ListTokenWire,
  PersonalAccessToken,
  SshKey,
} from "./types";

export function unixSecondsToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export function mapListSSHKey(row: ListSSHKeyWire): SshKey {
  return {
    id: row.id,
    title: row.title,
    publicKey: row.ssh_key,
    fingerprint: row.finger,
    createdAt: unixSecondsToIso(row.created_at),
  };
}

export function mapListToken(row: ListTokenWire): PersonalAccessToken {
  return {
    id: row.id,
    maskedToken: row.token,
    createdAt: unixSecondsToIso(row.created_at),
  };
}

export function mapGeneratedToken(token: string): GeneratedPersonalAccessToken {
  return { token };
}
