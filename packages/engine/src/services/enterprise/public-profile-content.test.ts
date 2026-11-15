// megaui-only (FS-22): content authors use the durable enterprise profile.
import { createDatabaseClient, type DatabaseClient } from "@megaui/database";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedMegaDatabase } from "../../seed";
import { USERS } from "../../testing/fixtures";
import { createClsService } from "../cls";
import { createAclService } from "../acl";
import { createBlocksRepo } from "../docs/blocks";
import { createLinksRepo } from "../docs/links";
import { createDocsService } from "../docs/docs";
import { createIssuesService } from "../issues";
import { fallbackPublicProfile, resolvePublicProfiles } from "./public-profile";

const EMPTY_BODY = "{\"root\":{\"children\":[]}}";
const ENTERPRISE_USER_ID = USERS.tianjing.id;
const LEGACY_USER_ID = USERS.eleanor.id;

describe("enterprise content public profiles (FS-22)", () => {
  let isolated: IsolatedPostgres;
  let client: DatabaseClient;

  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    client = createDatabaseClient({ connectionString: isolated.databaseUrl });
    await seedMegaDatabase(client.db);
    await client.pool.query(
      `insert into enterprise_profile
         (user_id, tenant_key, login_name, backend_username, display_name, notification_email)
       values ($1, 'fs22-tenant', 'directory.alice', 'mgu_fs22_alice', 'Directory Alice', 'alice@notify.test')`,
      [ENTERPRISE_USER_ID],
    );
  }, 120_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await client?.close(); } catch (error) { errors.push(error); }
    try { await isolated?.destroy(); } catch (error) { errors.push(error); }
    if (errors.length > 0) throw new AggregateError(errors, "FS-22 fixture teardown failed");
  }, 120_000);

  it("uses login_name across docs, comments, issues, and CLs without exposing compatibility email", async () => {
    const docs = createDocsService(
      client.db,
      createAclService(client.db),
      createBlocksRepo(client.db),
      createLinksRepo(client.db),
    );
    const issues = createIssuesService(client.db);
    const cls = createClsService(client.db);

    const doc = await docs.createDoc({ title: "FS-22 profile doc", body: EMPTY_BODY }, ENTERPRISE_USER_ID);
    const docComment = await docs.addDocComment(doc.id, "Profile comment", ENTERPRISE_USER_ID);
    const issue = await issues.createIssue(
      { title: "FS-22 profile issue", packageId: "pkg_engine", priority: "P2" },
      ENTERPRISE_USER_ID,
    );
    const issueComment = await issues.addIssueComment(issue.number, "Profile issue comment", ENTERPRISE_USER_ID);
    const cl = await cls.createCL(
      { title: "FS-22 profile CL", packageId: "pkg_engine", branch: "fs22-profile" },
      ENTERPRISE_USER_ID,
    );
    const clComment = await cls.addCLComment(cl.number, "Profile CL comment", ENTERPRISE_USER_ID);

    const projections = [doc.author, docComment.author, issue.author, issueComment.author, cl.author, clComment.author];
    for (const projection of projections) {
      expect(projection.id).toBe(ENTERPRISE_USER_ID);
      expect(projection.username).toBe("directory.alice");
      expect(projection.displayName).toBe("Directory Alice");
      expect(projection).not.toHaveProperty("email");
      expect(projection).not.toHaveProperty("notificationEmail");
      expect(projection).not.toHaveProperty("backendUsername");
    }
  });

  it("keeps author identity stable when notification or display data changes", async () => {
    const docs = createDocsService(
      client.db,
      createAclService(client.db),
      createBlocksRepo(client.db),
      createLinksRepo(client.db),
    );
    const created = await docs.createDoc({ title: "FS-22 stable author", body: EMPTY_BODY }, ENTERPRISE_USER_ID);
    const before = await docs.getDoc(created.id, ENTERPRISE_USER_ID);

    await client.pool.query(
      `update enterprise_profile
          set notification_email = 'replacement@notify.test', display_name = 'Renamed Alice'
        where user_id = $1`,
      [ENTERPRISE_USER_ID],
    );
    const after = await docs.getDoc(created.id, ENTERPRISE_USER_ID);

    expect(after.author.id).toBe(before.author.id);
    expect(after.author.username).toBe(before.author.username);
    expect(after.author.displayName).toBe("Renamed Alice");
    expect(after.id).toBe(before.id);
  });

  it("preserves legacy display fallback and unknown historical author ids", async () => {
    const legacy = (await resolvePublicProfiles(client.db, [LEGACY_USER_ID])).get(LEGACY_USER_ID);
    expect(legacy).toMatchObject({ id: LEGACY_USER_ID, username: "eleanor", displayName: USERS.eleanor.displayName });
    expect(legacy).not.toHaveProperty("email");

    const unknown = fallbackPublicProfile("historical-user-id");
    expect(unknown).toEqual({
      id: "historical-user-id",
      username: "historical-user-id",
      displayName: "historical-user-id",
      avatarInitials: "U",
      avatarColor: "#64748b",
    });
  });
});
