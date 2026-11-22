// megaui-only (FS-22, FSL-136, FSL-168): content authors carry the public profile across docs, comments,
// issues and CLs; the legacy rule projects the email prefix and `user.name`, never the email itself.
import { createDatabaseClient, type DatabaseClient } from "@megaui/database";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedMegaDatabase } from "../seed";
import { USERS } from "../testing/fixtures";
import { createClsService } from "./cls";
import { createAclService } from "./acl";
import { createBlocksRepo } from "./docs/blocks";
import { createLinksRepo } from "./docs/links";
import { createDocsService } from "./docs/docs";
import { createIssuesService } from "./issues";
import { fallbackPublicProfile, resolvePublicProfiles } from "./public-profile";

const EMPTY_BODY = "{\"root\":{\"children\":[]}}";
const AUTHOR_ID = USERS.tianjing.id;
const LEGACY_USER_ID = USERS.eleanor.id;

describe("content public profiles (FS-22, FSL-136)", () => {
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
    if (errors.length > 0) throw new AggregateError(errors, "FS-22 fixture teardown failed");
  }, 120_000);

  it("uses the same public profile across docs, comments, issues, and CLs", async () => {
    const docs = createDocsService(
      client.db,
      createAclService(client.db),
      createBlocksRepo(client.db),
      createLinksRepo(client.db),
    );
    const issues = createIssuesService(client.db);
    const cls = createClsService(client.db);

    const doc = await docs.createDoc({ title: "FS-22 profile doc", body: EMPTY_BODY }, AUTHOR_ID);
    const docComment = await docs.addDocComment(doc.id, "Profile comment", AUTHOR_ID);
    const issue = await issues.createIssue(
      { title: "FS-22 profile issue", packageId: "pkg_engine", priority: "P2" },
      AUTHOR_ID,
    );
    const issueComment = await issues.addIssueComment(issue.number, "Profile issue comment", AUTHOR_ID);
    const cl = await cls.createCL(
      { title: "FS-22 profile CL", packageId: "pkg_engine", branch: "fs22-profile" },
      AUTHOR_ID,
    );
    const clComment = await cls.addCLComment(cl.number, "Profile CL comment", AUTHOR_ID);

    const projections = [doc.author, docComment.author, issue.author, issueComment.author, cl.author, clComment.author];
    for (const projection of projections) {
      expect(projection.id).toBe(AUTHOR_ID);
      expect(projection.username).toBe(USERS.tianjing.username);
      expect(projection.displayName).toBe(USERS.tianjing.displayName);
      expect(JSON.stringify(projection)).not.toContain("@");
      expect(projection).not.toHaveProperty("email");
    }
    expect(new Set(projections.map(projection => JSON.stringify(projection))).size).toBe(1);
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
