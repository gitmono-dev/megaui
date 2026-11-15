// megaui-only (FS-80): fixture approval signer has no upstream counterpart.
// FS-80 fixture signer. This process is the only holder of the authority private key.
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { canonicalSignedDocument, type ApprovalBundle } from "./admin-approval-verifier";

const [keyPath, publicPath, requestPath, outputPath] = process.argv.slice(2);
if (!keyPath || !publicPath || !requestPath || !outputPath) {
  process.stderr.write("error: SIGNER_ARGUMENTS\n");
  process.exit(2);
}

let privatePem: string;
if (!existsSync(keyPath)) {
  const pair = generateKeyPairSync("ed25519");
  privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  writeFileSync(keyPath, privatePem, { mode: 0o600 });
  writeFileSync(
    publicPath,
    pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    { mode: 0o600 },
  );
} else {
  privatePem = readFileSync(keyPath, "utf8");
}

const request = JSON.parse(readFileSync(requestPath, "utf8")) as ApprovalBundle;
request.signature = "";
request.signature = sign(
  null,
  Buffer.from(canonicalSignedDocument(request), "utf8"),
  createPrivateKey(privatePem),
).toString("base64");
writeFileSync(outputPath, JSON.stringify(request));
