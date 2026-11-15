/** @type {import('dependency-cruiser').IConfiguration['options']} */
module.exports = {
  tsConfig: {
    fileName: "tsconfig.json",
  },
  // 类型依赖也受 App 隔离合同约束（ADR-FSM-02）。
  tsPreCompilationDeps: true,
  // Follow package.json "exports" (workspace packages expose only exports).
  enhancedResolveOptions: {
    exportsFields: ["exports"],
    conditionNames: ["import", "require", "node", "default", "types"],
    mainFields: ["types", "module", "main"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"],
  },
  exclude: {
    // Keep third-party edges (including node_modules/*/dist) visible to the
    // Mock boundary; doNotFollow still prevents scanning those packages.
    path: "^(?!.*(^|/)node_modules/).*(^|/)(dist|\\.next|\\.turbo|coverage|playwright-report|test-results)(/|$)",
  },
  doNotFollow: {
    path: "node_modules",
  },
};
