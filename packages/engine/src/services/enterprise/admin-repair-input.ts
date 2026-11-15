// megaui-only (FS-38): pure, bounded approval inputs; never reads deployment credentials.
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalizeJson } from "../../cli/admin-payload";
import { validMigrationIdentifier } from "./manifest";

export const ADMIN_REPAIR_MAX_BYTES = 1024 * 1024;
export class AdminRepairInputError extends Error {
  constructor(readonly key: "INVALID_ARGUMENT" | "INVALID_CONFIG" = "INVALID_ARGUMENT") {
    super(key); this.name = "AdminRepairInputError";
  }
}
const identifier = z.string().refine(validMigrationIdentifier);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const reason = z.string().refine(value => value.trim() !== "" && [...value].length <= 1024 && !value.includes("\0") &&
  ![...value].some(char => { const point = char.codePointAt(0)!; return point >= 0xd800 && point <= 0xdfff; }));
const quarantineSchema = z.object({ local_user_id: identifier, reason, expected_user_version: hash }).strict();
const repairSchema = z.object({
  local_user_id: identifier, tenant_key: identifier, app_id: identifier, open_id: identifier,
  login_name: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/), expected_user_version: hash,
  expected_identity_version: z.number().int().min(0).max(2147483647), expected_profile_digest: hash,
  expected_quarantine_operation_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
}).strict();
export type QuarantineMember = Readonly<z.infer<typeof quarantineSchema>>;
export type RepairMember = Readonly<z.infer<typeof repairSchema>>;

function decode(bytes: Uint8Array | undefined): unknown {
  if (!bytes || bytes.byteLength > ADMIN_REPAIR_MAX_BYTES) throw new AdminRepairInputError();
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export function parseQuarantineManifest(bytes: Uint8Array | undefined): readonly QuarantineMember[] {
  try {
    const members = z.array(quarantineSchema).max(100).parse(decode(bytes));
    if (new Set(members.map(row => row.local_user_id)).size !== members.length) throw new AdminRepairInputError();
    return Object.freeze(members.map(row => Object.freeze(row)));
  } catch { throw new AdminRepairInputError(); }
}

export function parseRepairManifest(bytes: Uint8Array | undefined): readonly RepairMember[] {
  try {
    const members = z.array(repairSchema).min(1).max(100).parse(decode(bytes)), first = members[0]!;
    if (["local_user_id", "open_id", "login_name"].some(key =>
      new Set(members.map(row => row[key as keyof RepairMember])).size !== members.length) ||
      members.some(row => row.tenant_key !== first.tenant_key || row.app_id !== first.app_id)) throw new AdminRepairInputError();
    return Object.freeze(members.map(row => Object.freeze(row)));
  } catch { throw new AdminRepairInputError(); }
}

/** Call only with the strict parsed manifest; file SHA is separately bound by FS-80. */
export function adminRepairDigest(members: readonly QuarantineMember[] | readonly RepairMember[]): string {
  return createHash("sha256").update(canonicalizeJson(members)).digest("hex");
}

/** pg URL parameters override Pool options, so constrain the effective client budgets here. */
export function boundedRepairConnectionString(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("protocol");
    for (const [name, limit] of [["query_timeout", 5000], ["connect_timeout", 5]] as const) {
      let budget: number = limit;
      for (const raw of url.searchParams.getAll(name)) {
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error("timeout");
        if (Number(raw) > 0) budget = Math.min(budget, Number(raw));
      }
      url.searchParams.set(name, String(budget));
    }
    return url.toString();
  } catch { throw new AdminRepairInputError("INVALID_CONFIG"); }
}
