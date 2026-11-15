// megaui-only (FS-23): social authors and members use public profiles.
import { createDatabaseClient, type DatabaseClient } from "@megaui/database";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedMegaDatabase } from "../../seed";
import { USERS } from "../../testing/fixtures";
import { createChatDomain } from "../chat";
import { createReleasesService } from "../releases";

const ALICE = USERS.tianjing.id;
const BOB = USERS.eleanor.id;

describe("enterprise social public profiles (FS-23)", () => {
  let isolated: IsolatedPostgres;
  let client: DatabaseClient;

  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    client = createDatabaseClient({ connectionString: isolated.databaseUrl });
    await seedMegaDatabase(client.db);
    const now = new Date();
    await client.pool.query(
      `insert into enterprise_profile
         (user_id, tenant_key, login_name, backend_username, display_name, notification_email, created_at, updated_at)
       values
         ($1, 'fs23-tenant', 'directory.alice', 'mgu_fs23_alice', 'Directory Alice', 'shared@notify.test', $3, $3),
         ($2, 'fs23-tenant', 'directory.bob', 'mgu_fs23_bob', 'Directory Bob', 'shared@notify.test', $3, $3)`,
      [ALICE, BOB, now],
    );
    await client.pool.query(
      `insert into enterprise_identity
         (id, local_user_id, tenant_key, app_id, open_id, union_id, status, identity_version, created_at, updated_at)
       values ('fs23-bob-identity', $1, 'fs23-tenant', 'fs23-app', 'fs23-bob-open', 'fs23-bob-union', 'active', 1, $2, $2)`,
      [BOB, now],
    );
  }, 120_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await client?.close(); } catch (error) { errors.push(error); }
    try { await isolated?.destroy(); } catch (error) { errors.push(error); }
    if (errors.length > 0) throw new AggregateError(errors, "FS-23 fixture teardown failed");
  }, 120_000);

  it("keeps members, chat authors, releases, and suspended history on separate public identities", async () => {
    const { chat, members } = createChatDomain(client.db);
    const releases = createReleasesService(client.db);
    const channel = await chat.createChannel(
      { name: "FS-23 social profile room", visibility: "private" },
      ALICE,
    );
    await chat.inviteChannelMember({ channelId: channel.id, userId: BOB, actorUserId: ALICE });

    const membersBefore = await members.listChannelMembers(channel.id, ALICE);
    expect(membersBefore.map((member) => member.userId)).toEqual([ALICE, BOB]);
    expect(membersBefore.map((member) => member.user.username)).toEqual([
      "directory.alice",
      "directory.bob",
    ]);
    expect(membersBefore[0]?.user.id).not.toBe(membersBefore[1]?.user.id);

    const message = await chat.sendChatMessage(
      { channelId: channel.id, segments: [{ type: "text", text: "FS-23 social message" }] },
      BOB,
    );
    const release = await releases.createDraftRelease(
      { tag: "v0.23.0-fs23", title: "FS-23 social release", targetSha: "fs23sha" },
      BOB,
    );
    for (const projection of [message.author, release.author]) {
      expect(projection).toMatchObject({ id: BOB, username: "directory.bob", displayName: "Directory Bob" });
      expect(projection).not.toHaveProperty("email");
      expect(projection).not.toHaveProperty("notificationEmail");
      expect(projection).not.toHaveProperty("backendUsername");
    }

    const dm = await chat.openOrCreateDm(BOB, ALICE);
    expect(dm.participant).toMatchObject({ id: BOB, username: "directory.bob" });
    expect(dm.participant).not.toHaveProperty("email");

    await client.pool.query(
      `update enterprise_identity set status = 'suspended', identity_version = identity_version + 1 where local_user_id = $1`,
      [BOB],
    );
    const messagesAfterSuspension = await chat.listChatMessages(channel.id, ALICE);
    const suspendedMessage = messagesAfterSuspension.find((item) => item.id === message.id);
    expect(suspendedMessage?.author).toMatchObject({ id: BOB, username: "directory.bob", displayName: "Directory Bob" });
    const releaseAfterSuspension = await releases.getRelease(release.id);
    expect(releaseAfterSuspension.author).toMatchObject({ id: BOB, username: "directory.bob", displayName: "Directory Bob" });
    expect(releaseAfterSuspension.author).not.toHaveProperty("email");
  });
});
