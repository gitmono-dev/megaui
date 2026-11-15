// FS-02：企业身份表。
//
// A row binds one external identity triple (tenant key, app id, app scoped
// open id) to one local user id. The local user id is never replaced: every
// later record keeps referencing the original `user.id`.
//
// Two unique constraints carry the binding rules of ADR-FS-ENT-02:
//   - the external triple is unique, so an open id belongs to one identity;
//   - a local user id binds at most once per app and tenant, so one account
//     never carries two identities of the same app.
//
// The table callback uses the object form of the drizzle table extras, which
// is the form this drizzle version no longer deprecates.
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { user } from "./user";

export const enterpriseIdentity = pgTable(
  "enterprise_identity",
  {
    id: text("id").primaryKey(),
    /** The local user this identity belongs to. */
    localUserId: text("local_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tenantKey: text("tenant_key").notNull(),
    appId: text("app_id").notNull(),
    /** The app scoped open id; only it takes part in the primary binding. */
    openId: text("open_id").notNull(),
    /** The cross app union id, when the provider reports one. */
    unionId: text("union_id"),
    /** active, suspended or resigned. */
    status: text("status").notNull().default("active"),
    /** Incremented on every authoritative change of the identity. */
    identityVersion: integer("identity_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    externalTriple: uniqueIndex(
      "enterprise_identity_tenant_app_open_uidx",
    ).on(table.tenantKey, table.appId, table.openId),
    localBinding: uniqueIndex(
      "enterprise_identity_local_tenant_app_uidx",
    ).on(table.localUserId, table.tenantKey, table.appId),
  }),
);

export type EnterpriseIdentity = InferSelectModel<typeof enterpriseIdentity>;
export type NewEnterpriseIdentity = InferInsertModel<typeof enterpriseIdentity>;
