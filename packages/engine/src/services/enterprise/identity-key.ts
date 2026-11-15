// megaui-only (FS-37): one compatibility-key algorithm for provision and migration.
import { createHash } from "node:crypto";

export function compatibilityEmail(localUserId: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let pending = 0, bits = 0, encoded = "";
  for (const byte of createHash("sha256").update(localUserId).digest()) {
    pending = (pending << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += alphabet[(pending >>> bits) & 31];
    }
    pending &= (1 << bits) - 1;
  }
  if (bits > 0) encoded += alphabet[(pending << (5 - bits)) & 31];
  return "u_" + encoded + "@identity.invalid";
}
