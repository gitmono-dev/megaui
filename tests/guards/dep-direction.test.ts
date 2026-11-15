import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ADR-ARCH-01 / ADR-FSM-02：运行真实配置与 depcruise，不复制规则正则。
 * 真实 workspace 保留正例；所有负例只写本 run 的独占临时图。
 */
const REPO_ROOT = resolve(__dirname, "../..");
const DEPCRUISE_BIN = resolve(REPO_ROOT, "node_modules/.bin/depcruise");
const CONFIG_FILE = resolve(REPO_ROOT, ".dependency-cruiser.cjs");
const MOCK_SOURCE = "apps/feishu-mock/src";
const MOCK_LITERAL_RULE = "feishu-mock-literal-imports";
const MOCK_DYNAMIC_RULE = "feishu-mock-dynamic-import";
const MOCK_OPAQUE_RULE = "feishu-mock-opaque-loader";
const MOCK_CONSUMER_RULE = "no-imports-from-feishu-mock";
const DEPCRUISE_TIMEOUT = 30_000;

interface GuardResult {
  modules: {
    source: string;
    dependencies: { module: string; resolved: string; couldNotResolve: boolean }[];
  }[];
  summary: {
    error: number;
    violations: { from: string; to: string; rule: { name: string } }[];
  };
}

function runGuard(cwd = REPO_ROOT): { exitCode: number; result: GuardResult } {
  const args = ["--config", CONFIG_FILE, "apps", "packages"];
  // The JSON reporter always exits 0. Keep the actual CMD-03 err reporter's
  // exit status, and inspect a separate JSON cruise to prove edge resolution.
  let exitCode = 0;
  try {
    execFileSync(DEPCRUISE_BIN, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DEPCRUISE_TIMEOUT,
    });
  } catch (error) {
    const execError = error as { status?: number; stdout?: string };
    // A CLI/configuration failure must fail the test, never count as rejection.
    if (!execError.status || !execError.stdout) throw error;
    exitCode = execError.status;
  }
  const result = JSON.parse(
    execFileSync(DEPCRUISE_BIN, [...args, "--output-type", "json"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
      timeout: DEPCRUISE_TIMEOUT,
    }),
  ) as GuardResult;
  return { exitCode, result };
}

function rejectedGraph(files: Record<string, string>): string {
  let failure: unknown;
  try {
    withGraph(files, () => undefined);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  return (failure as Error).message;
}

function withGraph(
  files: Record<string, string>,
  verify: (result: ReturnType<typeof runGuard>) => void,
  prepare?: (graphRoot: string) => void,
): void {
  const graphRoot = mkdtempSync(join(tmpdir(), "megaui-dep-direction-"));
  try {
    const graphFiles = {
      "package.json": JSON.stringify({ private: true, type: "module" }),
      "tsconfig.json": JSON.stringify({
        extends: resolve(REPO_ROOT, "tsconfig.base.json"),
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@fixture/mock": [`${MOCK_SOURCE}/internal.ts`],
            "@fixture/web": ["apps/web/src/index.ts"],
            "@fixture/core": ["packages/core/src/index.ts"],
          },
        },
      }),
      [`${MOCK_SOURCE}/internal.ts`]: "export interface Value {}\n",
      "apps/feishu-mock/tests/helper.ts": "export interface Value {}\n",
      "apps/web/src/index.ts": "export interface Value {}\n",
      "packages/core/src/index.ts": "export interface Value {}\n",
      "packages/engine/package.json": JSON.stringify({
        name: "@megaui/engine",
        exports: "./src/index.ts",
      }),
      "packages/engine/src/index.ts": "export interface Value {}\n",
      ...files,
    };
    for (const [file, content] of Object.entries(graphFiles)) {
      const target = resolve(graphRoot, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    // Resolve real test/third-party packages, plus an isolated package export.
    for (const name of ["vitest", "@playwright/test", "typescript", "@megaui/engine"]) {
      const target = resolve(graphRoot, "node_modules", name);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(
        name === "@megaui/engine"
          ? resolve(graphRoot, "packages/engine")
          : resolve(REPO_ROOT, "node_modules", name),
        target,
        "dir",
      );
    }
    prepare?.(graphRoot);
    verify(runGuard(graphRoot));
  } finally {
    rmSync(graphRoot, { recursive: true, force: true });
    expect(existsSync(graphRoot)).toBe(false);
  }
}

describe("dep-direction guard (ADR-ARCH-01 / ADR-FSM-02)", () => {
  it("exits 0 on the current workspace (no forbidden edges)", () => {
    const { exitCode, result } = runGuard();
    expect(result.summary.violations).toEqual([]);
    expect(exitCode).toBe(0);
  }, 30_000);

  it("rejects core importing engine through a resolved package export", () => {
    withGraph(
      { "packages/core/src/probe.ts": 'import "@megaui/engine";' },
      ({ exitCode, result }) => {
        expect(exitCode).not.toBe(0);
        expect(result.summary.violations).toContainEqual(
          expect.objectContaining({
            from: "packages/core/src/probe.ts",
            to: "packages/engine/src/index.ts",
            rule: expect.objectContaining({ name: "core-is-leaf" }),
          }),
        );
      },
    );
  }, 30_000);

  describe("Mock source boundary", () => {
    it("allows node builtins and in-app relative modules", () => {
      withGraph(
        {
          [`${MOCK_SOURCE}/allowed.ts`]: [
            'import fs from "node:fs";',
            'import { createHash } from "node:crypto";',
            'import type { Value } from "./internal";',
            'export { createHash };',
            'export type { Value };',
            'export const exists = fs.existsSync("x");',
            'export const url = new URL("https://example.com");',
          ].join("\n"),
        },
        ({ exitCode, result }) => {
          expect(result.summary.violations).toEqual([]);
          expect(exitCode).toBe(0);
        },
      );
    }, 30_000);

    it("allows dynamic imports of node builtins and in-app relative modules", () => {
      withGraph(
        {
          [`${MOCK_SOURCE}/dynamic-allowed.ts`]: [
            'export const builtin = () => import("node:fs");',
            'export const internal = () => import("./internal");',
          ].join("\n"),
        },
        ({ exitCode, result }) => {
          expect(result.summary.violations).toEqual([]);
          expect(exitCode).toBe(0);
        },
      );
    }, 30_000);

    it.each([
      { specifier: "typescript", form: `import "${'typescript'}";` },
      { specifier: "fs", form: `import "fs";` },
      { specifier: "http", form: `import "http";` },
      { specifier: "node:sqlite", form: `import "node:sqlite";` },
      { specifier: "@fixture/web", form: `import "@fixture/web";` },
      { specifier: "@fixture/core", form: `import "@fixture/core";` },
      { specifier: "@fixture/mock", form: `import "@fixture/mock";` },
      { specifier: "../../../packages/core/src/index", form: `import "../../../packages/core/src/index";` },
      { specifier: "../../web/src/index", form: `import "../../web/src/index";` },
      { specifier: "../tests/helper", form: `import "../tests/helper";` },
    ])("rejects a static import of $specifier", ({ form }) => {
      expect(() =>
        withGraph({ [`${MOCK_SOURCE}/rejected.ts`]: form }, () => undefined),
      ).toThrow(new RegExp(MOCK_LITERAL_RULE));
    }, 30_000);

    it("rejects a static type import of a bare builtin", () => {
      expect(() =>
        withGraph(
          { [`${MOCK_SOURCE}/type-builtin.ts`]: 'export type Builtin = import("fs").PathLike;' },
          () => undefined,
        ),
      ).toThrow(new RegExp(MOCK_LITERAL_RULE));
    }, 30_000);

    it("rejects a node: specifier that does not exist", () => {
      expect(() =>
        withGraph({ [`${MOCK_SOURCE}/missing-builtin.ts`]: 'import "node:does-not-exist";' }, () => undefined),
      ).toThrow(new RegExp(MOCK_LITERAL_RULE));
    }, 30_000);

    it("rejects a node: specifier remapped by the nearest tsconfig", () => {
      expect(() =>
        withGraph(
          {
            "apps/feishu-mock/tsconfig.json": JSON.stringify({
              compilerOptions: {
                module: "ESNext",
                moduleResolution: "Bundler",
                baseUrl: ".",
                paths: { "node:fs": ["../../packages/core/src/index.ts"] },
              },
            }),
            [`${MOCK_SOURCE}/remapped-node.ts`]: 'import "node:fs";',
          },
          () => undefined,
        ),
      ).toThrow(new RegExp(MOCK_LITERAL_RULE));
    }, 30_000);

    it("rejects a node: specifier remapped onto a third-party package", () => {
      expect(() =>
        withGraph(
          {
            "apps/feishu-mock/tsconfig.json": JSON.stringify({
              compilerOptions: {
                module: "ESNext",
                moduleResolution: "Bundler",
                baseUrl: ".",
                paths: { "node:fs": ["../../node_modules/typescript/package.json"] },
              },
            }),
            [`${MOCK_SOURCE}/remapped-package.ts`]: 'import "node:fs";',
          },
          () => undefined,
        ),
      ).toThrow(new RegExp(MOCK_LITERAL_RULE));
    }, 30_000);

    it.each([
      { specifier: "typescript", form: 'export const loaded = import("typescript");' },
      { specifier: "fs", form: 'export const loaded = import("fs");' },
      { specifier: "@fixture/mock", form: 'export const loaded = import("@fixture/mock");' },
      { specifier: "../../web/src/index", form: 'export const loaded = import("../../web/src/index");' },
    ])("rejects a dynamic import of $specifier", ({ form }) => {
      expect(() =>
        withGraph({ [`${MOCK_SOURCE}/dynamic-rejected.ts`]: form }, () => undefined),
      ).toThrow(new RegExp(MOCK_DYNAMIC_RULE));
    }, 30_000);

    it("rejects a dynamic import whose target is computed", () => {
      expect(() =>
        withGraph(
          {
            [`${MOCK_SOURCE}/dynamic-computed.ts`]: [
              'const target = "typescript";',
              "export const loaded = import(target);",
            ].join("\n"),
          },
          () => undefined,
        ),
      ).toThrow(new RegExp(MOCK_DYNAMIC_RULE));
    }, 30_000);

    it.each([
      {
        name: "require",
        source: 'export const loaded = require("fs");',
      },
      {
        name: "stored require",
        source: ['const load = require;', 'export const loaded = load("fs");'].join("\n"),
      },
      {
        name: "createRequire import",
        source: [
          'import { createRequire } from "node:module";',
          'export const loaded = createRequire(import.meta.url)("fs");',
        ].join("\n"),
      },
      {
        name: "createRequire namespace",
        source: [
          'import * as nodeModule from "node:module";',
          'export const loaded = nodeModule.createRequire(import.meta.url)("fs");',
        ].join("\n"),
      },
      {
        name: "register",
        source: ['import { register } from "node:module";', 'register("typescript");'].join("\n"),
      },
      {
        name: "getBuiltinModule",
        source: 'export const loaded = process.getBuiltinModule("node:module");',
      },
      {
        name: "module.require",
        source: 'export const loaded = module.require("fs");',
      },
      {
        name: "computed getBuiltinModule",
        source: [
          'const api = process["get" + "BuiltinModule"]("node:module");',
          'const load = api["create" + "Require"](import.meta.url);',
          'export const loaded = load("fs");',
        ].join("\n"),
      },
      {
        name: "computed getBuiltinModule by variable",
        source: [
          'const key = "getBuiltinModule";',
          'const api = process[key]("node:module");',
          'const name = "createRequire";',
          'const load = api[name](import.meta.url);',
          'export const loaded = load("fs");',
        ].join("\n"),
      },
      {
        name: "eval",
        source: 'export const loaded = eval("require(\'fs\')");',
      },
      {
        name: "Function constructor",
        source: 'export const loaded = new Function("return require(\'fs\')")();',
      },
      {
        name: "globalThis Function",
        source: 'export const loaded = globalThis.Function("return import(\'fs\')")();',
      },
      {
        name: "globalThis eval",
        source: 'export const loaded = globalThis["eval"]("import(\'fs\')");',
      },
      {
        name: "destructured Function",
        source: [
          'const { Function: F } = globalThis;',
          'export const loaded = F("return import(\'fs\')")();',
        ].join("\n"),
      },
      {
        name: "computed destructured Function",
        source: [
          'const key = "Function";',
          'const { [key]: F } = globalThis;',
          'export const loaded = F("return import(\'fs\')")();',
        ].join("\n"),
      },
      {
        name: "globalThis alias",
        source: [
          'const g = globalThis;',
          'export const loaded = g["eval"]("import(\'fs\')");',
        ].join("\n"),
      },
      {
        name: "Reflect apply",
        source: 'export const loaded = Reflect.apply(require, null, ["fs"]);',
      },
      {
        name: "constructor access",
        source: 'export const loaded = (() => {}).constructor("return import(\'fs\')")();',
      },
      {
        name: "joined builtin key",
        source: [
          'const key = ["get", "BuiltinModule"].join("");',
          'const api = process[key]("node:module");',
          'const name = ["create", "Require"].join("");',
          'export const loaded = api[name](import.meta.url)("fs");',
        ].join("\n"),
      },
      {
        name: "native addon load",
        source: 'export const loaded = process.dlopen({ exports: {} }, "/tmp/external.node");',
      },
      {
        name: "computed native addon load",
        source: 'export const loaded = process["dl" + "open"]({ exports: {} }, "/tmp/external.node");',
      },
    ])("rejects the opaque loader $name", ({ source }) => {
      expect(() =>
        withGraph({ [`${MOCK_SOURCE}/opaque.ts`]: source }, () => undefined),
      ).toThrow(new RegExp(MOCK_OPAQUE_RULE));
    }, 30_000);

    it.each([
      "node:module",
      "node:vm",
      "node:worker_threads",
      "node:inspector",
      "node:inspector/promises",
      "node:repl",
      "node:child_process",
      "node:sqlite",
      "node:test",
      "node:sea",
      "node:diagnostics_channel",
    ])("rejects the builtin %s outside the Mock allowlist", (specifier) => {
        expect(() =>
          withGraph({ [`${MOCK_SOURCE}/denied.ts`]: `import "${specifier}";` }, () => undefined),
        ).toThrow(new RegExp(MOCK_LITERAL_RULE));
      },
      30_000,
    );

    it.each([
      {
        name: "node:module import",
        source: 'import * as nodeModule from "node:module";\nexport const api = nodeModule;',
      },
      {
        name: "computed createRequire",
        source: [
          'import * as moduleApi from "node:module";',
          'const load = moduleApi["create" + "Require"](import.meta.url);',
          'export const loaded = load("fs");',
        ].join("\n"),
      },
    ])("rejects the node:module source $name", ({ source }) => {
      expect(() =>
        withGraph({ [`${MOCK_SOURCE}/opaque.ts`]: source }, () => undefined),
      ).toThrow(new RegExp(MOCK_LITERAL_RULE));
    }, 30_000);
  });

  describe("consumer boundary", () => {
    it.each([
      { specifier: "@fixture/mock", form: `import "@fixture/mock";` },
      { specifier: "@megaui/feishu-mock", form: `import "@megaui/feishu-mock";` },
      { specifier: "@megaui/feishu-mock/src/internal", form: `import "@megaui/feishu-mock/src/internal";` },
    ])("rejects a static import of $specifier", ({ form }) => {
      expect(() =>
        withGraph({ "apps/web/lib/rejected.ts": form }, () => undefined),
      ).toThrow(new RegExp(MOCK_CONSUMER_RULE));
    }, 30_000);

    it("rejects a static import that reaches Mock source by relative path", () => {
      expect(() =>
        withGraph(
          { "apps/web/lib/relative.ts": 'import "../../feishu-mock/src/internal";' },
          () => undefined,
        ),
      ).toThrow(new RegExp(MOCK_CONSUMER_RULE));
    }, 30_000);

    it("rejects a type import of Mock", () => {
      expect(() =>
        withGraph(
          { "apps/web/lib/type.ts": 'import type { Value } from "@fixture/mock";' },
          () => undefined,
        ),
      ).toThrow(new RegExp(MOCK_CONSUMER_RULE));
    }, 30_000);

    it("rejects a JSDoc type import of Mock", () => {
      expect(() =>
        withGraph(
          { "apps/web/lib/jsdoc.js": '/** @type {import("@fixture/mock").Value} */ let x;' },
          () => undefined,
        ),
      ).toThrow(new RegExp(MOCK_CONSUMER_RULE));
    }, 30_000);

    it.each([
      { specifier: "@fixture/mock", form: 'export const loaded = import("@fixture/mock");' },
      {
        specifier: "../../feishu-mock/src/internal",
        form: 'export const loaded = import("../../feishu-mock/src/internal");',
      },
      { specifier: "@fixture/mock", form: 'export const loaded = require("@fixture/mock");' },
    ])("rejects a dynamic import of $specifier", ({ form }) => {
      expect(() =>
        withGraph({ "apps/web/lib/dynamic.ts": form }, () => undefined),
      ).toThrow(new RegExp(MOCK_CONSUMER_RULE));
    }, 30_000);

    it("rejects a file URL that points at Mock source", () => {
      for (const specifierFor of [
        (target: string) => pathToFileURL(target).href,
        (target: string) => pathToFileURL(target).href.replace("file:///", "file:////"),
        (target: string) => `file://localhost${target}`,
        (target: string) => pathToFileURL(target).href.replace("file:", "FILE:"),
      ]) {
        expect(() =>
          withGraph({}, () => undefined, (graphRoot) => {
            const target = resolve(graphRoot, `${MOCK_SOURCE}/internal.ts`);
            const sourceFile = resolve(graphRoot, "apps/web/lib/file-url.ts");
            mkdirSync(dirname(sourceFile), { recursive: true });
            writeFileSync(sourceFile, `import ${JSON.stringify(specifierFor(target))};\n`);
          }),
        ).toThrow(new RegExp(MOCK_CONSUMER_RULE));
      }
    }, 30_000);

    it.each([
      {
        name: "dynamic import variable",
        prelude: ['const target = "@fixture/mock";'],
        call: "void import(target);",
      },
      {
        name: "require variable",
        prelude: ['const target = "@fixture/mock";'],
        call: "void require(target);",
      },
      {
        name: "optional require variable",
        prelude: ['const target = "@fixture/mock";'],
        call: "void require?.(target);",
      },
      {
        name: "dynamic import expression",
        prelude: ['const target = "fs";'],
        call: 'void import("node:" + target);',
      },
      {
        name: "require template expression",
        prelude: ['const target = "fs";'],
        call: "void require(`node:${target}`);",
      },
      {
        name: "aliased loader call",
        prelude: ["const loaders = [require];"],
        call: 'void loaders[0]("../../feishu-mock/src/internal");',
      },
      {
        name: "aliased loader member",
        prelude: ["const members = { load: require };"],
        call: 'void members.load("../../feishu-mock/src/internal");',
      },
      {
        name: "aliased loader through call",
        prelude: ["const loaders = [require];"],
        call: 'void loaders[0].call(null, "../../feishu-mock/src/internal");',
      },
      {
        name: "aliased loader through apply",
        prelude: ["const loaders = [require];"],
        call: 'void loaders[0].apply(null, ["../../feishu-mock/src/internal"]);',
      },
      {
        name: "module.require",
        prelude: [],
        call: 'void module.require("../../feishu-mock/src/internal");',
      },
      {
        name: "destructured loader",
        prelude: ["const { load } = { load: require };"],
        call: 'void load("../../feishu-mock/src/internal");',
      },
      {
        name: "conditional loader",
        prelude: [],
        call: 'void (true ? require : require)("../../feishu-mock/src/internal");',
      },
      {
        name: "destructured module.require",
        prelude: ["const { require: load } = module;"],
        call: 'void load("../../feishu-mock/src/internal");',
      },
      {
        name: "loader parameter",
        prelude: ["function use(load) {", "  return load("],
        call: '    "../../feishu-mock/src/internal");',
        suffix: ["}", "use(require);"],
      },
      {
        name: "loader and target parameters",
        prelude: ["function use(load, target) {", "  return load(target);", "}"],
        call: 'use(require, "../../feishu-mock/src/internal.js");',
      },
    ])("fails closed for a computed $name", ({ prelude, call, suffix }) => {
      const source = [...prelude, call, ...(suffix ?? [])].join("\n");
      expect(() =>
        withGraph({ "apps/web/lib/computed.ts": source }, () => undefined),
      ).toThrow(new RegExp(MOCK_CONSUMER_RULE));
    }, 30_000);

    it("allows a stored loader that loads a literal outside Mock", () => {
      withGraph(
        {
          "apps/web/lib/stored-loader.ts": [
            "const loaders = [require];",
            'export const loaded = loaders[0]("node:fs");',
            "const members = { load: require };",
            'export const other = members.load("node:path");',
          ].join("\n"),
        },
        ({ exitCode, result }) => {
          expect(result.summary.violations).toEqual([]);
          expect(exitCode).toBe(0);
        },
      );
    }, 30_000);

    it("rejects a createRequire load of Mock source", () => {
      expect(() =>
        withGraph(
          {
            "apps/web/lib/create-require.ts": [
              'import { createRequire } from "node:module";',
              'export const loaded = createRequire(import.meta.url)("../../feishu-mock/src/internal");',
            ].join("\n"),
          },
          () => undefined,
        ),
      ).toThrow(new RegExp(MOCK_CONSUMER_RULE));
    }, 30_000);

    it("rejects an aliased createRequire load of Mock source", () => {
      expect(() =>
        withGraph(
          {
            "apps/web/lib/aliased-require.ts": [
              'import { createRequire as make } from "node:module";',
              'export const loaded = make(import.meta.url)("../../feishu-mock/src/internal");',
            ].join("\n"),
          },
          () => undefined,
        ),
      ).toThrow(new RegExp(MOCK_CONSUMER_RULE));
    }, 30_000);

    it("rejects a createRequire load anchored inside Mock", () => {
      expect(() =>
        withGraph(
          {
            "apps/web/lib/anchored.ts": [
              'import { createRequire } from "node:module";',
              'const load = createRequire(new URL("../../feishu-mock/src/entry.js", import.meta.url));',
              'export const loaded = load("./internal.js");',
            ].join("\n"),
          },
          () => undefined,
        ),
      ).toThrow(new RegExp(MOCK_CONSUMER_RULE));
    }, 30_000);

    it("allows literal dynamic imports that stay outside Mock", () => {
      withGraph(
        {
          "apps/web/lib/allowed.ts": [
            'export const builtin = () => import("node:fs");',
            'export const local = () => import("./other");',
            'import { createRequire } from "node:module";',
            'const require = createRequire(import.meta.url);',
            'export const packageFile = require("./package.json");',
          ].join("\n"),
        },
        ({ exitCode, result }) => {
          expect(result.summary.violations).toEqual([]);
          expect(exitCode).toBe(0);
        },
      );
    }, 30_000);

    it("allows Mock tests and Web helpers consuming CLI plus HTTP", () => {
      withGraph(
        {
          "apps/feishu-mock/tests/unit/probe.test.ts": [
            'import { describe } from "vitest";',
            'import { test } from "@playwright/test";',
            'import type { Value } from "../../src/internal";',
            "export { describe, test }; export type TestValue = Value;",
          ].join("\n"),
          "apps/web/tests/e2e/helpers/mock-cli.ts": [
            'import { spawn } from "node:child_process";',
            'export const start = () => spawn("node", ["apps/feishu-mock/src/cli.ts"]);',
            'export const health = () => fetch("http://127.0.0.1:19400/health");',
          ].join("\n"),
        },
        ({ exitCode, result }) => {
          const dependencies = result.modules.find(
            (module) => module.source === "apps/feishu-mock/tests/unit/probe.test.ts",
          )?.dependencies;
          expect(dependencies).toHaveLength(3);
          expect(dependencies?.every((dependency) => !dependency.couldNotResolve)).toBe(true);
          expect(result.summary.violations).toEqual([]);
          expect(exitCode).toBe(0);
        },
      );
    }, 30_000);

    it("rejects other apps/packages and Web E2E helpers importing Mock source", () => {
      const consumers = [
        "apps/web/lib",
        "apps/web/tests/e2e/helpers",
        "apps/worker/src",
        "apps/collab-server/src",
        "packages/core/src",
        "packages/engine/src",
      ];
      const files = Object.fromEntries(
        consumers.map((consumer, index) => [
          `${consumer}/consumer-${index}.ts`,
          'import "@fixture/mock";',
        ]),
      );
      const lines = rejectedGraph(files).split("\n");
      for (const from of Object.keys(files)) {
        expect(
          lines.some((line) => line.includes(`${MOCK_CONSUMER_RULE}:`) && line.includes(from)),
          `${from} must be rejected`,
        ).toBe(true);
      }
    }, 30_000);
  });
});
