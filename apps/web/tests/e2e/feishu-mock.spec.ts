import { expect, test } from "@playwright/test";

import { startFeishuMock, type StartedFeishuMock } from "./helpers/feishu-mock";

/**
 * FSM-05：Mock 自身完整协议集成。
 *
 * 本 spec 只用 HTTP 与真实 CLI，不启动网站、浏览器或数据库。
 */

async function stateOf(mock: StartedFeishuMock): Promise<{
  data: { users: unknown[]; inboxes: Record<string, unknown[]>; events: unknown[]; faults: unknown[] };
}> {
  const response = await fetch(`${mock.baseUrl}/__mock/state`, {
    headers: { authorization: `Bearer ${mock.runtime.adminToken}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    data: { users: unknown[]; inboxes: Record<string, unknown[]>; events: unknown[]; faults: unknown[] };
  };
}

/** Waits for the delivery of a callback to be recorded. */
async function waitForEvents(mock: StartedFeishuMock, count: number): Promise<unknown[]> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const view = await stateOf(mock);
    if (view.data.events.length >= count) return view.data.events;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  const view = await stateOf(mock);
  return view.data.events;
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

      const directory = await fetch(
        `${mock.baseUrl}/open-apis/contact/v3/users/find_by_department?department_id=od_mock_engineering&page_size=100`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(directory.status).toBe(200);
      const listed = (await directory.json()) as {
        data: { items: Array<{ open_id: string }>; has_more: boolean };
      };
      expect(listed.data.items.map((user) => user.open_id)).toEqual(["ou_mock_alice", "ou_mock_bob"]);

      const single = await fetch(
        `${mock.baseUrl}/open-apis/contact/v3/users/ou_mock_alice?user_id_type=open_id&department_id_type=open_department_id`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(single.status).toBe(200);

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

      // The control route sends the p2p event to the callback target.
      const control = await fetch(`${mock.baseUrl}/__mock/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${mock.runtime.adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ openId: "ou_mock_bob", text: "from the mock" }),
      });
      expect(control.status).toBe(200);

      const view = await stateOf(mock);
      expect(view.data.users).toHaveLength(6);
      expect(view.data.inboxes.ou_mock_alice).toHaveLength(1);
      expect(await waitForEvents(mock, 1)).toHaveLength(1);

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

      // A cursor of the current generation, so the reset can be shown to
      // refuse it afterwards.
      const paged = await fetch(
        `${mock.baseUrl}/open-apis/contact/v3/users/find_by_department?department_id=od_mock_engineering&page_size=1`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      const pagedBody = (await paged.json()) as { data: { page_token: string } };
      const cursor = pagedBody.data.page_token;
      expect(cursor.length).toBeGreaterThan(0);

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
        data: { inboxes: Record<string, unknown[]>; events: unknown[]; faults: unknown[] };
      };
      expect(view.data.inboxes).toEqual({});
      expect(view.data.events).toEqual([]);
      expect(view.data.faults).toEqual([]);

      // The token of the old generation is refused as well.
      const afterReset = await fetch(
        `${mock.baseUrl}/open-apis/contact/v3/users/find_by_department?department_id=od_mock_engineering`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(afterReset.status).toBe(401);

      // The fault rule of the old generation is gone, so a fresh token is
      // issued again.
      const freshToken = await issueToken(mock);

      // The cursor of the old generation is refused as well.
      const staleCursor = await fetch(
        `${mock.baseUrl}/open-apis/contact/v3/users/find_by_department?department_id=od_mock_engineering&page_size=1&page_token=${cursor}`,
        { headers: { authorization: `Bearer ${freshToken}` } },
      );
      expect(staleCursor.status).toBe(400);
      expect(await staleCursor.json()).toEqual({ code: 1, msg: "mock_cursor_invalid" });

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
      expect(first.runtime.callbackUrl).not.toBe(second.runtime.callbackUrl);

      const token = await issueToken(first);
      const crossed = await fetch(
        `${second.baseUrl}/open-apis/contact/v3/users/find_by_department?department_id=od_mock_engineering`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(crossed.status).toBe(401);
    } finally {
      await first.stop();
      await second.stop();
    }
  });
});
