// megaui:libs/mega/services/monoengine/ssh-key-validation.ts@0ff3a9d

import { MegaBadRequestError } from "@megaui/engine";

const ALLOWED_SSH_KEY_TYPES = new Set([
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
]);

const CERT_SUFFIX = "-cert-v01@openssh.com";

function isValidBase64Segment(segment: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(segment) || segment.length % 4 !== 0) {
    return false;
  }
  try {
    const decoded = Buffer.from(segment, "base64");
    return decoded.length > 0;
  } catch {
    return false;
  }
}

/** BFF pre-check per workspace-settings-backend.md (ST-S1 freeze). */
export function assertValidSshPublicKeyLine(publicKey: string): void {
  const trimmed = publicKey.trim();
  if (!trimmed) {
    throw new MegaBadRequestError("SSH public key is required");
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) {
    throw new MegaBadRequestError("SSH public key must include key type and body");
  }

  const keyType = parts[0];
  const keyBody = parts[1];
  if (!keyType || !keyBody) {
    throw new MegaBadRequestError("SSH public key must include key type and body");
  }
  if (keyType === "ssh-dss" || keyType.endsWith(CERT_SUFFIX)) {
    throw new MegaBadRequestError("SSH key type is not supported");
  }
  if (!ALLOWED_SSH_KEY_TYPES.has(keyType)) {
    throw new MegaBadRequestError("SSH key type is not supported");
  }
  if (!isValidBase64Segment(keyBody)) {
    throw new MegaBadRequestError("SSH public key body is not valid base64");
  }
}
