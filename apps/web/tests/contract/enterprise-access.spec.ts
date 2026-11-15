// megaui-only (FS-15): the page/BFF actor contract shares one fail-closed gate.
import { describe, expect, it } from "vitest";

import { createAuth } from "@megaui/auth";
import type { EmailSender } from "@megaui/email";
import {
  createWebActorResolver,
  type EnterpriseSessionAuthority,
  type WebSessionSnapshot,
} from "@/lib/enterprise-session";

const email = {
  sendVerificationEmail: async () => ({ success: true as const }),
  sendResetPasswordEmail: async () => ({ success: true as const }),
} as unknown as EmailSender;

const snapshot: WebSessionSnapshot = {
  user: { id: "fs15-user" },
  session: { id: "fs15-session" },
};

const authority: EnterpriseSessionAuthority = {
  localUserId: "fs15-user",
  identityId: "fs15-identity",
  tenantKey: "tenant",
  appId: "app",
  authEpoch: 4,
  authMethod: "enterprise",
  enterpriseGrantId: "00000000-0000-4000-8000-000000000015",
  backendUsername: "fs15-backend-user",
};

function enterpriseResolver(
  overrides: Partial<Parameters<typeof createWebActorResolver>[0]> = {},
) {
  return createWebActorResolver({
    mode: "enterprise",
    readSession: async () => snapshot,
    readEnterpriseAuthority: async () => authority,
    qualifyEnterprise: async () => true,
    ...overrides,
  });
}

describe("Web enterprise access gate (FS-15)", () => {
  it("returns the same qualified actor for a page and a BFF-style lookup", async () => {
    const resolve = enterpriseResolver();
    const headers = new Headers({ cookie: "better-auth.session_token=opaque" });
    const pageActor = await resolve(headers);
    const bffActor = await resolve(headers);
    expect(pageActor).toEqual({
      kind: "enterprise",
      userId: "fs15-user",
      identityId: "fs15-identity",
      authEpoch: 4,
      backendUsername: "fs15-backend-user",
      sessionId: "fs15-session",
    });
    expect(bffActor).toEqual(pageActor);
  });

  it("rejects deactivated qualifications instead of treating user existence as access", async () => {
    const qualify = async () => false;
    await expect(enterpriseResolver({ qualifyEnterprise: qualify })(new Headers())).resolves.toBeNull();
  });

  it("passes the session epoch to the shared qualification port, so an old Cookie cannot bypass it", async () => {
    const epochs: number[] = [];
    const resolve = enterpriseResolver({
      qualifyEnterprise: async row => {
        epochs.push(row.authEpoch);
        return row.authEpoch === 5;
      },
    });
    await expect(resolve(new Headers())).resolves.toBeNull();
    expect(epochs).toEqual([4]);
  });

  it("fails closed when the authoritative database read is unavailable", async () => {
    const resolve = enterpriseResolver({
      readEnterpriseAuthority: async () => { throw new Error("database unavailable"); },
    });
    await expect(resolve(new Headers())).resolves.toBeNull();
  });

  it("keeps normal legacy sessions usable while maintenance has no business actor", async () => {
    const legacy = createWebActorResolver({ mode: "legacy", readSession: async () => snapshot });
    expect(await legacy(new Headers())).toEqual({ kind: "legacy", userId: "fs15-user", sessionId: "fs15-session" });
    const maintenance = createWebActorResolver({ mode: "maintenance", readSession: async () => snapshot });
    await expect(maintenance(new Headers())).resolves.toBeNull();
  });

  it("uses no Better Auth cookie cache or secondary session store", async () => {
    const auth = createAuth({
      appName: "fs15-contract",
      secret: "fs15-contract-secret-at-least-32-characters",
      baseURL: "http://localhost:3000",
      db: {} as never,
      email,
      nodeEnv: "test",
    });
    const context = await auth.$context;
    expect(context.options.session?.cookieCache?.enabled).toBe(false);
    expect(Reflect.get(context.options, "secondaryStorage")).toBeUndefined();
  });
});
