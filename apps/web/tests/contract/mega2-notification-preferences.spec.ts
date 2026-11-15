import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getUserNotificationPreferences,
  mapUserNotificationSettings,
  updateUserNotificationPreferences,
} from "../../lib/adapter/mega2/user-notifications";

interface RecordedRequest {
  method: string;
  body: unknown;
}

interface StubHandle {
  baseUrl: string;
  close: () => Promise<void>;
}

const responseData = {
  settings: {
    username: "alice",
    enabled: true,
    created_at: "2026-11-13T00:00:00Z",
    updated_at: "2026-11-13T00:00:00Z",
    // Legacy fields must be ignored rather than reintroduced into the local contract.
    email: "alice@example.test",
    delivery_mode: "email",
    preferred_locale: "zh-CN",
  },
  preferences: [
    {
      event_type_code: "cl.comment.created",
      category: "cl",
      description: "CL comment",
      system_required: false,
      default_enabled: true,
      explicit_enabled: true,
      enabled: true,
      updated_at: "2026-11-13T00:00:00Z",
    },
  ],
};

const requests: RecordedRequest[] = [];
let stub: StubHandle;
let previousMega2Url: string | undefined;

function sendJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ req_result: true, data: body, err_message: "" }));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }
  return raw ? JSON.parse(raw) : undefined;
}

async function startStub(): Promise<StubHandle> {
  const server: Server = createServer(async (req, res) => {
    requests.push({ method: req.method ?? "", body: await readBody(req) });
    sendJson(res, responseData);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

beforeAll(async () => {
  previousMega2Url = process.env.MEGA2_PUBLIC_BASE_URL;
  stub = await startStub();
  process.env.MEGA2_PUBLIC_BASE_URL = stub.baseUrl;
});

beforeEach(() => {
  requests.length = 0;
});

afterAll(async () => {
  await stub.close();
  if (previousMega2Url === undefined) {
    delete process.env.MEGA2_PUBLIC_BASE_URL;
  } else {
    process.env.MEGA2_PUBLIC_BASE_URL = previousMega2Url;
  }
});

describe("mega2 notification preferences contract", () => {
  it("maps only the current enabled notification settings", async () => {
    const mapped = mapUserNotificationSettings({
      username: "alice",
      enabled: false,
      created_at: null,
      updated_at: null,
    });

    expect(mapped).toEqual({
      username: "alice",
      enabled: false,
      createdAt: undefined,
      updatedAt: undefined,
    });
    expect(mapped).not.toHaveProperty("email");
    expect(mapped).not.toHaveProperty("deliveryMode");
    expect(mapped).not.toHaveProperty("preferredLocale");

    const config = await getUserNotificationPreferences();
    expect(config.settings).toEqual({
      username: "alice",
      enabled: true,
      createdAt: "2026-11-13T00:00:00Z",
      updatedAt: "2026-11-13T00:00:00Z",
    });
    expect(config.settings).not.toHaveProperty("email");
    expect(config.settings).not.toHaveProperty("deliveryMode");
    expect(config.settings).not.toHaveProperty("preferredLocale");
  });

  it("sends only enabled and per-event preference fields on update", async () => {
    await updateUserNotificationPreferences({
      enabled: false,
      preferences: [{ eventTypeCode: "cl.comment.created", enabled: false }],
    });

    expect(requests).toEqual([
      {
        method: "PUT",
        body: {
          enabled: false,
          preferences: [{ event_type_code: "cl.comment.created", enabled: false }],
        },
      },
    ]);
    const serialized = JSON.stringify(requests[0]?.body);
    expect(serialized).not.toContain("email");
    expect(serialized).not.toContain("delivery_mode");
    expect(serialized).not.toContain("preferred_locale");
  });
});
