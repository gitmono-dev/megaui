import { describe, expect, it } from "vitest";

import { MockConfigError, resolveMockConfig } from "../../src/config";

const DEFAULT_PORT = 19400;

function baseEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    FEISHU_SIMULATOR_ENABLED: "1",
    NODE_ENV: "test",
    ...overrides,
  };
}

function expectRejection(env: Record<string, string | undefined>, code: string): void {
  try {
    resolveMockConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(MockConfigError);
    expect((error as MockConfigError).code).toBe(code);
    return;
  }
  throw new Error(`expected the config to be rejected with ${code}`);
}

describe("mock CLI configuration (FSM-22)", () => {
  it("admits only FEISHU_SIMULATOR_ENABLED=1", () => {
    expect(() => resolveMockConfig(baseEnv({ FEISHU_SIMULATOR_ENABLED: "0" }))).toThrow();
    expectRejection(baseEnv({ FEISHU_SIMULATOR_ENABLED: "0" }), "simulator_disabled");
    expectRejection(baseEnv({ FEISHU_SIMULATOR_ENABLED: "true" }), "simulator_disabled");
    expectRejection(baseEnv({ FEISHU_SIMULATOR_ENABLED: " 1" }), "simulator_disabled");
    expectRejection(baseEnv({ FEISHU_SIMULATOR_ENABLED: undefined }), "simulator_disabled");
  });

  it("admits only development or test as NODE_ENV", () => {
    expect(resolveMockConfig(baseEnv({ NODE_ENV: "development" })).nodeEnv).toBe("development");
    expect(resolveMockConfig(baseEnv({ NODE_ENV: "test" })).nodeEnv).toBe("test");
    expectRejection(baseEnv({ NODE_ENV: "production" }), "simulator_node_env_invalid");
    expectRejection(baseEnv({ NODE_ENV: undefined }), "simulator_node_env_invalid");
    expectRejection(baseEnv({ NODE_ENV: "Test" }), "simulator_node_env_invalid");
  });

  it("pins the listener host to 127.0.0.1", () => {
    expect(resolveMockConfig(baseEnv()).host).toBe("127.0.0.1");
  });

  it("uses the frozen default port", () => {
    expect(resolveMockConfig(baseEnv()).port).toBe(19400);
  });

  it("carries no callback target (FSL-140)", () => {
    const config = resolveMockConfig(baseEnv());
    expect(Object.keys(config).sort()).toEqual(["host", "nodeEnv", "port", "runtimeFile"]);
    // The callback url key is gone: it is now an unknown simulator key.
    expectRejection(
      baseEnv({ FEISHU_SIMULATOR_CALLBACK_URL: "http://127.0.0.1:3000/api/integrations/feishu/events" }),
      "simulator_unknown_key",
    );
  });

  it("accepts the frozen default port and any legal port", () => {
    expect(resolveMockConfig(baseEnv()).port).toBe(DEFAULT_PORT);
    expect(resolveMockConfig(baseEnv({ FEISHU_SIMULATOR_PORT: "0" })).port).toBe(0);
    expect(resolveMockConfig(baseEnv({ FEISHU_SIMULATOR_PORT: "3000" })).port).toBe(3000);
    expect(resolveMockConfig(baseEnv({ FEISHU_SIMULATOR_PORT: "65535" })).port).toBe(65535);
    expectRejection(baseEnv({ FEISHU_SIMULATOR_PORT: "65536" }), "simulator_port_invalid");
    expectRejection(baseEnv({ FEISHU_SIMULATOR_PORT: "-1" }), "simulator_port_invalid");
    expectRejection(baseEnv({ FEISHU_SIMULATOR_PORT: "1.5" }), "simulator_port_invalid");
    expectRejection(baseEnv({ FEISHU_SIMULATOR_PORT: "3000 " }), "simulator_port_invalid");
    expectRejection(baseEnv({ FEISHU_SIMULATOR_PORT: "http" }), "simulator_port_invalid");
  });

  it("rejects unknown simulator config keys", () => {
    expectRejection(baseEnv({ FEISHU_SIMULATOR_UNKNOWN: "1" }), "simulator_unknown_key");
    expectRejection(baseEnv({ FEISHU_SIMULATOR_ADMIN_TOKEN: "x" }), "simulator_unknown_key");
    expect(() => resolveMockConfig(baseEnv({ OTHER_APP_SETTING: "x" }))).not.toThrow();
  });

  it("keeps the runtime file optional and rejects an empty one", () => {
    expect(resolveMockConfig(baseEnv()).runtimeFile).toBeUndefined();
    expect(resolveMockConfig(baseEnv({ FEISHU_SIMULATOR_RUNTIME_FILE: "/tmp/run/runtime.json" })).runtimeFile).toBe(
      "/tmp/run/runtime.json",
    );
    expectRejection(baseEnv({ FEISHU_SIMULATOR_RUNTIME_FILE: "  " }), "simulator_runtime_file_invalid");
  });

  it("returns a frozen config that the caller cannot change", () => {
    const config = resolveMockConfig(baseEnv());
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      (config as { port: number }).port = 1;
    }).toThrow();
    expect(config.port).toBe(DEFAULT_PORT);

    const env = baseEnv();
    const frozen = resolveMockConfig(env);
    env.NODE_ENV = "production";
    env.FEISHU_SIMULATOR_PORT = "1";
    expect(frozen.nodeEnv).toBe("test");
    expect(frozen.port).toBe(DEFAULT_PORT);
  });
});
