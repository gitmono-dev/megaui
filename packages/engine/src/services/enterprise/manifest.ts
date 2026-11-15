// megaui-only (FS-37): canonical migration input/source contract, shared by later phases.
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalizeJson } from "../../cli/admin-payload";

export const MIGRATION_MAX_BYTES = 10 * 1024 * 1024;
export const MIGRATION_MAX_MEMBERS = 10_000;
export class MigrationInputError extends Error {
  constructor() { super("INVALID_ARGUMENT"); this.name = "MigrationInputError"; }
}
export class MigrationSourceError extends Error {
  constructor() { super("SOURCE_REJECTED"); this.name = "MigrationSourceError"; }
}
export function validMigrationIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && [...value].length <= 256 && validUnicode(value);
}
function validUnicode(value: string): boolean {
  return !value.includes("\0") && ![...value].some(char => {
    const point = char.codePointAt(0)!;
    return point >= 0xd800 && point <= 0xdfff;
  });
}
const text = z.string().refine(validUnicode);
const identifier = z.string().refine(validMigrationIdentifier);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().refine(value => {
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)) return false;
  const milliseconds = value.slice(0, 23) + "Z";
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) && date.toISOString() === milliseconds;
});
const memberSchema = z.object({
  local_user_id: identifier, tenant_key: identifier, app_id: identifier, open_id: identifier,
  login_name: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/),
  expected_user_version: hash, expected_identity_version: z.number().int().min(0).max(2147483647),
}).strict();
const manifestSchema = z.object({ schemaVersion: z.literal(1),
  members: z.array(memberSchema).min(1).max(MIGRATION_MAX_MEMBERS) }).strict();
export type MigrationMember = Readonly<z.infer<typeof memberSchema>>;
export interface MigrationAuthority { tenantKey: string; appId: string }

function assertMembers(members: readonly MigrationMember[], authority: MigrationAuthority): void {
  if (!validMigrationIdentifier(authority.tenantKey) || !validMigrationIdentifier(authority.appId) ||
    members.some(row => row.tenant_key !== authority.tenantKey || row.app_id !== authority.appId) ||
    new Set(members.map(row => row.local_user_id)).size !== members.length ||
    new Set(members.map(row => row.open_id)).size !== members.length ||
    new Set(members.map(row => row.login_name)).size !== members.length) throw new MigrationInputError();
}

/** Pure replay validation: input consistency grants no deployment authority. */
export function parseMigrationManifestInput(bytes: Uint8Array | undefined): readonly MigrationMember[] {
  try {
    if (!bytes || bytes.byteLength > MIGRATION_MAX_BYTES) throw new MigrationInputError();
    const parsed = manifestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const first = parsed.members[0]!;
    assertMembers(parsed.members, { tenantKey: first.tenant_key, appId: first.app_id });
    return Object.freeze(parsed.members.map(row => Object.freeze(row)));
  } catch { throw new MigrationInputError(); }
}

/** Execution additionally requires the factory's trusted tenant and app. */
export function parseMigrationManifest(bytes: Uint8Array, authority: MigrationAuthority): readonly MigrationMember[] {
  const members = parseMigrationManifestInput(bytes);
  assertMembers(members, authority);
  return members;
}

const userSchema = z.object({ id: identifier, name: text, email: text, emailVerified: z.boolean(),
  updatedAt: timestamp, banned: z.boolean().nullable() }).strict();
const identitySchema = z.object({ id: identifier, local_user_id: identifier, tenant_key: identifier,
  app_id: identifier, open_id: identifier, union_id: text.nullable(), status: z.enum(["active", "suspended", "resigned"]),
  identity_version: z.number().int().min(1).max(2147483647), created_at: timestamp, updated_at: timestamp }).strict();
const profileSchema = z.object({ user_id: identifier, tenant_key: identifier, login_name: text,
  backend_username: text, display_name: text.nullable(), notification_email: text.nullable(),
  created_at: timestamp, updated_at: timestamp }).strict();
export type MigrationUserSource = z.infer<typeof userSchema>;
export type MigrationIdentitySource = z.infer<typeof identitySchema>;
export type MigrationProfileSource = z.infer<typeof profileSchema>;
function digest(value: unknown): string { return createHash("sha256").update(canonicalizeJson(value)).digest("hex"); }

export function migrationUserVersion(value: MigrationUserSource): string {
  try { return digest(userSchema.parse(value)); } catch { throw new MigrationSourceError(); }
}
export function migrationIdentityDigest(value: readonly MigrationIdentitySource[]): string {
  try {
    const rows = z.array(identitySchema).parse(value);
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw new MigrationSourceError();
    rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return digest(rows);
  } catch { throw new MigrationSourceError(); }
}
export function migrationProfileDigest(value: MigrationProfileSource | null): string {
  try { return digest(profileSchema.nullable().parse(value)); } catch { throw new MigrationSourceError(); }
}

const envelopeMemberSchema = memberSchema.extend({ backend_username: text.refine(value => /\P{White_Space}/u.test(value)),
  source_user_version: hash, source_identity_digest: hash, source_profile_digest: hash }).strict();
const envelopeSchema = z.object({ schemaVersion: z.literal(1), targetFingerprint: text.min(1), tenantKey: identifier,
  appId: identifier, ownershipDigest: hash, members: z.array(envelopeMemberSchema).min(1).max(MIGRATION_MAX_MEMBERS) }).strict();
export type MigrationEnvelope = z.infer<typeof envelopeSchema>;
export type MigrationEnvelopeMember = z.infer<typeof envelopeMemberSchema>;

/** Runtime validation also serves untrusted persisted initial envelopes in FS-61. */
export function validateMigrationEnvelope(value: unknown): MigrationEnvelope {
  try {
    const parsed = envelopeSchema.parse(value);
    assertMembers(parsed.members, parsed);
    if (parsed.members.some(row => row.expected_user_version !== row.source_user_version)) throw new MigrationInputError();
    return parsed;
  } catch { throw new MigrationInputError(); }
}
export function buildMigrationEnvelope(value: Omit<MigrationEnvelope, "schemaVersion">): MigrationEnvelope {
  return validateMigrationEnvelope({ schemaVersion: 1, ...value });
}
export function migrationManifestDigest(value: unknown): string {
  return digest(validateMigrationEnvelope(value));
}
