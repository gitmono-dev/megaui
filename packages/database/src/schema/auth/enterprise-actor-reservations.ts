// FS-69：后端 actor 保留集。
//
// The backend username of every historical subject is reserved for good — an
// unbound subject, a quarantined subject, a deactivated one and an upstream
// native actor all keep their name. The reservation set cannot rely on the
// unique key of the enterprise profile alone, because those subjects have no
// profile row.
//
// A reservation is not tied to a current identity: the identity link stays
// nullable. A quarantined subject keeps its reservation, an upstream native
// actor may be registered as unclaimable, and several historical subjects
// that share a name are marked ambiguous instead of being merged.
import { sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { user } from "./user";

/** The states of a reserved actor. */
export const ENTERPRISE_ACTOR_RESERVATION_STATES = [
  "reserved",
  "ambiguous",
  "unclaimable",
] as const;
export type EnterpriseActorReservationState =
  (typeof ENTERPRISE_ACTOR_RESERVATION_STATES)[number];

export const enterpriseActorReservations = pgTable(
  "enterprise_actor_reservations",
  {
    id: text("id").primaryKey(),
    /** The reserved backend username; it is unique in the instance. */
    backendUsername: text("backend_username").notNull(),
    /** The state of the reservation. */
    actorState: text("actor_state").notNull().default("reserved"),
    /** The current identity of the subject, when it has one. */
    identityId: text("identity_id"),
    /** The historical local user of the subject, when it still exists. */
    localUserId: text("local_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /** A quarantined subject keeps its reservation. */
    quarantined: boolean("quarantined").notNull().default(false),
    /** The digest of the upstream snapshot the reservation was built from. */
    sourceSnapshotDigest: text("source_snapshot_digest").notNull(),
    /** The moment the upstream snapshot was observed. */
    sourceObservedAt: timestamp("source_observed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    // The actor key of the instance.
    actor: uniqueIndex("enterprise_actor_reservations_backend_username_uidx").on(
      table.backendUsername,
    ),
    // The reservation set is looked up by state and by snapshot.
    state: index("enterprise_actor_reservations_state_idx").on(table.actorState),
    snapshot: index("enterprise_actor_reservations_snapshot_idx").on(
      table.sourceSnapshotDigest,
    ),
    // A quarantined subject never releases its name.
    quarantinedReserved: check(
      "enterprise_actor_reservations_quarantine_check",
      sql`${table.quarantined} = false or ${table.actorState} = 'reserved'`,
    ),
  }),
);

export type EnterpriseActorReservation = InferSelectModel<typeof enterpriseActorReservations>;
export type NewEnterpriseActorReservation = InferInsertModel<typeof enterpriseActorReservations>;
