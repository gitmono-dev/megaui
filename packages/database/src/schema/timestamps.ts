// megaui-only: shared audit-timestamp column builders.
//
// Both columns are `timestamptz NOT NULL DEFAULT now()`. A builder is created
// per call because drizzle column builders must not be shared between tables.
import { timestamp } from "drizzle-orm/pg-core";

/** `created_at`: set once by the database when the row is inserted. */
export const createdAtColumn = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** `updated_at`: defaults to insert time; application code refreshes it on writes. */
export const updatedAtColumn = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
