// megaui-only (FS-73): Better Auth endpoint for the bounded enterprise pairing request.
import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { createHash } from "node:crypto";

import { createEnterprisePairingRequest } from "./request";
import { createEnterprisePairingStatus } from "./status";
import type {
  EnterprisePairingPort,
  EnterprisePairingTransport,
  EnterpriseOtpGrant,
  EnterpriseOtpVerifyPort,
} from "./types";
import type { EnterprisePairingStatusPort } from "./status";
import { createEnterpriseSession } from "./verify";

const FLOW_COOKIE = "__Host-megaui.enterprise-flow";
const COOKIE_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const OPAQUE_FLOW = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PairingBody = { readonly alias: unknown };
type StatusBody = { readonly pairingId: unknown };
type VerifyBody = { readonly challengeId: unknown; readonly code: unknown };
type SchemaIssue = Readonly<{ readonly message: string; readonly path: readonly (string | number)[] }>;
type PairingBodySchema = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) =>
      | { readonly value: PairingBody }
      | { readonly issues: readonly SchemaIssue[] };
  };
};
type StatusBodySchema = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) =>
      | { readonly value: StatusBody }
      | { readonly issues: readonly SchemaIssue[] };
  };
};
type VerifyBodySchema = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) =>
      | { readonly value: VerifyBody }
      | { readonly issues: readonly SchemaIssue[] };
  };
};

// Keep auth independent of the app's zod dependency. Better-call consumes the
// Standard Schema protocol, so this strict schema is intentionally tiny.
const pairingBodySchema = {
  "~standard": {
    version: 1 as const,
    vendor: "megaui",
    validate(value: unknown) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { issues: [{ message: "Invalid request body", path: [] }] };
      }
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length !== 1 || !("alias" in record)) {
        return { issues: [{ message: "Invalid request body", path: [] }] };
      }
      return { value: { alias: record.alias } };
    },
  },
} satisfies PairingBodySchema;

const statusBodySchema = {
  "~standard": {
    version: 1 as const,
    vendor: "megaui",
    validate(value: unknown) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { issues: [{ message: "Invalid request body", path: [] }] };
      }
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length !== 1 || !("pairingId" in record)) {
        return { issues: [{ message: "Invalid request body", path: [] }] };
      }
      return { value: { pairingId: record.pairingId } };
    },
  },
} satisfies StatusBodySchema;

const verifyBodySchema = {
  "~standard": {
    version: 1 as const,
    vendor: "megaui",
    validate(value: unknown) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { issues: [{ message: "Invalid request body", path: [] }] };
      }
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length !== 2 || !Object.hasOwn(record, "challengeId") || !Object.hasOwn(record, "code")) {
        return { issues: [{ message: "Invalid request body", path: [] }] };
      }
      return { value: { challengeId: record.challengeId, code: record.code } };
    },
  },
} satisfies VerifyBodySchema;

export interface EnterprisePairingPluginOptions {
  readonly pairingPort: EnterprisePairingPort;
  readonly statusPort?: EnterprisePairingStatusPort;
  readonly resolveTransport: (request: Request) => EnterprisePairingTransport | null;
  readonly verifyPort?: EnterpriseOtpVerifyPort;
}

function invalidCookie(): "invalid" {
  return "invalid";
}

function hasControl(value: string): boolean {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

/** Parse only the HTTP Cookie grammar needed by this endpoint. */
export function parseEnterpriseFlowCookie(raw: string | null): string | undefined | "invalid" {
  if (raw === null) return undefined;
  if (raw.length === 0 || raw.length > 4096 || hasControl(raw)) return invalidCookie();
  const seen = new Set<string>();
  let selected: string | undefined;
  for (const part of raw.split(";")) {
    const item = part.trim();
    if (!item) return invalidCookie();
    const separator = item.indexOf("=");
    if (separator <= 0 || separator !== item.lastIndexOf("=")) return invalidCookie();
    const name = item.slice(0, separator);
    const value = item.slice(separator + 1);
    if (!COOKIE_TOKEN.test(name) || !/^[\x21-\x7e]*$/.test(value) || seen.has(name)) return invalidCookie();
    seen.add(name);
    if (name === FLOW_COOKIE) selected = value;
  }
  if (selected === undefined) return undefined;
  if (!OPAQUE_FLOW.test(selected)) return invalidCookie();
  return selected;
}

export function createEnterprisePairingPlugin(options: EnterprisePairingPluginOptions): BetterAuthPlugin {
  if (!options || typeof options.pairingPort !== "function" || typeof options.resolveTransport !== "function") {
    throw new Error("INVALID_ENTERPRISE_PAIRING_PLUGIN_CONFIG");
  }
  const pairingRequest = createEnterprisePairingRequest(options.pairingPort);
  const pairingStatus = options.statusPort ? createEnterprisePairingStatus(options.statusPort) : undefined;
  const verifyPort = options.verifyPort;
  return {
    id: "megaui-enterprise-pairing",
    version: "1",
    endpoints: {
      enterprisePairingRequest: createAuthEndpoint("/enterprise/request", {
        method: "POST",
        body: pairingBodySchema,
      }, async (ctx) => {
        const request = ctx.request;
        if (!request) { ctx.setStatus(503); return ctx.json({ error: "UNAVAILABLE" }); }
        const transport = options.resolveTransport(request);
        if (!transport) { ctx.setStatus(503); return ctx.json({ error: "UNAVAILABLE" }); }
        ctx.setHeader("cache-control", "no-store");
        const flow = parseEnterpriseFlowCookie(request.headers.get("cookie"));
        if (flow === "invalid") { ctx.setStatus(400); return ctx.json({ error: "INVALID_INPUT" }); }
        const body = ctx.body as PairingBody;
        const result = await pairingRequest({ alias: body.alias, flow, transport });
        if (result.kind === "accepted") {
          ctx.setCookie(result.cookie.name, result.cookie.value, {
            path: result.cookie.path,
            httpOnly: result.cookie.httpOnly,
            secure: result.cookie.secure,
            sameSite: result.cookie.sameSite,
            maxAge: result.cookie.maxAge,
          });
        }
        if (result.kind === "accepted") { ctx.setStatus(202); return ctx.json(result.body); }
        if (result.kind === "rate-limited") { ctx.setStatus(429); return ctx.json({ error: "RATE_LIMITED" }); }
        if (result.kind === "invalid-input") { ctx.setStatus(400); return ctx.json({ error: "INVALID_INPUT" }); }
        ctx.setStatus(503);
        return ctx.json({ error: "UNAVAILABLE" });
      }),
      ...(pairingStatus ? {
        enterprisePairingStatus: createAuthEndpoint("/enterprise/status", {
          method: "POST",
          body: statusBodySchema,
        }, async (ctx) => {
          const request = ctx.request;
          if (!request) { ctx.setStatus(503); return ctx.json({ error: "UNAVAILABLE" }); }
          ctx.setHeader("cache-control", "no-store");
          const flow = parseEnterpriseFlowCookie(request.headers.get("cookie"));
          if (flow === "invalid" || flow === undefined) { ctx.setStatus(400); return ctx.json({ error: "INVALID_INPUT" }); }
          const body = ctx.body as StatusBody;
          const result = await pairingStatus({ pairingId: body.pairingId, flow });
          if (result.kind === "pending" || result.kind === "confirmed" || result.kind === "expired") {
            ctx.setStatus(200);
            if (result.kind === "pending") return ctx.json({ status: result.status });
            if (result.kind === "expired") return ctx.json({ status: result.status });
            return ctx.json({ status: result.status, challengeId: result.challengeId });
          }
          if (result.kind === "not-found") { ctx.setStatus(404); return ctx.json({ error: "NOT_FOUND" }); }
          if (result.kind === "invalid-input") { ctx.setStatus(400); return ctx.json({ error: "INVALID_INPUT" }); }
          ctx.setStatus(503);
          return ctx.json({ error: "UNAVAILABLE" });
        }),
      } : {}),
      ...(verifyPort ? {
        enterpriseVerify: createAuthEndpoint("/enterprise/verify", {
          method: "POST",
          body: verifyBodySchema,
        }, async (ctx) => {
          const request = ctx.request;
          if (!request) { ctx.setStatus(503); return ctx.json({ error: "UNAVAILABLE" }); }
          ctx.setHeader("cache-control", "no-store");
          const flow = parseEnterpriseFlowCookie(request.headers.get("cookie"));
          if (flow === "invalid" || flow === undefined) { ctx.setStatus(400); return ctx.json({ error: "INVALID_INPUT" }); }
          const body = ctx.body as VerifyBody;
          if (typeof body.challengeId !== "string" || !UUID.test(body.challengeId)) {
            ctx.setStatus(400); return ctx.json({ error: "INVALID_INPUT" });
          }
          let result;
          try {
            result = await verifyPort({
              challengeId: body.challengeId,
              flowHash: createHash("sha256").update(flow, "utf8").digest("hex"),
              code: body.code,
            });
          } catch {
            ctx.setStatus(503); return ctx.json({ error: "UNAVAILABLE" });
          }
          if (result?.kind === "invalid") { ctx.setStatus(401); return ctx.json({ error: "INVALID_CREDENTIALS" }); }
          if (result?.kind !== "accepted") { ctx.setStatus(503); return ctx.json({ error: "UNAVAILABLE" }); }
          try {
            await createEnterpriseSession(ctx, result as EnterpriseOtpGrant);
            ctx.setStatus(200);
            return ctx.json({ ok: true });
          } catch {
            ctx.setStatus(503);
            return ctx.json({ error: "UNAVAILABLE" });
          }
        }),
      } : {}),
    },
  };
}
