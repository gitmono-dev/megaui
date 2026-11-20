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
import { createHmac, randomUUID } from "node:crypto";
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
