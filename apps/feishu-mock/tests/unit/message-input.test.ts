import { describe, expect, it } from "vitest";

import {
  admitMessageInput,
  MOCK_MESSAGE_TYPE,
  MOCK_TEXT_MAX_LENGTH,
} from "../../src/message-input";
import { createMockState, type MockUser } from "../../src/state";

const directory: MockUser[] = createMockState().users;

function admit(input: {
  receive_id?: unknown;
  msg_type?: unknown;
  content?: unknown;
  uuid?: unknown;
}) {
  return admitMessageInput(input, directory);
}

describe("direct message admission (FSM-20)", () => {
  it("accepts the frozen text content structure", () => {
    const admitted = admit({
      receive_id: "ou_mock_alice",
      msg_type: "text",
      content: JSON.stringify({ text: "hello" }),
      uuid: "uuid-1",
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.payload).toEqual({
      receive_id: "ou_mock_alice",
      msg_type: MOCK_MESSAGE_TYPE,
      content: JSON.stringify({ text: "hello" }),
    });
    expect(Object.keys(admitted.payload).sort()).toEqual(["content", "msg_type", "receive_id"]);
  });

  it("refuses any other content structure", () => {
    const cases: unknown[] = [
      "not json",
      JSON.stringify({ text: "hello", extra: 1 }),
      JSON.stringify({ text: 42 }),
      JSON.stringify({}),
      JSON.stringify(["hello"]),
      JSON.stringify("hello"),
    ];
    for (const content of cases) {
      const admitted = admit({ receive_id: "ou_mock_alice", msg_type: "text", content });
      expect(admitted.ok).toBe(false);
      if (admitted.ok) continue;
      expect(admitted.error.httpStatus).toBe(400);
      expect(admitted.error.msg).toBe("mock_content_invalid");
    }
  });

  it("refuses a text that is longer than the frozen limit", () => {
    const atLimit = "x".repeat(MOCK_TEXT_MAX_LENGTH);
    const accepted = admit({
      receive_id: "ou_mock_alice",
      msg_type: "text",
      content: JSON.stringify({ text: atLimit }),
    });
    expect(accepted.ok).toBe(true);

    const tooLong = admit({
      receive_id: "ou_mock_alice",
      msg_type: "text",
      content: JSON.stringify({ text: `${atLimit}y` }),
    });
    expect(tooLong.ok).toBe(false);
    if (tooLong.ok) return;
    expect(tooLong.error.httpStatus).toBe(400);
    expect(tooLong.error.msg).toBe("mock_text_too_long");
    expect(MOCK_TEXT_MAX_LENGTH).toBe(4096);
  });

  it("refuses a recipient the directory does not hold", () => {
    const admitted = admit({
      receive_id: "ou_mock_unknown",
      msg_type: "text",
      content: JSON.stringify({ text: "hello" }),
    });
    expect(admitted.ok).toBe(false);
    if (admitted.ok) return;
    expect(admitted.error.httpStatus).toBe(404);
    expect(admitted.error.msg).toBe("mock_user_not_found");
  });

  it("refuses a malformed receiver, message type or uuid", () => {
    const missingReceiver = admit({
      msg_type: "text",
      content: JSON.stringify({ text: "hello" }),
    });
    expect(missingReceiver.ok).toBe(false);
    if (!missingReceiver.ok) {
      expect(missingReceiver.error.msg).toBe("mock_receive_id_invalid");
    }

    const wrongType = admit({
      receive_id: "ou_mock_alice",
      msg_type: "post",
      content: JSON.stringify({ text: "hello" }),
    });
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) {
      expect(wrongType.error.msg).toBe("mock_msg_type_invalid");
    }

    const wrongUuid = admit({
      receive_id: "ou_mock_alice",
      msg_type: "text",
      content: JSON.stringify({ text: "hello" }),
      uuid: 7,
    });
    expect(wrongUuid.ok).toBe(false);
    if (!wrongUuid.ok) {
      expect(wrongUuid.error.msg).toBe("mock_uuid_invalid");
    }
  });

  it("gives the same canonical payload for the same input", () => {
    const input = {
      receive_id: "ou_mock_bob",
      msg_type: "text",
      content: JSON.stringify({ text: "same" }),
      uuid: "uuid-2",
    };
    const first = admit(input);
    const second = admit(input);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.payload).toEqual(second.payload);
    expect(JSON.stringify(first.payload)).toBe(JSON.stringify(second.payload));
  });
});
