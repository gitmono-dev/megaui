// FSL-121: required keys of the Feishu email-code login (ADR-FSL-12); FSL-148: provider selection.
import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { OFFICIAL_FEISHU_ORIGIN } from "@megaui/core";

import {
  FEISHU_LOGIN_REQUIRED_KEYS,
  FeishuLoginConfigError,
  INVALID_FEISHU_LOGIN_CONFIG,
  readFeishuLoginConfig,
  type FeishuLoginConfigKey,
  type FeishuLoginConfigSource,
  type FeishuLoginRequiredKey,
} from "../../lib/feishu-login-config";

const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index * 7 + 3);
const VALID: Required<Record<FeishuLoginRequiredKey, string>> = {
  FEISHU_APP_ID: "cli_fsl121_app",
  FEISHU_APP_SECRET: "fsl121-app-secret-value",
  ENTERPRISE_OTP_HMAC_KEY: Buffer.from(KEY_BYTES).toString("base64url"),
};

function capture(source: FeishuLoginConfigSource): FeishuLoginConfigError {
  try {
    readFeishuLoginConfig(source);
  } catch (error) {
    expect(error).toBeInstanceOf(FeishuLoginConfigError);
    return error as FeishuLoginConfigError;
  }
  throw new Error("expected readFeishuLoginConfig to throw");
}

function expectRejected(source: FeishuLoginConfigSource, keys: readonly FeishuLoginConfigKey[]): FeishuLoginConfigError {
  const error = capture(source);
  expect(error.code).toBe(INVALID_FEISHU_LOGIN_CONFIG);
  expect(error.keys).toEqual(keys);
  expect(error.message).toBe(`INVALID_FEISHU_LOGIN_CONFIG: ${keys.join(", ")}`);
  return error;
}

function without(key: FeishuLoginRequiredKey): FeishuLoginConfigSource {
  const { [key]: _omitted, ...rest } = VALID;
  return rest;
}

describe("readFeishuLoginConfig (FSL-121)", () => {
  it("AC1 returns the configuration when the three required keys are present and valid", () => {
    expect(VALID.ENTERPRISE_OTP_HMAC_KEY).toHaveLength(43);
    const config = readFeishuLoginConfig(VALID);
    expect(config.appId).toBe(VALID.FEISHU_APP_ID);
    expect(config.appSecret).toBe(VALID.FEISHU_APP_SECRET);
    expect(config.otpHmacKey).toBeInstanceOf(Uint8Array);
    expect([...config.otpHmacKey]).toEqual([...KEY_BYTES]);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.keys(config).sort()).toEqual(["appId", "appSecret", "otpHmacKey", "target"]);
  });

  it("AC1 accepts a process.env-like source with unrelated keys", () => {
    const config = readFeishuLoginConfig({ ...VALID, NODE_ENV: "test", AUTH_MODE: "enterprise" } as FeishuLoginConfigSource);
    expect(config.appId).toBe(VALID.FEISHU_APP_ID);
  });

  it("AC2 rejects a missing FEISHU_APP_ID with INVALID_FEISHU_LOGIN_CONFIG", () => {
    expectRejected(without("FEISHU_APP_ID"), ["FEISHU_APP_ID"]);
    expectRejected({ ...VALID, FEISHU_APP_ID: "" }, ["FEISHU_APP_ID"]);
    expectRejected({ ...VALID, FEISHU_APP_ID: "   " }, ["FEISHU_APP_ID"]);
  });

  it("AC3 rejects a missing FEISHU_APP_SECRET with INVALID_FEISHU_LOGIN_CONFIG", () => {
    expectRejected(without("FEISHU_APP_SECRET"), ["FEISHU_APP_SECRET"]);
    expectRejected({ ...VALID, FEISHU_APP_SECRET: "" }, ["FEISHU_APP_SECRET"]);
    expectRejected({ ...VALID, FEISHU_APP_SECRET: "\t" }, ["FEISHU_APP_SECRET"]);
  });

  it("AC4 rejects a missing ENTERPRISE_OTP_HMAC_KEY with INVALID_FEISHU_LOGIN_CONFIG", () => {
    expectRejected(without("ENTERPRISE_OTP_HMAC_KEY"), ["ENTERPRISE_OTP_HMAC_KEY"]);
    expectRejected({ ...VALID, ENTERPRISE_OTP_HMAC_KEY: "" }, ["ENTERPRISE_OTP_HMAC_KEY"]);
  });

  it("AC5 rejects an ENTERPRISE_OTP_HMAC_KEY that is not canonical base64url of 32 bytes", () => {
    const canonical = VALID.ENTERPRISE_OTP_HMAC_KEY;
    const standard = Buffer.from(Uint8Array.from({ length: 32 }, () => 0xfb)).toString("base64");
    expect(standard).toMatch(/[+/]/);
    const lastIndex = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(canonical.at(-1)!);
    // The 43rd character carries 2 spare bits; setting one keeps the bytes but breaks the round trip.
    const nonCanonicalTail = canonical.slice(0, 42)
      + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[lastIndex | 1];
    expect(Buffer.from(nonCanonicalTail, "base64url")).toEqual(Buffer.from(canonical, "base64url"));
    const invalid = [
      `${canonical}=`, // padded
      standard, // standard alphabet with padding
      standard.replace(/=+$/, ""), // standard alphabet without padding
      nonCanonicalTail, // decodes to the same bytes but does not round-trip
      Buffer.alloc(31, 1).toString("base64url"), // 31 bytes
      Buffer.alloc(33, 1).toString("base64url"), // 33 bytes
      Buffer.alloc(64, 1).toString("base64url"), // 64 bytes
      ` ${canonical}`, // surrounding whitespace
      `${canonical.slice(0, 20)}.${canonical.slice(21)}`, // character outside the alphabet
      Buffer.from(KEY_BYTES).toString("hex"), // hex, not base64url
    ];
    for (const value of invalid) {
      expectRejected({ ...VALID, ENTERPRISE_OTP_HMAC_KEY: value }, ["ENTERPRISE_OTP_HMAC_KEY"]);
    }
  });

  it("rejects malformed FEISHU_APP_ID / FEISHU_APP_SECRET values instead of trimming them", () => {
    for (const value of [" cli_padded", "cli_padded ", "cli\nnewline", "cli\u0000nul", "cli nbsp", "x".repeat(257)]) {
      expectRejected({ ...VALID, FEISHU_APP_ID: value }, ["FEISHU_APP_ID"]);
      expectRejected({ ...VALID, FEISHU_APP_SECRET: value }, ["FEISHU_APP_SECRET"]);
    }
    expect(readFeishuLoginConfig({ ...VALID, FEISHU_APP_ID: "x".repeat(256) }).appId).toHaveLength(256);
  });

  it("lists every offending key in the fixed order", () => {
    expectRejected({}, [...FEISHU_LOGIN_REQUIRED_KEYS]);
    expectRejected({ FEISHU_APP_SECRET: VALID.FEISHU_APP_SECRET, ENTERPRISE_OTP_HMAC_KEY: "tooShortKeyMarker" },
      ["FEISHU_APP_ID", "ENTERPRISE_OTP_HMAC_KEY"]);
  });

  it("AC6 error output names keys only and never contains a value", () => {
    const secretValues = {
      FEISHU_APP_ID: "cli_leak_marker_id\n",
      FEISHU_APP_SECRET: "leak-marker-secret value",
      ENTERPRISE_OTP_HMAC_KEY: `${VALID.ENTERPRISE_OTP_HMAC_KEY}=`,
    };
    const error = expectRejected(secretValues, [...FEISHU_LOGIN_REQUIRED_KEYS]);
    const surfaces = [
      error.message,
      String(error),
      error.stack ?? "",
      JSON.stringify(error),
      JSON.stringify(Object.getOwnPropertyNames(error).map(name => [name, (error as unknown as Record<string, unknown>)[name]])),
      inspect(error, { depth: 5, showHidden: true }),
    ];
    const fragments = [
      ...Object.values(secretValues),
      "cli_leak_marker_id",
      "leak-marker-secret",
      VALID.ENTERPRISE_OTP_HMAC_KEY,
      VALID.ENTERPRISE_OTP_HMAC_KEY.slice(0, 12),
    ];
    for (const surface of surfaces) {
      for (const fragment of fragments) expect(surface).not.toContain(fragment);
    }
    expect(error.message.replace(`${INVALID_FEISHU_LOGIN_CONFIG}: `, "").split(", ")).toEqual([...FEISHU_LOGIN_REQUIRED_KEYS]);
    expect(Object.keys(error).sort()).toEqual(["code", "keys", "name"]);

    // A single invalid key: the valid values present in the source do not leak either.
    const single = expectRejected({ ...VALID, ENTERPRISE_OTP_HMAC_KEY: "tooShortKeyMarker" }, ["ENTERPRISE_OTP_HMAC_KEY"]);
    const singleOutput = [single.message, single.stack ?? "", JSON.stringify(single), inspect(single, { showHidden: true })].join("\n");
    for (const fragment of [VALID.FEISHU_APP_ID, VALID.FEISHU_APP_SECRET, "tooShortKeyMarker"]) {
      expect(singleOutput).not.toContain(fragment);
    }
  });
});

describe("readFeishuLoginConfig provider selection (FSL-148)", () => {
  const LOOPBACK = "http://127.0.0.1:18080";

  it("AC1 selects the official origin when FEISHU_PROVIDER is not set", () => {
    for (const NODE_ENV of [undefined, "production", "development", "test"]) {
      const config = readFeishuLoginConfig({ ...VALID, NODE_ENV });
      expect(config.target).toEqual({ provider: "feishu", origin: OFFICIAL_FEISHU_ORIGIN });
      expect(config.target.origin).toBe("https://open.feishu.cn");
      expect(Object.isFrozen(config.target)).toBe(true);
    }
    // A blank value counts as unset.
    for (const FEISHU_PROVIDER of ["", "   "]) {
      expect(readFeishuLoginConfig({ ...VALID, FEISHU_PROVIDER, NODE_ENV: "production" }).target)
        .toEqual({ provider: "feishu", origin: OFFICIAL_FEISHU_ORIGIN });
    }
  });

  it("AC1 an explicit feishu provider also selects the official origin and ignores FEISHU_SIMULATOR_ORIGIN", () => {
    const config = readFeishuLoginConfig({
      ...VALID, NODE_ENV: "test", FEISHU_PROVIDER: "feishu", FEISHU_SIMULATOR_ORIGIN: LOOPBACK,
    });
    expect(config.target).toEqual({ provider: "feishu", origin: OFFICIAL_FEISHU_ORIGIN });
    expect(readFeishuLoginConfig({
      ...VALID, NODE_ENV: "production", FEISHU_PROVIDER: "feishu", FEISHU_SIMULATOR_ORIGIN: "https://evil.example",
    }).target).toEqual({ provider: "feishu", origin: OFFICIAL_FEISHU_ORIGIN });
    // FEISHU_SIMULATOR_ORIGIN is not even read for the official provider.
    const reads: string[] = [];
    const tracked = new Proxy({ ...VALID, NODE_ENV: "test", FEISHU_SIMULATOR_ORIGIN: LOOPBACK }, {
      get(target, property, receiver) {
        if (typeof property === "string") reads.push(property);
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as FeishuLoginConfigSource;
    expect(readFeishuLoginConfig(tracked).target.provider).toBe("feishu");
    expect(reads).not.toContain("FEISHU_SIMULATOR_ORIGIN");
  });

  it("AC2 selects the loopback FEISHU_SIMULATOR_ORIGIN for the simulator with NODE_ENV=test", () => {
    const config = readFeishuLoginConfig({
      ...VALID, NODE_ENV: "test", FEISHU_PROVIDER: "simulator", FEISHU_SIMULATOR_ORIGIN: LOOPBACK,
    });
    expect(config.target).toEqual({ provider: "simulator", origin: LOOPBACK });
    expect(Object.isFrozen(config.target)).toBe(true);
    expect(config.appId).toBe(VALID.FEISHU_APP_ID);
    // NODE_ENV=development is the other trusted value.
    expect(readFeishuLoginConfig({
      ...VALID, NODE_ENV: "development", FEISHU_PROVIDER: "simulator", FEISHU_SIMULATOR_ORIGIN: "http://127.0.0.1:1",
    }).target).toEqual({ provider: "simulator", origin: "http://127.0.0.1:1" });
  });

  it("AC3 rejects the simulator with NODE_ENV=production with INVALID_FEISHU_LOGIN_CONFIG", () => {
    expectRejected({ ...VALID, NODE_ENV: "production", FEISHU_PROVIDER: "simulator", FEISHU_SIMULATOR_ORIGIN: LOOPBACK },
      ["FEISHU_PROVIDER"]);
    // An unset or unrecognised NODE_ENV is untrusted too.
    for (const NODE_ENV of [undefined, "", "staging", "Test", " test"]) {
      expectRejected({ ...VALID, NODE_ENV, FEISHU_PROVIDER: "simulator", FEISHU_SIMULATOR_ORIGIN: LOOPBACK },
        ["FEISHU_PROVIDER"]);
    }
  });

  it("AC4 rejects the simulator when FEISHU_SIMULATOR_ORIGIN is not a loopback origin", () => {
    const invalidOrigins = [
      undefined,
      "",
      "https://open.feishu.cn",
      "http://example.com:8080",
      "http://localhost:18080",
      "http://127.1:18080",
      "http://[::1]:18080",
      "https://127.0.0.1:18080",
      "http://127.0.0.1",
      "http://127.0.0.1:0",
      "http://127.0.0.1:65536",
      "http://127.0.0.1:18080/",
      "http://127.0.0.1:18080/path",
      " http://127.0.0.1:18080",
      "http://user@127.0.0.1:18080",
    ];
    for (const FEISHU_SIMULATOR_ORIGIN of invalidOrigins) {
      expectRejected({ ...VALID, NODE_ENV: "test", FEISHU_PROVIDER: "simulator", FEISHU_SIMULATOR_ORIGIN },
        ["FEISHU_SIMULATOR_ORIGIN"]);
    }
  });

  it("AC5 rejects a FEISHU_PROVIDER value other than feishu or simulator", () => {
    for (const FEISHU_PROVIDER of ["Feishu", "SIMULATOR", "official", "mock", "lark", "local", "feishu,simulator"]) {
      expectRejected({ ...VALID, NODE_ENV: "test", FEISHU_PROVIDER, FEISHU_SIMULATOR_ORIGIN: LOOPBACK },
        ["FEISHU_PROVIDER"]);
      expectRejected({ ...VALID, NODE_ENV: "production", FEISHU_PROVIDER }, ["FEISHU_PROVIDER"]);
    }
  });

  it("lists a provider key after the required keys and never carries the provider values", () => {
    const origin = "http://leak-marker-origin.example:9";
    const error = expectRejected(
      { NODE_ENV: "test", FEISHU_PROVIDER: "simulator", FEISHU_SIMULATOR_ORIGIN: origin },
      [...FEISHU_LOGIN_REQUIRED_KEYS, "FEISHU_SIMULATOR_ORIGIN"],
    );
    const unknown = expectRejected({ ...VALID, FEISHU_PROVIDER: "leak-marker-provider" }, ["FEISHU_PROVIDER"]);
    for (const surface of [error, unknown].flatMap(e => [e.message, e.stack ?? "", JSON.stringify(e), inspect(e, { showHidden: true })])) {
      for (const fragment of ["leak-marker-origin", "leak-marker-provider", VALID.FEISHU_APP_SECRET]) {
        expect(surface).not.toContain(fragment);
      }
    }
  });
});
