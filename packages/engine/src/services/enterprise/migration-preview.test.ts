// FS-37: pure manifest contracts, exact source versions and compatibility keys.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compatibilityEmail } from "./identity-key";
import {
  parseMigrationManifest, parseMigrationManifestInput, migrationUserVersion, migrationIdentityDigest, migrationProfileDigest,
  buildMigrationEnvelope, migrationManifestDigest, validateMigrationEnvelope,
} from "./manifest";

const scope = { tenantKey: "tenant", appId: "app" };
const user = { id: "legacy-text-id", name: "  Ada  ", email: "ada@example.test", emailVerified: false,
  updatedAt: "2026-11-11T01:02:03.123456Z", banned: null };
const member = (n = 0) => ({ local_user_id: n === 0 ? user.id : `legacy-${n}`, tenant_key: "tenant", app_id: "app",
  open_id: `open-${n}`, login_name: `alias-${n}`, expected_user_version: "a".repeat(64), expected_identity_version: 0 });
const bytes = (members: unknown[] = [member()]) => Buffer.from(JSON.stringify({ schemaVersion: 1, members }));
const identity = { id: "i", local_user_id: user.id, tenant_key: "tenant", app_id: "app", open_id: "open-0",
  union_id: null, status: "active" as const, identity_version: 1, created_at: user.updatedAt, updated_at: user.updatedAt };
const profile = { user_id: user.id, tenant_key: "tenant", login_name: "alias-0", backend_username: "  Ada  ",
  display_name: null, notification_email: "notify@example.test", created_at: user.updatedAt, updated_at: user.updatedAt };
const envelope = () => buildMigrationEnvelope({ targetFingerprint: "megaui:instance:test", ...scope,
  ownershipDigest: "b".repeat(64), members: [{ ...member(), expected_user_version: migrationUserVersion(user),
    backend_username: "  Ada  ", source_user_version: migrationUserVersion(user),
    source_identity_digest: migrationIdentityDigest([]), source_profile_digest: migrationProfileDigest(null) }] });

describe("migration manifest (FS-37)", () => {
  it("parses signed replay input without granting its tenant any deployment authority", () => {
    const foreign = bytes([{ ...member(), tenant_key: "foreign" }]);
    expect(parseMigrationManifestInput(foreign)[0]?.tenant_key).toBe("foreign");
    expect(() => parseMigrationManifest(foreign, scope)).toThrow("INVALID_ARGUMENT");
    for (const bad of [undefined, Buffer.from([0xff]), bytes([]),
      bytes([member(), { ...member(1), tenant_key: "foreign" }]),
      bytes([member(), { ...member(1), app_id: "foreign" }]), bytes([member(), member()]),
      bytes([{ ...member(), extra: true }]), Buffer.alloc(10 * 1024 * 1024 + 1)]) {
      expect(() => parseMigrationManifestInput(bad)).toThrow("INVALID_ARGUMENT");
    }
  });
  it("accepts text local IDs and full multi-batch manifests through 10000 rows", () => {
    expect(parseMigrationManifest(bytes(), scope)[0]?.local_user_id).toBe(user.id);
    expect(parseMigrationManifest(bytes(Array.from({ length: 101 }, (_, n) => member(n))), scope)).toHaveLength(101);
    expect(parseMigrationManifest(bytes(Array.from({ length: 10000 }, (_, n) => member(n))), scope)).toHaveLength(10000);
  });
  it("rejects invalid UTF-8, unknown fields, wrong authority, versions and capacity", () => {
    const invalid = [Buffer.from([0xff]), bytes([]), bytes([{ ...member(), extra: true }]),
      bytes([{ ...member(), tenant_key: "foreign" }]), bytes([{ ...member(), app_id: "foreign" }]),
      bytes([{ ...member(), expected_user_version: "A".repeat(64) }]),
      ...[-1, 1.5, 2147483648].map(v => bytes([{ ...member(), expected_identity_version: v }])),
      bytes(Array.from({ length: 10001 }, (_, n) => member(n))), Buffer.alloc(10 * 1024 * 1024 + 1, 32)];
    for (const input of invalid) expect(() => parseMigrationManifest(input, scope)).toThrow("INVALID_ARGUMENT");
    const exactLimit = Buffer.alloc(10 * 1024 * 1024, 32); bytes().copy(exactLimit);
    expect(parseMigrationManifest(exactLimit, scope)).toHaveLength(1);
  });
  it("rejects duplicate identities, aliases and local IDs across batch boundaries", () => {
    for (const key of ["local_user_id", "open_id", "login_name"] as const) {
      const rows = Array.from({ length: 101 }, (_, n) => member(n));
      rows[100] = { ...rows[100]!, [key]: rows[0]![key] };
      expect(() => parseMigrationManifest(bytes(rows), scope)).toThrow("INVALID_ARGUMENT");
    }
  });
  it("counts Unicode codepoints without accepting NUL, unpaired surrogates or blank identifiers", () => {
    expect(parseMigrationManifest(bytes([{ ...member(), local_user_id: "😀".repeat(256) }]), scope)).toHaveLength(1);
    for (const value of ["", " \n", "\u0000", "\ud800", "😀".repeat(257)]) {
      expect(() => parseMigrationManifest(bytes([{ ...member(), local_user_id: value }]), scope)).toThrow("INVALID_ARGUMENT");
    }
  });
});

describe("canonical source versions (FS-37)", () => {
  it("hashes exactly the frozen user fields and preserves microseconds and nullable banned", () => {
    const canonical = '{"banned":null,"email":"ada@example.test","emailVerified":false,"id":"legacy-text-id","name":"  Ada  ","updatedAt":"2026-11-11T01:02:03.123456Z"}';
    expect(migrationUserVersion(user)).toBe(createHash("sha256").update(canonical).digest("hex"));
    expect(migrationUserVersion({ ...user, updatedAt: "2026-11-11T01:02:03.123457Z" })).not.toBe(migrationUserVersion(user));
    expect(migrationUserVersion({ ...user, banned: false })).not.toBe(migrationUserVersion(user));
    for (const updatedAt of ["infinity", "2026-02-30T01:02:03.123456Z", "2026-11-11T01:02:03.123Z", "0000-01-01T00:00:00.000000Z"]) {
      expect(() => migrationUserVersion({ ...user, updatedAt })).toThrow("SOURCE_REJECTED");
    }
  });
  it("sorts all identity rows by UTF-16 ID while covering every identity and profile field", () => {
    const a = { ...identity, id: "😀", app_id: "foreign" }, b = { ...identity, id: "\ue000" };
    expect(migrationIdentityDigest([a, b])).toBe(migrationIdentityDigest([b, a]));
    expect(migrationIdentityDigest([a, b])).not.toBe(migrationIdentityDigest([b]));
    expect(migrationIdentityDigest([{ ...identity, union_id: "union" }])).not.toBe(migrationIdentityDigest([identity]));
    expect(migrationProfileDigest(profile)).not.toBe(migrationProfileDigest({ ...profile, notification_email: "other@example.test" }));
    expect(migrationProfileDigest(profile)).not.toBe(migrationProfileDigest({ ...profile, updated_at: "2026-11-11T01:02:03.123457Z" }));
    expect(migrationProfileDigest(null)).toBe(createHash("sha256").update("null").digest("hex"));
  });
  it("ignores JSON key order and whitespace but binds row order, actor, source and ownership", () => {
    const initial = envelope(), digest = migrationManifestDigest(initial);
    const reordered = Object.fromEntries(Object.entries({ ...initial,
      members: initial.members.map(row => Object.fromEntries(Object.entries(row).reverse())) }).reverse());
    expect(migrationManifestDigest(reordered)).toBe(digest);
    expect(validateMigrationEnvelope(initial)).toEqual(initial);
    expect(migrationManifestDigest({ ...initial, ownershipDigest: "c".repeat(64) })).not.toBe(digest);
    expect(migrationManifestDigest({ ...initial, members: [{ ...initial.members[0], backend_username: "Ada" }] })).not.toBe(digest);
    expect(migrationManifestDigest({ ...initial, members: [{ ...initial.members[0], source_profile_digest: "d".repeat(64) }] })).not.toBe(digest);
    const second = { ...initial.members[0]!, ...member(1), expected_user_version: initial.members[0]!.expected_user_version };
    const multi = { ...initial, members: [...initial.members, second] };
    expect(migrationManifestDigest(multi)).not.toBe(migrationManifestDigest({ ...multi, members: [...multi.members].reverse() }));
    expect(() => validateMigrationEnvelope({ ...initial, observedAt: "not part of digest" })).toThrow("INVALID_ARGUMENT");
  });
  it("uses the same lowercase unpadded SHA-256 base32 compatibility key as provisioning", () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    const bits = [...createHash("sha256").update(user.id).digest()].map(b => b.toString(2).padStart(8, "0")).join("");
    let expected = "";
    for (let n = 0; n < bits.length; n += 5) expected += alphabet[parseInt(bits.slice(n, n + 5).padEnd(5, "0"), 2)];
    expect(compatibilityEmail(user.id)).toBe(`u_${expected}@identity.invalid`);
    expect(expected).toHaveLength(52);
  });
});
