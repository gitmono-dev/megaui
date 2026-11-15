// FS-38: bounded, pure approval input; no database or provider is consulted.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { adminRepairDigest, boundedRepairConnectionString, parseQuarantineManifest, parseRepairManifest } from "./admin-repair-input";

const q = (index = 0) => ({ local_user_id: "历史-" + index, reason: "approved isolation", expected_user_version: "a".repeat(64) });
const repair = (index = 0) => ({ local_user_id: "历史-" + index, tenant_key: "tenant", app_id: "app", open_id: "ou-" + index,
  login_name: "alias-" + index, expected_user_version: "a".repeat(64), expected_identity_version: 0,
  expected_profile_digest: "b".repeat(64), expected_quarantine_operation_id: "00000000-0000-4000-8000-000000000038" });
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("approved quarantine and repair input (FS-38)", () => {
  it("preserves approved empty quarantine and bounds both commands to 100 rows", () => {
    expect(parseQuarantineManifest(bytes([]))).toEqual([]);
    expect(parseQuarantineManifest(bytes(Array.from({ length: 100 }, (_, n) => q(n))))).toHaveLength(100);
    expect(parseRepairManifest(bytes(Array.from({ length: 100 }, (_, n) => repair(n))))).toHaveLength(100);
    expect(() => parseRepairManifest(bytes([]))).toThrow("INVALID_ARGUMENT");
    expect(() => parseQuarantineManifest(bytes(Array.from({ length: 101 }, (_, n) => q(n))))).toThrow("INVALID_ARGUMENT");
    expect(() => parseRepairManifest(bytes(Array.from({ length: 101 }, (_, n) => repair(n))))).toThrow("INVALID_ARGUMENT");
  });

  it("rejects invalid bytes before parsing and permits the exact one MiB boundary", () => {
    for (const parse of [parseQuarantineManifest, parseRepairManifest]) {
      for (const input of [undefined, Buffer.from([0xff]), Buffer.from("null"), Buffer.alloc(1024 * 1024 + 1)]) {
        expect(() => parse(input)).toThrow("INVALID_ARGUMENT");
      }
    }
    const boundary = Buffer.alloc(1024 * 1024, 32); bytes([repair()]).copy(boundary);
    expect(parseRepairManifest(boundary)).toHaveLength(1);
  });

  it("binds every strict expected field and rejects the former numeric quarantine placeholder", () => {
    for (const row of [{ ...q(), expected_user_version: 0 }, { ...q(), expected_user_version: "A".repeat(64) },
      { ...q(), extra: true }, { local_user_id: "user", reason: "missing version" }]) {
      expect(() => parseQuarantineManifest(bytes([row]))).toThrow("INVALID_ARGUMENT");
    }
    for (const row of [{ ...repair(), extra: true }, { ...repair(), expected_profile_digest: null },
      { ...repair(), expected_quarantine_operation_id: null }, { ...repair(), expected_quarantine_operation_id: "not-uuid" },
      ...[-1, 1.5, 2147483648].map(v => ({ ...repair(), expected_identity_version: v })),
      { ...repair(), login_name: "UpperCase" }]) {
      expect(() => parseRepairManifest(bytes([row]))).toThrow("INVALID_ARGUMENT");
    }
    expect(parseRepairManifest(bytes([{ ...repair(), expected_identity_version: 2147483647 }]))[0]?.expected_identity_version).toBe(2147483647);
    expect(parseRepairManifest(bytes([{ ...repair(), expected_quarantine_operation_id: "00000000-0000-0000-0000-000000000038" }]))).toHaveLength(1);
  });

  it("preserves case-sensitive Unicode IDs and rejects invalid scalar strings and overlong reasons", () => {
    const rows = [{ ...q(), local_user_id: "历史-A" }, { ...q(1), local_user_id: "历史-a" }];
    expect(parseQuarantineManifest(bytes(rows))).toEqual(rows);
    expect(parseQuarantineManifest(bytes([{ ...q(), local_user_id: "😀".repeat(256), reason: "😀".repeat(1024) }]))).toHaveLength(1);
    for (const value of ["", " \n", "\u0000", "\ud800", "😀".repeat(257)]) {
      expect(() => parseQuarantineManifest(bytes([{ ...q(), local_user_id: value }]))).toThrow("INVALID_ARGUMENT");
    }
    for (const reason of ["", " \t", "\u0000", "\udfff", "😀".repeat(1025)]) {
      expect(() => parseQuarantineManifest(bytes([{ ...q(), reason }]))).toThrow("INVALID_ARGUMENT");
    }
  });

  it("rejects duplicate IDs, open IDs, aliases, and multiple tenant or app authorities", () => {
    expect(() => parseQuarantineManifest(bytes([q(), q()]))).toThrow("INVALID_ARGUMENT");
    for (const field of ["local_user_id", "open_id", "login_name"] as const) {
      expect(() => parseRepairManifest(bytes([repair(), { ...repair(1), [field]: repair()[field] }]))).toThrow("INVALID_ARGUMENT");
    }
    for (const field of ["tenant_key", "app_id"] as const) {
      expect(() => parseRepairManifest(bytes([repair(), { ...repair(1), [field]: "foreign" }]))).toThrow("INVALID_ARGUMENT");
    }
  });

  it("canonicalizes key order while binding ordered rows and every expected value", () => {
    const source = [q(), q(1)], parsed = parseQuarantineManifest(bytes(source));
    const canonical = '[{"expected_user_version":"' + "a".repeat(64) + '","local_user_id":"历史-0","reason":"approved isolation"},' +
      '{"expected_user_version":"' + "a".repeat(64) + '","local_user_id":"历史-1","reason":"approved isolation"}]';
    expect(adminRepairDigest(parsed)).toBe(createHash("sha256").update(canonical).digest("hex"));
    expect(adminRepairDigest(parseQuarantineManifest(bytes(source.map(row => Object.fromEntries(Object.entries(row).reverse()))))))
      .toBe(adminRepairDigest(parsed));
    expect(adminRepairDigest([...parsed].reverse())).not.toBe(adminRepairDigest(parsed));
    const original = parseRepairManifest(bytes([repair()]));
    for (const field of ["expected_user_version", "expected_profile_digest"] as const) {
      expect(adminRepairDigest(parseRepairManifest(bytes([{ ...repair(), [field]: "c".repeat(64) }])))).not.toBe(adminRepairDigest(original));
    }
    expect(Object.isFrozen(original)).toBe(true); expect(Object.isFrozen(original[0])).toBe(true);
  });

  it("bounds pg URL query timeouts without loosening shorter limits", () => {
    for (const query of ["", "?query_timeout=0", "?query_timeout=20000"]) {
      expect(new URL(boundedRepairConnectionString("postgres://localhost/test" + query)).searchParams.get("query_timeout")).toBe("5000");
    }
    expect(new URL(boundedRepairConnectionString("postgres://localhost/test?query_timeout=1800&query_timeout=20000"))
      .searchParams.getAll("query_timeout")).toEqual(["1800"]);
    expect(new URL(boundedRepairConnectionString("postgres://localhost/test?connect_timeout=20"))
      .searchParams.get("connect_timeout")).toBe("5");
    expect(new URL(boundedRepairConnectionString("postgres://localhost/test?connect_timeout=1"))
      .searchParams.get("connect_timeout")).toBe("1");
    for (const query of ["-1", "1.2", "bad", "9007199254740992"]) {
      expect(() => boundedRepairConnectionString("postgres://localhost/test?query_timeout=" + query)).toThrow("INVALID_CONFIG");
    }
  });
});
