// megaui-only (FSL-122): the PostgreSQL transactions behind issuing a Feishu login code.
//
// The engine issue service (`packages/engine/src/services/feishu-login/issue.ts`) owns the
// Feishu calls; this module owns the rows of `feishu_login_codes` and the HMAC rules that
// decide what is stored. The email and the code only ever reach the table as keyed HMACs,
// except for the short-lived hold of an `active` row (ADR-FSL-11, FSL-119 two-way CHECK).
//
// Five transactions, none of which spans a Feishu call:
// - `reserve` (FSL-154, run before the request answers) takes the flow lock, the email lock and
//   the global lock in that fixed order. It first voids, in one statement, the row of the largest
//   `flow_seq` of the flow (whatever its email and state, unless it is `consumed`), then decides
//   the cooldown and the global budget (FSL-145), and only when both pass writes the `reserved`
//   row of one request and commits; a refused request commits only that void;
// - `beginDelivery` runs before the first Feishu call of a reservation: an expired one is
//   voided and nothing may be called (FSL-145);
// - `activate` takes the flow lock, then the email lock, and locks this row `FOR UPDATE`; only
//   an unexpired `reserved` row with no reservation of a larger `email_seq` for the same email
//   HMAC is activated (FSL-149): every `active` row of that email HMAC (whatever its flow) is
//   voided clearing its sensitive fields in the same statement, then this row turns `active`
//   with the email, open_id, name and code HMAC. An expired or superseded reservation is voided
//   instead and nothing else changes;
// - `voidReservation` has the same shape (flow lock, then email lock) and turns this row `void`;
// - `voidRejectedSend` writes back a send that Feishu rejected on every attempt: a
//   conditional update, under the same two locks, that only voids the row while it is still
//   `active` and unexpired.
// Every write-back of a delivery (`beginDelivery`, `activate`, `voidReservation`,
// `voidRejectedSend`) takes the flow lock, then the email lock, of its row, so a later request
// meets the same lock waits whatever the Feishu result was (FSL-154).
//
// Outside those transactions, `cleanupFeishuLoginCodes` (FSL-146) is the expiry cleanup that the
// engine scheduler runs on every Web instance: one statement that voids the expired `reserved`
// and `active` rows, clearing their sensitive fields, and deletes the rows created more than 24
// hours ago.
//
// The verify side (FSL-124, FSL-151, FSL-125, FSL-152) is `consumeFeishuLoginCode`: one
// transaction that locks the newest row of a flow `FOR UPDATE`, compares the code HMAC in constant
// time, counts a wrong code (the fifth one voids the row clearing its sensitive fields) or consumes
// the row clearing its sensitive fields and looks up the identity binding before it commits,
// creating the user and its binding in the same transaction when the member has none (FSL-125),
// under the member's identity lock and without merging a local user that holds the email
// (FSL-152); and
// `recordFeishuLoginSession`, which marks a session as issued by the Feishu login (FSL-147).
//
// `ensureKeyCheck` (FSL-161) records, or reads back, the single fingerprint of the HMAC key and
// the app ID in `feishu_login_key_check` (FSL-159); the auth plugin compares it with its own
// fingerprint before a request is reserved and before a verify reads a code.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";

/** A reservation expires this long after it was created. */
export const FEISHU_LOGIN_RESERVATION_TTL_SECONDS = 120;
/** An active code expires this long after activation. */
export const FEISHU_LOGIN_CODE_TTL_SECONDS = 300;

/** The purpose label of the email HMAC. */
export const FEISHU_LOGIN_EMAIL_HMAC_LABEL = "feishu-login-email:v1:";
/** The purpose label of the code HMAC. */
export const FEISHU_LOGIN_CODE_HMAC_LABEL = "feishu-login-code:v1:";

/**
 * The fixed first key of every per-email advisory lock ("FSL" + 0x01). The second key is
 * derived from the email HMAC, so two emails rarely share a lock and a collision only
 * serializes more, never less.
 */
export const FEISHU_LOGIN_EMAIL_LOCK_CLASS = 0x46534c01;

/**
 * The global advisory lock of every reservation ("FSL" + 0x02, key 0), taken after the flow lock
 * and the email lock (FSL-145, FSL-154): reservations of all emails, on all instances, decide
 * the global budget one after another.
 */
export const FEISHU_LOGIN_GLOBAL_LOCK_CLASS = 0x46534c02;
export const FEISHU_LOGIN_GLOBAL_LOCK_KEY = 0;

/**
 * The fixed first key of every per-flow advisory lock ("FSL" + 0x03, FSL-154). The second key is
 * derived from the flow hash; a collision of two flows only serializes more, never less. It is
 * the first lock of every transaction that takes it: flow, then email, then global.
 */
export const FEISHU_LOGIN_FLOW_LOCK_CLASS = 0x46534c03;

/**
 * The fixed first key of every per-identity advisory lock ("FSL" + 0x04, FSL-152). The second key
 * is derived from the `open_id_hmac` of a member; a collision of two members only serializes more,
 * never less. Only the verify transaction takes it, after its single row lock of
 * `feishu_login_codes` and only when that member has no binding yet; it serializes the first
 * logins of one member, so only one of them creates the account.
 */
export const FEISHU_LOGIN_IDENTITY_LOCK_CLASS = 0x46534c04;

/** A second reservation of one email HMAC within this many seconds is refused (FSL-145). */
export const FEISHU_LOGIN_COOLDOWN_SECONDS = 60;
/** The sliding window of the global budget, in seconds (FSL-145). */
export const FEISHU_LOGIN_GLOBAL_BUDGET_WINDOW_SECONDS = 60;
/** At most this many reservations, of all emails and instances, per window (FSL-145). */
export const FEISHU_LOGIN_GLOBAL_BUDGET = 120;

const HMAC_KEY_BYTES = 32;
const HEX_64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNIQUE_VIOLATION = "23505";

function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== HMAC_KEY_BYTES) {
    throw new Error("INVALID_FEISHU_LOGIN_HMAC_KEY");
  }
}

/**
 * HMAC-SHA256(key, "feishu-login-email:v1:" + email) as lowercase hex.
 *
 * The caller passes the normalized email (trimmed, lowercase); this function does not
 * normalize, so the request path and every later reader agree on one input.
 */
export function feishuLoginEmailHmac(key: Uint8Array, email: string): string {
  assertKey(key);
  if (typeof email !== "string" || email === "") throw new Error("INVALID_FEISHU_LOGIN_EMAIL");
  return createHmac("sha256", key).update(FEISHU_LOGIN_EMAIL_HMAC_LABEL + email, "utf8").digest("hex");
}

/**
 * HMAC-SHA256(key, "feishu-login-code:v1:" + row id + ":" + code) as lowercase hex.
 *
 * Binding the row id means a code HMAC is only ever comparable with its own row.
 */
export function feishuLoginCodeHmac(key: Uint8Array, rowId: string, code: string): string {
  assertKey(key);
  if (typeof rowId !== "string" || !UUID.test(rowId)) throw new Error("INVALID_FEISHU_LOGIN_ROW_ID");
  if (typeof code !== "string" || code === "") throw new Error("INVALID_FEISHU_LOGIN_CODE");
  return createHmac("sha256", key)
    .update(`${FEISHU_LOGIN_CODE_HMAC_LABEL}${rowId}:${code}`, "utf8")
    .digest("hex");
}

/** The second advisory-lock key of an email HMAC: its first 32 bits as a signed integer. */
export function feishuLoginEmailLockKey(emailHmac: string): number {
  assertHex(emailHmac, "INVALID_FEISHU_LOGIN_EMAIL_HMAC");
  return Buffer.from(emailHmac.slice(0, 8), "hex").readInt32BE(0);
}

/** The second advisory-lock key of a flow hash: its first 32 bits as a signed integer (FSL-154). */
export function feishuLoginFlowLockKey(flowHash: string): number {
  assertHex(flowHash, "INVALID_FEISHU_LOGIN_FLOW_HASH");
  return Buffer.from(flowHash.slice(0, 8), "hex").readInt32BE(0);
}

/** The second advisory-lock key of an `open_id_hmac`: its first 32 bits as a signed integer (FSL-152). */
export function feishuLoginIdentityLockKey(openIdHmac: string): number {
  assertHex(openIdHmac, "INVALID_FEISHU_LOGIN_OPEN_ID_HMAC");
  return Buffer.from(openIdHmac.slice(0, 8), "hex").readInt32BE(0);
}

function assertHex(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || !HEX_64.test(value)) throw new Error(code);
}

function assertText(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(code);
}

export interface FeishuLoginReserveInput {
  /** The SHA-256 of the flow cookie value, as 64 lowercase hex characters. */
  readonly flowHash: string;
  /** `feishuLoginEmailHmac` of the normalized email. */
  readonly emailHmac: string;
}

/**
 * Every result but `retry` comes from a committed transaction that has already voided the row of
 * the largest `flow_seq` of the flow (unless it was `consumed`, FSL-154).
 */
export type FeishuLoginReserveResult =
  | { readonly kind: "reserved"; readonly id: string }
  /** A concurrent reservation took the same order number; rolled back, the request is retried. */
  | { readonly kind: "retry" }
  /** The email HMAC already has a reservation of the last 60 seconds; no new row was written. */
  | { readonly kind: "cooldown" }
  /** 120 reservations of the last 60 seconds exist (all emails); no new row was written. */
  | { readonly kind: "budget" };

export type FeishuLoginDeliveryResult =
  /** The reservation is still an unexpired `reserved` row: the Feishu calls may start. */
  | { readonly kind: "live" }
  /**
   * Nothing may be called: the row is no longer `reserved` (`not_reserved`, left as it is) or
   * has passed its `expires_at` (`expired`, now voided).
   */
  | { readonly kind: "not_reserved"; readonly reason: "not_reserved" | "expired" };

export interface FeishuLoginActivateInput {
  readonly id: string;
  readonly emailHmac: string;
  /** The normalized email; held only while the row is active. */
  readonly email: string;
  readonly openId: string;
  /** `base_info.name.name.default_value`; any string, the empty one included. */
  readonly displayName: string;
  /** `feishuLoginCodeHmac` of this row's code. */
  readonly codeHmac: string;
}

/** Why a reservation was not activated. */
export type FeishuLoginNotActivatedReason =
  /** The row is no longer `reserved` (voided, consumed, active) or no longer exists. */
  | "not_reserved"
  /** The reservation passed its `expires_at`; it is voided. */
  | "expired"
  /** A reservation of a larger `email_seq` exists for the same email HMAC; it is voided. */
  | "superseded";

export type FeishuLoginActivateResult =
  | { readonly kind: "active" }
  /** Nothing was activated, no other row changed and nothing may be sent. */
  | { readonly kind: "not_reserved"; readonly reason: FeishuLoginNotActivatedReason };

export interface FeishuLoginVoidInput {
  readonly id: string;
  readonly emailHmac: string;
}

export interface FeishuLoginCodeStore {
  readonly reserve: (input: FeishuLoginReserveInput) => Promise<FeishuLoginReserveResult>;
  /** Checks a reservation before its first Feishu call; an expired one is voided (FSL-145). */
  readonly beginDelivery: (input: FeishuLoginVoidInput) => Promise<FeishuLoginDeliveryResult>;
  readonly activate: (input: FeishuLoginActivateInput) => Promise<FeishuLoginActivateResult>;
  readonly voidReservation: (input: FeishuLoginVoidInput) => Promise<void>;
  /**
   * Voids the row after every send attempt was rejected, only while it is still `active` and
   * unexpired; returns whether it changed. A row voided, consumed or expired meanwhile is left
   * as it is (an expired row is only handled by the cleanup).
   */
  readonly voidRejectedSend: (input: FeishuLoginVoidInput) => Promise<{ readonly voided: boolean }>;
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

async function lockEmail(client: PoolClient, emailHmac: string): Promise<void> {
  await client.query("select pg_advisory_xact_lock($1::int4, $2::int4)", [
    FEISHU_LOGIN_EMAIL_LOCK_CLASS,
    feishuLoginEmailLockKey(emailHmac),
  ]);
}

async function lockFlow(client: PoolClient, flowHash: string): Promise<void> {
  await client.query("select pg_advisory_xact_lock($1::int4, $2::int4)", [
    FEISHU_LOGIN_FLOW_LOCK_CLASS,
    feishuLoginFlowLockKey(flowHash),
  ]);
}

/**
 * The two locks of every write-back of a delivery (FSL-154): the flow lock of the row, then the
 * email lock, before any row lock. The flow hash of a row never changes, so it is read first
 * without a lock. `false` when the row no longer exists (nothing to write back, no lock taken).
 */
async function lockFlowThenEmail(client: PoolClient, id: string, emailHmac: string): Promise<boolean> {
  const found = await client.query<{ flow_hash: string }>(
    "select flow_hash from feishu_login_codes where id = $1 and email_hmac = $2",
    [id, emailHmac],
  );
  const flowHash = found.rows[0]?.flow_hash;
  if (flowHash === undefined) return false;
  await lockFlow(client, flowHash);
  await lockEmail(client, emailHmac);
  return true;
}

/**
 * The row locks of a write-back that may activate or void a row: this row and every `active` row
 * of its email HMAC (the rows an activation voids), in id order, in a statement of its own. The
 * activation and the void write-back of a delivery share it (FSL-154).
 */
const LOCK_ROW_AND_ACTIVE_ROWS_OF_EMAIL_SQL = `select 1 from feishu_login_codes
  where email_hmac = $2 and (id = $1 or state = 'active')
  order by id
  for update`;

/**
 * FSL-154: the one statement of a reservation that voids the row of the largest `flow_seq` of the
 * flow, whatever its email and state (`reserved`, `active` or `void`), clearing its sensitive
 * fields; a `consumed` newest row is left as it is. It rewrites 0 or 1 row: 0 only when the flow
 * has no row yet or its newest row is consumed. Only that row can still be valid: every
 * reservation voids the newest row of its flow before it adds a larger `flow_seq`, and only a
 * `reserved` row ever activates.
 */
export const FEISHU_LOGIN_SUPERSEDE_FLOW_SQL = `update feishu_login_codes
   set state = 'void', email = null, open_id = null, display_name = null, code_hmac = null
 where id = (select id from feishu_login_codes where flow_hash = $1::text order by flow_seq desc limit 1)
   and state <> 'consumed'`;

/** Creates the store over one pool; every method takes and releases its own client. */
export function createFeishuLoginCodeStore(pool: Pool): FeishuLoginCodeStore {
  return {
    async reserve(input) {
      assertHex(input?.flowHash, "INVALID_FEISHU_LOGIN_FLOW_HASH");
      assertHex(input.emailHmac, "INVALID_FEISHU_LOGIN_EMAIL_HMAC");
      const id = randomUUID();
      let refused: "cooldown" | "budget" | undefined;
      try {
        await inTransaction(pool, async (client) => {
          // FSL-154: the flow lock comes first. Every reservation of the flow runs under it, so
          // the newest row voided below is the newest committed row of the flow and each
          // `flow_seq` is the current maximum plus one, in commit order. The write-backs of a
          // delivery take it too, before the email lock.
          await lockFlow(client, input.flowHash);
          // The email lock serializes this reservation with every activation of the email:
          // a reservation can not commit between an activation's "no larger email_seq"
          // check and its activating write. Each `email_seq` is then the current maximum
          // plus one under that lock. The unique indexes of FSL-163 remain as a defence in
          // depth: a writer that would bypass the locks and read the same maximum collides,
          // and the later committer fails instead of sharing an order number.
          await lockEmail(client, input.emailHmac);
          // FSL-145: the global lock, always last (flow, then email, then global; every other
          // transaction takes a prefix of that order or none of these three locks, so it never
          // deadlocks; the identity lock of a first login (FSL-152) is another class, taken only
          // by verify, which takes none of these three). Every reservation of every email and instance decides the budget under
          // it, so two of them never both see the last free slot. The locks are released by the
          // commit, before any Feishu call.
          await client.query("select pg_advisory_xact_lock($1::int4, $2::int4)", [
            FEISHU_LOGIN_GLOBAL_LOCK_CLASS,
            FEISHU_LOGIN_GLOBAL_LOCK_KEY,
          ]);
          // FSL-154: void the newest row of the flow before anything is decided, so even a
          // refused request invalidates the earlier code of this flow. The statement waits for
          // the row lock of a verify, an activation or the cleanup holding that row, after all
          // advisory locks (every row lock comes after the advisory locks of its transaction).
          await client.query(FEISHU_LOGIN_SUPERSEDE_FLOW_SQL, [input.flowHash]);
          // The creation time is read once after the three locks and the void (`clock_timestamp()`,
          // not the transaction start `now()`), so waiting for a lock never shortens the two-minute
          // reservation and creation times follow the commit order. The cooldown (index
          // `(email_hmac, created_at)`) and the budget (index `(created_at)`, counted up to
          // the budget only) are decided against that same instant; every row counts, whatever
          // its state, because every row was once a reservation.
          const decision = await client.query<{ at: string; cooldown: boolean; recent: number }>(
            `select t.at::text as at,
                    exists (select 1 from feishu_login_codes
                             where email_hmac = $1::text
                               and created_at > t.at - make_interval(secs => $2::int)) as cooldown,
                    (select count(*) from (select 1 from feishu_login_codes
                                            where created_at > t.at - make_interval(secs => $3::int)
                                            limit $4::int) w)::int as recent
               from (select clock_timestamp() as at) t`,
            [
              input.emailHmac,
              FEISHU_LOGIN_COOLDOWN_SECONDS,
              FEISHU_LOGIN_GLOBAL_BUDGET_WINDOW_SECONDS,
              FEISHU_LOGIN_GLOBAL_BUDGET,
            ],
          );
          const { at, cooldown, recent } = decision.rows[0]!;
          // A refused request writes no new row (it commits only the void above): it never
          // extends the cooldown and never takes a slot of the budget, so retrying does not
          // delay the recovery of either.
          if (cooldown) {
            refused = "cooldown";
            return;
          }
          if (recent >= FEISHU_LOGIN_GLOBAL_BUDGET) {
            refused = "budget";
            return;
          }
          // `at` is the text form of the sampled instant, read back in the same session, so
          // the stored creation time is exactly that instant (microseconds included).
          await client.query(
            `insert into feishu_login_codes
               (id, flow_hash, flow_seq, email_hmac, email_seq, state, expires_at, created_at)
             select $1::uuid, $2::text,
               coalesce((select max(flow_seq) from feishu_login_codes where flow_hash = $2::text), 0) + 1,
               $3::text,
               coalesce((select max(email_seq) from feishu_login_codes where email_hmac = $3::text), 0) + 1,
               'reserved', $5::timestamptz + make_interval(secs => $4::int), $5::timestamptz`,
            [id, input.flowHash, input.emailHmac, FEISHU_LOGIN_RESERVATION_TTL_SECONDS, at],
          );
        });
      } catch (error) {
        if ((error as { code?: unknown }).code === UNIQUE_VIOLATION) return { kind: "retry" };
        throw error;
      }
      if (refused) return { kind: refused };
      return { kind: "reserved", id };
    },

    async beginDelivery(input) {
      assertText(input?.id, "INVALID_FEISHU_LOGIN_ROW_ID");
      assertHex(input.emailHmac, "INVALID_FEISHU_LOGIN_EMAIL_HMAC");
      return inTransaction(pool, async (client) => {
        if (!(await lockFlowThenEmail(client, input.id, input.emailHmac))) {
          return { kind: "not_reserved", reason: "not_reserved" } as const;
        }
        // The row lock is taken by a statement of its own, so the expiry below is read after
        // every lock wait (`clock_timestamp()`, never the transaction start `now()`).
        await client.query("select 1 from feishu_login_codes where id = $1 and email_hmac = $2 for update", [
          input.id,
          input.emailHmac,
        ]);
        const current = await client.query<{ state: string; live: boolean }>(
          `select state, expires_at > clock_timestamp() as live
             from feishu_login_codes
            where id = $1 and email_hmac = $2`,
          [input.id, input.emailHmac],
        );
        const row = current.rows[0];
        if (!row || row.state !== "reserved") return { kind: "not_reserved", reason: "not_reserved" } as const;
        if (row.live) return { kind: "live" } as const;
        // An expired reservation calls nothing; it is voided (a reserved row holds no sensitive
        // field, the clearing keeps the statement uniform).
        await client.query(
          `update feishu_login_codes
              set state = 'void', email = null, open_id = null, display_name = null, code_hmac = null
            where id = $1 and state = 'reserved'`,
          [input.id],
        );
        return { kind: "not_reserved", reason: "expired" } as const;
      });
    },

    async activate(input) {
      assertText(input?.id, "INVALID_FEISHU_LOGIN_ROW_ID");
      assertHex(input.emailHmac, "INVALID_FEISHU_LOGIN_EMAIL_HMAC");
      assertText(input.email, "INVALID_FEISHU_LOGIN_EMAIL");
      assertText(input.openId, "INVALID_FEISHU_LOGIN_OPEN_ID");
      // The directory contract (FSL-117) admits any string as the name, the empty one included;
      // the CHECK of FSL-119 only requires it to be present while the row is active.
      if (typeof input.displayName !== "string") throw new Error("INVALID_FEISHU_LOGIN_DISPLAY_NAME");
      assertHex(input.codeHmac, "INVALID_FEISHU_LOGIN_CODE_HMAC");
      return inTransaction(pool, async (client) => {
        // FSL-154: the flow lock, then the email lock, whatever the Feishu result was.
        if (!(await lockFlowThenEmail(client, input.id, input.emailHmac))) {
          return { kind: "not_reserved", reason: "not_reserved" } as const;
        }
        // Every row lock this transaction needs (this row and every active row of the email,
        // which the activation voids) is taken by a statement of its own, before the check:
        // the state and the newest reservation are read by the next statement, after any wait
        // for those locks, and the updates below never wait again. Only an activation, under
        // this email lock, makes a row active, so no new active row appears meanwhile. A later
        // reservation of this row's flow (FSL-154) waits for the flow lock: it voids this row
        // only before or after this transaction, and a voided row is no longer `reserved`.
        // `email_seq` follows the commit order of the reservations (the unique index of
        // FSL-163 fails a later committer that read the same maximum), so a larger one is a
        // later request whatever the timestamps say. The expiry is read with
        // `clock_timestamp()`, never the transaction start `now()`, and it is checked again by
        // the activating update itself, so an expiry that passes at any point before that
        // write still prevents the activation.
        await client.query(LOCK_ROW_AND_ACTIVE_ROWS_OF_EMAIL_SQL, [input.id, input.emailHmac]);
        const current = await client.query<{ state: string; live: boolean; superseded: boolean }>(
          `select c.state, c.expires_at > clock_timestamp() as live,
                  exists (select 1 from feishu_login_codes n
                           where n.email_hmac = c.email_hmac and n.email_seq > c.email_seq) as superseded
             from feishu_login_codes c
            where c.id = $1 and c.email_hmac = $2`,
          [input.id, input.emailHmac],
        );
        const row = current.rows[0];
        if (!row || row.state !== "reserved") return { kind: "not_reserved", reason: "not_reserved" } as const;
        if (!row.live || row.superseded) {
          // A stale reservation never activates and never touches another row; it is voided
          // (a reserved row holds no sensitive field, the clearing keeps the statement uniform).
          await client.query(
            `update feishu_login_codes
                set state = 'void', email = null, open_id = null, display_name = null, code_hmac = null
              where id = $1 and state = 'reserved'`,
            [input.id],
          );
          return { kind: "not_reserved", reason: row.superseded ? "superseded" : "expired" } as const;
        }
        // The activating write decides the expiry itself: it only applies to a reservation
        // that is still unexpired at the moment of the write. Older active rows are voided
        // only after it applied, so a reservation that expired meanwhile changes no other row.
        const activated = await client.query(
          `update feishu_login_codes
              set state = 'active', email = $2, open_id = $3, display_name = $4, code_hmac = $5,
                  expires_at = clock_timestamp() + make_interval(secs => $6::int)
            where id = $1 and state = 'reserved' and expires_at > clock_timestamp()`,
          [
            input.id,
            input.email,
            input.openId,
            input.displayName,
            input.codeHmac,
            FEISHU_LOGIN_CODE_TTL_SECONDS,
          ],
        );
        if (activated.rowCount !== 1) {
          await client.query(
            `update feishu_login_codes
                set state = 'void', email = null, open_id = null, display_name = null, code_hmac = null
              where id = $1 and state = 'reserved'`,
            [input.id],
          );
          return { kind: "not_reserved", reason: "expired" } as const;
        }
        // Only one code per email is usable: every other active row of this email HMAC, in
        // any flow, is voided and cleared in the same statement (FSL-119 CHECK).
        await client.query(
          `update feishu_login_codes
              set state = 'void', email = null, open_id = null, display_name = null, code_hmac = null
            where email_hmac = $1 and state = 'active' and id <> $2`,
          [input.emailHmac, input.id],
        );
        return { kind: "active" } as const;
      });
    },

    async voidReservation(input) {
      assertText(input?.id, "INVALID_FEISHU_LOGIN_ROW_ID");
      assertHex(input.emailHmac, "INVALID_FEISHU_LOGIN_EMAIL_HMAC");
      await inTransaction(pool, async (client) => {
        // The same shape as the activation (FSL-154): flow lock, email lock, then the row locks
        // the activation would take (this row and every active row of the email, in id order),
        // so a later request meets the same waits whether the lookup found a member or not.
        if (!(await lockFlowThenEmail(client, input.id, input.emailHmac))) return;
        await client.query(LOCK_ROW_AND_ACTIVE_ROWS_OF_EMAIL_SQL, [input.id, input.emailHmac]);
        await client.query(
          `update feishu_login_codes
              set state = 'void', email = null, open_id = null, display_name = null, code_hmac = null
            where id = $1 and email_hmac = $2 and state = 'reserved'`,
          [input.id, input.emailHmac],
        );
      });
    },

    async voidRejectedSend(input) {
      assertText(input?.id, "INVALID_FEISHU_LOGIN_ROW_ID");
      assertHex(input.emailHmac, "INVALID_FEISHU_LOGIN_EMAIL_HMAC");
      return inTransaction(pool, async (client) => {
        if (!(await lockFlowThenEmail(client, input.id, input.emailHmac))) return { voided: false };
        // A conditional write-back: a row voided by a newer request or the cleanup, consumed
        // by verify, or past its expiry (even before the cleanup ran) is never restored or
        // overwritten here. The row lock is taken first by a statement of its own, so
        // `clock_timestamp()` is read after every lock wait.
        await client.query("select 1 from feishu_login_codes where id = $1 and email_hmac = $2 for update", [
          input.id,
          input.emailHmac,
        ]);
        const voided = await client.query(
          `update feishu_login_codes
              set state = 'void', email = null, open_id = null, display_name = null, code_hmac = null
            where id = $1 and email_hmac = $2 and state = 'active' and expires_at > clock_timestamp()`,
          [input.id, input.emailHmac],
        );
        return { voided: voided.rowCount === 1 };
      });
    },
  };
}

export interface FeishuLoginConsumeInput {
  /** The SHA-256 of the flow cookie value, as 64 lowercase hex characters. */
  readonly flowHash: string;
  /** The submitted code (already normalized by the caller); compared through its HMAC only. */
  readonly code: string;
  /** The decoded 32-byte `ENTERPRISE_OTP_HMAC_KEY`. */
  readonly otpHmacKey: Uint8Array;
  /** `FEISHU_APP_ID`: the `app_id` half of the binding key. */
  readonly appId: string;
  /**
   * Derives the `open_id_hmac` of the held open_id (the auth verify module owns the rule). Called
   * inside the transaction, after the row was consumed; its result must be 64 lowercase hex.
   */
  readonly openIdHmac: (openId: string) => string;
  /**
   * The ID of the Better Auth user to create when `(app_id, open_id_hmac)` has no binding
   * (FSL-125 first login; the verify endpoint always passes one). Without it an unbound member
   * rolls the transaction back and the result is `unbound`, which only callers that probe whether
   * a code is valid without signing anyone up use.
   */
  readonly newUserId?: string;
}

/** A row turns `void` with the wrong code that brings `failed_attempts` to this value (FSL-151). */
export const FEISHU_LOGIN_MAX_FAILED_ATTEMPTS = 5;

export type FeishuLoginConsumeResult =
  /**
   * The row is now `consumed` with its sensitive fields cleared; the binding names the user (an
   * existing one, or the one this transaction created with the user on a first login, FSL-125).
   */
  | { readonly kind: "consumed"; readonly userId: string }
  /**
   * The code was not accepted: the flow has no row, its newest row is not an unexpired `active`
   * row (or has already reached the failure limit), or the code does not match. Only a mismatch
   * changes the row: its `failed_attempts` grows by one, and the mismatch that brings it to
   * `FEISHU_LOGIN_MAX_FAILED_ATTEMPTS` also turns it `void` with its sensitive fields cleared.
   */
  | { readonly kind: "invalid" }
  /**
   * The code matched but `(app_id, open_id_hmac)` has no binding and no `newUserId` was given: the
   * transaction was rolled back, so the row is still `active`.
   */
  | { readonly kind: "unbound" }
  /**
   * The code matched and the member has no binding, but a local user already holds the login email
   * (the insert of the user violated `user_email_unique`), FSL-152. Nothing is merged: the account
   * creation was rolled back to its savepoint, so no user was created or changed and no binding was
   * written, while the consumption committed: the row is `consumed` with its sensitive fields
   * cleared, so the same code can not be submitted again.
   */
  | { readonly kind: "conflict" };

/**
 * Thrown (and the whole consume transaction rolled back, the row staying `active`) when the
 * account creation of a first login fails for any reason other than a `conflict` (FSL-152). The
 * database error is not attached: its detail may name the email.
 */
export const FEISHU_LOGIN_ACCOUNT_CREATE_FAILED = "FEISHU_LOGIN_ACCOUNT_CREATE_FAILED";

/** Thrown inside the consume transaction to roll it back when no binding exists. */
const UNBOUND = Symbol("FEISHU_LOGIN_UNBOUND");
/** The savepoint the account creation of a first login rolls back to on a `conflict`. */
const ACCOUNT_SAVEPOINT = "feishu_login_account";

/** A local user already holds the email: the only unique violation that is a `conflict`. */
function isEmailConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && constraint === "user_email_unique";
}

function codeHmacMatches(expectedHex: string, storedHex: unknown): boolean {
  // Both sides are 32-byte digests; a stored value of another shape can never match, and the
  // comparison of two equal-length buffers takes the same time wherever they differ.
  if (typeof storedHex !== "string" || !HEX_64.test(storedHex)) return false;
  return timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(storedHex, "hex"));
}

/**
 * Verify (FSL-124 success path, FSL-151 failure path and concurrency, FSL-125 first-login account
 * creation, FSL-152 its conflict, rollback and concurrency; ADR-FSL-11 「校验」), one transaction,
 * set to READ COMMITTED by its first statement whatever the default isolation level is:
 * 1. locks the row of the largest `flow_seq` of the flow (whatever its state) with
 *    `SELECT … FOR UPDATE`, in a statement of its own. It is the only row of `feishu_login_codes`
 *    the transaction locks (the cleanup, the activation and the void write-back of a delivery,
 *    which lock several, do so in id order). A concurrent verify that selects the same row waits here until this transaction ends;
 * 2. reads the locked row again in the next statement (so after any lock wait, against its
 *    newest committed version and one `clock_timestamp()` sample). Only an `active` row that is
 *    unexpired (`expires_at > clock_timestamp()`), still the largest `flow_seq` of its flow in
 *    that statement's snapshot and below `FEISHU_LOGIN_MAX_FAILED_ATTEMPTS` goes on, and that
 *    statement returns the code HMAC only for such a row; anything else is `invalid` and changes
 *    nothing. A newer row of the flow committed after that statement started is not seen by this
 *    transaction; it is harmless, because every reservation of the flow first voids the flow's
 *    newest row (FSL-154) and that void waits for this row lock: a reservation that commits before
 *    this transaction voided the row (this statement then reads it `void`), one that waits voids
 *    it after this transaction ends (a consumed row is left as it is);
 * 3. compares `feishuLoginCodeHmac(key, row id, code)` with the stored code HMAC in constant time.
 *    A mismatch adds one to `failed_attempts`; the mismatch that brings it to
 *    `FEISHU_LOGIN_MAX_FAILED_ATTEMPTS` turns the row `void` clearing its email, open_id, name and
 *    code HMAC in the same statement. The transaction commits that write and the result is
 *    `invalid`;
 * 4. on a match, reads the held email, open_id and name (only while the row is still an unexpired
 *    `active` one at that statement's clock sample), then turns the row `consumed` clearing the
 *    email, open_id, name and code HMAC in the same statement (which repeats the `active` and
 *    expiry conditions: a row that expires between the two statements is not consumed);
 * 5. derives `open_id_hmac` with `input.openIdHmac` and reads the binding of
 *    `(app_id, open_id_hmac)` in `feishu_identities`. Found: the transaction commits and the
 *    result names the bound user. Not found, without `input.newUserId`: the transaction is rolled
 *    back (`unbound`). Not found, with `input.newUserId` (first login, FSL-125 and FSL-152):
 *    a. the transaction takes the member's identity advisory lock
 *       (`FEISHU_LOGIN_IDENTITY_LOCK_CLASS`, `feishuLoginIdentityLockKey(open_id_hmac)`; held to
 *       its end) and reads the binding again in a new statement, so after any wait for that lock
 *       it sees a binding that a concurrent first login of the same member committed meanwhile;
 *       found, the transaction commits naming that user, as in a later login;
 *    b. still not found, it sets a savepoint and inserts the Better Auth user `newUserId` with the
 *       held email and name, `email_verified = true` and `role = 'user'` (what the `admin` plugin
 *       writes for a new user), then the binding `(app_id, open_id_hmac, newUserId)` (no
 *       open_id), and commits, naming the new user;
 *    c. when the insert of the user violates `user_email_unique` (a local user already holds the
 *       email), it rolls back to the savepoint and commits only the consumption (`conflict`:
 *       nothing is merged, no user is created or changed, no binding is written);
 *    d. any other failure of the two inserts (including a violation of
 *       `feishu_identities_app_open_id_hmac_unique`, which only a writer bypassing the identity
 *       lock could cause) rolls the whole transaction back — the user, the binding and the
 *       consumption, so the row stays `active` — and throws `FEISHU_LOGIN_ACCOUNT_CREATE_FAILED`
 *       without the database error (its detail may name the email).
 * Because of the row lock, two transactions that lock the same row run one after the other: when
 * the first one consumed the row and committed, the second one reads it as `consumed` and is
 * `invalid` (if the first one rolled back, the second one goes on). Two first logins of the same
 * member through different rows (two flows) meet at the identity lock: the one that takes it
 * second waits until the first one has committed or rolled back, then finds the binding the first
 * one committed (or, after a rollback, creates the account itself), so they create at most one
 * user and one binding for that member. The identity lock is the only advisory lock of this
 * transaction and is taken after its only row lock of `feishu_login_codes`; a holder of it waits
 * for no lock of `feishu_login_codes` and for no flow, email or global lock (it can only wait for
 * a concurrent insert of the same email into `user` by a transaction that does not wait for it),
 * so it adds no deadlock. The open_id leaves the row only as its HMAC; nothing else of the hold is
 * returned.
 */
export async function consumeFeishuLoginCode(
  pool: Pool,
  input: FeishuLoginConsumeInput,
): Promise<FeishuLoginConsumeResult> {
  assertHex(input?.flowHash, "INVALID_FEISHU_LOGIN_FLOW_HASH");
  assertKey(input.otpHmacKey);
  if (typeof input.code !== "string" || input.code === "") throw new Error("INVALID_FEISHU_LOGIN_CODE");
  assertText(input.appId, "INVALID_FEISHU_LOGIN_APP_ID");
  if (typeof input.openIdHmac !== "function") throw new Error("INVALID_FEISHU_LOGIN_OPEN_ID_HMAC");
  const newUserId = input.newUserId;
  if (newUserId !== undefined) assertText(newUserId, "INVALID_FEISHU_LOGIN_NEW_USER_ID");
  try {
    return await inTransaction(pool, async (client) => {
      // FSL-152: fixed to READ COMMITTED whatever the database or session default is, so every
      // statement below reads with a fresh snapshot: the binding read again after the identity
      // lock sees a binding a concurrent first login committed while this transaction waited.
      await client.query("set transaction isolation level read committed");
      // The row lock comes first, in a statement of its own, so everything below is read after any
      // wait for it. It names no column but the id.
      const locked = await client.query<{ id: string }>(
        `select id from feishu_login_codes
          where flow_hash = $1
          order by flow_seq desc
          limit 1
            for update`,
        [input.flowHash],
      );
      const lockedId = locked.rows[0]?.id;
      if (lockedId === undefined) return { kind: "invalid" } as const;
      // The locked row, read again. Its code HMAC is only returned while it is an unexpired
      // `active` row (decided against one clock sample), still the newest row of its flow in this
      // statement's snapshot (a newer row committed after the lock statement's snapshot but before
      // this one supersedes it) and below the failure limit, so this statement returns no sensitive
      // field of a row expired at its clock sample; the email, open_id and name are only read once
      // the code matched.
      const current = await client.query<{
        id: string;
        state: string;
        live: boolean;
        superseded: boolean;
        failed_attempts: number;
        code_hmac: string | null;
      }>(
        `select c.id, c.state, t.live, t.superseded, c.failed_attempts,
                case when c.state = 'active' and t.live and not t.superseded and c.failed_attempts < $2
                     then c.code_hmac end as code_hmac
           from feishu_login_codes c
           cross join lateral (
             select c.expires_at > clock_timestamp() as live,
                    exists (select 1 from feishu_login_codes n
                             where n.flow_hash = c.flow_hash and n.flow_seq > c.flow_seq) as superseded
           ) t
          where c.id = $1`,
        [lockedId, FEISHU_LOGIN_MAX_FAILED_ATTEMPTS],
      );
      const row = current.rows[0];
      if (
        !row ||
        row.state !== "active" ||
        !row.live ||
        row.superseded ||
        row.failed_attempts >= FEISHU_LOGIN_MAX_FAILED_ATTEMPTS
      ) {
        return { kind: "invalid" } as const;
      }
      if (!codeHmacMatches(feishuLoginCodeHmac(input.otpHmacKey, row.id, input.code), row.code_hmac)) {
        // A wrong code is counted; the one that reaches the limit voids the row and clears its
        // hold in the same statement (FSL-119 CHECK). `SET` reads the old `failed_attempts`.
        await client.query(
          `update feishu_login_codes
              set failed_attempts = failed_attempts + 1,
                  state = case when failed_attempts + 1 >= $2 then 'void' else state end,
                  email = case when failed_attempts + 1 >= $2 then null else email end,
                  open_id = case when failed_attempts + 1 >= $2 then null else open_id end,
                  display_name = case when failed_attempts + 1 >= $2 then null else display_name end,
                  code_hmac = case when failed_attempts + 1 >= $2 then null else code_hmac end
            where id = $1 and state = 'active'`,
          [row.id, FEISHU_LOGIN_MAX_FAILED_ATTEMPTS],
        );
        return { kind: "invalid" } as const;
      }
      // The hold (email, open_id, name) is read only now, and only while the row is still an
      // unexpired `active` one at this statement's clock sample: a row expired by then is not
      // read (one that expires after it is still not consumed: the update repeats the check). The
      // binding lookup below needs the open_id; the email and the name are what the account
      // creation (FSL-125) writes.
      const held = await client.query<{ email: string | null; open_id: string | null; display_name: string | null }>(
        `select email, open_id, display_name from feishu_login_codes
          where id = $1 and state = 'active' and expires_at > clock_timestamp()`,
        [row.id],
      );
      const hold = held.rows[0];
      if (
        !hold ||
        typeof hold.open_id !== "string" ||
        typeof hold.email !== "string" ||
        typeof hold.display_name !== "string"
      ) {
        return { kind: "invalid" } as const;
      }
      const { open_id: openId, email, display_name: displayName } = hold;
      const consumed = await client.query(
        `update feishu_login_codes
            set state = 'consumed', email = null, open_id = null, display_name = null, code_hmac = null
          where id = $1 and state = 'active' and expires_at > clock_timestamp()`,
        [row.id],
      );
      if (consumed.rowCount !== 1) return { kind: "invalid" } as const;
      const openIdHmac = input.openIdHmac(openId);
      assertHex(openIdHmac, "INVALID_FEISHU_LOGIN_OPEN_ID_HMAC");
      const binding = await client.query<{ user_id: string }>(
        "select user_id from feishu_identities where app_id = $1 and open_id_hmac = $2",
        [input.appId, openIdHmac],
      );
      const userId = binding.rows[0]?.user_id;
      if (userId !== undefined) return { kind: "consumed", userId } as const;
      if (newUserId === undefined) throw UNBOUND;
      // First login (FSL-152): the first logins of one member are serialized by its identity lock,
      // and the binding is read again after it, so a concurrent first login that committed the
      // binding meanwhile is found here instead of creating a second user.
      await client.query("select pg_advisory_xact_lock($1::int4, $2::int4)", [
        FEISHU_LOGIN_IDENTITY_LOCK_CLASS,
        feishuLoginIdentityLockKey(openIdHmac),
      ]);
      const rebound = await client.query<{ user_id: string }>(
        "select user_id from feishu_identities where app_id = $1 and open_id_hmac = $2",
        [input.appId, openIdHmac],
      );
      const lockedUserId = rebound.rows[0]?.user_id;
      if (lockedUserId !== undefined) return { kind: "consumed", userId: lockedUserId } as const;
      // FSL-125: the account and its binding, in this transaction, so they commit with the
      // consumption or not at all. FSL-152: a local user that already holds the email is not
      // merged; only the account creation is rolled back (to the savepoint) and the consumption
      // commits. Any other failure rolls everything back. No database error of these inserts is
      // reported (its detail may name the email).
      await client.query(`savepoint ${ACCOUNT_SAVEPOINT}`);
      let creation: "created" | "conflict" | "failed" = "created";
      try {
        await client.query(
          `insert into "user" (id, name, email, email_verified, role) values ($1, $2, $3, true, 'user')`,
          [newUserId, displayName, email],
        );
        await client.query(
          "insert into feishu_identities (app_id, open_id_hmac, user_id) values ($1, $2, $3)",
          [input.appId, openIdHmac, newUserId],
        );
      } catch (error) {
        creation = isEmailConflict(error) ? "conflict" : "failed";
      }
      // The database error is dropped on purpose (not even as a cause): its detail may name the
      // email. Throwing rolls the whole transaction back.
      if (creation === "failed") throw new Error(FEISHU_LOGIN_ACCOUNT_CREATE_FAILED);
      if (creation === "conflict") {
        await client.query(`rollback to savepoint ${ACCOUNT_SAVEPOINT}`);
        return { kind: "conflict" } as const;
      }
      await client.query(`release savepoint ${ACCOUNT_SAVEPOINT}`);
      return { kind: "consumed", userId: newUserId } as const;
    });
  } catch (error) {
    if (error === UNBOUND) return { kind: "unbound" };
    throw error;
  }
}

/**
 * Marks a Better Auth session as issued by the Feishu login (FSL-147 `feishu_login_sessions`):
 * one row holding only the session ID; it disappears with its session.
 */
export async function recordFeishuLoginSession(pool: Pool, sessionId: string): Promise<void> {
  assertText(sessionId, "INVALID_FEISHU_LOGIN_SESSION_ID");
  await pool.query("insert into feishu_login_sessions (session_id) values ($1)", [sessionId]);
}

/** The purpose label of the key fingerprint of `feishu_login_key_check` (FSL-159, FSL-161). */
export const FEISHU_LOGIN_KEY_CHECK_LABEL = "feishu-login-key-check:v1:";

/**
 * HMAC-SHA256(key, "feishu-login-key-check:v1:" + appId) as 64 lowercase hex characters: the
 * fingerprint of `ENTERPRISE_OTP_HMAC_KEY` and `FEISHU_APP_ID` kept in `feishu_login_key_check`
 * (FSL-159). Either one changing changes it; the key itself never reaches the table.
 */
export function feishuLoginKeyFingerprint(key: Uint8Array, appId: string): string {
  assertKey(key);
  if (typeof appId !== "string" || appId === "") throw new Error("INVALID_FEISHU_LOGIN_APP_ID");
  return createHmac("sha256", key).update(FEISHU_LOGIN_KEY_CHECK_LABEL + appId, "utf8").digest("hex");
}

/**
 * FSL-161: the fingerprint stored in `feishu_login_key_check`, writing `keyCheck` first when the
 * table is empty. One statement inserts the row `(1, keyCheck)` unless a row exists (never
 * overwriting it) and returns the stored value, so the first caller of a deployment records its
 * fingerprint and every later caller reads it back. The caller compares the result with its own
 * fingerprint; this function never decides.
 *
 * Only when a concurrent first insert commits while this statement runs does the statement return
 * no row (its snapshot predates that row); the statement then runs once more and reads it. A
 * second empty result, or any database error, is thrown.
 */
export async function ensureKeyCheck(pool: Pool, keyCheck: string): Promise<string> {
  assertHex(keyCheck, "INVALID_FEISHU_LOGIN_KEY_CHECK");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await pool.query<{ key_check: string }>(
      `with inserted as (
         insert into feishu_login_key_check (id, key_check) values (1, $1)
         on conflict (id) do nothing
         returning key_check
       )
       select key_check from inserted
       union all
       select key_check from feishu_login_key_check where id = 1`,
      [keyCheck],
    );
    const stored = result.rows[0]?.key_check;
    if (typeof stored === "string") return stored;
  }
  throw new Error("FEISHU_LOGIN_KEY_CHECK_UNAVAILABLE");
}

/** A row created more than this many seconds ago is deleted by the cleanup (FSL-146). */
export const FEISHU_LOGIN_CODE_RETENTION_SECONDS = 24 * 60 * 60;
/**
 * The cleanup waits at most this long for each row lock held by another transaction (the
 * PostgreSQL `lock_timeout`, per lock acquisition, not cumulative); past it the run fails (and is
 * retried by the next period) instead of hanging behind a stuck transaction.
 */
export const FEISHU_LOGIN_CLEANUP_LOCK_TIMEOUT_MS = 10_000;

export interface FeishuLoginCleanupOptions {
  /**
   * The instant the cleanup decides against. Defaults to the database clock
   * (`clock_timestamp()`, the clock every `expires_at` and `created_at` is written with); only
   * tests inject it.
   */
  readonly now?: Date;
  /** Overrides `FEISHU_LOGIN_CLEANUP_LOCK_TIMEOUT_MS`; only tests shorten it. */
  readonly lockTimeoutMs?: number;
}

export interface FeishuLoginCleanupResult {
  /** Expired `reserved` or `active` rows turned `void`, their sensitive fields cleared. */
  readonly voided: number;
  /** Rows created more than `FEISHU_LOGIN_CODE_RETENTION_SECONDS` ago, deleted. */
  readonly deleted: number;
}

/**
 * The expiry cleanup of `feishu_login_codes` (FSL-146, ADR-FSL-11 "本地数据与清理"), one
 * transaction holding one statement:
 * - a `reserved` or `active` row whose `expires_at` has passed (`expires_at <= now`) turns
 *   `void` and its email, open_id, name and code HMAC are cleared in the same write;
 * - a row created more than 24 hours ago (`created_at < now - 24h`), whatever its state, is
 *   deleted.
 * The two sets are disjoint by `created_at`, so no row is both updated and deleted.
 *
 * Every instance runs it on its own and it is idempotent. The due rows are locked in id order
 * (`order by id for update`), the same order in which an activation, or the void write-back of a
 * delivery (FSL-154), locks the rows of one email (every other writer of the table locks a single row), so the cleanup never deadlocks with a
 * login transaction or with another cleanup. A row another transaction holds is waited for (at
 * most `FEISHU_LOGIN_CLEANUP_LOCK_TIMEOUT_MS`) rather than skipped, so a due row is handled by
 * this run as soon as that transaction ends: once locked, each candidate is re-checked against
 * its newest version (READ COMMITTED), so a row consumed, voided or deleted meanwhile (by a
 * login or by a concurrent cleanup) is left alone and counted by nobody twice.
 */
export async function cleanupFeishuLoginCodes(
  pool: Pool,
  options: FeishuLoginCleanupOptions = {},
): Promise<FeishuLoginCleanupResult> {
  const now = options.now;
  if (now !== undefined && !(now instanceof Date && Number.isFinite(now.getTime()))) {
    throw new Error("INVALID_FEISHU_LOGIN_CLEANUP_NOW");
  }
  const lockTimeoutMs = options.lockTimeoutMs ?? FEISHU_LOGIN_CLEANUP_LOCK_TIMEOUT_MS;
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
    throw new Error("INVALID_FEISHU_LOGIN_CLEANUP_LOCK_TIMEOUT");
  }
  return inTransaction(pool, async (client) => {
    await client.query("select set_config('lock_timeout', $1, true)", [`${lockTimeoutMs}ms`]);
    const result = await client.query<{ voided: number; deleted: number }>(
      `with t as (
         select coalesce($1::timestamptz, clock_timestamp()) as at
       ), due as (
         select c.id, c.created_at < t.at - make_interval(secs => $2::int) as stale
           from feishu_login_codes c, t
          where c.created_at < t.at - make_interval(secs => $2::int)
             or (c.state in ('reserved', 'active') and c.expires_at <= t.at)
          order by c.id
            for update of c
       ), voided as (
         update feishu_login_codes c
            set state = 'void', email = null, open_id = null, display_name = null, code_hmac = null
           from due
          where c.id = due.id and not due.stale and c.state in ('reserved', 'active')
         returning c.id
       ), deleted as (
         delete from feishu_login_codes c
          using due
          where c.id = due.id and due.stale
         returning c.id
       )
       select (select count(*) from voided)::int as voided,
              (select count(*) from deleted)::int as deleted`,
      [now === undefined ? null : now.toISOString(), FEISHU_LOGIN_CODE_RETENTION_SECONDS],
    );
    const row = result.rows[0];
    return { voided: row?.voided ?? 0, deleted: row?.deleted ?? 0 };
  });
}
