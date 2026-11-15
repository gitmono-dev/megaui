// megaui-only (FS-34): the verified event inbox has no upstream counterpart.
/**
 * FS-34：飞书事件 inbox schema。
 *
 * The inbox stores only the business fields needed after callback verification.
 * It never stores a raw callback body, private-chat text, or a pairing token.
 * Envelope event IDs and IM message IDs form separate idempotency boundaries,
 * while lease and completion columns support bounded worker processing and TTL
 * cleanup.
 */
import { sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const ENTERPRISE_EVENT_STATES = ["pending", "leased", "done"] as const;
export type EnterpriseEventState = (typeof ENTERPRISE_EVENT_STATES)[number];

export const enterpriseEventInbox = pgTable(
  "enterprise_event_inbox",
  {
    id: text("id").primaryKey(),
    tenantKey: text("tenant_key").notNull(),
    appId: text("app_id").notNull(),
    /** The verified callback-envelope identifier. */
    eventId: text("event_id").notNull(),
    /** The verified callback event type. */
    eventType: text("event_type").notNull(),
    /** Provider creation time after boundary parsing. */
    eventCreatedAt: timestamp("event_created_at", { withTimezone: true }).notNull(),
    /** The directory identity named by a Contact event. */
    subjectOpenId: text("subject_open_id"),
    /** IM business id; separately deduplicated from event_id. */
    messageId: text("message_id"),
    senderOpenId: text("sender_open_id"),
    senderType: text("sender_type"),
    chatType: text("chat_type"),
    messageType: text("message_type"),
    /** SHA-256 digest only; the opaque pairing token is never persisted. */
    pairingTokenDigest: text("pairing_token_digest"),
    state: text("state").notNull().default("pending"),
    claimOwner: text("claim_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    availableAt: timestamp("available_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    attempts: integer("attempts").notNull().default(0),
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
    envelope: uniqueIndex("enterprise_event_inbox_tenant_app_event_uidx").on(
      table.tenantKey,
      table.appId,
      table.eventId,
    ),
    message: uniqueIndex("enterprise_event_inbox_tenant_app_message_uidx")
      .on(table.tenantKey, table.appId, table.messageId)
      .where(sql`${table.messageId} is not null`),
    // Pending and expired-lease claims use different range columns. Separate
    // partial indexes keep both bounded claim paths indexable.
    pendingClaim: index("enterprise_event_inbox_pending_claim_idx")
      .on(table.availableAt, table.id)
      .where(sql`${table.state} = 'pending'`),
    leaseClaim: index("enterprise_event_inbox_lease_claim_idx")
      .on(table.leaseUntil, table.id)
      .where(sql`${table.state} = 'leased'`),
    cleanup: index("enterprise_event_inbox_cleanup_idx").on(
      table.state,
      table.completedAt,
      table.id,
    ),
    stateKnown: check(
      "enterprise_event_inbox_state_known",
      sql`${table.state} in ('pending', 'leased', 'done')`,
    ),
    messageIdRequired: check(
      "enterprise_event_inbox_message_id_required",
      sql`${table.eventType} <> 'im.message.receive_v1' or (${table.messageId} is not null and ${table.messageId} ~ '[^[:space:]]')`,
    ),
    stateFields: check(
      "enterprise_event_inbox_state_fields",
      sql`(
        ${table.state} = 'pending'
        and ${table.claimOwner} is null
        and ${table.leaseUntil} is null
        and ${table.completedAt} is null
      ) or (
        ${table.state} = 'leased'
        and ${table.claimOwner} is not null
        and ${table.claimOwner} ~ '[^[:space:]]'
        and ${table.leaseUntil} is not null
        and ${table.completedAt} is null
      ) or (
        ${table.state} = 'done'
        and ${table.claimOwner} is null
        and ${table.leaseUntil} is null
        and ${table.completedAt} is not null
      )`,
    ),
    digestShape: check(
      "enterprise_event_inbox_pairing_digest_shape",
      sql`${table.pairingTokenDigest} is null or ${table.pairingTokenDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    digestBelongsToMessage: check(
      "enterprise_event_inbox_pairing_digest_message",
      sql`${table.pairingTokenDigest} is null or (${table.messageId} is not null and ${table.messageId} ~ '[^[:space:]]')`,
    ),
  }),
);

export type EnterpriseEventInboxEntry = InferSelectModel<typeof enterpriseEventInbox>;
export type NewEnterpriseEventInboxEntry = InferInsertModel<typeof enterpriseEventInbox>;
