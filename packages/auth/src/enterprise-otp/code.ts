// megaui-only (FS-35): CSPRNG generation and the single canonical OTP predicate.
import { randomInt } from "node:crypto";

export const ENTERPRISE_OTP_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const ENTERPRISE_OTP_LENGTH = 8;
export const ENTERPRISE_OTP_FAILURE_MESSAGE = "Enterprise OTP operation failed";

// Internal shared predicate; user-input normalization belongs to FS-49.
export function isCanonicalEnterpriseOtpCode(value: unknown): value is string {
  return typeof value === "string" && value.length === ENTERPRISE_OTP_LENGTH
    && [...value].every(char => ENTERPRISE_OTP_ALPHABET.includes(char))
    && /[2-9]/.test(value) && /[A-Z]/.test(value);
}

export function generateEnterpriseOtpCode(): string {
  try {
    for (let attempt = 0; attempt < 128; attempt++) {
      let code = "";
      for (let index = 0; index < ENTERPRISE_OTP_LENGTH; index++) {
        code += ENTERPRISE_OTP_ALPHABET[randomInt(0, ENTERPRISE_OTP_ALPHABET.length)];
      }
      // Reject the entire sample to preserve uniformity over mixed valid codes.
      if (isCanonicalEnterpriseOtpCode(code)) return code;
    }
  } catch {
    // Never expose a random-source exception or any secret-bearing cause.
  }
  throw new Error(ENTERPRISE_OTP_FAILURE_MESSAGE);
}
