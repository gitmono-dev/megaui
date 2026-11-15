// megaui-only (FS-93): trusted Node Web configuration; importing performs no I/O.
import { resolveEnterpriseConfig, type AuthMode } from "@megaui/core";
import type { EnterpriseScopeExpectation } from "@megaui/database";

const SCOPE_KEYS = ["ENTERPRISE_PROCESS_ROLE", "ENTERPRISE_OWNER_FINGERPRINT",
  "ENTERPRISE_DB_INSTANCE_ID", "ENTERPRISE_DEPLOYMENT_ROLE", "ENTERPRISE_APPROVED_TARGETS"] as const;
const CONFIG_KEYS = ["AUTH_MODE", "DATABASE_URL", "BETTER_AUTH_URL", ...SCOPE_KEYS,
  "FEISHU_TENANT_KEY", "FEISHU_APP_ID", "ENTERPRISE_IP_HMAC_MASTER_KEY",
  "ENTERPRISE_TRUSTED_PROXY_CIDRS", "FEISHU_DIRECTORY_DEPARTMENT_IDS",
  "ENTERPRISE_OTP_HMAC_KEY", "ENTERPRISE_DELIVERY_KEY"] as const;
const DEPLOYMENTS = ["development", "test", "canary", "production"];
// Native pg still consults these fields at each Client construction unless
// explicitly fixed. Web uses URL TLS plus fixed UTF8/non-replication settings.
const UNSUPPORTED_DRIVER_ENV = ["PGBINARY", "PGSSLMODE", "PGSSLNEGOTIATION", "PGCLIENT_ENCODING", "PGREPLICATION"] as const;

export interface EnterpriseWebConfig {
  readonly mode: AuthMode;
  readonly scope?: Readonly<EnterpriseScopeExpectation>;
  readonly connectionString: string;
  readonly origin?: string;
  readonly pairing?: Readonly<{
    tenantKey: string;
    appId: string;
    ipMaster: string;
    proxyCidrs: readonly string[];
    departmentIds?: readonly string[];
    otp?: Readonly<{ hmacKey: Uint8Array; deliveryKey: Uint8Array }>;
  }>;
  /** Private comparison bytes. Never log or return them over HTTP. */
  readonly snapshot: string;
}

interface EnterpriseOtpConfig {
  readonly hmacKey: Uint8Array;
  readonly deliveryKey: Uint8Array;
}

export function invalidWebConfig(): Error { return new Error("ENTERPRISE_WEB_CONFIG_INVALID"); }

function hasAsciiControl(value: string, includeSpace = false): boolean {
  return [...value].some(character => character.charCodeAt(0) <= (includeSpace ? 32 : 31) || character.charCodeAt(0) === 127);
}
function identifier(value: string | undefined): string {
  if (!value || value.length > 256 || hasAsciiControl(value, true)) throw invalidWebConfig();
  return value;
}

function decodeKey(value: string | undefined, expectedBytes: number): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidWebConfig();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== expectedBytes || decoded.toString("base64url") !== value) throw invalidWebConfig();
  return Uint8Array.from(decoded);
}

function departmentIds(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  if (Buffer.byteLength(value, "utf8") > 32 * 1024) throw invalidWebConfig();
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 100) throw invalidWebConfig();
  const values = parsed.map(item => identifier(typeof item === "string" ? item : undefined));
  if (new Set(values).size !== values.length) throw invalidWebConfig();
  return Object.freeze(values);
}

/** The independent legacy getter must make this decision without opening a Pool. */
export function requiresEnterpriseWebRuntime(source: NodeJS.Dict<string> = process.env): boolean {
  const { mode } = resolveEnterpriseConfig({ authMode: source.AUTH_MODE, activated: false });
  return mode !== "legacy" || SCOPE_KEYS.some(key => source[key] !== undefined);
}

/** Eliminate URL overrides and PGOPTIONS fallback before using the public Pool factory. */
export function boundedWebDatabaseUrl(raw: string | undefined): string {
  try {
    if (!raw || raw.length > 16_384 || hasAsciiControl(raw, true)) throw invalidWebConfig();
    const url = new URL(raw);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username
      || !url.password || url.hash || url.pathname.length <= 1
      || hasAsciiControl(decodeURIComponent(url.pathname.slice(1))) || decodeURIComponent(url.pathname.slice(1)).includes("/")
      || (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))) throw invalidWebConfig();
    // An omitted URL port must not silently select a different target via PGPORT.
    if (!url.port) url.port = "5432";
    const replaced = new Set(["statement_timeout", "query_timeout", "lock_timeout",
      "idle_in_transaction_session_timeout", "connectionTimeoutMillis", "connect_timeout", "options", "pipeline", "application_name"]);
    // pg-connection-string reads certificate paths synchronously before its
    // connection timer. File-backed TLS configuration is not a bounded input.
    const retained = new Set(["sslmode"]);
    const seen = new Set<string>();
    for (const key of url.searchParams.keys()) {
      if (seen.has(key) || (!replaced.has(key) && !retained.has(key))) throw invalidWebConfig();
      seen.add(key);
    }
    for (const key of replaced) url.searchParams.delete(key);
    const sslMode = url.searchParams.get("sslmode") ?? "disable";
    if (!["disable", "prefer", "require", "verify-ca", "verify-full", "no-verify"].includes(sslMode)) throw invalidWebConfig();
    url.searchParams.set("sslmode", sslMode);
    url.searchParams.set("sslnegotiation", "postgres");
    url.searchParams.set("client_encoding", "UTF8");
    url.searchParams.set("replication", "false");
    url.searchParams.set("binary", "false");
    url.searchParams.set("statement_timeout", "3000");
    url.searchParams.set("query_timeout", "3000");
    url.searchParams.set("lock_timeout", "1000");
    url.searchParams.set("idle_in_transaction_session_timeout", "5000");
    url.searchParams.set("options", "-c statement_timeout=3000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000");
    url.searchParams.set("application_name", "megaui-web");
    return url.toString();
  } catch { throw invalidWebConfig(); }
}

function trustedOrigin(raw: string | undefined, environment: string): string {
  try {
    if (!raw || hasAsciiControl(raw, true) || !/^https?:\/\/[^/?#\\]+\/?$/.test(raw)) throw invalidWebConfig();
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || url.pathname !== "/" || raw.includes("?") || raw.includes("#")) throw invalidWebConfig();
    // Compare the original authority too: WHATWG canonicalizes shorthand and numeric IPv4.
    const authority = raw.slice(raw.indexOf("://") + 3).split("/")[0]!;
    const literalLoopback = /^(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/.test(authority);
    if (url.protocol === "http:" && (!['development', 'test'].includes(environment) || !literalLoopback)) throw invalidWebConfig();
    return url.origin;
  } catch { throw invalidWebConfig(); }
}

export function readEnterpriseWebConfig(source: NodeJS.Dict<string> = process.env): Readonly<EnterpriseWebConfig> {
  try {
    if (UNSUPPORTED_DRIVER_ENV.some(key => source[key] !== undefined)) throw invalidWebConfig();
    const { mode } = resolveEnterpriseConfig({ authMode: source.AUTH_MODE, activated: false });
    let scope: Readonly<EnterpriseScopeExpectation> | undefined;
    if (requiresEnterpriseWebRuntime(source)) {
      if (identifier(source.ENTERPRISE_PROCESS_ROLE) !== "web" || source.ENTERPRISE_APPROVED_TARGETS) throw invalidWebConfig();
      const environment = identifier(source.ENTERPRISE_DEPLOYMENT_ROLE);
      if (!DEPLOYMENTS.includes(environment)) throw invalidWebConfig();
      scope = Object.freeze({ processRole: "web", ownerFingerprint: identifier(source.ENTERPRISE_OWNER_FINGERPRINT),
        instanceId: identifier(source.ENTERPRISE_DB_INSTANCE_ID), environment });
    }
    let pairing: EnterpriseWebConfig["pairing"];
    let origin: string | undefined;
    if (mode === "enterprise") {
      const ipMaster = source.ENTERPRISE_IP_HMAC_MASTER_KEY;
      if (!ipMaster || !/^[A-Za-z0-9_-]{43}$/.test(ipMaster)
        || Buffer.from(ipMaster, "base64url").length !== 32
        || Buffer.from(ipMaster, "base64url").toString("base64url") !== ipMaster) throw invalidWebConfig();
      const raw = source.ENTERPRISE_TRUSTED_PROXY_CIDRS;
      if (raw === undefined || Buffer.byteLength(raw) > 8192) throw invalidWebConfig();
      const proxyCidrs: unknown = JSON.parse(raw);
      if (!Array.isArray(proxyCidrs) || proxyCidrs.length > 64 || proxyCidrs.some(value => typeof value !== "string")) throw invalidWebConfig();
      const tenantKey = identifier(source.FEISHU_TENANT_KEY);
      const appId = identifier(source.FEISHU_APP_ID);
      const configuredDepartments = source.FEISHU_DIRECTORY_DEPARTMENT_IDS;
      const configuredHmac = source.ENTERPRISE_OTP_HMAC_KEY;
      const configuredDelivery = source.ENTERPRISE_DELIVERY_KEY;
      const otpConfigured = configuredDepartments !== undefined || configuredHmac !== undefined || configuredDelivery !== undefined;
      let configuredOtp: EnterpriseOtpConfig | undefined;
      if (otpConfigured) {
        if (configuredDepartments === undefined || configuredHmac === undefined || configuredDelivery === undefined) throw invalidWebConfig();
        configuredOtp = Object.freeze({
          hmacKey: decodeKey(configuredHmac, 32),
          deliveryKey: decodeKey(configuredDelivery, 32),
        });
      }
      const configuredDepartmentIds = configuredDepartments === undefined ? undefined : departmentIds(configuredDepartments);
      pairing = Object.freeze({ tenantKey, appId, ipMaster, proxyCidrs: Object.freeze([...proxyCidrs] as string[]),
        ...(configuredDepartmentIds === undefined ? {} : { departmentIds: configuredDepartmentIds }),
        ...(configuredOtp === undefined ? {} : { otp: configuredOtp }) });
      origin = trustedOrigin(source.BETTER_AUTH_URL, scope!.environment);
    }
    return Object.freeze({ mode, scope, pairing, origin, connectionString: boundedWebDatabaseUrl(source.DATABASE_URL),
      snapshot: JSON.stringify(CONFIG_KEYS.map(key => [key, source[key] ?? null])) });
  } catch { throw invalidWebConfig(); }
}
