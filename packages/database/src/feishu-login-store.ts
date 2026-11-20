// megaui-only (FSL-122): the PostgreSQL transactions behind issuing a Feishu login code.
//
// The engine issue service (`packages/engine/src/services/feishu-login/issue.ts`) owns the
// Feishu calls; this module owns the rows of `feishu_login_codes` and the HMAC rules that
// decide what is stored. The email and the code only ever reach the table as keyed HMACs,
// except for the short-lived hold of an `active` row (ADR-FSL-11, FSL-119 two-way CHECK).
//
// Five transactions, none of which spans a Feishu call:
// - `reserve` takes the email lock, then the global lock (FSL-145), decides the cooldown and
//   the global budget while holding both, and only when both pass writes the `reserved` row
//   of one request and commits; a refused request writes nothing;
// - `beginDelivery` runs before the first Feishu call of a reservation: an expired one is
//   voided and nothing may be called (FSL-145);
// - `activate` serializes one email with a transaction-scoped advisory lock and locks this
//   row `FOR UPDATE`; only an unexpired `reserved` row with no reservation of a larger
//   `email_seq` for the same email HMAC is activated (FSL-149): every `active` row of that
//   email HMAC (whatever its flow) is voided clearing its sensitive fields in the same
//   statement, then this row turns `active` with the email, open_id, name and code HMAC.
//   An expired or superseded reservation is voided instead and nothing else changes;
// - `voidReservation` has the same shape and turns this row `void`;
// - `voidRejectedSend` writes back a send that Feishu rejected on every attempt: a
//   conditional update that only voids the row while it is still `active` and unexpired.
//
// Outside those transactions, `cleanupFeishuLoginCodes` (FSL-146) is the expiry cleanup that the
// engine scheduler runs on every Web instance: one statement that voids the expired `reserved`
// and `active` rows, clearing their sensitive fields, and deletes the rows created more than 24
// hours ago.
//
// The verify side (FSL-124, FSL-151) is `consumeFeishuLoginCode`: one transaction that locks the
// newest row of a flow `FOR UPDATE`, compares the code HMAC in constant time, counts a wrong code
// (the fifth one voids the row clearing its sensitive fields) or consumes the row clearing its
// sensitive fields and looks up the identity binding before it commits; and
// `recordFeishuLoginSession`, which marks a session as issued by the Feishu login (FSL-147).
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
 * The global advisory lock of every reservation ("FSL" + 0x02, key 0), taken after the email
 * lock (FSL-145): reservations of all emails, on all instances, decide the global budget one
 * after another.
 */
export const FEISHU_LOGIN_GLOBAL_LOCK_CLASS = 0x46534c02;
export const FEISHU_LOGIN_GLOBAL_LOCK_KEY = 0;

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

export type FeishuLoginReserveResult =
  | { readonly kind: "reserved"; readonly id: string }
  /** A concurrent reservation took the same order number; the request is retried. */
  | { readonly kind: "retry" }
  /** The email HMAC already has a reservation of the last 60 seconds; nothing was written. */
  | { readonly kind: "cooldown" }
  /** 120 reservations of the last 60 seconds exist (all emails); nothing was written. */
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
          // The email lock serializes this reservation with every activation of the email:
          // a reservation can not commit between an activation's "no larger email_seq"
          // check and its activating write. Each order number is then the current maximum
          // plus one under that lock. The unique indexes of FSL-163 remain as a defence in
          // depth: a writer that would bypass the lock and read the same maximum collides,
          // and the later committer fails instead of sharing an order number.
          await lockEmail(client, input.emailHmac);
          // FSL-145: the global lock, always after the email lock (activations only take the
          // email lock, so the order never deadlocks). Every reservation of every email and
          // instance decides the budget under it, so two of them never both see the last
          // free slot. Both locks are released by the commit, before any Feishu call.
          await client.query("select pg_advisory_xact_lock($1::int4, $2::int4)", [
            FEISHU_LOGIN_GLOBAL_LOCK_CLASS,
            FEISHU_LOGIN_GLOBAL_LOCK_KEY,
          ]);
          // The creation time is read once after both locks (`clock_timestamp()`, not the
          // transaction start `now()`), so waiting for a lock never shortens the two-minute
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
          // A refused request writes nothing: it never extends the cooldown and never takes a
          // slot of the budget, so retrying does not delay the recovery of either.
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
        await lockEmail(client, input.emailHmac);
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
        await lockEmail(client, input.emailHmac);
        // Every row lock this transaction needs (this row and every active row of the email,
        // which the activation voids) is taken by a statement of its own, before the check:
        // the state and the newest reservation are read by the next statement, after any wait
        // for those locks, and the updates below never wait again. Only an activation, under
        // this email lock, makes a row active, so no new active row appears meanwhile.
        // `email_seq` follows the commit order of the reservations (the unique index of
        // FSL-163 fails a later committer that read the same maximum), so a larger one is a
        // later request whatever the timestamps say. The expiry is read with
        // `clock_timestamp()`, never the transaction start `now()`, and it is checked again by
        // the activating update itself, so an expiry that passes at any point before that
        // write still prevents the activation.
        await client.query(
          `select 1 from feishu_login_codes
            where email_hmac = $2 and (id = $1 or state = 'active')
            order by id
            for update`,
          [input.id, input.emailHmac],
        );
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
        await lockEmail(client, input.emailHmac);
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
        await lockEmail(client, input.emailHmac);
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
}

/** A row turns `void` with the wrong code that brings `failed_attempts` to this value (FSL-151). */
export const FEISHU_LOGIN_MAX_FAILED_ATTEMPTS = 5;

export type FeishuLoginConsumeResult =
  /** The row is now `consumed` with its sensitive fields cleared; the binding names the user. */
  | { readonly kind: "consumed"; readonly userId: string }
  /**
   * The code was not accepted: the flow has no row, its newest row is not an unexpired `active`
   * row (or has already reached the failure limit), or the code does not match. Only a mismatch
   * changes the row: its `failed_attempts` grows by one, and the mismatch that brings it to
   * `FEISHU_LOGIN_MAX_FAILED_ATTEMPTS` also turns it `void` with its sensitive fields cleared.
   */
  | { readonly kind: "invalid" }
  /**
   * The code matched but `(app_id, open_id_hmac)` has no binding: the transaction was rolled
   * back, so the row is still `active` (account creation is FSL-125).
   */
  | { readonly kind: "unbound" };

/** Thrown inside the consume transaction to roll it back when no binding exists. */
const UNBOUND = Symbol("FEISHU_LOGIN_UNBOUND");

function codeHmacMatches(expectedHex: string, storedHex: unknown): boolean {
  // Both sides are 32-byte digests; a stored value of another shape can never match, and the
  // comparison of two equal-length buffers takes the same time wherever they differ.
  if (typeof storedHex !== "string" || !HEX_64.test(storedHex)) return false;
  return timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(storedHex, "hex"));
}

/**
 * Verify (FSL-124 success path, FSL-151 failure path and concurrency; ADR-FSL-11 「校验」), one
 * transaction:
 * 1. locks the row of the largest `flow_seq` of the flow (whatever its state) with
 *    `SELECT … FOR UPDATE`, in a statement of its own. It is the only row of `feishu_login_codes`
 *    the transaction locks (the cleanup and the activation, which lock several, do so in id
 *    order). A concurrent verify that selects the same row waits here until this transaction ends;
 * 2. reads the locked row again in the next statement (so after any lock wait, against its
 *    newest committed version and one `clock_timestamp()` sample). Only an `active` row that is
 *    unexpired (`expires_at > clock_timestamp()`), still the largest `flow_seq` of its flow in
 *    that statement's snapshot and below `FEISHU_LOGIN_MAX_FAILED_ATTEMPTS` goes on, and that
 *    statement returns the code HMAC only for such a row; anything else is `invalid` and changes
 *    nothing. A newer row of the flow committed after that statement started is not seen by this
 *    transaction (voiding the flow's newest row when a new one is reserved, which waits for this
 *    lock, is FSL-154);
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
 *    result names the bound user. Not found: the transaction is rolled back (`unbound`).
 * Because of the lock, two transactions that lock the same row run one after the other: when the
 * first one consumed the row and committed, the second one reads it as `consumed` and is `invalid`
 * (if the first one rolled back, the second one goes on). The open_id leaves the row only as its HMAC; nothing
 * else of the hold is returned.
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
  try {
    return await inTransaction(pool, async (client) => {
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
      // read (one that expires after it is still not consumed: the update repeats the check). The binding lookup below needs the open_id; the email and the name are what
      // the account creation of FSL-125 builds on.
      const held = await client.query<{ email: string | null; open_id: string | null; display_name: string | null }>(
        `select email, open_id, display_name from feishu_login_codes
          where id = $1 and state = 'active' and expires_at > clock_timestamp()`,
        [row.id],
      );
      const hold = held.rows[0];
      if (!hold || typeof hold.open_id !== "string") return { kind: "invalid" } as const;
      const openId = hold.open_id;
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
      if (userId === undefined) throw UNBOUND;
      return { kind: "consumed", userId } as const;
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
 * (`order by id for update`), the same order in which an activation locks the rows of one email
 * (every other writer of the table locks a single row), so the cleanup never deadlocks with a
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
