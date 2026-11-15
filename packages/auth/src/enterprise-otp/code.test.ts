import { createCipheriv, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ENTERPRISE_OTP_ALPHABET, ENTERPRISE_OTP_LENGTH, createEnterpriseOtpCrypto, generateEnterpriseOtpCode,
  type EnterpriseOtpBinding, type EnterpriseOtpCryptoConfig, type EnterpriseOtpDelivery, type EnterpriseOtpDigest,
} from "../index";
import { isCanonicalEnterpriseOtpCode } from "./code";

vi.mock("node:crypto", async importOriginal => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomInt: vi.fn(actual.randomInt), randomBytes: vi.fn(actual.randomBytes), timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});
const randomIntMock = vi.mocked(randomInt as (min: number, max: number) => number);
const randomBytesMock = vi.mocked(randomBytes as (size: number) => Buffer);

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  randomIntMock.mockReset().mockImplementation(actual.randomInt);
  randomBytesMock.mockReset().mockImplementation(actual.randomBytes);
  vi.mocked(timingSafeEqual).mockReset().mockImplementation(actual.timingSafeEqual);
});

const code = "2A3B4C5D";
const binding: EnterpriseOtpBinding = Object.freeze({
  scope: "scope.test", deploymentRole: "test", tenantKey: "tenant.test", appId: "app.test",
  challengeId: "11111111-2222-3333-4444-555555555555", localUserId: "local-user", identityId: "identity-user",
  identityVersion: 7, purpose: "login", flowHash: "a".repeat(64), generation: 3, expiresAtMs: 1800000000000,
});
const config = (): EnterpriseOtpCryptoConfig => ({
  hmacKeyId: "hmac.v1", hmacKey: Uint8Array.from({ length: 32 }, (_, i) => i),
  deliveryKeyId: "delivery.v1", deliveryKey: Uint8Array.from({ length: 32 }, (_, i) => i + 32),
});
const asBinding = (value: unknown): EnterpriseOtpBinding => value as EnterpriseOtpBinding;
const asConfig = (value: unknown): EnterpriseOtpCryptoConfig => value as EnterpriseOtpCryptoConfig;
function expectPrivateFailure(action: () => unknown): void {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe("Enterprise OTP operation failed");
  expect((caught as Error).cause).toBeUndefined();
}

describe("FS-35 CSPRNG and canonical codes", () => {
  it("generates canonical mixed eight-character codes through the public auth API", () => {
    expect(ENTERPRISE_OTP_ALPHABET).toBe("23456789ABCDEFGHJKMNPQRSTUVWXYZ");
    expect(ENTERPRISE_OTP_LENGTH).toBe(8);
    for (let i = 0; i < 256; i++) {
      const value = generateEnterpriseOtpCode();
      expect(value).toHaveLength(8);
      expect([...value].every(char => ENTERPRISE_OTP_ALPHABET.includes(char))).toBe(true);
      expect(value).toMatch(/[2-9]/); expect(value).toMatch(/[A-Z]/);
      expect(isCanonicalEnterpriseOtpCode(value)).toBe(true);
    }
  });
  it("rejects whole digit-only and letter-only samples and reaches alphabet endpoints", () => {
    for (const char of "22222222AAAAAAAA2ZZZZZZZ") randomIntMock.mockReturnValueOnce(ENTERPRISE_OTP_ALPHABET.indexOf(char));
    expect(generateEnterpriseOtpCode()).toBe("2ZZZZZZZ");
    expect(randomInt).toHaveBeenCalledTimes(24);
    for (const call of randomIntMock.mock.calls) expect(call).toEqual([0, 31]);
  });
  it("bounds rejection at 128 whole samples and redacts random-source errors", () => {
    randomIntMock.mockReturnValue(0);
    expectPrivateFailure(generateEnterpriseOtpCode);
    expect(randomInt).toHaveBeenCalledTimes(1024);
    randomIntMock.mockImplementation(() => { throw new Error("private failure"); });
    expectPrivateFailure(generateEnterpriseOtpCode);
  });
  it.each([
    ["missing", undefined], ["null", null], ["number", 23456789], ["object", {}], ["array", [code]],
    ["empty", ""], ["short", "2A3B4C5"], ["long", code + "2"], ["lowercase", "2a3b4c5d"],
    ["digits", "23456789"], ["letters", "ABCDEFGH"], ["ambiguous", "2I3L4O5D"],
    ["leading space", " " + code], ["trailing newline", code + "\n"], ["non-ASCII", "２A3B4C5D"],
  ])("rejects %s without normalizing inside crypto", (_name, value) => {
    const crypto = createEnterpriseOtpCrypto(config());
    expect(isCanonicalEnterpriseOtpCode(value)).toBe(false);
    expect(crypto.verify(value, binding, crypto.digest(code, binding))).toBe(false);
    expectPrivateFailure(() => crypto.digest(value as string, binding));
    expectPrivateFailure(() => crypto.seal(value as string, binding));
  });
});

describe("FS-35 authenticated record protocol", () => {
  it("matches independent Python hmac/AESGCM vectors and public record types", () => {
    // Python stdlib hmac and cryptography AESGCM over compact UTF-8 JSON.
    const crypto = createEnterpriseOtpCrypto(config());
    const digest: EnterpriseOtpDigest = crypto.digest(code, binding);
    expect(digest).toEqual({ hmacKeyId: "hmac.v1", codeHmac: "edb22e7401598233c114cb1f281e8691aa8629845392bedb0351d81a3ea2609e" });
    randomBytesMock.mockReturnValueOnce(Buffer.from(Array.from({ length: 12 }, (_, i) => i)));
    const delivery: EnterpriseOtpDelivery = crypto.seal(code, binding);
    expect(delivery).toEqual({ deliveryKeyId: "delivery.v1", encryptedPayload: "AQABAgMEBQYHCAkKC_CRRx92ccadY4YvxJHKPnxuE27lfnbeqA" });
    expect(crypto.open(delivery, binding)).toBe(code);
    expect(crypto.verify(code, binding, digest)).toBe(true);
    for (const value of [crypto, digest, delivery]) expect(Object.isFrozen(value)).toBe(true);
    expect(Object.keys(crypto).sort()).toEqual(["digest", "open", "seal", "verify"]);
  });
  it("uses fresh twelve-byte nonces in canonical 37-byte envelopes", () => {
    const crypto = createEnterpriseOtpCrypto(config());
    const one = crypto.seal(code, binding), two = crypto.seal(code, binding);
    expect(one.encryptedPayload).not.toBe(two.encryptedPayload);
    for (const delivery of [one, two]) {
      expect(delivery.encryptedPayload).toHaveLength(50);
      const bytes = Buffer.from(delivery.encryptedPayload, "base64url");
      expect(bytes).toHaveLength(37); expect(bytes[0]).toBe(1);
      expect(bytes.toString("base64url")).toBe(delivery.encryptedPayload);
      expect(crypto.open(delivery, binding)).toBe(code);
    }
    expect(randomBytes).toHaveBeenNthCalledWith(1, 12);
    expect(randomBytes).toHaveBeenNthCalledWith(2, 12);
  });
  it("compares valid HMACs as fixed-length bytes using timingSafeEqual", () => {
    const crypto = createEnterpriseOtpCrypto(config()), digest = crypto.digest(code, binding);
    vi.mocked(timingSafeEqual).mockClear();
    expect(crypto.verify(code, binding, digest)).toBe(true);
    expect(crypto.verify("2A3B4C5E", binding, digest)).toBe(false);
    expect(timingSafeEqual).toHaveBeenCalledTimes(2);
    for (const args of vi.mocked(timingSafeEqual).mock.calls) {
      expect(args[0].byteLength).toBe(32); expect(args[1].byteLength).toBe(32);
    }
    vi.mocked(timingSafeEqual).mockClear();
    for (const codeHmac of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), "a".repeat(63) + "\n"]) {
      expect(crypto.verify(code, binding, { ...digest, codeHmac })).toBe(false);
    }
    expect(timingSafeEqual).not.toHaveBeenCalled();
  });
  it("binds every context field in both HMAC and AEAD", () => {
    const crypto = createEnterpriseOtpCrypto(config());
    const digest = crypto.digest(code, binding), delivery = crypto.seal(code, binding);
    const changes: Record<keyof EnterpriseOtpBinding, unknown> = {
      scope: "scope.other", deploymentRole: "canary", tenantKey: "tenant.other", appId: "app.other",
      challengeId: "21111111-2222-3333-4444-555555555555", localUserId: "other-user", identityId: "other-identity",
      identityVersion: 8, purpose: "not-login", flowHash: "b".repeat(64), generation: 4, expiresAtMs: 1800000000001,
    };
    for (const [key, value] of Object.entries(changes)) {
      const changed = { ...binding, [key]: value };
      expect(crypto.verify(code, changed, digest), key).toBe(false);
      expect(crypto.open(delivery, changed), key).toBeNull();
    }
  });
  it("ignores object key order but preserves Unicode and field boundaries", () => {
    const crypto = createEnterpriseOtpCrypto(config());
    const reversed = asBinding(Object.fromEntries(Object.entries(binding).reverse()));
    expect(crypto.digest(code, reversed)).toEqual(crypto.digest(code, binding));
    expect(crypto.open(crypto.seal(code, binding), reversed)).toBe(code);
    const pairs = [
      [{ ...binding, scope: "ab", tenantKey: "c" }, { ...binding, scope: "a", tenantKey: "bc" }],
      [{ ...binding, scope: "é" }, { ...binding, scope: "e\u0301" }],
      [{ ...binding, scope: " user " }, { ...binding, scope: "user" }],
    ] as const;
    for (const [one, two] of pairs) {
      expect(crypto.verify(code, two, crypto.digest(code, one))).toBe(false);
      expect(crypto.open(crypto.seal(code, one), two)).toBeNull();
    }
  });
  it("accepts boundary values without asserting current eligibility, TTL or consumption", () => {
    const crypto = createEnterpriseOtpCrypto(config());
    for (const role of ["development", "test", "production", "canary"] as const) {
      for (const expiresAtMs of [0, 8640000000000000]) {
        const context = { ...binding, deploymentRole: role, scope: "😀".repeat(256), identityVersion: 2147483647, generation: 1, expiresAtMs };
        expect(crypto.verify(code, context, crypto.digest(code, context))).toBe(true);
        expect(crypto.open(crypto.seal(code, context), context)).toBe(code);
      }
    }
  });
});

describe("FS-35 untrusted input and tampering", () => {
  it("rejects malformed bindings without invoking getters or exposing inputs", () => {
    const crypto = createEnterpriseOtpCrypto(config());
    const digest = crypto.digest(code, binding), delivery = crypto.seal(code, binding);
    const invalid: unknown[] = [null, undefined, [], "context", { ...binding, extra: "private" }, { ...binding, [Symbol("extra")]: true }];
    for (const field of ["scope", "tenantKey", "appId", "localUserId", "identityId"]) {
      for (const value of ["", " \t\n", "a".repeat(257), "😀".repeat(257), "\ud800", "x\udfff", 12, null]) invalid.push({ ...binding, [field]: value });
    }
    for (const field of ["generation", "identityVersion"]) {
      for (const value of [0, -1, 1.5, 2147483648, NaN, Infinity, "1"]) invalid.push({ ...binding, [field]: value });
    }
    for (const expiresAtMs of [-1, 0.5, NaN, Infinity, 8640000000000001, "1"]) invalid.push({ ...binding, expiresAtMs });
    for (const deploymentRole of ["", "TEST", "unknown", 1]) invalid.push({ ...binding, deploymentRole });
    for (const challengeId of ["", binding.challengeId + "\n", "AAAAAAAA-2222-3333-4444-555555555555", "not-a-uuid"]) invalid.push({ ...binding, challengeId });
    for (const flowHash of ["", "a".repeat(63), "A".repeat(64), "a".repeat(63) + "\n"]) invalid.push({ ...binding, flowHash });
    for (const key of Object.keys(binding)) {
      const missing = { ...binding } as Record<string, unknown>;
      delete missing[key]; invalid.push(missing);
    }
    let getterCalls = 0;
    invalid.push({ ...binding, get scope() { getterCalls++; throw new Error("private context"); } });
    invalid.push(new Proxy({}, { getPrototypeOf() { throw new Error("private proxy"); } }));
    for (const context of invalid) {
      expect(crypto.verify(code, context, digest)).toBe(false);
      expect(crypto.open(delivery, context)).toBeNull();
      expectPrivateFailure(() => crypto.digest(code, asBinding(context)));
      expectPrivateFailure(() => crypto.seal(code, asBinding(context)));
    }
    expect(getterCalls).toBe(0);
  });
  it("rejects altered versions, nonces, tags, ciphertext and noncanonical base64url", () => {
    const crypto = createEnterpriseOtpCrypto(config()), delivery = crypto.seal(code, binding);
    for (const index of [0, 1, 12, 13, 28, 29, 36]) {
      const bytes = Buffer.from(delivery.encryptedPayload, "base64url");
      bytes[index] = bytes[index]! ^ 1;
      expect(crypto.open({ ...delivery, encryptedPayload: bytes.toString("base64url") }, binding)).toBeNull();
    }
    // Last sextet has four unused bits; the decoder alone accepts aliases.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const final = alphabet.indexOf(delivery.encryptedPayload.at(-1)!);
    const alias = delivery.encryptedPayload.slice(0, -1) + alphabet[final + 1];
    expect(Buffer.from(alias, "base64url")).toEqual(Buffer.from(delivery.encryptedPayload, "base64url"));
    for (const encryptedPayload of [alias, delivery.encryptedPayload + "=", delivery.encryptedPayload.slice(1),
      delivery.encryptedPayload.slice(0, -1) + "\n", "!".repeat(50), "a".repeat(8193)]) {
      expect(crypto.open({ ...delivery, encryptedPayload }, binding)).toBeNull();
    }
  });
  it("rejects even authentic ciphertext when plaintext is not a canonical ASCII code", () => {
    const crypto = createEnterpriseOtpCrypto(config());
    const b = [1, binding.scope, binding.deploymentRole, binding.tenantKey, binding.appId, binding.challengeId,
      binding.localUserId, binding.identityId, binding.identityVersion, binding.purpose, binding.flowHash, binding.generation, binding.expiresAtMs];
    for (const plaintext of [Buffer.from("ABCDEFGH"), Buffer.from("23456789"), Buffer.from([0xb2, 65, 51, 66, 52, 67, 53, 68])]) {
      const nonce = Buffer.alloc(12, 9);
      const cipher = createCipheriv("aes-256-gcm", config().deliveryKey, nonce, { authTagLength: 16 });
      cipher.setAAD(Buffer.from(JSON.stringify(["megaui:enterprise-otp:delivery:v1", "delivery.v1", b])));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const encryptedPayload = Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]).toString("base64url");
      expect(crypto.open({ encryptedPayload, deliveryKeyId: "delivery.v1" }, binding)).toBeNull();
    }
  });
  it("rejects missing, extra, inherited, accessor and wrong-key record fields", () => {
    const crypto = createEnterpriseOtpCrypto(config());
    const digest = crypto.digest(code, binding), delivery = crypto.seal(code, binding);
    for (const value of [null, undefined, [], 1, "record", {}, Object.create(digest), { ...digest, extra: true }, { ...digest, [Symbol()]: true },
      { ...digest, hmacKeyId: "other" }, { ...digest, hmacKeyId: undefined }, { hmacKeyId: digest.hmacKeyId }]) expect(crypto.verify(code, binding, value)).toBe(false);
    for (const value of [null, undefined, [], 1, "record", {}, Object.create(delivery), { ...delivery, extra: true }, { ...delivery, [Symbol()]: true },
      { ...delivery, deliveryKeyId: "other" }, { ...delivery, deliveryKeyId: undefined }, { deliveryKeyId: delivery.deliveryKeyId }]) expect(crypto.open(value, binding)).toBeNull();
    let getterCalls = 0;
    expect(crypto.verify(code, binding, { ...digest, get codeHmac() { getterCalls++; return digest.codeHmac; } })).toBe(false);
    expect(crypto.open({ ...delivery, get encryptedPayload() { getterCalls++; return delivery.encryptedPayload; } }, binding)).toBeNull();
    expect(getterCalls).toBe(0);
  });
});

describe("FS-35 independent immutable keys", () => {
  it("rejects absent, identical, malformed or incorrectly sized keys without fallback", () => {
    const invalid: unknown[] = [null, [], {}, { ...config(), extra: true }, { ...config(), hmacKey: config().deliveryKey }];
    for (const key of ["hmacKey", "deliveryKey"]) {
      for (const value of [undefined, null, "private material", [], new Uint16Array(32), new Uint8Array(31)]) invalid.push({ ...config(), [key]: value });
    }
    invalid.push({ ...config(), hmacKey: new Uint8Array(1025) }, { ...config(), deliveryKey: new Uint8Array(33) });
    for (const key of ["hmacKeyId", "deliveryKeyId"]) {
      for (const value of [undefined, null, "", "k".repeat(129), "key\n", "密钥", "a/b", 1]) invalid.push({ ...config(), [key]: value });
    }
    for (const value of invalid) expectPrivateFailure(() => createEnterpriseOtpCrypto(asConfig(value)));
    const crypto = createEnterpriseOtpCrypto({ ...config(), hmacKey: new Uint8Array(1024), hmacKeyId: "k".repeat(128), deliveryKeyId: "A._-9" });
    expect(crypto.verify(code, binding, crypto.digest(code, binding))).toBe(true);
  });
  it("copies caller-owned keys and keeps the two key purposes independent", () => {
    const input = config(), crypto = createEnterpriseOtpCrypto(input);
    const digest = crypto.digest(code, binding), delivery = crypto.seal(code, binding);
    input.hmacKey.fill(255); input.deliveryKey.fill(254);
    expect(crypto.digest(code, binding)).toEqual(digest);
    expect(crypto.open(delivery, binding)).toBe(code);
    const changedHmac = createEnterpriseOtpCrypto({ ...config(), hmacKey: new Uint8Array(32).fill(100) });
    const changedDelivery = createEnterpriseOtpCrypto({ ...config(), deliveryKey: new Uint8Array(32).fill(101) });
    expect(changedHmac.verify(code, binding, digest)).toBe(false);
    expect(changedHmac.open(delivery, binding)).toBe(code);
    expect(changedDelivery.verify(code, binding, digest)).toBe(true);
    expect(changedDelivery.open(delivery, binding)).toBeNull();
    expect(createEnterpriseOtpCrypto({ ...config(), hmacKeyId: "new" }).verify(code, binding, { ...digest, hmacKeyId: "new" })).toBe(false);
    expect(createEnterpriseOtpCrypto({ ...config(), deliveryKeyId: "new" }).open({ ...delivery, deliveryKeyId: "new" }, binding)).toBeNull();
  });
  it("redacts encryption random-source errors without logging", () => {
    const crypto = createEnterpriseOtpCrypto(config());
    const log = vi.spyOn(console, "log"), warn = vi.spyOn(console, "warn"), error = vi.spyOn(console, "error");
    try {
      randomBytesMock.mockImplementation(() => { throw new Error("private random input"); });
      expectPrivateFailure(() => crypto.seal(code, binding));
      expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    } finally { log.mockRestore(); warn.mockRestore(); error.mockRestore(); }
  });
});
