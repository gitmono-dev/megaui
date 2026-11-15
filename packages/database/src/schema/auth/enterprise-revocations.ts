// FS-42：user-revoke outbox。
//
// The outbox is the durable hand-off of a revocation to the processes that
// have to act on it. The idempotency key is the pair of the user and the
// auth epoch: a revocation of the same epoch is enqueued only once, while
// every later epoch is a new revocation.
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { user } from "./user";

/** The states of a revocation. */
export const ENTERPRISE_REVOCATION_STATES = ["pending", "delivered"] as const;
export type EnterpriseRevocationState = (typeof ENTERPRISE_REVOCATION_STATES)[number];

export const enterpriseRevocations = pgTable(
  "enterprise_revocations",
  {
    id: text("id").primaryKey(),
    /** The revoked user; the row disappears with the user. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The auth epoch of the revocation. */
    authEpoch: integer("auth_epoch").notNull(),
    /** The reason of the revocation, for the receiving process. */
    reason: text("reason").notNull(),
    /** The additional payload of the revocation. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    state: text("state").notNull().default("pending"),
    /** How often the revocation was delivered. */
    attempts: integer("attempts").notNull().default(0),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    // The idempotency key of a revocation: the user and its epoch.
    epoch: uniqueIndex("enterprise_revocations_user_epoch_uidx").on(
      table.userId,
      table.authEpoch,
    ),
    // The delivery query reads the pending revocations of a state.
    delivery: index("enterprise_revocations_delivery_idx").on(
      table.state,
      table.createdAt,
    ),
  }),
);

export type EnterpriseRevocation = InferSelectModel<typeof enterpriseRevocations>;
export type NewEnterpriseRevocation = InferInsertModel<typeof enterpriseRevocations>;
