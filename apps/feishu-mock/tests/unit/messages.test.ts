import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { resolveMockConfig } from "../../src/config";
import { MOCK_INBOX_MAX_MESSAGES } from "../../src/messages";
import { startMockListener, type MockListener } from "../../src/server";
import { MOCK_APP_ID } from "../../src/state";

const CONFIG = resolveMockConfig({
  FEISHU_SIMULATOR_ENABLED: "1",
  NODE_ENV: "test",
  FEISHU_SIMULATOR_PORT: "0",
});

const APP_SECRET = "mock-app-secret-for-the-tenant-token";
const ADMIN_TOKEN = "mock-admin-token-for-the-control-plane";
const MESSAGE_PATH = "/open-apis/im/v1/messages?receive_id_type=open_id";

let listener: MockListener | undefined;

afterEach(async () => {
  await listener?.close();
  listener = undefined;
});

function call(
  baseUrl: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  const target = new URL(path, baseUrl);
  return new Promise((resolvePromise, reject) => {
    const headers = { ...options.headers };
    if (options.body !== undefined && headers["content-type"] === undefined) {
      headers["content-type"] = "application/json";
    }
    const outgoing = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: options.method ?? "GET",
        headers,
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += String(chunk);
        });
        response.on("end", () => {
          resolvePromise({ status: response.statusCode ?? 0, body });
        });
      },
    );
    outgoing.on("error", reject);
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
}

async function startListener(): Promise<MockListener> {
  listener = await startMockListener(CONFIG, { adminToken: ADMIN_TOKEN, appSecret: APP_SECRET });
  return listener;
}

async function issueToken(): Promise<string> {
  const response = await call(
    listener!.baseUrl,
    "/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      body: JSON.stringify({ app_id: MOCK_APP_ID, app_secret: APP_SECRET }),
    },
  );
  expect(response.status).toBe(200);
  return (JSON.parse(response.body) as { tenant_access_token: string }).tenant_access_token;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function message(uuid: string, text: string, receiveId = "ou_mock_alice"): string {
  return JSON.stringify({
    receive_id: receiveId,
    msg_type: "text",
    content: JSON.stringify({ text }),
    uuid,
  });
}

describe("directed messages and the uuid ledger (FSM-10)", () => {
  it("delivers to the inbox of the named member and answers a stable message id", async () => {
    await startListener();
    const token = await issueToken();
    const response = await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: bearer(token),
      body: message("uuid-1", "hello"),
    });
    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as {
      code: number;
      data: { message_id: string; msg_type: string; chat_id: string; body: { content: string } };
    };
    expect(payload.code).toBe(0);
    expect(payload.data.chat_id).toBe("oc_ou_mock_alice");
    expect(payload.data.msg_type).toBe("text");
    expect(JSON.parse(payload.data.body.content)).toEqual({ text: "hello" });
    expect(payload.data.message_id.length).toBeGreaterThan(0);

    const state = await call(listener!.baseUrl, "/__mock/state", { headers: bearer(ADMIN_TOKEN) });
    const view = JSON.parse(state.body) as { data: { inboxes: Record<string, unknown[]> } };
    expect(view.data.inboxes.ou_mock_alice).toHaveLength(1);
    expect(view.data.inboxes.ou_mock_bob).toBeUndefined();
  });

  it("returns the original result for the same uuid and payload", async () => {
    await startListener();
    const token = await issueToken();
    const first = await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: bearer(token),
      body: message("uuid-2", "hello"),
    });
    const second = await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: bearer(token),
      body: message("uuid-2", "hello"),
    });
    expect(second.status).toBe(200);
    expect(JSON.parse(second.body)).toEqual(JSON.parse(first.body));

    const state = await call(listener!.baseUrl, "/__mock/state", { headers: bearer(ADMIN_TOKEN) });
    const view = JSON.parse(state.body) as { data: { inboxes: Record<string, unknown[]> } };
    expect(view.data.inboxes.ou_mock_alice).toHaveLength(1);
  });

  it("refuses the same uuid with another canonical payload", async () => {
    await startListener();
    const token = await issueToken();
    await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: bearer(token),
      body: message("uuid-3", "hello"),
    });
    const conflict = await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: bearer(token),
      body: message("uuid-3", "different"),
    });
    expect(conflict.status).toBe(409);
    expect(JSON.parse(conflict.body)).toEqual({ code: 5, msg: "mock_uuid_conflict" });
  });

  it("refuses a new message when the inbox of the member is full", async () => {
    await startListener();
    const token = await issueToken();
    for (let index = 0; index < MOCK_INBOX_MAX_MESSAGES; index += 1) {
      const response = await call(listener!.baseUrl, MESSAGE_PATH, {
        method: "POST",
        headers: bearer(token),
        body: message(`uuid-full-${index}`, `message ${index}`),
      });
      expect(response.status).toBe(200);
    }
    const refused = await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: bearer(token),
      body: message("uuid-overflow", "one too many"),
    });
    expect(refused.status).toBe(429);
    expect(JSON.parse(refused.body)).toEqual({ code: 6, msg: "mock_inbox_full" });

    // The repeated uuid still answers with the original result.
    const repeated = await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: bearer(token),
      body: message("uuid-full-0", "message 0"),
    });
    expect(repeated.status).toBe(200);
  });

  it("keeps the uuid ledger when the token expired", async () => {
    await startListener();
    const token = await issueToken();
    const first = await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: bearer(token),
      body: message("uuid-4", "hello"),
    });
    const firstBody = JSON.parse(first.body) as { data: { message_id: string } };

    // The ledger answers the repeated uuid even though the caller has to
    // present a fresh token, because a token expiry does not release it.
    const state = await call(listener!.baseUrl, "/__mock/state", { headers: bearer(ADMIN_TOKEN) });
    const view = JSON.parse(state.body) as { data: { inboxes: Record<string, unknown[]> } };
    expect(view.data.inboxes.ou_mock_alice).toHaveLength(1);

    const fresh = await issueToken();
    const repeated = await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: bearer(fresh),
      body: message("uuid-4", "hello"),
    });
    expect(repeated.status).toBe(200);
    expect((JSON.parse(repeated.body) as { data: { message_id: string } }).data.message_id).toBe(
      firstBody.data.message_id,
    );
    const after = await call(listener!.baseUrl, "/__mock/state", { headers: bearer(ADMIN_TOKEN) });
    const afterView = JSON.parse(after.body) as { data: { inboxes: Record<string, unknown[]> } };
    expect(afterView.data.inboxes.ou_mock_alice).toHaveLength(1);
  });

  it("empties the inbox and the uuid ledger after a reset", async () => {
    await startListener();
    const token = await issueToken();
    await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: bearer(token),
      body: message("uuid-5", "hello"),
    });
    const reset = await call(listener!.baseUrl, "/__mock/reset", {
      method: "POST",
      headers: bearer(ADMIN_TOKEN),
      body: "{}",
    });
    expect(reset.status).toBe(200);

    const state = await call(listener!.baseUrl, "/__mock/state", { headers: bearer(ADMIN_TOKEN) });
    const view = JSON.parse(state.body) as { data: { inboxes: Record<string, unknown[]> } };
    expect(view.data.inboxes).toEqual({});

    const fresh = await issueToken();
    const afterReset = await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: bearer(fresh),
      body: message("uuid-5", "hello"),
    });
    expect(afterReset.status).toBe(200);
    const stateAfter = await call(listener!.baseUrl, "/__mock/state", { headers: bearer(ADMIN_TOKEN) });
    const viewAfter = JSON.parse(stateAfter.body) as { data: { inboxes: Record<string, unknown[]> } };
    expect(viewAfter.data.inboxes.ou_mock_alice).toHaveLength(1);
  });

  it("accepts only a request that the token validator and the message admission approve", async () => {
    await startListener();
    const token = await issueToken();

    const withoutBearer = await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      body: message("uuid-6", "hello"),
    });
    expect(withoutBearer.status).toBe(401);
    expect(JSON.parse(withoutBearer.body)).toEqual({ code: 2, msg: "mock_provider_unauthorized" });

    const withoutIdType = await call(
      listener!.baseUrl,
      "/open-apis/im/v1/messages",
      { method: "POST", headers: bearer(token), body: message("uuid-6", "hello") },
    );
    expect(withoutIdType.status).toBe(400);
    expect(JSON.parse(withoutIdType.body)).toEqual({ code: 1, msg: "mock_id_type_required" });

    const wrongIdType = await call(
      listener!.baseUrl,
      "/open-apis/im/v1/messages?receive_id_type=user_id",
      { method: "POST", headers: bearer(token), body: message("uuid-6", "hello") },
    );
    expect(wrongIdType.status).toBe(400);
    expect(JSON.parse(wrongIdType.body)).toEqual({ code: 1, msg: "mock_id_type_invalid" });

    const unknownField = await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({
        receive_id: "ou_mock_alice",
        msg_type: "text",
        content: JSON.stringify({ text: "hello" }),
        uuid: "uuid-6",
        extra: 1,
      }),
    });
    expect(unknownField.status).toBe(400);
    expect(JSON.parse(unknownField.body)).toEqual({ code: 1, msg: "mock_unknown_field" });

    const unknownRecipient = await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: bearer(token),
      body: message("uuid-6", "hello", "ou_mock_unknown"),
    });
    expect(unknownRecipient.status).toBe(404);
    expect(JSON.parse(unknownRecipient.body)).toEqual({ code: 4, msg: "mock_user_not_found" });

    const badContent = await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({
        receive_id: "ou_mock_alice",
        msg_type: "text",
        content: JSON.stringify({ text: "hello", extra: 1 }),
        uuid: "uuid-6",
      }),
    });
    expect(badContent.status).toBe(400);
    expect(JSON.parse(badContent.body)).toEqual({ code: 1, msg: "mock_content_invalid" });
  });
});

interface SuccessAnswer {
  code: unknown;
  msg: unknown;
  data: Record<string, unknown> & {
    body?: { content?: unknown };
    sender?: Record<string, unknown>;
  };
}

/** Sends one message on a fresh listener and returns the request and answer. */
async function sendOnce(
  text = "hello",
  uuid = "uuid-shape",
): Promise<{ sentContent: string; answer: SuccessAnswer; status: number }> {
  await startListener();
  const token = await issueToken();
  const body = message(uuid, text);
  const response = await call(listener!.baseUrl, MESSAGE_PATH, {
    method: "POST",
    headers: bearer(token),
    body,
  });
  return {
    sentContent: (JSON.parse(body) as { content: string }).content,
    answer: JSON.parse(response.body) as SuccessAnswer,
    status: response.status,
  };
}

describe("the success answer follows the measured real shape (FSL-170)", () => {
  it("answers code 0 on the first send", async () => {
    const { status, answer } = await sendOnce();
    expect(status).toBe(200);
    expect(answer.code).toBe(0);
  });

  it("answers msg success on the first send", async () => {
    const { answer } = await sendOnce();
    expect(answer.msg).toBe("success");
  });

  it("answers a non-empty string data.message_id", async () => {
    const { answer } = await sendOnce();
    expect(typeof answer.data.message_id).toBe("string");
    expect(String(answer.data.message_id).length).toBeGreaterThan(0);
  });

  it("answers data.msg_type text", async () => {
    const { answer } = await sendOnce();
    expect(answer.data.msg_type).toBe("text");
  });

  it("answers a string data.body.content", async () => {
    const { answer } = await sendOnce();
    expect(typeof answer.data.body?.content).toBe("string");
  });

  it("answers a data.body.content that is not byte-identical to the request content", async () => {
    const ascii = await sendOnce("hello", "uuid-ascii");
    expect(ascii.answer.data.body?.content).not.toBe(ascii.sentContent);
    expect(JSON.parse(String(ascii.answer.data.body?.content))).toEqual(JSON.parse(ascii.sentContent));
    await listener!.close();
    listener = undefined;
    const chinese = await sendOnce("企业登录验证码：2ABCD4EF", "uuid-chinese");
    expect(chinese.answer.data.body?.content).not.toBe(chinese.sentContent);
    expect(JSON.parse(String(chinese.answer.data.body?.content))).toEqual(JSON.parse(chinese.sentContent));
  });

  it("answers a string data.chat_id", async () => {
    const { answer } = await sendOnce();
    expect(typeof answer.data.chat_id).toBe("string");
  });

  it("answers a string data.create_time", async () => {
    const { answer } = await sendOnce();
    expect(typeof answer.data.create_time).toBe("string");
  });

  it("answers a string data.update_time", async () => {
    const { answer } = await sendOnce();
    expect(typeof answer.data.update_time).toBe("string");
  });

  it("answers a string data.sender.id", async () => {
    const { answer } = await sendOnce();
    expect(typeof answer.data.sender?.id).toBe("string");
  });

  it("answers a string data.sender.id_type", async () => {
    const { answer } = await sendOnce();
    expect(typeof answer.data.sender?.id_type).toBe("string");
  });

  it("answers a string data.sender.sender_type", async () => {
    const { answer } = await sendOnce();
    expect(typeof answer.data.sender?.sender_type).toBe("string");
  });

  it("answers a string data.sender.tenant_key", async () => {
    const { answer } = await sendOnce();
    expect(typeof answer.data.sender?.tenant_key).toBe("string");
  });

  it("answers a boolean data.deleted", async () => {
    const { answer } = await sendOnce();
    expect(typeof answer.data.deleted).toBe("boolean");
  });

  it("answers a boolean data.updated", async () => {
    const { answer } = await sendOnce();
    expect(typeof answer.data.updated).toBe("boolean");
  });

  it("answers without data.receive_id", async () => {
    const { answer } = await sendOnce();
    expect(Object.hasOwn(answer.data, "receive_id")).toBe(false);
  });

  it("answers without a top-level data.content", async () => {
    const { answer } = await sendOnce();
    expect(Object.hasOwn(answer.data, "content")).toBe(false);
  });

  it("answers the same message_id for the same uuid and payload", async () => {
    const { answer } = await sendOnce("hello", "uuid-replay");
    const token = await issueToken();
    const repeated = await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: bearer(token),
      body: message("uuid-replay", "hello"),
    });
    expect((JSON.parse(repeated.body) as SuccessAnswer).data.message_id).toBe(answer.data.message_id);
  });

  it("answers a repeated request with a body deeply equal to the first answer", async () => {
    const { answer } = await sendOnce("企业登录验证码：2ABCD4EF", "uuid-replay-body");
    const token = await issueToken();
    const repeated = await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: bearer(token),
      body: message("uuid-replay-body", "企业登录验证码：2ABCD4EF"),
    });
    expect(repeated.status).toBe(200);
    expect(JSON.parse(repeated.body)).toEqual(answer);
  });

  it("keeps exactly one message in the inbox after a repeated request", async () => {
    await sendOnce("hello", "uuid-replay-inbox");
    const token = await issueToken();
    await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: bearer(token),
      body: message("uuid-replay-inbox", "hello"),
    });
    const state = await call(listener!.baseUrl, "/__mock/state", { headers: bearer(ADMIN_TOKEN) });
    const view = JSON.parse(state.body) as { data: { inboxes: Record<string, unknown[]> } };
    expect(view.data.inboxes.ou_mock_alice).toHaveLength(1);
  });

  it("still refuses the same uuid with another payload as mock_uuid_conflict", async () => {
    await sendOnce("hello", "uuid-replay-conflict");
    const token = await issueToken();
    const conflict = await call(listener!.baseUrl, MESSAGE_PATH, {
      method: "POST",
      headers: bearer(token),
      body: message("uuid-replay-conflict", "another text"),
    });
    expect(conflict.status).toBe(409);
    expect(JSON.parse(conflict.body)).toEqual({ code: 5, msg: "mock_uuid_conflict" });
  });
});
