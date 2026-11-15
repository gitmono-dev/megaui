/**
 * 包依赖方向守卫（SC-04）。
 *
 * 规则来源：ADR-ARCH-01单向依赖约束：
 *   `packages/core` ← `packages/{content,database,i18n,storage,auth,email}` ← `packages/engine` ← `apps/web`
 *   `packages/ui` → `{packages/core, packages/content, packages/i18n}`（仅此三者）
 * `apps/collab-server` 与 `apps/web` 是两个独立可发布应用，不通过源码 import 互相耦合。
 *
 * 挂入 CMD-03（`pnpm turbo run lint`）：见根 `turbo.json` 的 `//#lint:deps` 根任务与
 * `lint` 任务的 `dependsOn`，以及根 `package.json` 的 `lint:deps` script。
 *
 * Path rules match both resolved filesystem paths (`packages/engine/...`) and
 * workspace package names (`@megaui/engine`) so exports-based entrypoints are
 * covered even before a consuming package lists the dependency in package.json.
 */

const { existsSync, readdirSync, readFileSync } = require("node:fs");
const { dirname, isAbsolute, join, resolve } = require("node:path");
const { isBuiltin } = require("node:module");
const { fileURLToPath } = require("node:url");
const ts = require("typescript");

const generatedDirectories = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  "coverage",
  "playwright-report",
  "test-results",
]);

function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      return generatedDirectories.has(entry.name) ? [] : sourceFiles(file);
    }
    return entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : [];
  });
}

/**
 * ADR-FSM-02（FSM-17）的隔离边界是**可判定**的，而不是靠还原运行期别名：
 *
 * - Mock 生产源码（`apps/feishu-mock/src/**`）只允许静态声明真实 `node:*`
 *   内置模块或本 App 内相对模块；动态加载必须使用字面量说明符。
 * - Mock 生产源码不得出现 `require`、`createRequire`、`register`、
 *   `process.getBuiltinModule` 等不透明加载器，否则无法静态判定其目标。
 * - 其它 apps/packages（含网站 E2E 复用夹具）不得源码 import Mock；其动态
 *   加载同样必须使用字面量说明符，无法静态判定的目标一律拒绝。
 *
 * 规则用 AST 直接读取原始说明符，不依赖 depcruise 是否能提取括号语法的边。
 */

const mockRoot = resolve("apps/feishu-mock");
const mockSourceRoot = resolve("apps/feishu-mock/src");

function isMockAppFile(file) {
  return file.startsWith("apps/feishu-mock/");
}

function isMockSourceFile(file) {
  return file.startsWith("apps/feishu-mock/src/");
}

function unwrap(expression) {
  while (expression) {
    if (ts.isParenthesizedExpression(expression)) {
      expression = expression.expression;
      continue;
    }
    if (
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression)
    ) {
      expression = expression.expression;
      continue;
    }
    break;
  }
  return expression;
}

function bindsName(binding, name) {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(
    (element) => ts.isBindingElement(element) && bindsName(element.name, name),
  );
}

function importBindsName(declaration, name) {
  const clause = declaration.importClause;
  if (!clause) return false;
  if (clause.name && clause.name.text === name) return true;
  const bindings = clause.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return bindings.name.text === name;
  return bindings.elements.some((element) => element.name.text === name);
}

function scopeStatements(scope) {
  if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)) return scope.statements ?? [];
  if (ts.isFunctionLike(scope) && scope.body && ts.isBlock(scope.body)) return scope.body.statements;
  return [];
}

/** Locates the declaration a reference resolves to, if any. */
function bindingFor(expression) {
  for (let scope = expression.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      if (scope.parameters.some((parameter) => bindsName(parameter.name, expression.text))) {
        return { shadowed: "parameter" };
      }
      if (scope.name && ts.isIdentifier(scope.name) && scope.name.text === expression.text) {
        return { shadowed: true };
      }
    }
    if (
      ts.isCatchClause(scope) &&
      scope.variableDeclaration &&
      bindsName(scope.variableDeclaration.name, expression.text)
    ) {
      return { shadowed: true };
    }
    for (const statement of scopeStatements(scope)) {
      if (ts.isImportDeclaration(statement) && importBindsName(statement, expression.text)) {
        return { shadowed: true };
      }
      if (
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        statement.name?.text === expression.text
      ) {
        return { shadowed: true };
      }
    }
    const lists = scopeStatements(scope)
      .filter(ts.isVariableStatement)
      .map((statement) => statement.declarationList);
    for (const list of lists) {
      const declaration = list.declarations.find((item) => bindsName(item.name, expression.text));
      if (declaration) return { declaration };
    }
  }
  return undefined;
}

function mentionsIdentifier(expression, name) {
  let found = false;
  function visit(node) {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(expression);
  return found;
}

/** The literal text of a module specifier, or undefined when it is computed. */
function literalText(node) {
  const expression = unwrap(node);
  if (!expression) return undefined;
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isTemplateExpression(expression) && expression.templateSpans.length === 0) {
    return expression.head.text;
  }
  return undefined;
}

const resolutionByConfig = new Map();

function nearestTsconfig(file) {
  let dir = dirname(resolve(file));
  const stop = resolve(".");
  while (true) {
    const candidate = join(dir, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    if (dir === stop || dir === dirname(dir)) return join(stop, "tsconfig.json");
    dir = dirname(dir);
  }
}

function resolutionFor(file) {
  const configPath = nearestTsconfig(file);
  let cached = resolutionByConfig.get(configPath);
  if (!cached) {
    const configDir = dirname(configPath);
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, configDir);
    const options = { ...parsed.options };
    // Next's plugin is not needed to resolve path aliases and may be absent in guard runs.
    delete options.plugins;
    cached = {
      options,
      cache: ts.createModuleResolutionCache(configDir, (name) => name, options),
    };
    resolutionByConfig.set(configPath, cached);
  }
  return cached;
}

function moduleTarget(file, specifier) {
  const { options, cache } = resolutionFor(file);
  const target = ts.resolveModuleName(specifier, resolve(file), options, ts.sys, cache)
    .resolvedModule?.resolvedFileName;
  return target === undefined ? undefined : ts.sys.realpath(target);
}

function canonical(path) {
  try {
    return ts.sys.realpath(path);
  } catch {
    return resolve(path);
  }
}

function inside(directory, target) {
  if (target === undefined) return false;
  const root = canonical(directory);
  const file = canonical(target);
  return file === root || file.startsWith(`${root}/`);
}

function fileUrlPath(specifier) {
  if (!/^[\x00-\x20]*file:/i.test(specifier)) return undefined;
  try {
    const path = fileURLToPath(specifier);
    // file:////abs is parsed as //abs, and Node opens that as /abs.
    return path.startsWith("//") ? `/${path.replace(/^\/+/, "")}` : path;
  } catch {
    return undefined;
  }
}

/** Resolves a relative specifier against the file, also when it does not exist yet. */
function relativeTarget(file, specifier) {
  const base = resolve(dirname(file), specifier);
  const resolved = moduleTarget(file, specifier);
  if (resolved !== undefined) return resolved;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    join(base, "index.ts"),
    join(base, "index.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/** True when a specifier points at the Mock app or one of its sources. */
function targetsMock(file, specifier) {
  if (/^@megaui\/feishu-mock(?:\/|$)/.test(specifier)) return true;
  const fromFileUrl = fileUrlPath(specifier);
  if (fromFileUrl && inside(mockRoot, fromFileUrl)) return true;
  if (isAbsolute(specifier) && inside(mockRoot, resolve(specifier))) return true;
  if (/^\.\.?\//.test(specifier)) {
    const target = relativeTarget(file, specifier);
    return target !== undefined && inside(mockRoot, target);
  }
  const target = moduleTarget(file, specifier);
  return target !== undefined && inside(mockRoot, target);
}

/**
 * The node:* builtins Mock source may use. The list is an allowlist so that the
 * module-loading, evaluation and process-spawning capabilities of Node are
 * excluded by construction rather than by enumerating denied modules. It covers
 * the frozen Mock contract (HTTP server, control plane, provider API, events);
 * extending it is a reviewed change to the plan and the guide.
 */
const mockAllowedBuiltins = new Set([
  "node:assert",
  "node:assert/strict",
  "node:buffer",
  "node:crypto",
  "node:events",
  "node:fs",
  "node:fs/promises",
  "node:http",
  "node:net",
  "node:os",
  "node:path",
  "node:path/posix",
  "node:process",
  "node:stream",
  "node:stream/consumers",
  "node:stream/web",
  "node:string_decoder",
  "node:timers",
  "node:timers/promises",
  "node:url",
  "node:util",
  "node:util/types",
  "node:zlib",
]);

/**
 * Builtins that can load, evaluate or spawn code, and are therefore not allowed
 * in Mock source. Mock is a single process that must only depend on node:*.
 */
const mockDeniedBuiltins = new Set([
  "node:module",
  "module",
  "node:vm",
  "vm",
  "node:worker_threads",
  "worker_threads",
  "node:inspector",
  "node:inspector/promises",
  "inspector",
  "inspector/promises",
  "node:repl",
  "repl",
  "node:child_process",
  "child_process",
]);

/** True when Mock source may depend on the given specifier. */
function mockSpecifierAllowed(file, specifier) {
  if (typeof specifier !== "string") return false;
  if (specifier.startsWith("node:")) {
    // node:module / node:vm / node:worker_threads 只提供加载或执行能力，Mock 不允许引入。
    if (mockDeniedBuiltins.has(specifier)) return false;
    if (!mockAllowedBuiltins.has(specifier) || !isBuiltin(specifier)) return false;
    const resolved = moduleTarget(file, specifier);
    return resolved === undefined || inside(mockSourceRoot, resolved);
  }
  if (!/^\.\.?\//.test(specifier)) return false;
  const target = relativeTarget(file, specifier);
  return target !== undefined && inside(mockSourceRoot, target);
}

/**
 * Calls that load a module at runtime. `createRequire(...)` is a factory that
 * yields a loader, so `createRequire(x)("spec")` loads while `createRequire(x)`
 * itself does not.
 */
/** Locals bound to node:module's createRequire, regardless of the local alias. */
function moduleFacts(sourceFile) {
  const createRequireLocals = new Set();
  const moduleLocals = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const text = statement.moduleSpecifier.text;
    if (text !== "node:module" && text !== "module") continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) moduleLocals.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      moduleLocals.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (imported === "createRequire") createRequireLocals.add(element.name.text);
      if (imported === "register") moduleLocals.add(element.name.text);
    }
  }
  return { createRequireLocals, moduleLocals };
}

/** Every string literal inside an expression. */
function literalsIn(expression) {
  const literals = [];
  function visit(node) {
    if (ts.isStringLiteralLike(node)) {
      literals.push(node.text);
      return;
    }
    ts.forEachChild(node, visit);
  }
  if (expression) visit(expression);
  return literals;
}

/** True when the call is node:module's createRequire factory. */
function isCreateRequireFactory(expression, facts) {
  expression = unwrap(expression);
  if (!expression || !ts.isCallExpression(expression)) return false;
  const callee = unwrap(expression.expression);
  if (callee && ts.isIdentifier(callee) && facts.createRequireLocals.has(callee.text)) return true;
  if (
    callee &&
    (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
    memberKey(callee) === "createRequire" &&
    ts.isIdentifier(unwrap(callee.expression)) &&
    facts.moduleLocals.has(unwrap(callee.expression).text)
  ) {
    return true;
  }
  return mentionsIdentifier(expression.expression, "createRequire");
}

/** The path a loader is anchored at, when it was created by createRequire. */
function loaderAnchor(expression, facts, seen = new Set()) {
  expression = unwrap(expression);
  if (!expression || seen.has(expression)) return undefined;
  seen.add(expression);
  if (ts.isCallExpression(expression) && isCreateRequireFactory(expression, facts)) {
    return expression.arguments[0];
  }
  if (ts.isIdentifier(expression)) {
    const declaration = bindingFor(expression)?.declaration;
    if (declaration && declaration.initializer) {
      return loaderAnchor(declaration.initializer, facts, seen);
    }
  }
  return undefined;
}

/** True when a literal specifier points into the Mock app, resolved lexically. */
function literalTargetsMock(file, literal) {
  if (typeof literal !== "string") return false;
  if (isAbsolute(literal)) return inside(mockRoot, resolve(literal));
  if (/^\.\.?\//.test(literal)) return inside(mockRoot, resolve(dirname(file), literal));
  return targetsMock(file, literal);
}

/** True when a loader anchor points into the Mock app, resolved lexically. */
function anchorTargetsMock(file, anchor, seen = new Set()) {
  const literals = literalsIn(anchor);
  for (const literal of literals) {
    if (isAbsolute(literal) && inside(mockRoot, resolve(literal))) return true;
    if (/^\.\.?\//.test(literal) && inside(mockRoot, resolve(dirname(file), literal))) return true;
    if (targetsMock(file, literal)) return true;
  }
  // The anchor may be held in a variable: follow its initializer.
  const identifiers = identifiersIn(anchor);
  for (const identifier of identifiers) {
    if (seen.has(identifier)) continue;
    seen.add(identifier);
    const declaration = bindingFor(identifier)?.declaration;
    if (declaration && declaration.initializer && anchorTargetsMock(file, declaration.initializer, seen)) {
      return true;
    }
  }
  return false;
}

/** Identifiers referenced by an expression. */
function identifiersIn(expression) {
  const identifiers = [];
  function visit(node) {
    if (ts.isIdentifier(node)) identifiers.push(node);
    ts.forEachChild(node, visit);
  }
  if (expression) visit(expression);
  return identifiers;
}

function isModuleLoadCall(node, facts) {
  const callee = unwrap(node.expression);
  if (!callee) return undefined;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return { argument: node.arguments[0] };
  if (isLoaderValue(callee, facts)) {
    // createRequire(anchor)("spec"): the anchor decides where "spec" resolves.
    return { argument: node.arguments[0], anchor: loaderAnchor(callee, facts) };
  }
  if (
    (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
    memberKey(callee) === "require" &&
    ts.isIdentifier(unwrap(callee.expression)) &&
    unwrap(callee.expression).text === "module" &&
    !bindingFor(unwrap(callee.expression))
  ) {
    return { argument: node.arguments[0] };
  }
  // loader.call(thisArg, spec) / loader.apply(thisArg, [spec]) / loader.bind(thisArg, spec)()
  if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
    const invoked = memberKey(callee);
    if ((invoked === "call" || invoked === "apply" || invoked === "bind") && isLoaderValue(callee.expression, facts)) {
      if (invoked === "call" || invoked === "bind") return { argument: node.arguments[1] };
      const args = unwrap(node.arguments[1]);
      return {
        argument: args && ts.isArrayLiteralExpression(args) ? unwrap(args.elements[0]) : undefined,
      };
    }
  }
  return undefined;
}

const moduleRequireMarker = { moduleRequire: true };

/** The value a destructured binding receives from its initializer. */
function destructuredValue(declaration, name) {
  const pattern = declaration.name;
  const initializer = unwrap(declaration.initializer);
  if (ts.isObjectBindingPattern(pattern)) {
    const element = pattern.elements.find(
      (item) => ts.isBindingElement(item) && bindsName(item.name, name),
    );
    if (!element || !ts.isBindingElement(element)) return undefined;
    const propertyName = element.propertyName
      ? element.propertyName.text
      : ts.isIdentifier(element.name) ? element.name.text : undefined;
    // const { require: load } = module;
    if (
      initializer &&
      ts.isIdentifier(initializer) &&
      initializer.text === "module" &&
      propertyName === "require" &&
      !bindingFor(initializer)
    ) {
      return moduleRequireMarker;
    }
    const container = resolveContainerValue(initializer, new Set());
    return container ? memberValue(container, propertyName) : undefined;
  }
  if (ts.isArrayBindingPattern(pattern)) {
    const index = pattern.elements.findIndex(
      (item) => ts.isBindingElement(item) && bindsName(item.name, name),
    );
    if (index < 0) return undefined;
    const container = resolveContainerValue(initializer, new Set());
    return container && ts.isArrayLiteralExpression(container) ? container.elements[index] : undefined;
  }
  return undefined;
}

/** True when the expression denotes a module loader function. */
function isLoaderValue(expression, facts, seen = new Set()) {
  expression = unwrap(expression);
  if (!expression || seen.has(expression)) return false;
  seen.add(expression);
  if (expression === moduleRequireMarker) return true;
  if (ts.isIdentifier(expression)) {
    if (expression.text === "require" && !bindingFor(expression)) return true;
    const binding = bindingFor(expression);
    if (!binding || binding.shadowed || !binding.declaration) return false;
    const declaration = binding.declaration;
    if (declaration.initializer && !ts.isIdentifier(declaration.name)) {
      const destructured = destructuredValue(declaration, expression.text);
      if (destructured && isLoaderValue(destructured, facts, seen)) return true;
    }
    if (declaration.initializer && isLoaderValue(declaration.initializer, facts, seen)) return true;
    return assignedValues(declaration).some((value) => isLoaderValue(value, facts, seen));
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    // module.require
    if (
      memberKey(expression) === "require" &&
      ts.isIdentifier(unwrap(expression.expression)) &&
      unwrap(expression.expression).text === "module" &&
      !bindingFor(unwrap(expression.expression))
    ) {
      return true;
    }
    const container = resolveContainerValue(expression.expression, seen);
    const member = container ? memberValue(container, memberKey(expression)) : undefined;
    return member ? isLoaderValue(member, facts, seen) : false;
  }
  if (ts.isCallExpression(expression)) {
    // createRequire(...) returns a loader; require(...) returns a module.
    return isCreateRequireFactory(expression, facts);
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      isLoaderValue(expression.whenTrue, facts, seen) || isLoaderValue(expression.whenFalse, facts, seen)
    );
  }
  if (
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.CommaToken ||
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    return (
      isLoaderValue(expression.left, facts, seen) || isLoaderValue(expression.right, facts, seen)
    );
  }
  return false;
}

/** Folds string literals, concatenation and templates into a constant string. */
function constantText(node, seen = new Set()) {
  const expression = unwrap(node);
  if (!expression || seen.has(expression)) return undefined;
  seen.add(expression);
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const part = constantText(span.expression, seen);
      if (part === undefined) return undefined;
      value += part + span.literal.text;
    }
    return value;
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = constantText(expression.left, seen);
    const right = constantText(expression.right, seen);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isIdentifier(expression)) {
    const binding = bindingFor(expression);
    const declaration = binding?.declaration;
    if (
      declaration &&
      ts.isIdentifier(declaration.name) &&
      declaration.parent.flags & ts.NodeFlags.Const &&
      declaration.initializer
    ) {
      return constantText(declaration.initializer, seen);
    }
  }
  // ["get", "BuiltinModule"].join("")
  if (
    ts.isCallExpression(expression) &&
    memberKey(expression.expression) === "join" &&
    expression.arguments.length <= 1
  ) {
    const separator = expression.arguments[0]
      ? constantText(expression.arguments[0])
      : "";
    const array = unwrap(expression.expression)?.expression;
    if (separator !== undefined && array && ts.isArrayLiteralExpression(array)) {
      const parts = array.elements.map((element) => constantText(element, seen));
      return parts.every((part) => part !== undefined) ? parts.join(separator) : undefined;
    }
  }
  return undefined;
}

function memberKey(expression) {
  if (ts.isPropertyAccessExpression(expression) || ts.isPropertyAccessChain(expression)) {
    return expression.name.text;
  }
  const argument = unwrap(expression.argumentExpression);
  if (!argument) return undefined;
  if (ts.isNumericLiteral(argument)) return argument.text;
  return constantText(argument);
}

function memberValue(container, key) {
  if (!container || key === undefined) return undefined;
  if (ts.isObjectLiteralExpression(container)) {
    for (const property of container.properties) {
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === key) return property.name;
      if (
        ts.isPropertyAssignment(property) &&
        propertyNameText(property.name) === key
      ) {
        return property.initializer;
      }
    }
    return undefined;
  }
  if (ts.isArrayLiteralExpression(container) && /^(0|[1-9]\d*)$/.test(key)) {
    return container.elements[Number(key)];
  }
  return undefined;
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return literalText(name.expression);
  return undefined;
}

/** The literal value of a constant container, so members can be resolved. */
function resolveContainerValue(expression, seen = new Set()) {
  expression = unwrap(expression);
  if (!expression || seen.has(expression)) return undefined;
  seen.add(expression);
  if (ts.isObjectLiteralExpression(expression) || ts.isArrayLiteralExpression(expression)) return expression;
  if (!ts.isIdentifier(expression)) return undefined;
  const binding = bindingFor(expression);
  if (!binding || binding.shadowed || !binding.declaration) return undefined;
  if (!binding.declaration.initializer) return undefined;
  return resolveContainerValue(binding.declaration.initializer, seen);
}

/** Every value assigned to a binding anywhere in its file. */
function assignedValues(declaration, seen = new Set()) {
  const values = [];
  const scope = declaration.getSourceFile?.();
  if (!scope) return values;
  function visit(node) {
    if (
      ts.isBinaryExpression(node) &&
      ts.isAssignmentOperator(node.operatorToken.kind) &&
      ts.isIdentifier(node.left) &&
      bindingFor(node.left)?.declaration === declaration
    ) {
      values.push(node.right);
    }
    ts.forEachChild(node, visit);
  }
  visit(scope);
  return values;
}

/**
 * depcruise 18 将 `node:fs` 与 `fs` 都解析为 `fs`，并可能合并同文件的两条边；
 * AST 统一收集原始说明符（含 optional require、模板和类型语法），不依赖
 * preprocess 的语法子集。Mock tests 不进入这些源码准入；注释/普通字符串不会成为加载语法节点。
 */
function validateImportBoundaries() {
  const errors = [];
  const report = (message) => errors.push(message);
  for (const file of [...sourceFiles("apps"), ...sourceFiles("packages")]) {
    const mockSource = isMockSourceFile(file);
    // Mock 的其它文件（测试、夹具）按 ADR-FSM-02 允许使用 Mock 自身源码。
    if (isMockAppFile(file) && !mockSource) continue;
    const parsed = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const facts = moduleFacts(parsed);

    function visit(node) {
      for (const doc of node.jsDoc ?? []) visit(doc);
      if (mockSource) {
        // 不透明加载器：目标无法静态判定，直接拒绝。
        if (ts.isIdentifier(node)) {
          if (node.text === "createRequire" || node.text === "getBuiltinModule") {
            report(`feishu-mock-opaque-loader: ${node.text} in ${file}`);
          } else if (node.text === "require" && !bindingFor(node)) {
            report(`feishu-mock-opaque-loader: require in ${file}`);
          } else if (node.text === "register" && mentionsNodeModuleImport(parsed, "register")) {
            report(`feishu-mock-opaque-loader: register in ${file}`);
          } else if (node.text === "eval" && !bindingFor(node)) {
            report(`feishu-mock-opaque-loader: eval in ${file}`);
          } else if (
            (node.text === "globalThis" || node.text === "Reflect") &&
            !bindingFor(node)
          ) {
            report(`feishu-mock-opaque-loader: ${node.text} in ${file}`);
          } else if (node.text === "dlopen" && !bindingFor(node)) {
            report(`feishu-mock-opaque-loader: dlopen in ${file}`);
          } else if (node.text === "WebAssembly" && !bindingFor(node)) {
            report(`feishu-mock-opaque-loader: WebAssembly in ${file}`);
          }
        }
        if (
          (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
          ts.isIdentifier(unwrap(node.expression)) &&
          unwrap(node.expression).text === "Function" &&
          !bindingFor(unwrap(node.expression))
        ) {
          report(`feishu-mock-opaque-loader: Function in ${file}`);
        }
        // 计算属性形式（process["get" + "BuiltinModule"]）同样不得取用加载器。
        if (
          (ts.isElementAccessExpression(node) || ts.isElementAccessChain(node)) &&
          ["require", "createRequire", "register", "getBuiltinModule"].includes(
            constantText(node.argumentExpression) ?? "",
          )
        ) {
          report(`feishu-mock-opaque-loader: computed loader lookup in ${file}`);
        }
        // 全局属性形式（globalThis.Function、globalThis["eval"]）同样禁止。
        if (
          (ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node) ||
            ts.isElementAccessExpression(node) || ts.isElementAccessChain(node)) &&
          ["eval", "Function", "constructor", "dlopen"].includes(memberKey(node) ?? "")
        ) {
          report(`feishu-mock-opaque-loader: runtime evaluation in ${file}`);
        }
        // 解构形式（const { Function: F } = globalThis）同样禁止。
        if (ts.isBindingElement(node)) {
          const names = [node.propertyName, node.name]
            .filter((part) => part && ts.isIdentifier(part))
            .map((part) => part.text);
          const computed = node.propertyName && ts.isComputedPropertyName(node.propertyName)
            ? constantText(node.propertyName.expression)
            : undefined;
          if (
            names.some((text) => ["eval", "Function"].includes(text)) ||
            (computed !== undefined && ["eval", "Function"].includes(computed))
          ) {
            report(`feishu-mock-opaque-loader: runtime evaluation in ${file}`);
          }
        }
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          ["eval", "Function"].includes(node.name.text)
        ) {
          report(`feishu-mock-opaque-loader: runtime evaluation in ${file}`);
        }
      }
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (!node.moduleSpecifier) {
          ts.forEachChild(node, visit);
          return;
        }
        const specifier = literalText(node.moduleSpecifier);
        if (mockSource) {
          if (specifier === undefined || !mockSpecifierAllowed(file, specifier)) {
            report(`feishu-mock-literal-imports: invalid module specifier in ${file}`);
          }
        } else if (specifier !== undefined && targetsMock(file, specifier)) {
          report(`no-imports-from-feishu-mock: forbidden module in ${file}`);
        }
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        if (mockSource) {
          report(`feishu-mock-literal-imports: invalid module specifier in ${file}`);
        } else {
          const specifier = literalText(node.moduleReference.expression);
          if (specifier !== undefined && targetsMock(file, specifier)) {
            report(`no-imports-from-feishu-mock: forbidden module in ${file}`);
          }
        }
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        const specifier = literalText(node.argument.literal);
        if (mockSource) {
          if (specifier === undefined || !mockSpecifierAllowed(file, specifier)) {
            report(`feishu-mock-literal-imports: invalid module specifier in ${file}`);
          }
        } else if (specifier !== undefined && targetsMock(file, specifier)) {
          report(`no-imports-from-feishu-mock: forbidden module in ${file}`);
        }
      } else if (ts.isCallExpression(node)) {
        const loaded = isModuleLoadCall(node, facts);
        if (!loaded && !mockSource) {
          // A loader handed to another function can load anything later on.
          const passed = node.arguments.some((argument) => isLoaderValue(argument, facts));
          if (passed) {
            report(`no-imports-from-feishu-mock: loader passed as argument in ${file}`);
          }
          // A call through an unknown parameter can still be a loader: check its literal arguments.
          const callee = unwrap(node.expression);
          if (callee && ts.isIdentifier(callee) && bindingFor(callee)?.shadowed === "parameter") {
            const literals = node.arguments
              .map((argument) => literalText(argument))
              .filter((literal) => literal !== undefined);
            if (literals.some((literal) => literalTargetsMock(file, literal))) {
              report(`no-imports-from-feishu-mock: forbidden module in ${file}`);
            }
          }
        }
        if (loaded) {
          const specifier = literalText(loaded.argument);
          if (mockSource) {
            if (specifier === undefined || !mockSpecifierAllowed(file, specifier)) {
              report(`feishu-mock-dynamic-import: invalid module specifier in ${file}`);
            }
          } else if (specifier === undefined) {
            report(`no-imports-from-feishu-mock: nonliteral import/require in ${file}`);
          } else if (targetsMock(file, specifier)) {
            report(`no-imports-from-feishu-mock: forbidden module in ${file}`);
          } else if (loaded.anchor && anchorTargetsMock(file, loaded.anchor)) {
            // The loader is anchored inside Mock, so any specifier it loads is Mock's.
            report(`no-imports-from-feishu-mock: forbidden module in ${file}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(parsed);
  }
  if (errors.length) throw new Error(errors.join("\n"));
}

/** True when the file imports the given name from `node:module`. */
function mentionsNodeModuleImport(sourceFile, name) {
  let found = false;
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== "node:module" && statement.moduleSpecifier.text !== "module") continue;
    if (importBindsName(statement, name)) found = true;
  }
  return found;
}

validateImportBoundaries();

const depcruiseOptions = require("./.dependency-cruiser-options.cjs");

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  options: depcruiseOptions,
  forbidden: [
    {
      name: "core-is-leaf",
      comment: "packages/core 是叶子包，不得依赖仓内任何其它 package 或 app（ADR-ARCH-01）",
      severity: "error",
      from: { path: "^packages/core/" },
      to: {
        path: "^(packages/(?!core/)|apps/|@megaui/(?!core$))",
      },
    },
    {
      name: "mid-tier-no-upward",
      comment:
        "content/database/i18n/storage/auth/email 只能依赖 core 或彼此，不得依赖 engine/ui/apps（ADR-ARCH-01）",
      severity: "error",
      from: {
        path: "^packages/(content|database|i18n|storage|auth|email)/",
      },
      to: {
        path: "^(packages/(engine|ui)/|apps/|@megaui/(engine|ui)$)",
      },
    },
    {
      name: "engine-no-apps-or-ui",
      comment: "engine 不得依赖 apps/*；也不得依赖 packages/ui（ui 与 engine 是并列上层，仅 apps/web 同时消费两者，ADR-ARCH-01）",
      severity: "error",
      from: { path: "^packages/engine/" },
      to: { path: "^(apps/|packages/ui/|@megaui/ui$)" },
    },
    {
      name: "ui-restricted-deps",
      comment: "packages/ui 只能依赖 core/content/i18n；不得依赖 engine/database/auth/email/storage 或 apps（ADR-ARCH-01）",
      severity: "error",
      from: { path: "^packages/ui/" },
      to: {
        path: "^(packages/(database|auth|email|storage|engine)/|apps/|@megaui/(database|auth|email|storage|engine)$)",
      },
    },
    {
      name: "web-not-collab-server",
      comment:
        "apps/web 与 apps/collab-server 是两个独立可发布应用，互不通过源码 import 耦合（跨进程通信走 HTTP/WS）",
      severity: "error",
      from: { path: "^apps/web/" },
      to: { path: "^apps/collab-server/" },
    },
    {
      name: "collab-server-not-web",
      comment:
        "apps/web 与 apps/collab-server 是两个独立可发布应用，互不通过源码 import 耦合（跨进程通信走 HTTP/WS）",
      severity: "error",
      from: { path: "^apps/collab-server/" },
      to: { path: "^apps/web/" },
    },
    {
      name: "no-imports-from-feishu-mock",
      comment:
        "其它 apps/packages（含 Web E2E helper）只能通过 CLI+HTTP 消费 Mock，不得 import Mock 源码（ADR-FSM-02）",
      severity: "error",
      from: { path: "^(apps/(?!feishu-mock/)|packages/)" },
      to: { path: "^(apps/feishu-mock/|@megaui/feishu-mock($|/))" },
    },
    {
      name: "no-circular",
      comment: "循环依赖会破坏 ADR-ARCH-01 的单向包边界",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
};
