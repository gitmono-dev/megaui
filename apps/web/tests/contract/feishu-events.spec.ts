// FS-09: exact anonymous route and real callback-to-PostgreSQL contract.
import { createCipheriv, createHash } from "node:crypto";

import { closeDatabaseClient, getPool } from "@megaui/database";
import {
  createIsolatedPostgres,
  isDockerAvailable,
  type IsolatedPostgres,
} from "@megaui/database/test-support";
import { NextRequest } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const getSession = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../../lib/auth", () => ({
  getAuth: () => ({ api: { getSession } }),
}));

import { POST } from "../../app/api/integrations/feishu/events/route";
import {
  FEISHU_EVENT_NONCE_HEADER,
  FEISHU_EVENT_SIGNATURE_HEADER,
  FEISHU_EVENT_TIMESTAMP_HEADER,
} from "../../lib/feishu-events";
import { authMiddleware } from "../../middlewares/auth";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error(
    "[@megaui/web] feishu-events.spec.ts requires Docker for its isolated PostgreSQL 16 fixture.",
  );
}

const CALLBACK_ENV = {
  FEISHU_TENANT_KEY: "tenant-contract",
  FEISHU_APP_ID: "cli_contract",
  FEISHU_EVENT_VERIFICATION_TOKEN: "verification-contract",
  FEISHU_EVENT_ENCRYPT_KEY: "encrypt-contract",
} as const;
const MANAGED_ENV_NAMES = ["DATABASE_URL", ...Object.keys(CALLBACK_ENV)] as const;
const previousEnv = new Map<string, string | undefined>();

function businessEnvelope(
  eventId: string,
  eventType: string,
  event: Record<string, unknown>,
  headerOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: "2.0",
    header: {
      event_id: eventId,
      event_type: eventType,
      create_time: String(Date.now()),
      token: CALLBACK_ENV.FEISHU_EVENT_VERIFICATION_TOKEN,
      app_id: CALLBACK_ENV.FEISHU_APP_ID,
      tenant_key: CALLBACK_ENV.FEISHU_TENANT_KEY,
      ...headerOverrides,
    },
    event,
  };
}

function encrypt(payload: unknown): Buffer {
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const key = createHash("sha256")
    .update(CALLBACK_ENV.FEISHU_EVENT_ENCRYPT_KEY, "utf8")
    .digest();
  const iv = Buffer.alloc(16, 11);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.from(
    JSON.stringify({
      encrypt: Buffer.concat([iv, ciphertext]).toString("base64"),
    }),
    "utf8",
  );
}

function signedWire(
  payload: unknown,
  options: { encrypted?: boolean; body?: Buffer } = {},
): { body: Buffer; headers: Headers } {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonce = "nonce-contract";
  const body =
    options.body ??
    (options.encrypted
      ? encrypt(payload)
      : Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = createHash("sha256")
    .update(
      `${timestamp}${nonce}${CALLBACK_ENV.FEISHU_EVENT_ENCRYPT_KEY}`,
      "utf8",
    )
    .update(body)
    .digest("hex");
  return {
    body,
    headers: new Headers({
      "Content-Type": "application/json",
      [FEISHU_EVENT_TIMESTAMP_HEADER]: timestamp,
      [FEISHU_EVENT_NONCE_HEADER]: nonce,
      [FEISHU_EVENT_SIGNATURE_HEADER]: signature,
    }),
  };
}

async function postWire(wire: {
  body: Buffer;
  headers: Headers;
}): Promise<Response> {
  return POST(
    new Request(
      "http://127.0.0.1:3000/api/integrations/feishu/events",
      {
        method: "POST",
        headers: wire.headers,
        body: wire.body.toString("utf8"),
      },
    ),
  );
}

async function storedCounts(pool: ReturnType<typeof getPool>): Promise<{
  inbox: number;
  jobs: number;
}> {
  const inbox = await pool.query<{ count: number }>(
    `select count(*)::int as count from "enterprise_event_inbox"`,
  );
  const jobs = await pool.query<{ count: number }>(
    `select count(*)::int as count from "enterprise_jobs"`,
  );
  return {
    inbox: inbox.rows[0]?.count ?? -1,
    jobs: jobs.rows[0]?.count ?? -1,
  };
}

let isolated: IsolatedPostgres | undefined;
let inspectionPool: ReturnType<typeof getPool> | undefined;

describe("Feishu callback route contract (FS-09)", () => {
  beforeAll(async () => {
    for (const name of MANAGED_ENV_NAMES) {
      previousEnv.set(name, process.env[name]);
    }
    isolated = await createIsolatedPostgres();
    await isolated.migrate();
    process.env.DATABASE_URL = isolated.databaseUrl;
    Object.assign(process.env, CALLBACK_ENV);
    inspectionPool = getPool();
  }, 120_000);

  beforeEach(async () => {
    getSession.mockClear();
    if (!inspectionPool) throw new Error("inspection pool was not initialized");
    await inspectionPool.query(`delete from "enterprise_jobs"`);
    await inspectionPool.query(`delete from "enterprise_event_inbox"`);
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    try {
      await closeDatabaseClient();
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      try {
        for (const name of MANAGED_ENV_NAMES) {
          const previous = previousEnv.get(name);
          if (previous === undefined) delete process.env[name];
          else process.env[name] = previous;
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        if (isolated) await isolated.destroy();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "Feishu callback contract cleanup failed",
      );
    }
  }, 120_000);

  it("grants an anonymous exception only to the exact POST callback", async () => {
    const exact = await authMiddleware(
      new NextRequest(
        "http://127.0.0.1:3000/api/integrations/feishu/events",
        { method: "POST" },
      ),
    );
    expect(exact).toBeUndefined();
    expect(getSession).not.toHaveBeenCalled();

    const protectedRequests = [
      new NextRequest(
        "http://127.0.0.1:3000/api/integrations/feishu/events",
        { method: "GET" },
      ),
      new NextRequest(
        "http://127.0.0.1:3000/api/integrations/feishu/events",
        { method: "PUT" },
      ),
      new NextRequest(
        "http://127.0.0.1:3000/api/integrations/feishu/events/",
        { method: "POST" },
      ),
      new NextRequest(
        "http://127.0.0.1:3000/api/integrations/feishu/events-neighbor",
        { method: "POST" },
      ),
      new NextRequest(
        "http://127.0.0.1:3000/api/integrations/other",
        { method: "POST" },
      ),
    ];
    for (const request of protectedRequests) {
      const response = await authMiddleware(request);
      expect(response?.status).toBe(401);
    }
    expect(getSession).toHaveBeenCalledTimes(protectedRequests.length);
  });

  it("awaits durable acceptance and deduplicates a replay", async () => {
    if (!inspectionPool) throw new Error("inspection pool was not initialized");
    const payload = businessEnvelope(
      "evt-contact-contract",
      "contact.user.updated_v3",
      { object: { open_id: "ou-contract" } },
    );
    const wire = signedWire(payload, { encrypted: true });

    const first = await postWire(wire);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    // The route response is available only after both rows commit.
    expect(await storedCounts(inspectionPool)).toEqual({ inbox: 1, jobs: 1 });

    const replay = await postWire(wire);
    expect(replay.status).toBe(200);
    expect(await storedCounts(inspectionPool)).toEqual({ inbox: 1, jobs: 1 });
  });

  it("rejects bad signatures, decryption, tenant, and app before persistence", async () => {
    if (!inspectionPool) throw new Error("inspection pool was not initialized");
    const validPayload = businessEnvelope(
      "evt-rejected",
      "contact.user.deleted_v3",
      { object: { open_id: "ou-rejected" } },
    );

    const badSignature = signedWire(validPayload);
    badSignature.headers.set(FEISHU_EVENT_SIGNATURE_HEADER, "0".repeat(64));

    const invalidCiphertextBody = Buffer.from(
      JSON.stringify({ encrypt: Buffer.alloc(32).toString("base64") }),
      "utf8",
    );
    const badDecryption = signedWire({}, { body: invalidCiphertextBody });
    const wrongTenant = signedWire(
      businessEnvelope(
        "evt-wrong-tenant",
        "contact.user.updated_v3",
        { object: { open_id: "ou-tenant" } },
        { tenant_key: "other-tenant" },
      ),
    );
    const wrongApp = signedWire(
      businessEnvelope(
        "evt-wrong-app",
        "contact.user.updated_v3",
        { object: { open_id: "ou-app" } },
        { app_id: "other-app" },
      ),
    );
    const wrongBusinessToken = signedWire(
      businessEnvelope(
        "evt-wrong-token",
        "contact.user.updated_v3",
        { object: { open_id: "ou-token" } },
        { token: "wrong-token" },
      ),
    );

    for (const wire of [
      badSignature,
      badDecryption,
      wrongTenant,
      wrongApp,
      wrongBusinessToken,
    ]) {
      const response = await postWire(wire);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    expect(await storedCounts(inspectionPool)).toEqual({ inbox: 0, jobs: 0 });
  });

  it("answers URL verification only after token validation", async () => {
    if (!inspectionPool) throw new Error("inspection pool was not initialized");
    const response = await postWire(
      signedWire(
        {
          type: "url_verification",
          token: CALLBACK_ENV.FEISHU_EVENT_VERIFICATION_TOKEN,
          challenge: "challenge-contract",
        },
        { encrypted: true },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "challenge-contract" });
    expect(await storedCounts(inspectionPool)).toEqual({ inbox: 0, jobs: 0 });

    const rejected = await postWire(
      signedWire({
        type: "url_verification",
        token: "wrong-token",
        challenge: "must-not-return",
      }),
    );
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).not.toEqual({
      challenge: "must-not-return",
    });
  });

  it("persists only the digest and whitelisted IM metadata", async () => {
    if (!inspectionPool) throw new Error("inspection pool was not initialized");
    const token = "opaque-contract-token";
    const payload = businessEnvelope(
      "evt-message-contract",
      "im.message.receive_v1",
      {
        sender: {
          sender_id: { open_id: "ou-message" },
          sender_type: "user",
        },
        message: {
          message_id: "om-contract",
          create_time: String(Date.now()),
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: `/login ${token}` }),
        },
      },
    );
    const response = await postWire(signedWire(payload, { encrypted: true }));
    expect(response.status).toBe(200);

    const stored = await inspectionPool.query<{
      row: Record<string, unknown>;
      pairingTokenDigest: string;
    }>(
      `select to_jsonb(inbox) as row,
              pairing_token_digest as "pairingTokenDigest"
         from "enterprise_event_inbox" inbox`,
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.pairingTokenDigest).toBe(
      createHash("sha256").update(token, "utf8").digest("hex"),
    );
    const serialized = JSON.stringify(stored.rows[0]?.row);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("/login");
    expect(serialized).not.toContain("raw_body");
    expect(serialized).not.toContain("message_text");
  });
});
