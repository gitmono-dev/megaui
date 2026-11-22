// megaui-only (FS-23, FSL-136, FSL-168): social authors and members use public profiles, projected by the
// legacy rule from the email prefix and `user.name`, never the email itself.
import { createDatabaseClient, type DatabaseClient } from "@megaui/database";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedMegaDatabase } from "../seed";
import { USERS } from "../testing/fixtures";
import { createChatDomain } from "./chat";
import { createReleasesService } from "./releases";

const ALICE = USERS.tianjing.id;
const BOB = USERS.eleanor.id;
const BOB_PROFILE = { id: BOB, username: USERS.eleanor.username, displayName: USERS.eleanor.displayName };

/** A public profile carries no email. */
function expectNoEmail(projection: unknown): void {
  expect(JSON.stringify(projection)).not.toContain("@");
  expect(projection).not.toHaveProperty("email");
}

describe("social public profiles (FS-23, FSL-136)", () => {
  let isolated: IsolatedPostgres;
  let client: DatabaseClient;

  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    client = createDatabaseClient({ connectionString: isolated.databaseUrl });
    await seedMegaDatabase(client.db);
  }, 120_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await client?.close(); } catch (error) { errors.push(error); }
    try { await isolated?.destroy(); } catch (error) { errors.push(error); }
    if (errors.length > 0) throw new AggregateError(errors, "FS-23 fixture teardown failed");
  }, 120_000);

  it("keeps members, chat authors, releases, and DMs on separate public identities", async () => {
    const { chat, members } = createChatDomain(client.db);
    const releases = createReleasesService(client.db);
    const channel = await chat.createChannel(
      { name: "FS-23 social profile room", visibility: "private" },
      ALICE,
    );
    await chat.inviteChannelMember({ channelId: channel.id, userId: BOB, actorUserId: ALICE });

    const membersBefore = await members.listChannelMembers(channel.id, ALICE);
    expect(membersBefore.map((member) => member.userId)).toEqual([ALICE, BOB]);
    expect(membersBefore.map((member) => member.user.username)).toEqual([USERS.tianjing.username, USERS.eleanor.username]);
    expect(membersBefore.map((member) => member.user.displayName)).toEqual([
      USERS.tianjing.displayName,
      USERS.eleanor.displayName,
    ]);
    expect(membersBefore[0]?.user.id).not.toBe(membersBefore[1]?.user.id);
    for (const member of membersBefore) expectNoEmail(member.user);

    const message = await chat.sendChatMessage(
      { channelId: channel.id, segments: [{ type: "text", text: "FS-23 social message" }] },
      BOB,
    );
    const release = await releases.createDraftRelease(
      { tag: "v0.23.0-fs23", title: "FS-23 social release", targetSha: "fs23sha" },
      BOB,
    );
    for (const projection of [message.author, release.author]) {
      expect(projection).toMatchObject(BOB_PROFILE);
      expectNoEmail(projection);
    }

    const dm = await chat.openOrCreateDm(BOB, ALICE);
    expect(dm.participant).toMatchObject(BOB_PROFILE);
    expectNoEmail(dm.participant);

    const messagesAfter = await chat.listChatMessages(channel.id, ALICE);
    expect(messagesAfter.find((item) => item.id === message.id)?.author).toMatchObject(BOB_PROFILE);
    expect((await releases.getRelease(release.id)).author).toMatchObject(BOB_PROFILE);
  });
});
