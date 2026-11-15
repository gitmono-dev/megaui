// FS-85: offline approval authority has no database or application environment.
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  approvalPublicKey,
  parseApprovalBundle,
  verifyApprovalSignature,
} from "./admin-approval-verifier";
import { payloadDigest, type PayloadDigestInput } from "./admin-payload";
import { runApprovalAuthority } from "./approval-authority";

const NOW = new Date("2030-01-01T00:00:00Z");
const EXPIRES_AT = "2030-01-01T00:10:00Z";
const OPERATION_ID = "00000000-0000-4000-8000-000000000085";
const directories: string[] = [];
const require = createRequire(import.meta.url);

function request(): Record<string, unknown> {
  const payload: PayloadDigestInput = {
    verb: "maintenance",
    targetFingerprint: "megaui:fs85-instance:test",
    deploymentRole: "test",
    operationId: OPERATION_ID,
    expectedPolicyEpoch: 3,
    args: {
      target: "fs85-instance",
      "operation-id": OPERATION_ID,
      "expect-policy-epoch": 3,
      mode: "maintenance",
    },
    inputFiles: {},
  };
  return { schemaVersion: 1, ...payload, manifestDigest: null, payloadDigest: payloadDigest(payload) };
}

function setup(): {
  directory: string;
  requestPath: string;
  keyPath: string;
  publicPem: string;
  outputPath: string;
  privatePem: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "megaui-fs85-"));
  directories.push(directory);
  const pair = generateKeyPairSync("ed25519");
  const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const requestPath = join(directory, "request.json");
  const keyPath = join(directory, "authority.pem");
  const outputPath = join(directory, "approval.json");
  writeFileSync(requestPath, JSON.stringify(request()));
  writeFileSync(keyPath, privatePem, { mode: 0o600 });
  return { directory, requestPath, keyPath, publicPem, outputPath, privatePem };
}

function argv(paths: ReturnType<typeof setup>, overrides: Partial<Record<string, string>> = {}): string[] {
  return [
    "--request", overrides.request ?? paths.requestPath,
    "--key-file", overrides.keyFile ?? paths.keyPath,
    "--approved-by", overrides.approvedBy ?? "fixture-authority",
    "--expires-at", overrides.expiresAt ?? EXPIRES_AT,
    "--out", overrides.out ?? paths.outputPath,
  ];
}

function invoke(args: string[]): { code: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = runApprovalAuthority({
    argv: args,
    now: () => NOW,
    newApprovalId: () => "00000000-0000-4000-8000-0000000000a5",
    io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true });
});

describe("offline approval authority (FS-85)", () => {
  it("recomputes the request digest and produces a bundle accepted by the public verifier", () => {
    const paths = setup();
    const result = invoke(argv(paths));
    expect(result).toEqual({
      code: 0,
      stdout: JSON.stringify({
        schemaVersion: 1,
        approvalId: "00000000-0000-4000-8000-0000000000a5",
        operationId: OPERATION_ID,
        expiresAt: 1_893_456_600,
      }) + "\n",
      stderr: "",
    });
    expect(result.stdout).not.toContain(paths.privatePem);
    const parsed = parseApprovalBundle(JSON.parse(readFileSync(paths.outputPath, "utf8")));
    expect(typeof parsed).not.toBe("string");
    const key = approvalPublicKey(paths.publicPem);
    expect(typeof key).not.toBe("string");
    if (typeof parsed === "string" || typeof key === "string") throw new Error("fixture key rejected");
    expect(verifyApprovalSignature(parsed, key)).toBe(true);
    expect(parsed.operations).toEqual([expect.objectContaining({ operationId: OPERATION_ID })]);
  });

  it("refuses requests whose declared digest does not match canonical payload bytes", () => {
    const paths = setup();
    const corrupt = { ...request(), payloadDigest: "a".repeat(64) };
    writeFileSync(paths.requestPath, JSON.stringify(corrupt));
    expect(invoke(argv(paths))).toEqual({ code: 2, stdout: "", stderr: "error: AUTHORITY_REQUEST_INVALID\n" });
  });

  it("refuses non-Ed25519 private keys without printing key material", () => {
    const paths = setup();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privatePem = rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    writeFileSync(paths.keyPath, privatePem, { mode: 0o600 });
    const result = invoke(argv(paths));
    expect(result).toEqual({ code: 2, stdout: "", stderr: "error: AUTHORITY_KEY_INVALID\n" });
    expect(result.stderr).not.toContain(privatePem);
  });

  it.each([
    ["blank approver", { approvedBy: " " }, "AUTHORITY_APPROVER_INVALID"],
    ["past expiry", { expiresAt: "2029-12-31T23:59:59Z" }, "AUTHORITY_EXPIRY_INVALID"],
    ["non-UTC expiry", { expiresAt: "2030-01-01T08:10:00+08:00" }, "AUTHORITY_EXPIRY_INVALID"],
  ])("rejects %s", (_name, overrides, key) => {
    const paths = setup();
    expect(invoke(argv(paths, overrides))).toEqual({ code: 2, stdout: "", stderr: `error: ${key}\n` });
  });

  it("rejects unknown, duplicate, and unsafe path arguments before reading files", () => {
    const paths = setup();
    expect(invoke([...argv(paths), "--unknown", "value"])).toEqual({
      code: 2, stdout: "", stderr: "error: AUTHORITY_ARGUMENTS\n",
    });
    expect(invoke([...argv(paths), "--request", paths.requestPath])).toEqual({
      code: 2, stdout: "", stderr: "error: AUTHORITY_ARGUMENTS\n",
    });
    expect(invoke(argv(paths, { out: "relative.json" }))).toEqual({
      code: 2, stdout: "", stderr: "error: AUTHORITY_ARGUMENTS\n",
    });
  });

  it("keeps the complete signing module graph free of database and application-environment modules", async () => {
    const [{ cruise }, { default: extractTSConfig }] = await Promise.all([
      import("dependency-cruiser"),
      import("dependency-cruiser/config-utl/extract-ts-config"),
    ]);
    const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const options = require("../../../../.dependency-cruiser-options.cjs") as Record<string, unknown>;
    const graph = cruise(
      ["packages/engine/src/cli/approval-authority.ts"],
      {
        ...options,
        baseDir: repositoryRoot,
        validate: false,
      } as never,
      undefined,
      { tsConfig: extractTSConfig(`${repositoryRoot}/tsconfig.json`) },
    );
    return graph.then(result => {
      const modules = (result.output as { modules: Array<{ source: string }> }).modules;
      const applicationSources = modules
        .map(({ source }) => source)
        .filter((source) => !source.startsWith("node_modules/") && !["crypto", "fs", "path"].includes(source));
      expect(applicationSources.sort()).toEqual([
        "packages/engine/src/cli/admin-approval-verifier.ts",
        "packages/engine/src/cli/admin-payload.ts",
        "packages/engine/src/cli/admin-request.ts",
        "packages/engine/src/cli/approval-authority.ts",
      ]);
    });
  });
});
