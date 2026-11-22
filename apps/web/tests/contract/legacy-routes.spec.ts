// megaui-only (FSL-132): AC19-AC21, the deleted enterprise routes answer 404 in a real Next process.
//
// The Web runs as its own `next dev` child from an owned copy of the source (FS-92 `OwnedWeb`:
// one-shot PostgreSQL, no real .env) in legacy mode. A legacy user signs up through the real
// `/api/auth/[...all]` route. Every deleted path answers 404 with and without that session:
// `/api/auth/enterprise/*` because Better Auth has no such operation any more, and the Feishu
// events callback and the eligibility route because the middleware answers 404 for these two
// retired paths before its session guard (and Next has no route for them either).
import { describe, expect, it } from "vitest";

import { isDockerAvailable } from "@megaui/database/test-support";

import { withOwnedWeb, type OwnedWeb } from "../helpers/owned-web";

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  throw new Error("[@megaui/web] legacy-routes.spec.ts: a docker daemon is required (the fixture owns its own Postgres).");
}

const SESSION_COOKIE = "better-auth.session_token";
const ENTERPRISE_AUTH_PATHS = [
  "/api/auth/enterprise/request",
  "/api/auth/enterprise/status",
  "/api/auth/enterprise/verify",
  "/api/auth/enterprise/session",
] as const;
const FEISHU_EVENTS_PATH = "/api/integrations/feishu/events";
const ELIGIBILITY_PATH = "/api/internal/enterprise/eligibility";

async function send(owner: OwnedWeb, path: string, method: "GET" | "POST", cookie?: string): Promise<Response> {
  return fetch(`${owner.baseURL}${path}`, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(120_000),
    headers: {
      origin: owner.baseURL,
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify({ alias: "member", type: "url_verification", challenge: "x" }) } : {}),
  });
}

/** Sign a legacy user up through the real route and return its session cookie. */
async function legacySession(owner: OwnedWeb): Promise<string> {
  const response = await fetch(`${owner.baseURL}/api/auth/sign-up/email`, {
    method: "POST",
    signal: AbortSignal.timeout(120_000),
    headers: { origin: owner.baseURL, "content-type": "application/json" },
    body: JSON.stringify({ email: "legacy-routes@example.test", password: "fsl132-password-long-enough", name: "Legacy" }),
  });
  expect(response.status).toBe(200);
  const line = response.headers.getSetCookie().find(entry => entry.startsWith(`${SESSION_COOKIE}=`));
  if (!line) throw new Error("legacy sign-up issued no session cookie");
  const cookie = line.split(";", 1)[0]!;
  // The cookie is a live session: get-session returns the user.
  const session = await fetch(`${owner.baseURL}/api/auth/get-session`, { headers: { cookie, origin: owner.baseURL } });
  expect(session.status).toBe(200);
  expect(await session.json()).toMatchObject({ user: { email: "legacy-routes@example.test" } });
  return cookie;
}

describe("FSL-132 deleted enterprise routes", () => {
  it("AC19-AC21: /api/auth/enterprise/*, the Feishu events callback and the eligibility route answer 404", async ({ signal }) => {
    await withOwnedWeb(async (owner) => {
      expect(owner.env.AUTH_MODE).toBe("legacy");
      const dev = await owner.start("dev");
      try {
        const cookie = await legacySession(owner);

        // AC19: the old enterprise Better Auth operations, with and without a session.
        for (const path of ENTERPRISE_AUTH_PATHS) {
          for (const method of ["GET", "POST"] as const) {
            expect((await send(owner, path, method)).status, `${method} ${path}`).toBe(404);
            expect((await send(owner, path, method, cookie)).status, `${method} ${path} signed in`).toBe(404);
          }
        }

        // AC20, AC21: with and without a session, including a trailing slash and a case variant.
        for (const path of [FEISHU_EVENTS_PATH, ELIGIBILITY_PATH]) {
          for (const variant of [path, `${path}/`, path.toUpperCase()]) {
            for (const method of ["GET", "POST"] as const) {
              const anonymous = await send(owner, variant, method);
              expect(anonymous.status, `anonymous ${method} ${variant}`).toBe(404);
              expect(await anonymous.json()).toEqual({ error: "NOT_FOUND" });
              expect((await send(owner, variant, method, cookie)).status, `${method} ${variant} signed in`).toBe(404);
            }
          }
        }
        // A neighbouring unknown API path still meets the fail-closed session guard.
        expect((await send(owner, "/api/integrations/feishu/other", "POST")).status).toBe(401);

        // Control: an existing route still answers in the same process.
        expect((await fetch(`${owner.baseURL}/api/health`, { signal: AbortSignal.timeout(30_000) })).status).toBe(200);
      } finally {
        await dev.stop();
      }
    }, signal);
  }, 600_000);
});
