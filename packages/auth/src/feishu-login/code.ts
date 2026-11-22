// megaui-only (FS-35: CSPRNG generation and the single canonical OTP predicate; 原参照见 docs/implementation/feishu-login.md「来源」)
/**
 * FSL-133: the 8-character code generator of the Feishu login, moved here unchanged (only the
 * names changed). The engine issue service (FSL-122) takes it as its `generateCode` port and
 * the verify endpoint (FSL-124) admits only codes of this alphabet and length.
 */
import { randomInt } from "node:crypto";

export const FEISHU_LOGIN_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const FEISHU_LOGIN_CODE_LENGTH = 8;
export const FEISHU_LOGIN_CODE_FAILURE_MESSAGE = "Feishu login code generation failed";

/** The single canonical code predicate: 8 characters of the alphabet, at least one digit and one letter. */
export function isCanonicalFeishuLoginCode(value: unknown): value is string {
  return typeof value === "string" && value.length === FEISHU_LOGIN_CODE_LENGTH
    && [...value].every(char => FEISHU_LOGIN_CODE_ALPHABET.includes(char))
    && /[2-9]/.test(value) && /[A-Z]/.test(value);
}

export function generateFeishuLoginCode(): string {
  try {
    for (let attempt = 0; attempt < 128; attempt++) {
      let code = "";
      for (let index = 0; index < FEISHU_LOGIN_CODE_LENGTH; index++) {
        code += FEISHU_LOGIN_CODE_ALPHABET[randomInt(0, FEISHU_LOGIN_CODE_ALPHABET.length)];
      }
      // Reject the entire sample to preserve uniformity over mixed valid codes.
      if (isCanonicalFeishuLoginCode(code)) return code;
    }
  } catch {
    // Never expose a random-source exception or any secret-bearing cause.
  }
  throw new Error(FEISHU_LOGIN_CODE_FAILURE_MESSAGE);
}
