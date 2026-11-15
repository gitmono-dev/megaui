import { describe, expect, it } from "vitest";
import { evaluateAcl, collaboratorRoleToAclRole, type AclAction, type AclRole } from "./acl";

const ROLES: readonly AclRole[] = ["anonymous", "none", "member", "admin", "owner"];
const ACTIONS: readonly AclAction[] = ["read", "write", "manage"];

const EXPECTED: Record<AclRole, Record<AclAction, boolean>> = {
  anonymous: { read: false, write: false, manage: false },
  none: { read: false, write: false, manage: false },
  member: { read: true, write: false, manage: false },
  admin: { read: true, write: true, manage: false },
  owner: { read: true, write: true, manage: true },
};

describe("ACL role×action matrix (EG-02)", () => {
  it("covers anonymous/non-member/member/admin/owner × read/write/manage", () => {
    for (const role of ROLES) {
      for (const action of ACTIONS) {
        expect(evaluateAcl(role, action), `${role}/${action}`).toEqual({
          allow: EXPECTED[role][action],
          role,
          action,
        });
      }
    }
  });

  it("denies by default (fail-closed) for anonymous and non-members", () => {
    for (const action of ACTIONS) {
      expect(evaluateAcl("anonymous", action).allow).toBe(false);
      expect(evaluateAcl("none", action).allow).toBe(false);
    }
  });

  it("maps collaborator vocabulary onto ACL roles and denies unknown roles", () => {
    expect(collaboratorRoleToAclRole("owner")).toBe("owner");
    expect(collaboratorRoleToAclRole("editor")).toBe("admin");
    expect(collaboratorRoleToAclRole("viewer")).toBe("member");
    expect(collaboratorRoleToAclRole(undefined)).toBe("none");
    expect(collaboratorRoleToAclRole("superadmin")).toBe("none");
  });
});
