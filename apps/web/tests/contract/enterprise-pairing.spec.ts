// megaui-only (FS-73): real owned Next/PG pairing HTTP contract.
import { describe, expect, it } from "vitest";

import { installEnterprisePairingFixture, withOwnedWeb } from "../helpers/owned-web";

describe("enterprise pairing HTTP contract", () => {
  it("uses the real owned Next route, commits known/unknown pairings, and rate-limits without a cookie", async () => {
    await withOwnedWeb(async owner => {
      await installEnterprisePairingFixture(owner);
      await owner.start();
      const post = (alias: string, headers: Record<string, string> = {}) => fetch(`${owner.baseURL}/api/auth/enterprise/request`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ alias }),
      });
      const accepted = async (alias: string) => {
        const response = await post(alias);
        const body = await response.json() as Record<string, unknown>;
        expect(response.status, JSON.stringify(body)).toBe(202);
        expect(Object.keys(body).sort()).toEqual(["expiresIn", "pairingId", "pairingToken", "resendAfter"]);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("set-cookie")).toMatch(/^__Host-megaui\.enterprise-flow=.*Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
        return body;
      };
      const unknown = await accepted("unknown");
      const known = await accepted("known");
      expect(Object.keys(unknown).sort()).toEqual(Object.keys(known).sort());
      expect(JSON.stringify(unknown)).not.toContain("unknown");
      expect(JSON.stringify(known)).not.toContain("known");

      const before = owner.createDatabaseObserver();
      await before.pool.query("update enterprise_policy set activation_state='maintenance'");
      const maintenance = await post("maintenance-user");
      // FS-77 keeps maintenance fail-closed: pairing is an unavailable
      // operation, not a public transport error.
      expect(maintenance.status).toBe(404);
      expect(maintenance.headers.get("set-cookie")).toBeNull();
      await before.pool.query("update enterprise_policy set activation_state='enterprise'");

      const oversized = await post("x".repeat(5000));
      expect(oversized.status).toBe(413);

      for (let start = 0; start < 28; start += 4) {
        await Promise.all(Array.from({ length: Math.min(4, 28 - start) }, (_, offset) => accepted(`user${start + offset}`)));
      }
      const beforeCount = (await before.pool.query<{ count: number }>("select count(*)::int as count from enterprise_pairings")).rows[0]!.count;
      expect(beforeCount).toBe(30);
      const limited = await post("user-over-budget", { "x-forwarded-for": "203.0.113.88" });
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ error: "RATE_LIMITED" });
      expect(limited.headers.get("set-cookie")).toBeNull();
      const afterCount = (await before.pool.query<{ count: number }>("select count(*)::int as count from enterprise_pairings")).rows[0]!.count;
      expect(afterCount).toBe(beforeCount);

      expect((await fetch(`${owner.baseURL}/api/auth/enterprise/request`)).status).toBe(405);
    }, undefined);
  }, 600_000);
});
