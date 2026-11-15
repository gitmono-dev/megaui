// megaui-only (FS-06): shared deployment-owned administrator provider authority.
import { admitProvider, parseDirectoryDepartmentIds, resolveEnterpriseConfig } from "@megaui/core";
import { readScopeExpectation } from "@megaui/database";
import { trustedAdminEnv } from "../../cli/admin-env";
import { ApprovedMutationRejection } from "../../cli/admin-mutation";

/** The signed request has no authority flags. Only deployment-owned env supplies them. */
export function trustedAdminProviderConfiguration() {
  const env = { ...trustedAdminEnv() };
  try {
    const expectation = readScopeExpectation(env);
    if (!expectation) throw new Error("scope");
    const role = expectation.environment;
    const nodeEnv = env.NODE_ENV;
    if (!["development", "test", "production", "canary"].includes(role) ||
      (nodeEnv !== "development" && nodeEnv !== "test" && nodeEnv !== "production")) throw new Error("role");
    const departmentIds = parseDirectoryDepartmentIds(env.FEISHU_DIRECTORY_DEPARTMENT_IDS);
    const tenantKey = env.FEISHU_TENANT_KEY;
    const appId = env.FEISHU_APP_ID;
    const appSecret = env.FEISHU_APP_SECRET;
    for (const value of [tenantKey, appId]) {
      if (!value || value.trim() !== value || value.includes("\0") || [...value].length > 256 ||
        [...value].some(char => { const code = char.codePointAt(0) ?? 0; return code >= 0xd800 && code <= 0xdfff; })) {
        throw new Error("identity");
      }
    }
    if (!tenantKey || !appId || !appSecret || !appSecret.trim()) throw new Error("credentials");
    const mode = resolveEnterpriseConfig({ authMode: env.AUTH_MODE, activated: false }).mode;
    const target = admitProvider({
      enabled: true, provider: env.FEISHU_PROVIDER,
      role: role as "development" | "test" | "production" | "canary", nodeEnv,
      simulatorOrigin: env.FEISHU_SIMULATOR_ORIGIN,
    });
    if (!target) throw new Error("provider");
    return { expectation, scope: expectation.instanceId, mode, departmentIds, tenantKey, appId, appSecret, target };
  } catch { throw new ApprovedMutationRejection("INVALID_CONFIG"); }
}
