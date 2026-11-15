// megaui-only (FS-35): Independent HMAC and AES-256-GCM with complete binding authentication.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ENTERPRISE_OTP_FAILURE_MESSAGE, isCanonicalEnterpriseOtpCode } from "./code";
import type { EnterpriseOtpCrypto, EnterpriseOtpCryptoConfig } from "./types";

const BINDING_KEYS = [
  "scope", "deploymentRole", "tenantKey", "appId", "challengeId", "localUserId",
  "identityId", "identityVersion", "purpose", "flowHash", "generation", "expiresAtMs",
] as const;

function invalid(): never {
  throw new Error(ENTERPRISE_OTP_FAILURE_MESSAGE);
}

// Snapshot data properties once: no getters, coercion, inherited or unknown fields.
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object") return invalid();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return invalid();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) return invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !("value" in property)) return invalid();
    result[key] = property.value;
  }
  return result;
}

function text(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512 || !value.trim()) return false;
  // for-of joins valid surrogate pairs; a remaining surrogate is unpaired.
  let length = 0;
  for (const char of value) {
    const point = char.codePointAt(0)!;
    if ((point >= 0xd800 && point <= 0xdfff) || ++length > 256) return false;
  }
  return length > 0;
}

function keyId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[^A-Za-z0-9._-]/.test(value);
}

function hexDigest(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && !/[^0-9a-f]/.test(value);
}

function positiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 2147483647;
}

function bindingArray(value: unknown): readonly (string | number)[] {
  const b = record(value, BINDING_KEYS);
  if (!text(b.scope) || !text(b.tenantKey) || !text(b.appId) || !text(b.localUserId) || !text(b.identityId)
    || typeof b.deploymentRole !== "string" || !["development", "test", "production", "canary"].includes(b.deploymentRole)
    || typeof b.challengeId !== "string" || b.challengeId.length !== 36
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(b.challengeId)
    || !positiveInt(b.identityVersion) || b.purpose !== "login" || !hexDigest(b.flowHash)
    || !positiveInt(b.generation) || typeof b.expiresAtMs !== "number" || !Number.isSafeInteger(b.expiresAtMs)
    || b.expiresAtMs < 0 || b.expiresAtMs > 8640000000000000) return invalid();
  return [1, b.scope, b.deploymentRole, b.tenantKey, b.appId, b.challengeId, b.localUserId,
    b.identityId, b.identityVersion, b.purpose, b.flowHash, b.generation, b.expiresAtMs];
}

export function createEnterpriseOtpCrypto(config: EnterpriseOtpCryptoConfig): EnterpriseOtpCrypto {
  try {
    const input = record(config, ["hmacKeyId", "hmacKey", "deliveryKeyId", "deliveryKey"]);
    if (!keyId(input.hmacKeyId) || !keyId(input.deliveryKeyId)
      || !(input.hmacKey instanceof Uint8Array) || input.hmacKey.length < 32 || input.hmacKey.length > 1024
      || !(input.deliveryKey instanceof Uint8Array) || input.deliveryKey.length !== 32) return invalid();
    const hmacKeyId = input.hmacKeyId;
    const deliveryKeyId = input.deliveryKeyId;
    const hmacKey = Buffer.from(input.hmacKey);
    const deliveryKey = Buffer.from(input.deliveryKey);
    if (hmacKey.length === deliveryKey.length && timingSafeEqual(hmacKey, deliveryKey)) return invalid();

    const digestBytes = (code: unknown, binding: unknown): Buffer => {
      if (!isCanonicalEnterpriseOtpCode(code)) return invalid();
      const message = JSON.stringify(["megaui:enterprise-otp:hmac:v1", hmacKeyId, bindingArray(binding), code]);
      return createHmac("sha256", hmacKey).update(message, "utf8").digest();
    };
    const aad = (binding: unknown): Buffer => Buffer.from(
      JSON.stringify(["megaui:enterprise-otp:delivery:v1", deliveryKeyId, bindingArray(binding)]), "utf8",
    );

    return Object.freeze({
      digest(code, binding) {
        try {
          return Object.freeze({ codeHmac: digestBytes(code, binding).toString("hex"), hmacKeyId });
        } catch { return invalid(); }
      },
      verify(code, binding, value) {
        try {
          const input = record(value, ["codeHmac", "hmacKeyId"]);
          if (input.hmacKeyId !== hmacKeyId || !hexDigest(input.codeHmac)) return false;
          return timingSafeEqual(digestBytes(code, binding), Buffer.from(input.codeHmac, "hex"));
        } catch { return false; }
      },
      seal(code, binding) {
        try {
          if (!isCanonicalEnterpriseOtpCode(code)) return invalid();
          const authenticatedData = aad(binding);
          const nonce = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", deliveryKey, nonce, { authTagLength: 16 });
          cipher.setAAD(authenticatedData);
          const ciphertext = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
          const encryptedPayload = Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]).toString("base64url");
          return Object.freeze({ encryptedPayload, deliveryKeyId });
        } catch { return invalid(); }
      },
      open(value, binding) {
        try {
          const input = record(value, ["encryptedPayload", "deliveryKeyId"]);
          const payload = input.encryptedPayload;
          if (input.deliveryKeyId !== deliveryKeyId || typeof payload !== "string" || payload.length !== 50
            || /[^A-Za-z0-9_-]/.test(payload)) return null;
          const bytes = Buffer.from(payload, "base64url");
          if (bytes.length !== 37 || bytes[0] !== 1 || bytes.toString("base64url") !== payload) return null;
          const decipher = createDecipheriv("aes-256-gcm", deliveryKey, bytes.subarray(1, 13), { authTagLength: 16 });
          decipher.setAAD(aad(binding));
          decipher.setAuthTag(bytes.subarray(13, 29));
          const plaintext = Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString("utf8");
          return isCanonicalEnterpriseOtpCode(plaintext) ? plaintext : null;
        } catch { return null; }
      },
    } satisfies EnterpriseOtpCrypto);
  } catch { return invalid(); }
}
