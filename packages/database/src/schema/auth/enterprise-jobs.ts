// FS-42：通用 leased job 队列。
//
// A job is a durable row, never an in-memory task. A worker claims it with
// `FOR UPDATE SKIP LOCKED` on the claim index, holds it until `lease_until`
// and marks it done; a job whose lease expired becomes claimable again.
//
// The dedupe key is unique, so the same work is enqueued only once. The
// completed jobs carry their completion time, so they can be cleaned up by
// TTL with the cleanup index.
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

/** The states a job passes through. */
export const ENTERPRISE_JOB_STATES = ["pending", "leased", "done"] as const;
export type EnterpriseJobState = (typeof ENTERPRISE_JOB_STATES)[number];

export const enterpriseJobs = pgTable(
  "enterprise_jobs",
  {
    id: text("id").primaryKey(),
    /** The queue the job belongs to. */
    queue: text("queue").notNull(),
    /** The idempotency key of the job; it is unique. */
    dedupeKey: text("dedupe_key").notNull(),
    /** The job payload. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    state: text("state").notNull().default("pending"),
    /** The worker that holds the lease of the job. */
    claimOwner: text("claim_owner"),
    /** The moment the lease expires; the job becomes claimable again. */
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    /** The moment the job may be claimed; it carries the retry backoff. */
    availableAt: timestamp("available_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** How often the job was claimed. */
    attempts: integer("attempts").notNull().default(0),
    /** The moment the job was completed; it drives the TTL cleanup. */
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
    dedupe: uniqueIndex("enterprise_jobs_dedupe_key_uidx").on(table.dedupeKey),
    // The claim query filters on the queue and the state and orders by the
    // moment the job becomes available, so a bounded `FOR UPDATE SKIP LOCKED`
    // uses this index.
    claim: index("enterprise_jobs_claim_idx").on(
      table.queue,
      table.state,
      table.availableAt,
    ),
    // The cleanup of the completed jobs walks the completion time.
    cleanup: index("enterprise_jobs_completed_at_idx").on(table.completedAt),
  }),
);

export type EnterpriseJob = InferSelectModel<typeof enterpriseJobs>;
export type NewEnterpriseJob = InferInsertModel<typeof enterpriseJobs>;
