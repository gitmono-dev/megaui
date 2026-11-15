import { describe, expect, it } from "vitest";
import { normalizeEnterpriseOtpInput, parseEnterpriseLoginName } from "./input";

const canonical = "7K3M9Q2H";
const whitespace = [
  { name: "TAB", value: "\t" }, { name: "LF", value: "\n" },
  { name: "VT", value: "\v" }, { name: "FF", value: "\f" },
  { name: "CR", value: "\r" }, { name: "SPACE", value: " " },
];

describe("enterprise OTP input (FS-49)", () => {
  it("normalizes ASCII edge whitespace and lowercase into a canonical mixed code", () => {
    expect(normalizeEnterpriseOtpInput(" \t7k3m9q2h\r\n")).toBe("7K3M9Q2H");
  });

  it.each(whitespace)("trims only edge $name whitespace", ({ value }) => {
    expect(normalizeEnterpriseOtpInput(value + "7k3m9q2h" + value)).toBe(canonical);
  });

  it.each(whitespace)("rejects internal $name whitespace", ({ value }) => {
    expect(normalizeEnterpriseOtpInput("7K3M" + value + "9Q2H")).toBeNull();
  });

  it("accepts every approved alphabet character in a mixed code", () => {
    for (const char of "23456789ABCDEFGHJKMNPQRSTUVWXYZ") {
      const code = "2" + char + "BCDEFG";
      expect(normalizeEnterpriseOtpInput(code)).toBe(code);
      expect(normalizeEnterpriseOtpInput(code.toLowerCase())).toBe(code);
    }
  });

  it("is idempotent and preserves canonical input", () => {
    const normalized = normalizeEnterpriseOtpInput(" \t\n\v\f\r7k3M9q2H\r\f\v\n\t ");
    expect(normalized).toBe(canonical);
    expect(normalizeEnterpriseOtpInput(normalized)).toBe(canonical);
  });

  it.each(["0", "1", "I", "L", "O", "i", "l", "o", "-", "_", "*", "?"])(
    "rejects the unapproved character %s",
    char => expect(normalizeEnterpriseOtpInput("2BCDEFG" + char)).toBeNull(),
  );

  it.each(["ABCDEFGH", "abcdefgh", "23456789", "", "        ", "2BCDEFG", "2BCDEFGHJ"])(
    "rejects invalid length or a code without mixed letters and digits: %j",
    value => expect(normalizeEnterpriseOtpInput(value)).toBeNull(),
  );

  it.each(["\u00a0", "\u3000", "\ufeff"])("does not trim Unicode whitespace %j", value => {
    expect(normalizeEnterpriseOtpInput(value + canonical + value)).toBeNull();
  });

  it.each(["\u00a0", "\u3000", "\ufeff", "\u017f", "\u212a", "Ｋ", "\u200b", "\u200d", "\ufe0f", "é", "😀", "\ud800", "\udc00"])(
    "rejects non-ASCII input before any normalization: %j",
    char => expect(normalizeEnterpriseOtpInput("2BCDEFG" + char)).toBeNull(),
  );

  it("does not trim other ASCII controls or DEL", () => {
    for (let code = 0; code <= 0x20; code++) {
      if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) continue;
      const char = String.fromCharCode(code);
      expect(normalizeEnterpriseOtpInput(char + canonical + char), "control " + code).toBeNull();
    }
    expect(normalizeEnterpriseOtpInput("\x7f" + canonical)).toBeNull();
    expect(normalizeEnterpriseOtpInput("2BCDEFG\x7f")).toBeNull();
  });

  it("applies the 1024 UTF-16-unit limit to the original input", () => {
    expect(normalizeEnterpriseOtpInput(" ".repeat(1016) + canonical)).toBe(canonical);
    expect(normalizeEnterpriseOtpInput(" ".repeat(1017) + canonical)).toBeNull();
    expect(normalizeEnterpriseOtpInput(canonical + "\t".repeat(1016))).toBe(canonical);
    expect(normalizeEnterpriseOtpInput(canonical + "\t".repeat(1017))).toBeNull();
    expect(normalizeEnterpriseOtpInput(" ".repeat(100_000) + canonical)).toBeNull();
  });
});

describe("strict enterprise login names (FS-49)", () => {
  it.each(["abc", "123", "a.b", "a_b", "a-b", "a..", "0_.", "a" + "b".repeat(63)])(
    "preserves a valid original alias: %j",
    value => expect(parseEnterpriseLoginName(value)).toBe(value),
  );

  it.each([
    "", "a", "ab", "a".repeat(65), ".ab", "_ab", "-ab", "Abc", "aBc",
    "abc ", " abc", "\tabc", "abc\n", "abc\r\n", "abc\0", "a bc", "a/b",
    "a@b", "a:b", "åbc", "ａｂｃ", "abc\u00a0", "abc\u200b", "aKb", "aſb",
  ])("rejects an invalid alias without trimming or folding: %j", value => {
    expect(parseEnterpriseLoginName(value)).toBeNull();
  });

  it("rejects every ASCII whitespace character at either edge", () => {
    for (const { value } of whitespace) {
      expect(parseEnterpriseLoginName(value + "abc")).toBeNull();
      expect(parseEnterpriseLoginName("abc" + value)).toBeNull();
    }
  });
});

describe("unknown input types (FS-49)", () => {
  it.each([
    { name: "undefined", value: undefined }, { name: "null", value: null },
    { name: "boolean", value: true }, { name: "number", value: 23456789 },
    { name: "NaN", value: NaN }, { name: "infinity", value: Infinity },
    { name: "bigint", value: 23456789n }, { name: "symbol", value: Symbol("synthetic-input") },
    { name: "array", value: [canonical] }, { name: "record", value: {} },
    { name: "boxed string", value: Object(canonical) },
    { name: "function", value: () => canonical },
  ])("rejects $name without coercion", ({ value }) => {
    expect(normalizeEnterpriseOtpInput(value)).toBeNull();
    expect(parseEnterpriseLoginName(value)).toBeNull();
  });

  it("does not access properties or conversion hooks on objects", () => {
    const unexpected = (): never => { throw new Error("conversion must not run"); };
    const hostile = { get length() { return unexpected(); }, toString: unexpected, [Symbol.toPrimitive]: unexpected };
    const proxy = new Proxy({}, { get: unexpected });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const value of [hostile, proxy, revoked.proxy, Object.create(null)]) {
      expect(normalizeEnterpriseOtpInput(value)).toBeNull();
      expect(parseEnterpriseLoginName(value)).toBeNull();
    }
  });
});
