/**
 * FSM-20：DM 请求准入 validator。
 *
 * 本片只做输入解析与准入判定，不发送消息，也不提供 DM 路由：调用方注入已交付的
 * 目录快照，得到一份规范载荷（receive_id/msg_type/content），供发送器与 uuid
 * 去重比较复用。
 */
import { mockError, type MockHttpError } from "./http";
import type { MockUser } from "./state";

/** The frozen limit of the message text, in characters. */
export const MOCK_TEXT_MAX_LENGTH = 4096;

/** The only accepted message type. */
export const MOCK_MESSAGE_TYPE = "text";

/** The canonical payload the sender and the uuid ledger compare. */
export interface MockMessagePayload {
  receive_id: string;
  msg_type: typeof MOCK_MESSAGE_TYPE;
  content: string;
}

export interface MockMessageInput {
  receive_id?: unknown;
  msg_type?: unknown;
  content?: unknown;
  uuid?: unknown;
}

export type MockMessageAdmission =
  | { ok: true; payload: MockMessagePayload }
  | { ok: false; error: MockHttpError };

/**
 * Decides whether a direct message input may be sent.
 *
 * The content must be the frozen text structure, a JSON string that holds
 * exactly a `text` field, and the text may not exceed the frozen length. The
 * recipient has to be a member of the injected directory.
 */
export function admitMessageInput(
  input: MockMessageInput,
  directory: readonly MockUser[],
): MockMessageAdmission {
  if (typeof input.receive_id !== "string" || input.receive_id === "") {
    return { ok: false, error: mockError(1, "mock_receive_id_invalid") };
  }
  if (input.msg_type !== MOCK_MESSAGE_TYPE) {
    return { ok: false, error: mockError(1, "mock_msg_type_invalid") };
  }
  if (typeof input.content !== "string") {
    return { ok: false, error: mockError(1, "mock_content_invalid") };
  }
  if (input.uuid !== undefined && typeof input.uuid !== "string") {
    return { ok: false, error: mockError(1, "mock_uuid_invalid") };
  }
  const text = readTextContent(input.content);
  if (typeof text !== "string") {
    return { ok: false, error: mockError(1, "mock_content_invalid") };
  }
  if (text.length > MOCK_TEXT_MAX_LENGTH) {
    return { ok: false, error: mockError(1, "mock_text_too_long") };
  }
  const recipient = directory.find((user) => user.open_id === input.receive_id);
  if (recipient === undefined) {
    return { ok: false, error: mockError(4, "mock_user_not_found") };
  }
  return {
    ok: true,
    payload: {
      receive_id: input.receive_id,
      msg_type: MOCK_MESSAGE_TYPE,
      content: input.content,
    },
  };
}

/**
 * Reads the frozen text content.
 *
 * The content is a JSON string that holds exactly a `text` field with a string
 * value; anything else is not the frozen structure.
 */
function readTextContent(content: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "text") return undefined;
  const text = record.text;
  if (typeof text !== "string") return undefined;
  return text;
}
