// megaui-only (FS-83): same-flow pairing status contract.
import { createHash } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPAQUE_FLOW = /^[A-Za-z0-9_-]{43}$/;

function canonicalOpaque(value: unknown): value is string {
  if (typeof value !== "string" || !OPAQUE_FLOW.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value;
}

export type EnterprisePairingStatusPortResult =
  | { readonly kind: "pending" }
  | { readonly kind: "confirmed"; readonly challengeId: string }
  | { readonly kind: "expired" }
  | { readonly kind: "not-found" }
  | { readonly kind: "unavailable" };

export type EnterprisePairingStatusPort = (input: {
  readonly pairingId: string;
  readonly flowHash: string;
}) => Promise<EnterprisePairingStatusPortResult>;

export type EnterprisePairingStatusResult =
  | { readonly kind: "pending"; readonly status: "pending" }
  | { readonly kind: "confirmed"; readonly status: "confirmed"; readonly challengeId: string }
  | { readonly kind: "expired"; readonly status: "expired" }
  | { readonly kind: "not-found" }
  | { readonly kind: "invalid-input" }
  | { readonly kind: "unavailable" };

/**
 * Validate and hash the preauth flow at the auth boundary, then expose only
 * the deliberately opaque status projection returned by the scoped port.
 */
export function createEnterprisePairingStatus(port: EnterprisePairingStatusPort) {
  if (typeof port !== "function") throw new Error("INVALID_ENTERPRISE_PAIRING_STATUS_PORT");
  return async (input: { readonly pairingId: unknown; readonly flow: unknown }): Promise<EnterprisePairingStatusResult> => {
    const pairingId = typeof input?.pairingId === "string" ? input.pairingId : "";
    if (!input || typeof input !== "object" || Array.isArray(input)
      || !UUID.test(pairingId)
      || !canonicalOpaque(input.flow)) return { kind: "invalid-input" };
    try {
      const result = await port({
        pairingId,
        flowHash: createHash("sha256").update(input.flow, "utf8").digest("hex"),
      });
      if (result?.kind === "pending") return { kind: "pending", status: "pending" };
      if (result?.kind === "expired") return { kind: "expired", status: "expired" };
      if (result?.kind === "confirmed" && UUID.test(result.challengeId)) {
        return { kind: "confirmed", status: "confirmed", challengeId: result.challengeId };
      }
      if (result?.kind === "not-found") return { kind: "not-found" };
      return { kind: "unavailable" };
    } catch {
      return { kind: "unavailable" };
    }
  };
}
