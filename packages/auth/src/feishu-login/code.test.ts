// FSL-133: the code generator of the Feishu login (FS-35 generation rules, unchanged), trimmed
// from its earlier test to the generator and canonical-format cases.
import { randomInt } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FEISHU_LOGIN_CODE_ALPHABET, FEISHU_LOGIN_CODE_LENGTH, generateFeishuLoginCode } from "../index";
import { isCanonicalFeishuLoginCode } from "./code";

vi.mock("node:crypto", async importOriginal => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});
const randomIntMock = vi.mocked(randomInt as (min: number, max: number) => number);

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  randomIntMock.mockReset().mockImplementation(actual.randomInt);
});

const code = "2A3B4C5D";
function expectPrivateFailure(action: () => unknown): void {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe("Feishu login code generation failed");
  expect((caught as Error).cause).toBeUndefined();
}

describe("Feishu login code generator (FS-35 rules)", () => {
  it("generates canonical mixed eight-character codes through the public auth API", () => {
    expect(FEISHU_LOGIN_CODE_ALPHABET).toBe("23456789ABCDEFGHJKMNPQRSTUVWXYZ");
    expect(FEISHU_LOGIN_CODE_LENGTH).toBe(8);
    for (let i = 0; i < 256; i++) {
      const value = generateFeishuLoginCode();
      expect(value).toHaveLength(8);
      expect([...value].every(char => FEISHU_LOGIN_CODE_ALPHABET.includes(char))).toBe(true);
      expect(value).toMatch(/[2-9]/); expect(value).toMatch(/[A-Z]/);
      expect(isCanonicalFeishuLoginCode(value)).toBe(true);
    }
  });
  it("rejects whole digit-only and letter-only samples and reaches alphabet endpoints", () => {
    for (const char of "22222222AAAAAAAA2ZZZZZZZ") randomIntMock.mockReturnValueOnce(FEISHU_LOGIN_CODE_ALPHABET.indexOf(char));
    expect(generateFeishuLoginCode()).toBe("2ZZZZZZZ");
    expect(randomInt).toHaveBeenCalledTimes(24);
    for (const call of randomIntMock.mock.calls) expect(call).toEqual([0, 31]);
  });
  it("bounds rejection at 128 whole samples and redacts random-source errors", () => {
    randomIntMock.mockReturnValue(0);
    expectPrivateFailure(generateFeishuLoginCode);
    expect(randomInt).toHaveBeenCalledTimes(1024);
    randomIntMock.mockImplementation(() => { throw new Error("private failure"); });
    expectPrivateFailure(generateFeishuLoginCode);
  });
  it("accepts a canonical mixed code", () => {
    expect(isCanonicalFeishuLoginCode(code)).toBe(true);
  });
  it.each([
    ["missing", undefined], ["null", null], ["number", 23456789], ["object", {}], ["array", [code]],
    ["empty", ""], ["short", "2A3B4C5"], ["long", code + "2"], ["lowercase", "2a3b4c5d"],
    ["digits", "23456789"], ["letters", "ABCDEFGH"], ["ambiguous", "2I3L4O5D"],
    ["leading space", " " + code], ["trailing newline", code + "\n"], ["non-ASCII", "２A3B4C5D"],
  ])("rejects %s without normalizing", (_name, value) => {
    expect(isCanonicalFeishuLoginCode(value)).toBe(false);
  });
});
