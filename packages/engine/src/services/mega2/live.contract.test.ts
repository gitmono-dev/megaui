// Live gated suite (DEP-02): runs pinned-contract assertions against a real
// mega2 instance when reachable, otherwise skips with an explicit
// console.warn (never a silent pass — plan GC-06 / "gated 用例的显式跳过必须
// 记录原因"). Default probe target matches the plan's DEP-02 entry
// (`curl -sf http://127.0.0.1:19180/api/openapi.json`); override with
// `MEGA2_LIVE_BASE_URL` for the in-stack hostname
// (`http://mega2:8000`).
import { describe, expect, it } from "vitest";
import { fetchWorkspace } from "./code-backend";

const DEFAULT_LIVE_BASE_URL = "http://127.0.0.1:19180";
const liveBaseUrl = process.env.MEGA2_LIVE_BASE_URL?.trim() || DEFAULT_LIVE_BASE_URL;

async function probeMega2OpenApi(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/openapi.json`, {
        signal: controller.signal,
      });
      return response.ok;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

const liveAvailable = await probeMega2OpenApi(liveBaseUrl);

if (!liveAvailable) {
  console.warn(
    `[@megaui/engine] mega2/live.contract.test.ts: ${liveBaseUrl}/api/openapi.json unreachable — ` +
      "skipping DEP-02 live suite (stub-server contract tests are unaffected).",
  );
}

describe.skipIf(!liveAvailable)(
  "mega2 live contract (EG-11, DEP-02, gated on a reachable mega2)",
  () => {
    const env = { MEGA2_PUBLIC_BASE_URL: liveBaseUrl };

    it("fetches the pinned latest-commit shape and maps it onto a Workspace", async () => {
      const workspace = await fetchWorkspace({}, env);
      expect(typeof workspace.headSha).toBe("string");
      expect(workspace.headSha.length).toBeGreaterThan(0);
      expect(workspace.packages.length).toBeGreaterThan(0);
    });
  },
);
