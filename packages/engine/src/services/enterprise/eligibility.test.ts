import { describe, expect, it } from "vitest";

import {
  createEnterpriseEligibilityService,
  type AuthenticationAuthorityRow,
  type AuthenticationEligibilityDatabaseReader,
  type DirectoryAdmissionReader,
  type EnterpriseEligibilityServiceOptions,
} from "./eligibility";
import { DIRECTORY_FRESHNESS_LIMIT_MS } from "./directory-sync";
import { scopeHashOf, type AuthoritativeDirectoryMember } from "./feishu/directory";

const NOW = new Date("2026-11-09T20:00:00.000Z");
const DIRECTORY_SCOPE = {
  tenantKey: "tenant-1",
  appId: "app-1",
  departmentIds: ["od-approved"],
} as const;
const DIRECTORY_SCOPE_HASH = scopeHashOf(DIRECTORY_SCOPE);

function member(
  overrides: Partial<AuthoritativeDirectoryMember> = {},
): AuthoritativeDirectoryMember {
  return {
    openId: "ou-1",
    departmentIds: ["od-approved"],
    status: {
      isActivated: true,
      isFrozen: false,
      isResigned: false,
      isExited: false,
    },
    ...overrides,
  };
}

function authorityRow(overrides: Partial<AuthenticationAuthorityRow> = {}): AuthenticationAuthorityRow {
  return {
    identityId: "identity-1",
    localUserId: "user-1",
    tenantKey: DIRECTORY_SCOPE.tenantKey,
    appId: DIRECTORY_SCOPE.appId,
    identityStatus: "active",
    banned: false,
    banExpires: null,
    policyScope: "instance-1",
    authEpoch: 7,
    activationState: "enterprise",
    identityScopeHash: DIRECTORY_SCOPE_HASH,
    identityGeneration: 4,
    scopeHash: DIRECTORY_SCOPE_HASH,
    scopeGeneration: 4,
    snapshotGeneration: 4,
    snapshotComplete: true,
    snapshotObservedAt: new Date(NOW.getTime() - DIRECTORY_FRESHNESS_LIMIT_MS),
    ...overrides,
  };
}

function boundDirectoryReader(
  read: DirectoryAdmissionReader["read"] = async () => member(),
): DirectoryAdmissionReader {
  return {
    tenantKey: DIRECTORY_SCOPE.tenantKey,
    appId: DIRECTORY_SCOPE.appId,
    read,
  };
}

function service(
  options: Partial<EnterpriseEligibilityServiceOptions> = {},
) {
  const databaseReader: AuthenticationEligibilityDatabaseReader =
    options.databaseReader ?? { read: async () => [authorityRow()] };
  const directoryReader = options.directoryReader ?? boundDirectoryReader();
  return createEnterpriseEligibilityService({
    directoryScope: DIRECTORY_SCOPE,
    policyScope: "instance-1",
    authMode: "enterprise",
    databaseReader,
    directoryReader,
    now: () => new Date(NOW),
    ...options,
  });
}

describe("enterprise eligibility ports (FS-10)", () => {
  it("admits an unbound member in maintenance through a fresh provider read", async () => {
    let providerReads = 0;
    const eligibility = service({
      authMode: "maintenance",
      databaseReader: { read: async () => Promise.reject(new Error("must not read the database")) },
      directoryReader: boundDirectoryReader(async () => {
        providerReads += 1;
        return member();
      }),
    });

    expect(eligibility.directoryAdmission.length).toBe(1);
    await expect(eligibility.directoryAdmission("ou-1")).resolves.toBe(true);
    await expect(eligibility.directoryAdmission("ou-1")).resolves.toBe(true);
    expect(providerReads).toBe(2);
  });

  it.each([
    ["open-id echo", member({ openId: "ou-other" })],
    ["approved department", member({ departmentIds: ["od-other"] })],
    ["activation", member({ status: { ...member().status, isActivated: false } })],
    ["frozen", member({ status: { ...member().status, isFrozen: true } })],
    ["resigned", member({ status: { ...member().status, isResigned: true } })],
    ["exited", member({ status: { ...member().status, isExited: true } })],
  ])("rejects directory admission when %s does not match", async (_name, result) => {
    await expect(
      service({ directoryReader: boundDirectoryReader(async () => result) }).directoryAdmission(
        "ou-1",
      ),
    ).resolves.toBe(false);
  });

  it("fails directory admission closed on provider errors or malformed input", async () => {
    const eligibility = service({
      directoryReader: boundDirectoryReader(async () =>
        Promise.reject(new Error("provider failed")),
      ),
    });
    await expect(eligibility.directoryAdmission("ou-1")).resolves.toBe(false);
    await expect(eligibility.directoryAdmission(" ")).resolves.toBe(false);
  });

  it("refuses a directory reader bound to another tenant or app", () => {
    expect(() =>
      service({
        directoryReader: {
          tenantKey: "tenant-other",
          appId: DIRECTORY_SCOPE.appId,
          read: async () => member(),
        },
      }),
    ).toThrow(/does not match the factory tenant and app/);
  });

  it("passes only factory-bound authority fields to the database reader", async () => {
    const lookups: unknown[] = [];
    const eligibility = service({
      databaseReader: {
        read: async (lookup) => {
          lookups.push(lookup);
          return [authorityRow()];
        },
      },
      directoryReader: boundDirectoryReader(async () =>
        Promise.reject(new Error("must not call provider")),
      ),
    });

    expect(eligibility.authenticationEligibility.length).toBe(3);
    await expect(
      eligibility.authenticationEligibility("user-1", "identity-1", 7),
    ).resolves.toBe(true);
    expect(lookups).toEqual([
      {
        identityId: "identity-1",
        localUserId: "user-1",
        tenantKey: "tenant-1",
        appId: "app-1",
        policyScope: "instance-1",
        directoryScopeHash: DIRECTORY_SCOPE_HASH,
      },
    ]);
  });

  it.each([
    ["identity status", { identityStatus: "suspended" }],
    ["identity binding", { localUserId: "user-other" }],
    ["tenant", { tenantKey: "tenant-other" }],
    ["app", { appId: "app-other" }],
    ["policy scope", { policyScope: "instance-other" }],
    ["local ban", { banned: true }],
    ["epoch", { authEpoch: 8 }],
    ["effective mode", { activationState: "maintenance" }],
    ["identity scope", { identityScopeHash: "scope-other" }],
    ["scope watermark", { scopeHash: "scope-other" }],
    ["identity generation", { identityGeneration: 3 }],
    ["snapshot generation", { snapshotGeneration: 3 }],
    ["snapshot completeness", { snapshotComplete: false }],
    [
      "stale observation",
      { snapshotObservedAt: new Date(NOW.getTime() - DIRECTORY_FRESHNESS_LIMIT_MS - 1) },
    ],
    ["future observation", { snapshotObservedAt: new Date(NOW.getTime() + 1) }],
  ] as const)("rejects authentication when %s fails", async (_name, overrides) => {
    const eligibility = service({
      databaseReader: { read: async () => [authorityRow(overrides)] },
    });
    await expect(
      eligibility.authenticationEligibility("user-1", "identity-1", 7),
    ).resolves.toBe(false);
  });

  it("accepts the exact freshness boundary", async () => {
    await expect(
      service().authenticationEligibility("user-1", "identity-1", 7),
    ).resolves.toBe(true);
  });

  it("rejects missing, ambiguous, invalid, and failed authority reads", async () => {
    for (const databaseReader of [
      { read: async () => [] },
      { read: async () => [authorityRow(), authorityRow()] },
      { read: async () => [{ ...authorityRow(), authEpoch: -1 }] as AuthenticationAuthorityRow[] },
      { read: async () => Promise.reject(new Error("database failed")) },
    ] satisfies AuthenticationEligibilityDatabaseReader[]) {
      await expect(
        service({ databaseReader }).authenticationEligibility("user-1", "identity-1", 7),
      ).resolves.toBe(false);
    }
  });

  it("rejects malformed caller identifiers before any authority read", async () => {
    let reads = 0;
    const eligibility = service({
      databaseReader: {
        read: async () => {
          reads += 1;
          return [authorityRow()];
        },
      },
    });
    await expect(eligibility.authenticationEligibility("", "identity-1", 7)).resolves.toBe(false);
    await expect(eligibility.authenticationEligibility("user-1", "", 7)).resolves.toBe(false);
    await expect(eligibility.authenticationEligibility("user-1", "identity-1", -1)).resolves.toBe(
      false,
    );
    expect(reads).toBe(0);
  });
});
