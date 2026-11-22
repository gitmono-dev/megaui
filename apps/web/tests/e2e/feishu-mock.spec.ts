import { expect, test } from "@playwright/test";

import { startFeishuMock, type StartedFeishuMock } from "./helpers/feishu-mock";

/**
 * FSM-05：Mock 自身完整协议集成。
 *
 * 本 spec 只用 HTTP 与真实 CLI，不启动网站、浏览器或数据库。
 */

async function stateOf(mock: StartedFeishuMock): Promise<{
  data: { users: Array<{ open_id: string; status: Record<string, boolean> }>; inboxes: Record<string, unknown[]>; faults: unknown[] };
}> {
  const response = await fetch(`${mock.baseUrl}/__mock/state`, {
    headers: { authorization: `Bearer ${mock.runtime.adminToken}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    data: { users: Array<{ open_id: string; status: Record<string, boolean> }>; inboxes: Record<string, unknown[]>; faults: unknown[] };
  };
}

/** The retained authenticated single member read (FSM-18). */
function userPath(mock: StartedFeishuMock, openId = "ou_mock_alice"): string {
  return `${mock.baseUrl}/open-apis/contact/v3/users/${openId}?user_id_type=open_id&department_id_type=open_department_id`;
}

async function issueToken(mock: StartedFeishuMock): Promise<string> {
  const response = await fetch(`${mock.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: mock.runtime.appId, app_secret: mock.runtime.appSecret }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { tenant_access_token: string; expire: number };
  expect(body.expire).toBe(7200);
  return body.tenant_access_token;
}

test.describe("feishu mock protocol", () => {
  test("runs the whole protocol over real http", async () => {
    const mock = await startFeishuMock();
    try {
      const token = await issueToken(mock);

      // FSL-167: the department directory is gone; its route answers the frozen 404.
      const retired = await fetch(
        `${mock.baseUrl}/open-apis/contact/v3/users/find_by_department?department_id=od_mock_engineering&page_size=100`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(retired.status).toBe(404);

      const single = await fetch(userPath(mock), { headers: { authorization: `Bearer ${token}` } });
      expect(single.status).toBe(200);
      const read = (await single.json()) as { data: { user: { open_id: string } } };
      expect(read.data.user.open_id).toBe("ou_mock_alice");

      // The provider route writes the inbox of the member it addresses.
      const message = await fetch(`${mock.baseUrl}/open-apis/im/v1/messages?receive_id_type=open_id`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          receive_id: "ou_mock_alice",
          msg_type: "text",
          content: JSON.stringify({ text: "hello from the api e2e" }),
          uuid: "api-e2e-uuid",
        }),
      });
      expect(message.status).toBe(200);

      // FSL-140: message injection is gone; the status control only changes one member.
      const injected = await fetch(`${mock.baseUrl}/__mock/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${mock.runtime.adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ openId: "ou_mock_bob", text: "from the mock" }),
      });
      expect(injected.status).toBe(404);
      const status = await fetch(`${mock.baseUrl}/__mock/users/ou_mock_bob`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${mock.runtime.adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ status: "suspended" }),
      });
      expect(status.status).toBe(200);

      const view = await stateOf(mock);
      expect(view.data.users).toHaveLength(6);
      expect(Object.keys(view.data).sort()).toEqual(["faults", "inboxes", "users"]);
      expect(view.data.users.find((user) => user.open_id === "ou_mock_bob")?.status.is_frozen).toBe(true);
      expect(view.data.users.find((user) => user.open_id === "ou_mock_alice")?.status.is_frozen).toBe(false);
      expect(view.data.inboxes.ou_mock_alice).toHaveLength(1);
      expect(view.data.inboxes.ou_mock_bob).toBeUndefined();

      // The same uuid in the same generation repeats the first answer instead
      // of delivering a second message.
      const repeat = await fetch(`${mock.baseUrl}/open-apis/im/v1/messages?receive_id_type=open_id`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          receive_id: "ou_mock_alice",
          msg_type: "text",
          content: JSON.stringify({ text: "hello from the api e2e" }),
          uuid: "api-e2e-uuid",
        }),
      });
      expect(repeat.status).toBe(200);
      const viewAfterRepeat = await stateOf(mock);
      expect(viewAfterRepeat.data.inboxes.ou_mock_alice).toHaveLength(1);
    } finally {
      await mock.stop();
    }
  });

  test("resets every resource of the run at once", async () => {
    const mock = await startFeishuMock();
    try {
      const token = await issueToken(mock);
      await fetch(`${mock.baseUrl}/open-apis/im/v1/messages?receive_id_type=open_id`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          receive_id: "ou_mock_alice",
          msg_type: "text",
          content: JSON.stringify({ text: "before the reset" }),
          uuid: "reset-uuid",
        }),
      });
      await fetch(`${mock.baseUrl}/__mock/faults`, {
        method: "POST",
        headers: { authorization: `Bearer ${mock.runtime.adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ target: "token", kind: "403" }),
      });

      // The token of the current generation is admitted before the reset.
      const beforeReset = await fetch(userPath(mock), { headers: { authorization: `Bearer ${token}` } });
      expect(beforeReset.status).toBe(200);

      const firstMessage = await fetch(`${mock.baseUrl}/open-apis/im/v1/messages?receive_id_type=open_id`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          receive_id: "ou_mock_alice",
          msg_type: "text",
          content: JSON.stringify({ text: "before the reset" }),
          uuid: "reset-uuid",
        }),
      });
      const firstMessageId = ((await firstMessage.json()) as { data: { message_id: string } }).data.message_id;

      const reset = await fetch(`${mock.baseUrl}/__mock/reset`, {
        method: "POST",
        headers: { authorization: `Bearer ${mock.runtime.adminToken}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(reset.status).toBe(200);

      const state = await fetch(`${mock.baseUrl}/__mock/state`, {
        headers: { authorization: `Bearer ${mock.runtime.adminToken}` },
      });
      const view = (await state.json()) as {
        data: { inboxes: Record<string, unknown[]>; faults: unknown[] };
      };
      expect(view.data.inboxes).toEqual({});
      expect(view.data.faults).toEqual([]);

      // The token of the old generation is refused on the retained
      // authenticated route.
      const afterReset = await fetch(userPath(mock), { headers: { authorization: `Bearer ${token}` } });
      expect(afterReset.status).toBe(401);
      expect(await afterReset.json()).toEqual({ code: 2, msg: "mock_provider_unauthorized" });

      // The fault rule of the old generation is gone, so a fresh token is
      // issued again.
      const freshToken = await issueToken(mock);

      const freshRead = await fetch(userPath(mock), { headers: { authorization: `Bearer ${freshToken}` } });
      expect(freshRead.status).toBe(200);

      // The uuid ledger of the old generation is empty, so the same uuid
      // delivers a second message instead of repeating the first one.
      const repeated = await fetch(`${mock.baseUrl}/open-apis/im/v1/messages?receive_id_type=open_id`, {
        method: "POST",
        headers: { authorization: `Bearer ${freshToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          receive_id: "ou_mock_alice",
          msg_type: "text",
          content: JSON.stringify({ text: "before the reset" }),
          uuid: "reset-uuid",
        }),
      });
      expect(repeated.status).toBe(200);
      const viewAfter = await stateOf(mock);
      // The ledger of the old generation is gone, so the same uuid delivers
      // again instead of repeating the first answer.
      expect(viewAfter.data.inboxes.ou_mock_alice).toHaveLength(1);
      expect(firstMessageId.length).toBeGreaterThan(0);
    } finally {
      await mock.stop();
    }
  });

  test("keeps a second instance isolated inside the same worker", async () => {
    const first = await startFeishuMock();
    const second = await startFeishuMock();
    try {
      expect(first.baseUrl).not.toBe(second.baseUrl);
      expect(first.runtime.adminToken).not.toBe(second.runtime.adminToken);
      expect(first.runtime.appSecret).not.toBe(second.runtime.appSecret);

      const token = await issueToken(first);
      const own = await fetch(userPath(first), { headers: { authorization: `Bearer ${token}` } });
      expect(own.status).toBe(200);
      const crossed = await fetch(userPath(second), { headers: { authorization: `Bearer ${token}` } });
      expect(crossed.status).toBe(401);
      expect(await crossed.json()).toEqual({ code: 2, msg: "mock_provider_unauthorized" });
    } finally {
      await first.stop();
      await second.stop();
    }
  });
});
