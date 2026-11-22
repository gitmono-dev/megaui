// megaui-only: the `@megaui/database` entry (`src/index.ts`, its package.json "." export)
// after FSL-139. The enterprise database client and every enterprise store are gone; the
// enterprise table definitions stay exported through `./schema` until FSL-168 drops them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import * as entry from "./index";
import * as schema from "./schema";

const exported: Record<string, unknown> = entry;

/** The runtime exports of the deleted `src/enterprise-*.ts` modules, as of the commit before FSL-139. */
const REMOVED_STORE_EXPORTS = {
  "enterprise-actor-store": ["beginActorClaimBatch", "insertClaimedActorReservations", "lockActorClaimScope",
    "lockActorInventoryInputs", "readActorInventory", "readActorReservations", "readCreatedActorBindings",
    "readHistoricalActorSubjects", "updateActorInventoryLocalDigests", "writeActorInventory"],
  "enterprise-directory-store": ["createEnterpriseDirectoryStore"],
  "enterprise-grant-store": ["createEnterpriseGrantStore"],
  "enterprise-identity-store": ["bindHistoricalIdentity", "createProvisionedIdentity", "recordProvisionCheckpoint"],
  "enterprise-offboarding-store": ["EnterpriseOffboardingError", "createEnterpriseOffboardingStore"],
  "enterprise-operations-store": ["beginApprovedOperation", "completeApprovedOperation", "insertMigrationRun",
    "lockMigrationRunSources", "recordMigrationCheckpoint", "updateMigrationRun", "validAffectedRows",
    "validAppliedRows", "validProvisionedRows"],
  "enterprise-policy-store": ["activateEnterprise", "enterEnterpriseMaintenance"],
  "enterprise-repair-store": ["EnterpriseRepairStoreRejected", "lockEnterpriseRepairSources",
    "lockRepairDirectorySnapshot", "quarantineEnterpriseUser", "readCurrentQuarantines", "repairEnterpriseUser"],
  "enterprise-scope": ["DEFAULT_OWNER_FINGERPRINT", "ENTERPRISE_PROCESS_ROLES", "EnterpriseScopeError",
    "REGISTERED_ROLE_SCOPES", "assertEnterpriseScope", "assertMigrationTarget", "bootstrapEnterpriseMarker",
    "readEnterpriseMarker", "readScopeExpectation", "readSqlRolePrivileges", "runMigrationPrecheck",
    "targetFingerprint"],
} as const;

describe("FSL-139: @megaui/database exports no enterprise database code", () => {
  it("AC4: the entry does not export createEnterpriseDatabaseClient", () => {
    expect(exported).not.toHaveProperty("createEnterpriseDatabaseClient");
  });

  it.each(Object.entries(REMOVED_STORE_EXPORTS))("AC5: the entry exports nothing of %s", (_module, names) => {
    for (const name of names) expect(exported, name).not.toHaveProperty(name);
  });

  it("AC5: every enterprise-named export is a schema definition, not a store", () => {
    const enterpriseNamed = Object.keys(exported).filter(name => /enterprise/i.test(name));
    expect(enterpriseNamed.filter(name => !(name in schema))).toEqual([]);
  });

  it("AC4, AC5: the entry source re-exports no enterprise module", () => {
    const source = readFileSync(join(__dirname, "index.ts"), "utf8");
    expect(source).not.toMatch(/enterprise/i);
  });

  it("the entry still exports the database client, the Feishu login store and the role scope check", () => {
    for (const name of ["createDatabaseClient", "getDatabaseClient", "getDb", "getPool", "closeDatabaseClient",
      "readRuntimeRolePrivileges", "assertRuntimeRoleScope"]) {
      expect(exported, name).toHaveProperty(name);
    }
    expect(Object.keys(exported).some(name => /feishu/i.test(name))).toBe(true);
  });
});
