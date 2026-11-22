// megaui-only (FSL-153, FSL-136): Feishu users' public identity is the opaque user ID and never their login
// email; other users follow the legacy rule.
import { createHash } from "node:crypto";
import type { User } from "@megaui/core";
import { createDatabaseClient, type DatabaseClient } from "@megaui/database";
import { createIsolatedPostgres, type IsolatedPostgres } from "@megaui/database/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedMegaDatabase } from "../seed";
import { createIssuesService } from "./issues";
import { resolvePublicProfiles } from "./public-profile";

const APP_ID = "cli_fsl153_app";
const OTHER_APP_ID = "cli_fsl153_other_app";
const AVATAR = "#64748b";

type Seed = { id: string; name: string; email: string; image?: string };

// Feishu-bound users, one per name rule case.
const UNRELATED: Seed = { id: "fsl153FeishuUnrelated", name: "王小明", email: "wang.xiaoming@corp.example" };
const NAME_IS_EMAIL: Seed = { id: "fsl153FeishuNameIsEmail", name: "Li.Lei@Corp.Example", email: "li.lei@corp.example" };
const NAME_HAS_LOCAL: Seed = { id: "fsl153FeishuNameHasLocal", name: "Zhang.San Ops", email: "zhang.san@corp.example" };
const NAME_HAS_DOMAIN: Seed = {
  id: "fsl153FeishuNameHasDomain",
  name: "Corp Example Team",
  email: "zhao.liu@corp.example",
  image: "https://img.example/feishu.png",
};
const NAME_HAS_LOCAL_FRAGMENT: Seed = { id: "fsl153FeishuLocalFragment", name: "Chen Qi", email: "chen.qi@corp.example" };
// The user ID happens to contain the local part of the login email.
const ID_HAS_LOCAL: Seed = { id: "fsl153sunmeiAccount", name: "孙梅", email: "sunmei@corp.example" };
// The kept name's initials spell the whole (short) local part.
const INITIALS_SPELL_LOCAL: Seed = { id: "fsl153FeishuInitials", name: "Alice Brown", email: "ab@corp.example" };
// The local part equals the initials `U` of a name without words.
const LOCAL_IS_U: Seed = { id: "fsl153FeishuLocalU", name: "", email: "u@corp.example" };
// The local part is contained in the default avatar color.
const LOCAL_IN_COLOR: Seed = { id: "fsl153FeishuLocalColor", name: "Gao Ming", email: "647@corp.example" };
// A one-letter local part that the user ID starts with: the name contains it, so the
// display name is the ID and its initial is part of the ID.
const LOCAL_IS_ID_INITIAL: Seed = { id: "fsl153FeishuIdInitial", name: "Fang Hua", email: "f@corp.example" };
// Surrounding whitespace is kept as stored.
const PADDED_NAME: Seed = { id: "fsl153FeishuPadded", name: " Ma Li ", email: "maria@corp.example" };
// The directory may return an empty name; it is kept as stored.
const EMPTY_NAME: Seed = { id: "fsl153FeishuEmptyName", name: "", email: "liu.wei@corp.example" };

const LEGACY: Seed = {
  id: "fsl153Legacy",
  name: "Legacy Person",
  email: "legacy.person@corp.example",
  image: "https://img.example/legacy.png",
};

const FEISHU_USERS = [
  UNRELATED,
  NAME_IS_EMAIL,
  NAME_HAS_LOCAL,
  NAME_HAS_DOMAIN,
  NAME_HAS_LOCAL_FRAGMENT,
  ID_HAS_LOCAL,
  INITIALS_SPELL_LOCAL,
  LOCAL_IS_U,
  LOCAL_IN_COLOR,
  LOCAL_IS_ID_INITIAL,
  PADDED_NAME,
  EMPTY_NAME,
];

function openIdHmac(label: string): string {
  return createHash("sha256").update(`fsl153:${label}`).digest("hex");
}

/** Every public field other than the user ID itself is free of `@` and of the complete local part. */
function expectNoLoginEmail(row: User, seed: Seed): void {
  const localPart = seed.email.slice(0, seed.email.lastIndexOf("@")).toLowerCase();
  expect(row).not.toHaveProperty("avatarUrl");
  expect(row).not.toHaveProperty("email");
  for (const [field, value] of Object.entries(row)) {
    if (typeof value !== "string" || value === seed.id) continue;
    expect(value, field).not.toContain("@");
    expect(value.toLowerCase(), field).not.toContain(localPart);
  }
}

describe("Feishu user public profiles (FSL-153)", () => {
  let isolated: IsolatedPostgres;
  let client: DatabaseClient;
  let profiles: Map<string, User>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    client = createDatabaseClient({ connectionString: isolated.databaseUrl });
    await seedMegaDatabase(client.db);
    for (const seed of [...FEISHU_USERS, LEGACY]) {
      await client.pool.query(
        `insert into "user" (id, name, email, email_verified, image, role)
         values ($1, $2, $3, true, $4, 'user')`,
        [seed.id, seed.name, seed.email, seed.image ?? null],
      );
    }
    for (const seed of FEISHU_USERS) {
      await client.pool.query(
        "insert into feishu_identities (app_id, open_id_hmac, user_id) values ($1, $2, $3)",
        [APP_ID, openIdHmac(seed.id), seed.id],
      );
    }
    // A second binding in another app must not duplicate or change the projection.
    await client.pool.query(
      "insert into feishu_identities (app_id, open_id_hmac, user_id) values ($1, $2, $3)",
      [OTHER_APP_ID, openIdHmac(`${UNRELATED.id}:other`), UNRELATED.id],
    );
    profiles = await resolvePublicProfiles(
      client.db,
      [...FEISHU_USERS, LEGACY].map(seed => seed.id),
    );
  }, 120_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await client?.close(); } catch (error) { errors.push(error); }
    try { await isolated?.destroy(); } catch (error) { errors.push(error); }
    if (errors.length > 0) throw new AggregateError(errors, "FSL-153 fixture teardown failed");
  }, 120_000);

  it("uses the user ID as username and keeps a name unrelated to the login email", () => {
    const row = profiles.get(UNRELATED.id);
    expect(row).toEqual({
      id: UNRELATED.id,
      username: UNRELATED.id,
      displayName: "王小明",
      avatarInitials: "王",
      avatarColor: AVATAR,
    });
    expectNoLoginEmail(row!, UNRELATED);
  });

  it("falls back to the user ID when the name contains @", () => {
    const row = profiles.get(NAME_IS_EMAIL.id);
    expect(row).toEqual({
      id: NAME_IS_EMAIL.id,
      username: NAME_IS_EMAIL.id,
      displayName: NAME_IS_EMAIL.id,
      avatarInitials: "F",
      avatarColor: AVATAR,
    });
    expectNoLoginEmail(row!, NAME_IS_EMAIL);
  });

  it("falls back to the user ID when the name contains the complete local part in another case", () => {
    const row = profiles.get(NAME_HAS_LOCAL.id);
    expect(row).toEqual({
      id: NAME_HAS_LOCAL.id,
      username: NAME_HAS_LOCAL.id,
      displayName: NAME_HAS_LOCAL.id,
      avatarInitials: "F",
      avatarColor: AVATAR,
    });
    expectNoLoginEmail(row!, NAME_HAS_LOCAL);
  });

  it("keeps a name that only contains a fragment of the domain, and never exposes user.image", () => {
    const row = profiles.get(NAME_HAS_DOMAIN.id);
    expect(row).toEqual({
      id: NAME_HAS_DOMAIN.id,
      username: NAME_HAS_DOMAIN.id,
      displayName: "Corp Example Team",
      avatarInitials: "CE",
      avatarColor: AVATAR,
    });
    expectNoLoginEmail(row!, NAME_HAS_DOMAIN);
  });

  it("keeps a name that only contains fragments of the local part", () => {
    const row = profiles.get(NAME_HAS_LOCAL_FRAGMENT.id);
    expect(row).toEqual({
      id: NAME_HAS_LOCAL_FRAGMENT.id,
      username: NAME_HAS_LOCAL_FRAGMENT.id,
      displayName: "Chen Qi",
      avatarInitials: "CQ",
      avatarColor: AVATAR,
    });
    expectNoLoginEmail(row!, NAME_HAS_LOCAL_FRAGMENT);
  });

  it("keeps the user ID as username when the ID happens to contain the local part", () => {
    const row = profiles.get(ID_HAS_LOCAL.id);
    expect(ID_HAS_LOCAL.id).toContain("sunmei");
    expect(row).toEqual({
      id: ID_HAS_LOCAL.id,
      username: ID_HAS_LOCAL.id,
      displayName: "孙梅",
      avatarInitials: "孙",
      avatarColor: AVATAR,
    });
    expectNoLoginEmail(row!, ID_HAS_LOCAL);
  });

  it("shrinks initials that spell the complete local part to the first initial and keeps the name", () => {
    const row = profiles.get(INITIALS_SPELL_LOCAL.id);
    expect(row).toEqual({
      id: INITIALS_SPELL_LOCAL.id,
      username: INITIALS_SPELL_LOCAL.id,
      displayName: "Alice Brown",
      avatarInitials: "A",
      avatarColor: AVATAR,
    });
    expectNoLoginEmail(row!, INITIALS_SPELL_LOCAL);
  });

  it("drops the U initials of an empty name and moves the avatar color when they contain the local part", () => {
    expect(profiles.get(LOCAL_IS_U.id)).toEqual({
      id: LOCAL_IS_U.id,
      username: LOCAL_IS_U.id,
      displayName: "",
      avatarInitials: "",
      avatarColor: AVATAR,
    });
    expectNoLoginEmail(profiles.get(LOCAL_IS_U.id)!, LOCAL_IS_U);
    expect(profiles.get(LOCAL_IN_COLOR.id)).toEqual({
      id: LOCAL_IN_COLOR.id,
      username: LOCAL_IN_COLOR.id,
      displayName: "Gao Ming",
      avatarInitials: "GM",
      avatarColor: "#525252",
    });
    expectNoLoginEmail(profiles.get(LOCAL_IN_COLOR.id)!, LOCAL_IN_COLOR);
  });

  it("keeps the ID initial when the display name is the ID and the local part is that letter", () => {
    expect(profiles.get(LOCAL_IS_ID_INITIAL.id)).toEqual({
      id: LOCAL_IS_ID_INITIAL.id,
      username: LOCAL_IS_ID_INITIAL.id,
      displayName: LOCAL_IS_ID_INITIAL.id,
      avatarInitials: "F",
      avatarColor: AVATAR,
    });
  });

  it("keeps user.name exactly as stored, including surrounding whitespace and the empty name", () => {
    expect(profiles.get(PADDED_NAME.id)).toEqual({
      id: PADDED_NAME.id,
      username: PADDED_NAME.id,
      displayName: " Ma Li ",
      avatarInitials: "ML",
      avatarColor: AVATAR,
    });
    expectNoLoginEmail(profiles.get(PADDED_NAME.id)!, PADDED_NAME);
    expect(profiles.get(EMPTY_NAME.id)).toEqual({
      id: EMPTY_NAME.id,
      username: EMPTY_NAME.id,
      displayName: "",
      avatarInitials: "U",
      avatarColor: AVATAR,
    });
    expectNoLoginEmail(profiles.get(EMPTY_NAME.id)!, EMPTY_NAME);
  });

  it("keeps the legacy projection: email prefix username, user.name and user.image", () => {
    expect(profiles.get(LEGACY.id)).toEqual({
      id: LEGACY.id,
      username: "legacy.person",
      displayName: "Legacy Person",
      avatarUrl: LEGACY.image,
      avatarInitials: "LP",
      avatarColor: AVATAR,
    });
  });

  it("returns one row per requested user in input order", () => {
    expect([...profiles.keys()]).toEqual([...FEISHU_USERS, LEGACY].map(seed => seed.id));
  });

  it("serves the same projection through a shared service", async () => {
    const issues = createIssuesService(client.db);
    const issue = await issues.createIssue(
      { title: "FSL-153 Feishu author", packageId: "pkg_engine", priority: "P2" },
      NAME_HAS_LOCAL.id,
    );
    expect(issue.author).toEqual(profiles.get(NAME_HAS_LOCAL.id));
    expectNoLoginEmail(issue.author, NAME_HAS_LOCAL);
  });
});
