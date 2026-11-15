// megaui-only (FS-83): real owned Next/PG same-flow status HTTP contract.
import { describe, expect, it } from "vitest";

import { installEnterprisePairingFixture, withOwnedWeb } from "../helpers/owned-web";

describe("enterprise pairing status HTTP contract", () => {
  it("keeps status scoped to the flow and deployment and exposes only an opaque challenge id", async () => {
    await withOwnedWeb(async owner => {
      await installEnterprisePairingFixture(owner);
      const admin = owner.createDatabaseObserver();
      await admin.pool.query(`
        insert into "user" (id,name,email,email_verified) values ('fs83-user','FS83 User','fs83@example.test',false);
        insert into enterprise_identity (id,local_user_id,tenant_key,app_id,open_id)
          values ('fs83-identity','fs83-user','tenant','app','fs83-open');
        insert into enterprise_profile (user_id,tenant_key,login_name,backend_username,display_name)
          values ('fs83-user','tenant','known','fs83-user','Directory Detail');
      `);
      await owner.start();

      const request = await fetch(`${owner.baseURL}/api/auth/enterprise/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alias: "known" }),
      });
      const requestBody = await request.json() as Record<string, unknown>;
      expect(request.status, JSON.stringify(requestBody)).toBe(202);
      const pairingId = requestBody.pairingId;
      expect(typeof pairingId).toBe("string");
      const setCookie = request.headers.get("set-cookie");
      expect(setCookie).toMatch(/^__Host-megaui\.enterprise-flow=/);
      const flowCookie = setCookie!.split(";", 1)[0]!;

      const status = async (cookie = flowCookie, id = pairingId) => fetch(`${owner.baseURL}/api/auth/enterprise/status`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: owner.baseURL },
        body: JSON.stringify({ pairingId: id }),
      });
      const pending = await status();
      expect(pending.status).toBe(200);
      expect(await pending.json()).toEqual({ status: "pending" });
      expect(pending.headers.get("cache-control")).toBe("no-store");

      const otherFlow = `__Host-megaui.enterprise-flow=${Buffer.alloc(32, 1).toString("base64url")}`;
      const crossFlow = await status(otherFlow);
      expect(crossFlow.status).toBe(404);
      expect(await crossFlow.json()).toEqual({ error: "NOT_FOUND" });

      await admin.pool.query("update enterprise_pairings set deployment_role='production' where id=$1", [pairingId]);
      const crossDeployment = await status();
      expect(crossDeployment.status).toBe(404);
      expect(await crossDeployment.json()).toEqual({ error: "NOT_FOUND" });
      await admin.pool.query("update enterprise_pairings set deployment_role='test' where id=$1", [pairingId]);

      const challengeId = "00000000-0000-0000-0000-000000000083";
      await admin.pool.query(`update enterprise_pairings
        set state='confirmed', confirmed_identity_version=1,
            confirmed_message_id='fs83-message', confirmed_at=created_at + interval '1 second',
            retain_until=created_at + interval '391 seconds'
        where id=$1`, [pairingId]);
      await admin.pool.query(`insert into enterprise_challenges
        (id,scope,deployment_role,local_user_id,identity_id,identity_version,flow_hash,generation,purpose,
         pairing_id,code_hmac,hmac_key_id,state,created_at,expires_at,secret_expires_at)
        select $2,scope,deployment_role,'fs83-user','fs83-identity',1,flow_hash,generation,'login',
          id,repeat('a',64),'fs83-test-key','active',now(),now() + interval '300 seconds',now() + interval '300 seconds'
        from enterprise_pairings where id=$1`, [pairingId, challengeId]);
      const confirmed = await status();
      expect(confirmed.status).toBe(200);
      expect(await confirmed.json()).toEqual({ status: "confirmed", challengeId });
      const confirmedText = JSON.stringify(await (await status()).clone().json());
      expect(confirmedText).not.toContain("fs83@example.test");
      expect(confirmedText).not.toContain("Directory Detail");
      expect(confirmedText).not.toContain("known");
      expect(confirmedText).not.toContain("code_hmac");

      await admin.pool.query("update enterprise_pairings set state='expired' where id=$1", [pairingId]);
      const expired = await status();
      expect(expired.status).toBe(200);
      expect(await expired.json()).toEqual({ status: "expired" });

      const get = await fetch(`${owner.baseURL}/api/auth/enterprise/status`, { headers: { cookie: flowCookie, origin: owner.baseURL } });
      expect([404, 405]).toContain(get.status);
    }, undefined);
  }, 600_000);
});
