// FS-43：管理员操作、批次 checkpoint 与 quarantine 账本。
//
// The administrative CLI writes its decisions into the database, so a run
// stays recoverable and attributable: the operation is deduplicated by its
// operation id, every batch carries the manifest digest it belongs to, and
// a quarantine is a persistent user state instead of a note in a log.
//
// The audit keeps the versions the operator expected, but it never keeps a
// verification code: the schema has no column for one.
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

/** The states of an administrative operation. */
export const ENTERPRISE_OPERATION_STATES = [
  "pending",
  "running",
  "completed",
  "failed",
] as const;
export type EnterpriseOperationState = (typeof ENTERPRISE_OPERATION_STATES)[number];

/** The states of a quarantined user. */
export const ENTERPRISE_QUARANTINE_STATES = ["quarantined", "released"] as const;
export type EnterpriseQuarantineState = (typeof ENTERPRISE_QUARANTINE_STATES)[number];

/**
 * The ledger of the administrative operations.
 *
 * The operation id is the idempotency key of the run: a replay of the same
 * operation returns the recorded result instead of writing again.
 */
export const enterpriseAdminOperations = pgTable(
  "enterprise_admin_operations",
  {
    id: text("id").primaryKey(),
    /** The idempotency key of the operation. */
    operationId: text("operation_id").notNull(),
    /** The verb of the operation, for example provision or activate. */
    verb: text("verb").notNull(),
    /** The digest of the manifest the operation was approved for. */
    manifestDigest: text("manifest_digest").notNull(),
    /** The versions the operator expected to change. */
    expectedUserVersion: integer("expected_user_version"),
    expectedIdentityVersion: integer("expected_identity_version"),
    /** The state of the operation. */
    state: text("state").notNull().default("pending"),
    /** The counts of the operation, never the content of a verification code. */
    result: jsonb("result").$type<Record<string, unknown>>().notNull().default({}),
    /** How often the operation was replayed. */
    attempts: integer("attempts").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    operation: uniqueIndex("enterprise_admin_operations_operation_id_uidx").on(
      table.operationId,
    ),
    state: index("enterprise_admin_operations_state_idx").on(table.state),
  }),
);

/**
 * The checkpoints of a batch run.
 *
 * Every checkpoint is bound to the manifest digest of its operation, so a
 * resumed run cannot continue with a manifest that was not approved.
 */
export const enterpriseBatchCheckpoints = pgTable(
  "enterprise_batch_checkpoints",
  {
    id: text("id").primaryKey(),
    /** The operation the checkpoint belongs to. */
    operationId: text("operation_id").notNull(),
    /** The digest of the manifest the checkpoint belongs to. */
    manifestDigest: text("manifest_digest").notNull(),
    /** The number of the batch. */
    batchNumber: integer("batch_number").notNull(),
    /** How many rows the batch processed. */
    processed: integer("processed").notNull().default(0),
    /** The moment the batch was finished. */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    batch: uniqueIndex("enterprise_batch_checkpoints_operation_batch_uidx").on(
      table.operationId,
      table.batchNumber,
    ),
    digest: index("enterprise_batch_checkpoints_digest_idx").on(table.manifestDigest),
  }),
);

/**
 * The quarantine of a user.
 *
 * A quarantine is a persistent state of the user, not a transient flag of a
 * run: a conflicting or empty actor keeps it until an operator releases it.
 */
export const enterpriseQuarantine = pgTable(
  "enterprise_quarantine",
  {
    id: text("id").primaryKey(),
    /** The quarantined user; the row disappears with the user. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The reason of the quarantine. */
    reason: text("reason").notNull(),
    /** The state of the quarantine. */
    state: text("state").notNull().default("quarantined"),
    /** The operation that caused the quarantine. */
    operationId: text("operation_id"),
    /** The digest of the manifest the quarantine belongs to. */
    manifestDigest: text("manifest_digest"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    user: uniqueIndex("enterprise_quarantine_user_id_uidx").on(table.userId),
    state: index("enterprise_quarantine_state_idx").on(table.state),
  }),
);

export type EnterpriseAdminOperation = InferSelectModel<typeof enterpriseAdminOperations>;
export type NewEnterpriseAdminOperation = InferInsertModel<typeof enterpriseAdminOperations>;
export type EnterpriseBatchCheckpoint = InferSelectModel<typeof enterpriseBatchCheckpoints>;
export type NewEnterpriseBatchCheckpoint = InferInsertModel<typeof enterpriseBatchCheckpoints>;
export type EnterpriseQuarantine = InferSelectModel<typeof enterpriseQuarantine>;
export type NewEnterpriseQuarantine = InferInsertModel<typeof enterpriseQuarantine>;
