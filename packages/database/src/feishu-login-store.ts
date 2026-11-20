// megaui-only (FSL-122): the PostgreSQL transactions behind issuing a Feishu login code.
//
// The engine issue service (`packages/engine/src/services/feishu-login/issue.ts`) owns the
// Feishu calls; this module owns the rows of `feishu_login_codes` and the HMAC rules that
// decide what is stored. The email and the code only ever reach the table as keyed HMACs,
// except for the short-lived hold of an `active` row (ADR-FSL-11, FSL-119 two-way CHECK).
//
// Three transactions, none of which spans a Feishu call:
// - `reserve` writes the `reserved` row of one request and commits;
// - `activate` serializes one email with a transaction-scoped advisory lock, voids every
//   `active` row of that email HMAC (whatever its flow) clearing its sensitive fields in the
//   same statement, then turns this row `active` with the email, open_id, name and code HMAC;
// - `voidReservation` has the same shape and turns this row `void`.
// The state checks before activation (expiry, newest reservation) belong to FSL-149, and the
// cooldown, the global budget and the email lock around the reservation to FSL-145.
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
  | { readonly kind: "retry" };

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

export type FeishuLoginActivateResult =
  | { readonly kind: "active" }
  /** The row was no longer `reserved`; nothing changed and nothing may be sent. */
  | { readonly kind: "not_reserved" };

export interface FeishuLoginVoidInput {
  readonly id: string;
  readonly emailHmac: string;
}

export interface FeishuLoginCodeStore {
  readonly reserve: (input: FeishuLoginReserveInput) => Promise<FeishuLoginReserveResult>;
  readonly activate: (input: FeishuLoginActivateInput) => Promise<FeishuLoginActivateResult>;
  readonly voidReservation: (input: FeishuLoginVoidInput) => Promise<void>;
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

/** Raised inside a transaction to roll it back without failing the caller. */
class Rollback extends Error {}

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
      try {
        await inTransaction(pool, async (client) => {
          // Each order number is the current maximum plus one. Two concurrent reservations
          // that read the same maximum collide on the unique indexes of FSL-163, and the
          // later committer fails instead of sharing an order number.
          await client.query(
            `insert into feishu_login_codes
               (id, flow_hash, flow_seq, email_hmac, email_seq, state, expires_at, created_at)
             select $1::uuid, $2::text,
               coalesce((select max(flow_seq) from feishu_login_codes where flow_hash = $2::text), 0) + 1,
               $3::text,
               coalesce((select max(email_seq) from feishu_login_codes where email_hmac = $3::text), 0) + 1,
               'reserved', now() + make_interval(secs => $4::int), now()`,
            [id, input.flowHash, input.emailHmac, FEISHU_LOGIN_RESERVATION_TTL_SECONDS],
          );
        });
      } catch (error) {
        if ((error as { code?: unknown }).code === UNIQUE_VIOLATION) return { kind: "retry" };
        throw error;
      }
      return { kind: "reserved", id };
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
      try {
        return await inTransaction(pool, async (client) => {
          await lockEmail(client, input.emailHmac);
          // Only one code per email is usable: every active row of this email HMAC, in
          // any flow, is voided and cleared in the same statement (FSL-119 CHECK).
          await client.query(
            `update feishu_login_codes
                set state = 'void', email = null, open_id = null, display_name = null, code_hmac = null
              where email_hmac = $1 and state = 'active' and id <> $2`,
            [input.emailHmac, input.id],
          );
          const activated = await client.query(
            `update feishu_login_codes
                set state = 'active', email = $3, open_id = $4, display_name = $5, code_hmac = $6,
                    expires_at = now() + make_interval(secs => $7::int)
              where id = $1 and email_hmac = $2 and state = 'reserved'`,
            [
              input.id,
              input.emailHmac,
              input.email,
              input.openId,
              input.displayName,
              input.codeHmac,
              FEISHU_LOGIN_CODE_TTL_SECONDS,
            ],
          );
          // A row that is no longer reserved can never come back to life; the voiding
          // above is rolled back with it, so a stale request changes nothing.
          if (activated.rowCount !== 1) throw new Rollback();
          return { kind: "active" } as const;
        });
      } catch (error) {
        if (error instanceof Rollback) return { kind: "not_reserved" };
        throw error;
      }
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
  };
}
