// FS-79: the enterprise admin dispatch must not acquire an unguarded write verb.
import { afterEach, describe, expect, it } from "vitest";

import {
  clearRegisteredWriteHandlers,
  registerGuardedWriteHandler,
  registeredApprovedMutationVerbs,
  registeredGuardedWriteVerbs,
} from "../../packages/engine/src/cli/admin-approval";
import {
  ENTERPRISE_ADMIN_DISPATCH,
  assertEnterpriseAdminWriteDispatch,
  installEnterpriseAdminDispatch,
  type EnterpriseAdminDispatchEntry,
} from "../../packages/engine/src/cli/enterprise-admin";

afterEach(() => {
  clearRegisteredWriteHandlers();
});

describe("enterprise admin write-verb dispatch guard (FS-79)", () => {
  it("matches the actual production dispatch table to the complete guarded-write registry", () => {
    installEnterpriseAdminDispatch();
    expect(registeredGuardedWriteVerbs()).toEqual(["activate", "apply", "convert", "maintenance", "provision", "quarantine", "repair", "reserve-actors"]);
    expect(registeredApprovedMutationVerbs()).toEqual(["activate", "apply", "convert", "maintenance", "provision", "quarantine", "repair", "reserve-actors"]);
    expect(() => assertEnterpriseAdminWriteDispatch()).not.toThrow();
    expect(() => registerGuardedWriteHandler(
      "post-startup-sentinel",
      { flags: {} },
      () => {},
      { approval: true, scope: true },
    )).toThrow(/sealed/);
    expect(registeredGuardedWriteVerbs()).toEqual(["activate", "apply", "convert", "maintenance", "provision", "quarantine", "repair", "reserve-actors"]);
    expect(ENTERPRISE_ADMIN_DISPATCH.map((entry) => entry.verb)).toEqual([
      "preview",
      "ready-check",
      "maintenance",
      "reserve-actors",
      "provision",
      "apply",
      "convert",
      "activate",
      "quarantine",
      "repair",
    ]);
  });

  it("rejects an unwrapped write sentinel that bypasses the approved mutation capability", () => {
    const sentinel: readonly EnterpriseAdminDispatchEntry[] = [
      { verb: "preview", kind: "read-only" },
      { verb: "ready-check", kind: "read-only" },
      {
        verb: "sentinel",
        kind: "write",
        register: () => registerGuardedWriteHandler(
          "sentinel",
          { flags: {} },
          () => {},
          { approval: true, scope: true },
        ),
      },
    ];
    expect(() => installEnterpriseAdminDispatch(sentinel)).toThrow(/approved mutation capability/);
  });

  it("rejects a write verb relabeled as read-only and guarded writes outside the actual dispatch table", () => {
    const mislabeled: readonly EnterpriseAdminDispatchEntry[] = [
      { verb: "convert", kind: "read-only" },
    ];
    expect(() => assertEnterpriseAdminWriteDispatch(mislabeled)).toThrow(/only preview and ready-check/);

    registerGuardedWriteHandler("sentinel", { flags: {} }, () => {}, { approval: true, scope: true });
    expect(() => assertEnterpriseAdminWriteDispatch()).toThrow(/complete mutation guard/);
  });
});
