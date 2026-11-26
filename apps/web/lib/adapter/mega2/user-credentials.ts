// megaui:libs/mega/services/monoengine/user-credentials.ts@0ff3a9d

import { z } from "zod";

import { assertValidSshPublicKeyLine } from "./ssh-key-validation";
import {
  listSshKeyWireSchema,
  listTokenWireSchema,
  type GeneratedPersonalAccessToken,
  type PersonalAccessToken,
  type SshKey,
} from "./types";
import {
  mapGeneratedToken,
  mapListSSHKey,
  mapListToken,
} from "./user-mappers";
import {
  deleteCommonResultVoid,
  deleteCommonResultWithBody,
  getCommonResultJson,
  postCommonResultJson,
  postCommonResultVoid,
} from "./write-client";

export interface AddSshKeyInput {
  title: string;
  publicKey: string;
}

const gpgWire = z.object({ key_id: z.string(), fingerprint: z.string(), created_at: z.string(), expires_at: z.string().nullable() });

export async function listGpgKeys(headers?: HeadersInit) {
  const keys = await getCommonResultJson("/api/v1/gpg/list", z.array(gpgWire), requestOptions(headers));
  return keys.map(key => ({ id: key.key_id, fingerprint: key.fingerprint, createdAt: key.created_at, expiresAt: key.expires_at }));
}

export async function addGpgKey(publicKey: string, headers?: HeadersInit) {
  await postCommonResultVoid("/api/v1/gpg/add", { gpg_content: publicKey }, requestOptions(headers));
  return { added: true };
}

export async function deleteGpgKey(id: string, headers?: HeadersInit) {
  await deleteCommonResultWithBody("/api/v1/gpg/remove", { key_id: id }, requestOptions(headers));
  return { deleted: true };
}

function requestOptions(headers?: HeadersInit) {
  return headers ? { headers } : {};
}

export async function listSshKeys(headers?: HeadersInit): Promise<SshKey[]> {
  const rows = await getCommonResultJson(
    "/api/v1/user/ssh/list",
    z.array(listSshKeyWireSchema),
    requestOptions(headers),
  );
  return rows.map(mapListSSHKey);
}

export async function addSshKey(
  input: AddSshKeyInput,
  headers?: HeadersInit,
): Promise<{ added: true }> {
  assertValidSshPublicKeyLine(input.publicKey);
  await postCommonResultVoid(
    "/api/v1/user/ssh",
    { title: input.title.trim(), ssh_key: input.publicKey.trim() },
    requestOptions(headers),
  );
  return { added: true };
}

export async function deleteSshKey(
  id: number,
  headers?: HeadersInit,
): Promise<{ deleted: true }> {
  await deleteCommonResultVoid(`/api/v1/user/ssh/${id}`, requestOptions(headers));
  return { deleted: true };
}

export async function listPersonalAccessTokens(
  headers?: HeadersInit,
): Promise<PersonalAccessToken[]> {
  const rows = await getCommonResultJson(
    "/api/v1/user/token/list",
    z.array(listTokenWireSchema),
    requestOptions(headers),
  );
  return rows.map(mapListToken);
}

export async function generatePersonalAccessToken(
  headers?: HeadersInit,
): Promise<GeneratedPersonalAccessToken> {
  const token = await postCommonResultJson(
    "/api/v1/user/token/generate",
    {},
    z.string(),
    requestOptions(headers),
  );
  return mapGeneratedToken(token);
}

export async function deletePersonalAccessToken(
  id: number,
  headers?: HeadersInit,
): Promise<{ deleted: true }> {
  await deleteCommonResultVoid(`/api/v1/user/token/${id}`, requestOptions(headers));
  return { deleted: true };
}
