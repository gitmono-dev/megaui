// FS-02：企业资料表。
//
// The profile is the material projection of a user for the enterprise
// identity: the alias an administrator assigns, the immutable internal name
// and the notification address.
//
// The two names have different scopes and different rules:
//   - `login_name` is the human alias, unique inside the tenant. It is never
//     derived from an email address or a display name.
//   - `backend_username` is the immutable internal name, unique inside the
//     instance. It is derived from the local user id and never changes.
//
// `notification_email` is a separate column, nullable, and it takes part in
// no unique constraint: the same address may notify several identities and
// it never becomes part of the identity.
import { sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import {
  check,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { user } from "./user";

export const enterpriseProfile = pgTable(
  "enterprise_profile",
  {
    /** The local user this profile belongs to; the profile never outlives it. */
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    tenantKey: text("tenant_key").notNull(),
    /** The administrator assigned alias, unique inside the tenant. */
    loginName: text("login_name").notNull(),
    /** The immutable internal name, unique inside the instance. */
    backendUsername: text("backend_username").notNull(),
    displayName: text("display_name"),
    /** The notification address; it never takes part in a unique constraint. */
    notificationEmail: text("notification_email"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    loginNameInTenant: uniqueIndex("enterprise_profile_tenant_login_name_uidx").on(
      table.tenantKey,
      table.loginName,
    ),
    backendUsernameInInstance: uniqueIndex(
      "enterprise_profile_backend_username_uidx",
    ).on(table.backendUsername),
    // The alias is an ASCII lower case name, assigned by an administrator.
    loginNameFormat: check(
      "enterprise_profile_login_name_format_check",
      sql`${table.loginName} ~ '^[a-z0-9][a-z0-9._-]{2,63}$'`,
    ),
  }),
);

export type EnterpriseProfile = InferSelectModel<typeof enterpriseProfile>;
export type NewEnterpriseProfile = InferInsertModel<typeof enterpriseProfile>;
