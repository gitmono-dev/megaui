// PK-04 AC2: "四表 schema 与 better-auth 1.x 期望字段一致（类型测试）".
//
// Expected shapes below are better-auth's documented core schema
// (https://www.better-auth.com/docs/concepts/database) plus the `admin`
// plugin's additional fields (role/banned/banReason/banExpires on `user`,
// impersonatedBy on `session`) — see the diff notes in `./user.ts` and
// `./auth.ts` for why the SaaS/phone-number columns from upstream are absent.
import { getTableColumns } from "drizzle-orm";
import type { Table } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { account, session, user, verification } from "./index";
import type {
  Account,
  NewAccount,
  NewSession,
  NewUser,
  NewVerification,
  Session,
  User,
  Verification,
} from "./index";

interface ColumnShape {
  dataType: string;
  notNull: boolean;
}

function shapeOf(table: Table): Record<string, ColumnShape> {
  const columns = getTableColumns(table);
  return Object.fromEntries(
    Object.entries(columns).map(([key, column]) => [
      key,
      { dataType: column.dataType, notNull: column.notNull },
    ]),
  );
}

describe("auth schema matches better-auth 1.x expected fields (PK-04 AC2)", () => {
  it("user: exactly the better-auth core fields + admin-plugin fields", () => {
    const shape = shapeOf(user);
    expect(Object.keys(shape).sort()).toEqual(
      [
        "id",
        "name",
        "email",
        "emailVerified",
        "image",
        "createdAt",
        "updatedAt",
        "role",
        "banned",
        "banReason",
        "banExpires",
      ].sort(),
    );
    expect(shape).toMatchObject({
      id: { dataType: "string", notNull: true },
      name: { dataType: "string", notNull: true },
      email: { dataType: "string", notNull: true },
      emailVerified: { dataType: "boolean", notNull: true },
      image: { dataType: "string", notNull: false },
      createdAt: { dataType: "date", notNull: true },
      updatedAt: { dataType: "date", notNull: true },
      role: { dataType: "string", notNull: false },
      banned: { dataType: "boolean", notNull: false },
      banReason: { dataType: "string", notNull: false },
      banExpires: { dataType: "date", notNull: false },
    });
  });

  it("session: better-auth fields + enterprise server-only metadata", () => {
    const shape = shapeOf(session);
    expect(Object.keys(shape).sort()).toEqual(
      [
        "id",
        "expiresAt",
        "token",
        "createdAt",
        "updatedAt",
        "ipAddress",
        "userAgent",
        "userId",
        "enterpriseGrantId",
        "enterpriseIdentityId",
        "authEpoch",
        "authMethod",
        "impersonatedBy",
      ].sort(),
    );
    expect(shape).toMatchObject({
      id: { dataType: "string", notNull: true },
      expiresAt: { dataType: "date", notNull: true },
      token: { dataType: "string", notNull: true },
      createdAt: { dataType: "date", notNull: true },
      updatedAt: { dataType: "date", notNull: true },
      ipAddress: { dataType: "string", notNull: false },
      userAgent: { dataType: "string", notNull: false },
      userId: { dataType: "string", notNull: true },
      enterpriseGrantId: { dataType: "string", notNull: false },
      enterpriseIdentityId: { dataType: "string", notNull: false },
      authEpoch: { dataType: "number", notNull: false },
      authMethod: { dataType: "string", notNull: false },
      impersonatedBy: { dataType: "string", notNull: false },
    });
  });

  it("account: exactly the better-auth core fields (no plugin additions)", () => {
    const shape = shapeOf(account);
    expect(Object.keys(shape).sort()).toEqual(
      [
        "id",
        "accountId",
        "providerId",
        "userId",
        "accessToken",
        "refreshToken",
        "idToken",
        "accessTokenExpiresAt",
        "refreshTokenExpiresAt",
        "scope",
        "password",
        "createdAt",
        "updatedAt",
      ].sort(),
    );
    expect(shape).toMatchObject({
      id: { dataType: "string", notNull: true },
      accountId: { dataType: "string", notNull: true },
      providerId: { dataType: "string", notNull: true },
      userId: { dataType: "string", notNull: true },
      accessToken: { dataType: "string", notNull: false },
      refreshToken: { dataType: "string", notNull: false },
      idToken: { dataType: "string", notNull: false },
      accessTokenExpiresAt: { dataType: "date", notNull: false },
      refreshTokenExpiresAt: { dataType: "date", notNull: false },
      scope: { dataType: "string", notNull: false },
      password: { dataType: "string", notNull: false },
      createdAt: { dataType: "date", notNull: true },
      updatedAt: { dataType: "date", notNull: true },
    });
  });

  it("verification: exactly the better-auth core fields (no plugin additions)", () => {
    const shape = shapeOf(verification);
    expect(Object.keys(shape).sort()).toEqual(
      ["id", "identifier", "value", "expiresAt", "createdAt", "updatedAt"].sort(),
    );
    expect(shape).toMatchObject({
      id: { dataType: "string", notNull: true },
      identifier: { dataType: "string", notNull: true },
      value: { dataType: "string", notNull: true },
      expiresAt: { dataType: "date", notNull: true },
      createdAt: { dataType: "date", notNull: true },
      updatedAt: { dataType: "date", notNull: true },
    });
  });
});

// --- Compile-time type test (checked by `tsc --noEmit`, CMD-01) ---------
//
// `Equal`/`Expect` fail to compile (not just at runtime) if the inferred
// row types drift from better-auth's documented shape.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
  ? 1
  : 2
  ? true
  : false;
type Expect<T extends true> = T;

interface ExpectedUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
  role: string | null;
  banned: boolean | null;
  banReason: string | null;
  banExpires: Date | null;
}

interface ExpectedSession {
  id: string;
  expiresAt: Date;
  token: string;
  createdAt: Date;
  updatedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  userId: string;
  enterpriseGrantId: string | null;
  enterpriseIdentityId: string | null;
  authEpoch: number | null;
  authMethod: string | null;
  impersonatedBy: string | null;
}

interface ExpectedAccount {
  id: string;
  accountId: string;
  providerId: string;
  userId: string;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  scope: string | null;
  password: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ExpectedVerification {
  id: string;
  identifier: string;
  value: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

type _UserSelectMatchesBetterAuth = Expect<Equal<User, ExpectedUser>>;
type _SessionSelectMatchesBetterAuth = Expect<Equal<Session, ExpectedSession>>;
type _AccountSelectMatchesBetterAuth = Expect<Equal<Account, ExpectedAccount>>;
type _VerificationSelectMatchesBetterAuth = Expect<
  Equal<Verification, ExpectedVerification>
>;

// Insert models must accept the same required/optional split (defaulted
// columns like createdAt/updatedAt/banned stay optional on insert).
type _NewUserHasRequiredEmail = Expect<
  Equal<Pick<NewUser, "id" | "name" | "email" | "emailVerified">, {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
  }>
>;
type _NewSessionHasRequiredFields = Expect<
  Equal<Pick<NewSession, "id" | "expiresAt" | "token" | "userId">, {
    id: string;
    expiresAt: Date;
    token: string;
    userId: string;
  }>
>;
type _NewAccountHasRequiredFields = Expect<
  Equal<
    Pick<NewAccount, "id" | "accountId" | "providerId" | "userId">,
    { id: string; accountId: string; providerId: string; userId: string }
  >
>;
type _NewVerificationHasRequiredFields = Expect<
  Equal<
    Pick<NewVerification, "id" | "identifier" | "value" | "expiresAt">,
    { id: string; identifier: string; value: string; expiresAt: Date }
  >
>;
