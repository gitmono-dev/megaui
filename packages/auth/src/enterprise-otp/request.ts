// megaui-only (FS-11): package-internal request admission; HTTP is owned by FS-73.
import { createHash, randomBytes } from "node:crypto";
import { parseEnterpriseLoginName } from "./input";
import type { EnterprisePairingPort, EnterprisePairingRequestResult, EnterprisePairingTransport } from "./types";

function canonicalOpaque(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 43 || /[^A-Za-z0-9_-]/.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value;
}

/** Only this auth boundary parses complete alias syntax; the port receives validated text. */
export function createEnterprisePairingRequest(port: EnterprisePairingPort) {
  if (typeof port !== "function") throw new Error("INVALID_ENTERPRISE_PAIRING_PORT");
  return async (input: { readonly alias: unknown; readonly flow?: unknown; readonly transport: EnterprisePairingTransport }): Promise<EnterprisePairingRequestResult> => {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => !["alias", "flow", "transport"].includes(key))) return { kind: "invalid-input" };
    const loginName = parseEnterpriseLoginName(input.alias);
    if (loginName === null || (input.flow !== undefined && !canonicalOpaque(input.flow))) return { kind: "invalid-input" };
    try {
      const rawFlow = input.flow === undefined ? randomBytes(32).toString("base64url") : input.flow as string;
      const result = await port({ loginName, transport: input.transport,
        flowHash: createHash("sha256").update(rawFlow, "utf8").digest("hex") });
      if (result?.kind === "rate-limited" && result.status === 429 && result.code === "RATE_LIMITED") {
        return { kind: "rate-limited", status: 429, code: "RATE_LIMITED" };
      }
      if (result?.kind !== "accepted" || result.status !== 202) return { kind: "unavailable" };
      const body = result.body;
      if (!body || typeof body.pairingId !== "string" || body.pairingId.length !== 36
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.pairingId)
        || !canonicalOpaque(body.pairingToken) || body.expiresIn !== 120 || body.resendAfter !== 60) return { kind: "unavailable" };
      return { kind: "accepted", status: 202,
        body: { pairingId: body.pairingId, pairingToken: body.pairingToken, expiresIn: 120, resendAfter: 60 },
        cookie: { name: "__Host-megaui.enterprise-flow", value: rawFlow, path: "/",
          httpOnly: true, secure: true, sameSite: "lax", maxAge: 600 } };
    } catch { return { kind: "unavailable" }; }
  };
}
