import { describe, expect, it } from "vitest";
import { MegaForbiddenError, MegaUnauthorizedError } from "../../errors";
import type { AclRole, AclService } from "../acl";
import { createCollabAuthzService } from "./authz";

function fakeAclFor(role: AclRole): Pick<AclService, "resolveDocRole"> {
  return {
    resolveDocRole: async () => role,
  };
}

const DOC_ID = "doc_1";
const USER_ID = "usr_1";

describe("createCollabAuthzService (EG-13)", () => {
  it("mirrors the EG-02 role×action matrix for doc room read/write access", () => {
    const cases: Array<{
      role: AclRole;
      allow: boolean;
      readOnly: boolean;
      reason: string;
    }> = [
      { role: "anonymous", allow: false, readOnly: true, reason: "unauthenticated" },
      { role: "none", allow: false, readOnly: true, reason: "no_access" },
      { role: "member", allow: true, readOnly: true, reason: "read_only" },
      { role: "admin", allow: true, readOnly: false, reason: "editor" },
      { role: "owner", allow: true, readOnly: false, reason: "editor" },
    ];

    return Promise.all(
      cases.map(async ({ role, allow, readOnly, reason }) => {
        const authz = createCollabAuthzService(fakeAclFor(role));
        const access = await authz.resolveDocAccess(DOC_ID, USER_ID);
        expect(access, role).toEqual({ allow, readOnly, role, reason });
      }),
    );
  });

  it("assertCanJoin rejects unauthenticated with 401 and non-members with 403 (fail closed)", async () => {
    const anon = createCollabAuthzService(fakeAclFor("anonymous"));
    await expect(anon.assertCanJoin(DOC_ID, null)).rejects.toBeInstanceOf(
      MegaUnauthorizedError,
    );

    const none = createCollabAuthzService(fakeAclFor("none"));
    await expect(none.assertCanJoin(DOC_ID, USER_ID)).rejects.toBeInstanceOf(
      MegaForbiddenError,
    );
  });

  it("assertCanJoin resolves for member/admin/owner", async () => {
    for (const role of ["member", "admin", "owner"] as const) {
      const authz = createCollabAuthzService(fakeAclFor(role));
      await expect(authz.assertCanJoin(DOC_ID, USER_ID)).resolves.toMatchObject({
        allow: true,
        role,
      });
    }
  });

  it("EG-13 AC2: a member can join (mint succeeds elsewhere) but write is denied fail-closed", async () => {
    const authz = createCollabAuthzService(fakeAclFor("member"));
    await expect(authz.assertCanJoin(DOC_ID, USER_ID)).resolves.toMatchObject({
      allow: true,
      readOnly: true,
    });
    await expect(authz.assertCanWrite(DOC_ID, USER_ID)).rejects.toBeInstanceOf(
      MegaForbiddenError,
    );
  });

  it("assertCanWrite resolves for admin/owner and still fail-closed for anonymous/none", async () => {
    for (const role of ["admin", "owner"] as const) {
      const authz = createCollabAuthzService(fakeAclFor(role));
      await expect(authz.assertCanWrite(DOC_ID, USER_ID)).resolves.toMatchObject({
        allow: true,
        readOnly: false,
      });
    }

    const anon = createCollabAuthzService(fakeAclFor("anonymous"));
    await expect(anon.assertCanWrite(DOC_ID, null)).rejects.toBeInstanceOf(
      MegaUnauthorizedError,
    );

    const none = createCollabAuthzService(fakeAclFor("none"));
    await expect(none.assertCanWrite(DOC_ID, USER_ID)).rejects.toBeInstanceOf(
      MegaForbiddenError,
    );
  });
});
