// FS-02：企业策略表。
//
// The policy row is the instance's own state: who owns the instance, which
// deployment it is, and how far the activation has progressed.
//
// The activation watermark is monotonic. `auth_epoch` only grows, and the
// activation state only moves through the ordered set legacy → maintenance →
// enterprise. A legacy deployment was never activated, so it carries epoch 0;
// once the persistent activation marker exists, the deployment never returns
// to legacy and the epoch stays above zero.
import { sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** The ordered activation states of an instance. */
export const ENTERPRISE_ACTIVATION_STATES = [
  "legacy",
  "maintenance",
  "enterprise",
] as const;
export type EnterpriseActivationState = (typeof ENTERPRISE_ACTIVATION_STATES)[number];

export const enterprisePolicy = pgTable(
  "enterprise_policy",
  {
    id: text("id").primaryKey(),
    /** The scope of the row; an instance keeps one policy row. */
    scope: text("scope").notNull().unique(),
    /** The fingerprint of the instance owner; the policy belongs to it. */
    ownerFingerprint: text("owner_fingerprint").notNull(),
    deploymentRole: text("deployment_role").notNull(),
    environment: text("environment").notNull(),
    /** The monotonic activation watermark. */
    authEpoch: integer("auth_epoch").notNull().default(0),
    /** Where the activation currently stands. */
    activationState: text("activation_state").notNull().default("legacy"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => ({
    activationStateKnown: check(
      "enterprise_policy_activation_state_check",
      sql`${table.activationState} in ('legacy', 'maintenance', 'enterprise')`,
    ),
    authEpochNotNegative: check(
      "enterprise_policy_auth_epoch_check",
      sql`${table.authEpoch} >= 0`,
    ),
    // A deployment that was never activated keeps the epoch at zero; an
    // activated deployment never returns to legacy.
    legacyKeepsEpochZero: check(
      "enterprise_policy_legacy_epoch_check",
      sql`${table.activationState} <> 'legacy' or ${table.authEpoch} = 0`,
    ),
  }),
);

export type EnterprisePolicy = InferSelectModel<typeof enterprisePolicy>;
export type NewEnterprisePolicy = InferInsertModel<typeof enterprisePolicy>;

export interface EnterpriseActivation {
  authEpoch: number;
  activationState: EnterpriseActivationState;
}

/**
 * Checks that a new activation state may replace the stored one.
 *
 * The watermark only grows, and a deployment that carries a watermark is an
 * activated one: it may enter maintenance for repair, but it may never
 * present itself as legacy again, because the persistent activation marker
 * may not be cleared.
 */
export function assertMonotonicActivation(
  current: EnterpriseActivation,
  next: EnterpriseActivation,
): void {
  if (next.authEpoch < current.authEpoch) {
    throw new Error(
      "[@megaui/database] the activation watermark may not decrease.",
    );
  }
  if (next.activationState === "legacy" && next.authEpoch !== 0) {
    throw new Error(
      "[@megaui/database] a deployment that carries a watermark may not return to legacy.",
    );
  }
  if (current.activationState === "legacy" && next.activationState === "legacy" && next.authEpoch !== 0) {
    throw new Error(
      "[@megaui/database] a legacy deployment carries the watermark zero.",
    );
  }
}
