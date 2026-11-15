import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabaseClient, megaDocCollaboratorRoles, megaDocCollaborators } from "@megaui/database";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MegaBadRequestError, MegaForbiddenError, MegaUnauthorizedError } from "../errors";
import { seedMegaDatabase } from "../seed";
import { SAMPLE_DOC, USERS } from "../testing/fixtures";
import { createAclService } from "./acl";
import { createMembersService, dmChannelId } from "./members";

describe("dmChannelId (EG-02)", () => {
  it("is order-independent and collision-free for underscore-containing ids", () => {
    expect(dmChannelId("usr_a", "usr_b")).toBe(dmChannelId("usr_b", "usr_a"));
    expect(dmChannelId("usr_a", "usr_b_usr_c")).not.toBe(
      dmChannelId("usr_a_usr_b", "usr_c"),
    );
    expect(dmChannelId("usr_a", "usr_b")).toMatch(/^dm_[0-9a-f]{64}$/);
  });
});

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, "../../../database/drizzle");
const adminDatabaseUrl = process.env.DATABASE_URL;

if (!adminDatabaseUrl) {
  if (process.env.CI === "true") {
    throw new Error(
      "[@megaui/engine] members.test.ts: DATABASE_URL is required in CI.",
    );
  }
  console.warn(
    "[@megaui/engine] members.test.ts: DATABASE_URL is unset — skipping PG ACL/members suite.",
  );
}

function oneShotDatabaseUrl(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

describe.skipIf(!adminDatabaseUrl)("doc ACL + channel members (EG-02, throwaway PG)", () => {
  const testDbName = `megaui_test_acl_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  let adminPool: Pool;
  let connectionString: string;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminDatabaseUrl });
    await adminPool.query(`CREATE DATABASE "${testDbName}"`);
    connectionString = oneShotDatabaseUrl(adminDatabaseUrl!, testDbName);
    const migratePool = new Pool({ connectionString });
    const client = createDatabaseClient({ connectionString });
    try {
      await migrate(drizzle(migratePool), { migrationsFolder });
      await seedMegaDatabase(client.db);
    } finally {
      await client.close();
      await migratePool.end();
    }
  });

  afterAll(async () => {
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [testDbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
    await adminPool.end();
  });

  it("defaults workspace docs to read/write and honors explicit collaborator roles", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const acl = createAclService(client.db);
      expect(await acl.resolveDocRole(SAMPLE_DOC.id, null)).toBe("anonymous");
      expect(await acl.resolveDocRole(SAMPLE_DOC.id, USERS.tianjing.id)).toBe("owner");
      expect(await acl.resolveDocRole(SAMPLE_DOC.id, USERS.eleanor.id)).toBe("admin");
      expect(await acl.resolveDocRole(SAMPLE_DOC.id, USERS.rafael.id)).toBe("admin");

      expect((await acl.canRead(SAMPLE_DOC.id, USERS.rafael.id)).allow).toBe(true);
      expect((await acl.canWrite(SAMPLE_DOC.id, USERS.eleanor.id)).allow).toBe(true);
      expect((await acl.canManage(SAMPLE_DOC.id, USERS.eleanor.id)).allow).toBe(false);
      expect((await acl.canManage(SAMPLE_DOC.id, USERS.tianjing.id)).allow).toBe(true);

      await expect(acl.assert(SAMPLE_DOC.id, null, "read")).rejects.toBeInstanceOf(
        MegaUnauthorizedError,
      );
      await expect(acl.assert(SAMPLE_DOC.id, USERS.rafael.id, "read")).resolves.toBeUndefined();

      await client.db.insert(megaDocCollaborators).values({
        id: `collab_${SAMPLE_DOC.id}_${USERS.rafael.id}`,
        docId: SAMPLE_DOC.id,
        userId: USERS.rafael.id,
        role: megaDocCollaboratorRoles.VIEWER,
      });
      expect(await acl.resolveDocRole(SAMPLE_DOC.id, USERS.rafael.id)).toBe("member");
      expect((await acl.canRead(SAMPLE_DOC.id, USERS.rafael.id)).allow).toBe(true);
      expect((await acl.canWrite(SAMPLE_DOC.id, USERS.rafael.id)).allow).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("lists/invites/removes channel members and blocks duplicate invite + last admin", async () => {
    const client = createDatabaseClient({ connectionString });
    try {
      const members = createMembersService(client.db);
      const channel = await members.createChannel(
        { name: "secret-room", visibility: "private" },
        USERS.tianjing.id,
      );

      expect(
        await members.canAccessChannel(channel.id, USERS.tianjing.id),
      ).toEqual({ allow: true, reason: "member" });
      expect(
        await members.canAccessChannel(channel.id, USERS.rafael.id),
      ).toEqual({ allow: false, reason: "not_member" });
      expect((await members.canAccessChannel(channel.id, null)).allow).toBe(false);

      const listed = await members.listChannelMembers(channel.id, USERS.tianjing.id);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.role).toBe("admin");

      const invited = await members.inviteChannelMember({
        channelId: channel.id,
        userId: USERS.rafael.id,
        actorUserId: USERS.tianjing.id,
      });
      expect(invited.userId).toBe(USERS.rafael.id);
      expect(await members.canAccessChannel(channel.id, USERS.rafael.id)).toEqual({
        allow: true,
        reason: "member",
      });

      await expect(
        members.inviteChannelMember({
          channelId: channel.id,
          userId: USERS.rafael.id,
          actorUserId: USERS.tianjing.id,
        }),
      ).rejects.toBeInstanceOf(MegaBadRequestError);

      await expect(
        members.inviteChannelMember({
          channelId: channel.id,
          userId: USERS.eleanor.id,
          actorUserId: USERS.rafael.id,
        }),
      ).rejects.toBeInstanceOf(MegaForbiddenError);

      await expect(
        members.listChannelMembers(channel.id, null),
      ).rejects.toBeInstanceOf(MegaUnauthorizedError);

      await expect(
        members.removeChannelMember(channel.id, USERS.tianjing.id, USERS.tianjing.id),
      ).rejects.toBeInstanceOf(MegaBadRequestError);

      await members.removeChannelMember(
        channel.id,
        USERS.rafael.id,
        USERS.tianjing.id,
      );
      expect((await members.canAccessChannel(channel.id, USERS.rafael.id)).allow).toBe(
        false,
      );

      const pub = await members.createChannel(
        { name: "town-square", visibility: "public" },
        USERS.tianjing.id,
      );
      expect(await members.canAccessChannel(pub.id, USERS.rafael.id)).toEqual({
        allow: true,
        reason: "public_workspace",
      });
      expect(await members.canAccessChannel(pub.id, null)).toEqual({
        allow: false,
        reason: "unauthenticated",
      });

      const dmFirst = await members.openOrCreateDm(
        USERS.rafael.id,
        USERS.tianjing.id,
      );
      const dmSecond = await members.openOrCreateDm(
        USERS.tianjing.id,
        USERS.rafael.id,
      );
      expect(dmFirst.id).toBe(dmChannelId(USERS.tianjing.id, USERS.rafael.id));
      expect(dmSecond.id).toBe(dmFirst.id);
      expect(await members.canAccessChannel(dmFirst.id, USERS.eleanor.id)).toEqual({
        allow: false,
        reason: "not_member",
      });
    } finally {
      await client.close();
    }
  });
});
