/**
 * FSM-22：CLI 开发准入与冻结目标。
 *
 * 纯函数 validator：只接收调用方提供的环境对象，不读取 process.env，
 * 不监听端口、不写 runtime、不发 callback。返回的配置被冻结，调用方
 * 无法改写它，也无法用请求参数影响它。
 */

export type MockNodeEnv = "development" | "test";

export interface MockConfig {
  readonly nodeEnv: MockNodeEnv;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly callbackUrl: string;
  readonly runtimeFile: string | undefined;
}

export type MockConfigErrorCode =
  | "simulator_disabled"
  | "simulator_node_env_invalid"
  | "simulator_port_invalid"
  | "simulator_callback_url_invalid"
  | "simulator_runtime_file_invalid"
  | "simulator_unknown_key";

export class MockConfigError extends Error {
  readonly code: MockConfigErrorCode;

  constructor(code: MockConfigErrorCode, message: string) {
    super(message);
    this.name = "MockConfigError";
    this.code = code;
  }
}

export const MOCK_CALLBACK_PATH = "/api/integrations/feishu/events";
export const MOCK_DEFAULT_PORT = 19400;
export const MOCK_DEFAULT_CALLBACK_URL = `http://127.0.0.1:3000${MOCK_CALLBACK_PATH}`;

const ALLOWED_SIMULATOR_KEYS = new Set([
  "FEISHU_SIMULATOR_ENABLED",
  "FEISHU_SIMULATOR_PORT",
  "FEISHU_SIMULATOR_CALLBACK_URL",
  "FEISHU_SIMULATOR_RUNTIME_FILE",
]);

function assertKnownKeys(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    if (!key.startsWith("FEISHU_SIMULATOR_")) continue;
    if (!ALLOWED_SIMULATOR_KEYS.has(key)) {
      throw new MockConfigError("simulator_unknown_key", `unknown simulator config key: ${key}`);
    }
  }
}

function resolvePort(value: string | undefined): number {
  if (value === undefined) return MOCK_DEFAULT_PORT;
  // The rejected value is never echoed: a misconfigured environment could put
  // a secret in this variable, and error output must not leak it.
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new MockConfigError("simulator_port_invalid", "port must be an integer 0..65535");
  }
  const port = Number(value);
  if (port > 65535) {
    throw new MockConfigError("simulator_port_invalid", "port must be an integer 0..65535");
  }
  return port;
}

function resolveCallbackUrl(value: string | undefined): string {
  if (value === undefined) return MOCK_DEFAULT_CALLBACK_URL;
  // The frozen contract allows one exact literal target, so the raw string is
  // validated instead of a parsed URL: WHATWG parsing would drop port 80 and
  // rewrite non-literal hosts such as 127.1 or 2130706433 into 127.0.0.1.
  // Rejected values are never echoed: a callback url may carry userinfo or a
  // query secret, and the error message must not leak it.
  if (!value.startsWith("http://")) {
    throw new MockConfigError("simulator_callback_url_invalid", "callback url must use http:");
  }
  const rest = value.slice("http://".length);
  if (rest.includes("?") || rest.includes("#")) {
    throw new MockConfigError(
      "simulator_callback_url_invalid",
      "callback url must not carry query or fragment",
    );
  }
  const separator = rest.indexOf("/");
  const authority = separator === -1 ? rest : rest.slice(0, separator);
  const path = separator === -1 ? "" : rest.slice(separator);
  if (authority.includes("@")) {
    throw new MockConfigError(
      "simulator_callback_url_invalid",
      "callback url must not carry userinfo",
    );
  }
  if (path !== MOCK_CALLBACK_PATH) {
    throw new MockConfigError(
      "simulator_callback_url_invalid",
      `callback url path must be ${MOCK_CALLBACK_PATH}`,
    );
  }
  const portMatch = /^127\.0\.0\.1:(\d{1,5})$/.exec(authority);
  if (!portMatch) {
    throw new MockConfigError(
      "simulator_callback_url_invalid",
      "callback url host must be the literal 127.0.0.1 with an explicit port",
    );
  }
  const portText = portMatch[1] ?? "";
  if (!/^(0|[1-9]\d*)$/.test(portText)) {
    throw new MockConfigError("simulator_callback_url_invalid", "callback url port must be 1..65535");
  }
  const port = Number(portText);
  if (port < 1 || port > 65535) {
    throw new MockConfigError("simulator_callback_url_invalid", "callback url port must be 1..65535");
  }
  return value;
}

function resolveRuntimeFile(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") {
    throw new MockConfigError("simulator_runtime_file_invalid", "runtime file path must not be empty");
  }
  return value;
}

/**
 * Validates the caller-provided environment and returns a frozen config.
 * Throws MockConfigError with a stable code for every rejection branch.
 */
export function resolveMockConfig(env: Record<string, string | undefined>): MockConfig {
  assertKnownKeys(env);

  if (env.FEISHU_SIMULATOR_ENABLED !== "1") {
    throw new MockConfigError(
      "simulator_disabled",
      "FEISHU_SIMULATOR_ENABLED must be exactly 1 to run the mock",
    );
  }
  const nodeEnv = env.NODE_ENV;
  if (nodeEnv !== "development" && nodeEnv !== "test") {
    throw new MockConfigError(
      "simulator_node_env_invalid",
      "NODE_ENV must be development or test to run the mock",
    );
  }

  const config: MockConfig = Object.freeze({
    nodeEnv,
    host: "127.0.0.1",
    port: resolvePort(env.FEISHU_SIMULATOR_PORT),
    callbackUrl: resolveCallbackUrl(env.FEISHU_SIMULATOR_CALLBACK_URL),
    runtimeFile: resolveRuntimeFile(env.FEISHU_SIMULATOR_RUNTIME_FILE),
  });
  return config;
}
