// megaui-only (FS-88): project only the simulator runtime fields needed by Web.
export interface SimulatorRuntimeProjection {
  readonly FEISHU_PROVIDER: "simulator";
  readonly FEISHU_SIMULATOR_ORIGIN: string;
  readonly FEISHU_TENANT_KEY: string;
  readonly FEISHU_APP_ID: string;
  readonly FEISHU_APP_SECRET: string;
  readonly FEISHU_EVENT_VERIFICATION_TOKEN: string;
  readonly FEISHU_EVENT_ENCRYPT_KEY: string;
}

export function projectSimulatorRuntime(runtime: Readonly<Record<string, unknown>>): SimulatorRuntimeProjection {
  const fields = ["baseUrl", "tenantKey", "appId", "appSecret", "verificationToken", "encryptKey"] as const;
  if (fields.some(field => typeof runtime[field] !== "string" || runtime[field] === "")) {
    throw new Error("FS88 mock runtime is incomplete");
  }
  return Object.freeze({
    FEISHU_PROVIDER: "simulator" as const,
    FEISHU_SIMULATOR_ORIGIN: runtime.baseUrl as string,
    FEISHU_TENANT_KEY: runtime.tenantKey as string,
    FEISHU_APP_ID: runtime.appId as string,
    FEISHU_APP_SECRET: runtime.appSecret as string,
    FEISHU_EVENT_VERIFICATION_TOKEN: runtime.verificationToken as string,
    FEISHU_EVENT_ENCRYPT_KEY: runtime.encryptKey as string,
  });
}

export function containsAdminToken(environment: Readonly<Record<string, unknown>>, adminToken: string): boolean {
  return Object.values(environment).some(value => value === adminToken);
}

