/**
 * WA-04 content-domain BFF contract tests (docs / issues / CL).
 */
import { ownedContractFixture } from "../helpers/owned-contract";

import { isBlockId } from "@megaui/core";
import { createDatabaseClient } from "@megaui/database";
import {
  MEGA_ERROR_CODES,
  createIssuesService,
} from "@megaui/engine";
import { SAMPLE_CL, SAMPLE_DOC } from "@megaui/engine/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET, POST } from "../../app/api/mega/[...segments]/route";
import { assertMegaFailureEnvelope, assertMegaSuccessEnvelope } from "../../lib/adapter/envelope";

const fixture = ownedContractFixture();
afterAll(() => fixture.close(), 120_000);

function megaUrl(path: string): string {
  return `http://127.0.0.1:3000/api/mega${path}`;
}

function canonicalOrigin(): string {
  return new URL(process.env.APP_BASE_URL ?? "http://127.0.0.1:3000").origin;
}

function authedRequest(path: string, cookie: string, init: RequestInit = {}): Request {
  return new Request(megaUrl(path), {
    ...init,
    headers: {
      Cookie: cookie,
      Origin: canonicalOrigin(),
      ...(init.headers ?? {}),
    },
  });
}

describe(
  "WA-04 mega content BFF contract",
  () => {
    let sessionCookieHeader: string;

    beforeAll(async () => {
      await fixture.start();

      sessionCookieHeader = await fixture.mint();
    }, 60_000);

    describe("docs domain", () => {
      it("publishes and retracts a document through authenticated BFF routes", async () => {
        const post = (segments: string[], input: unknown = {}) => POST(
          authedRequest(`/${segments.join("/")}`, sessionCookieHeader, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
          }), { params: Promise.resolve({ segments }) },
        );
        const created = await post(["docs"], { title: `Publication contract ${Date.now()}` });
        expect(created.status).toBe(200);
        const initial = await created.json();
        assertMegaSuccessEnvelope(initial);
        const id = (initial.data as { id: string }).id;
        for (const [action, status] of [["publish", "published"], ["publish", "published"], ["unpublish", "draft"]]) {
          const response = await post(["docs", id, action!]);
          expect(response.status).toBe(200);
          const result = await response.json();
          assertMegaSuccessEnvelope(result);
          expect(result.data).toMatchObject({ status, canEdit: true });
          expect((result.data as { versions: unknown[] }).versions).toHaveLength(2);
        }
        expect((await post(["docs", id, "meta"], { status: "invalid" })).status).toBe(400);
        const anonymous = await POST(
          new Request(megaUrl(`/docs/${id}/publish`), {
            method: "POST",
            headers: { Origin: canonicalOrigin() },
          }),
          { params: Promise.resolve({ segments: ["docs", id, "publish"] }) });
        expect(anonymous.status).toBe(401);
        expect((await post(["docs", "missing", "publish"])).status).toBe(404);
      });

      it.each(["blocks", "embed"])("rejects old UUID block targets at the %s resolution boundary", async (kind) => {
        const response = await GET(
          authedRequest(`/${kind}/resolve?doc=${SAMPLE_DOC.id}&block=573ddfe6-ee19-4015-89dd-558f7a5e44db`, sessionCookieHeader),
          { params: Promise.resolve({ segments: [kind, "resolve"] }) },
        );
        expect(response.status).toBe(400);
        const body: unknown = await response.json();
        assertMegaFailureEnvelope(body);
      });
      it("lists readable docs for the authenticated actor", async () => {
        const response = await GET(
          authedRequest("/docs", sessionCookieHeader),
          { params: Promise.resolve({ segments: ["docs"] }) },
        );
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        assertMegaSuccessEnvelope(body);
        expect(Array.isArray(body.data)).toBe(true);
      });

      it("returns a seeded workspace doc to another signed-in user", async () => {
        const response = await GET(
          authedRequest(`/docs/${SAMPLE_DOC.id}`, sessionCookieHeader),
          { params: Promise.resolve({ segments: ["docs", SAMPLE_DOC.id] }) },
        );
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        assertMegaSuccessEnvelope(body);
      });

      it("returns 404 for a missing document", async () => {
        const response = await GET(
          authedRequest("/docs/doc_does_not_exist", sessionCookieHeader),
          { params: Promise.resolve({ segments: ["docs", "doc_does_not_exist"] }) },
        );
        expect(response.status).toBe(404);
        const body: unknown = await response.json();
        assertMegaFailureEnvelope(body);
        expect(body.error.code).toBe(MEGA_ERROR_CODES.NOT_FOUND);
      });

      it("returns 400 for malformed create payloads", async () => {
        const response = await POST(
          authedRequest("/docs", sessionCookieHeader, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "   " }),
          }),
          { params: Promise.resolve({ segments: ["docs"] }) },
        );
        expect(response.status).toBe(400);
        const body: unknown = await response.json();
        assertMegaFailureEnvelope(body);
        expect(body.error.code).toBe(MEGA_ERROR_CODES.BAD_REQUEST);
      });

      it("resolve-or-create is idempotent for the same title", async () => {
        const title = `wa04-idempotent-${Date.now()}`;
        const first = await POST(
          authedRequest("/docs/resolve-or-create", sessionCookieHeader, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title }),
          }),
          { params: Promise.resolve({ segments: ["docs", "resolve-or-create"] }) },
        );
        expect(first.status).toBe(200);
        const firstBody: unknown = await first.json();
        assertMegaSuccessEnvelope(firstBody);
        const firstRecord = firstBody.data as { targetId: string; created: boolean };
        expect(firstRecord.created).toBe(true);

        const second = await POST(
          authedRequest("/docs/resolve-or-create", sessionCookieHeader, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title }),
          }),
          { params: Promise.resolve({ segments: ["docs", "resolve-or-create"] }) },
        );
        expect(second.status).toBe(200);
        const secondBody: unknown = await second.json();
        assertMegaSuccessEnvelope(secondBody);
        const secondRecord = secondBody.data as { targetId: string; created: boolean };
        expect(secondRecord.created).toBe(false);
        expect(secondRecord.targetId).toBe(firstRecord.targetId);
      });
    });

    describe("issues domain", () => {
      it("lists issues for the authenticated actor", async () => {
        const response = await GET(
          authedRequest("/issues", sessionCookieHeader),
          { params: Promise.resolve({ segments: ["issues"] }) },
        );
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        assertMegaSuccessEnvelope(body);
        expect(body.data).toMatchObject({ items: expect.any(Array) });
      });

      it("creates an issue on POST /issues", async () => {
        const response = await POST(
          authedRequest("/issues", sessionCookieHeader, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: "WA-04 contract issue",
              packageId: "pkg_engine",
              priority: "P2",
              body: "Repro",
            }),
          }),
          { params: Promise.resolve({ segments: ["issues"] }) },
        );
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        assertMegaSuccessEnvelope(body);
        expect(body.data).toMatchObject({
          title: "WA-04 contract issue",
          state: "open",
        });
      });

      it("returns 404 for a missing issue", async () => {
        const response = await GET(
          authedRequest("/issues/999999", sessionCookieHeader),
          { params: Promise.resolve({ segments: ["issues", "999999"] }) },
        );
        expect(response.status).toBe(404);
        const body: unknown = await response.json();
        assertMegaFailureEnvelope(body);
        expect(body.error.code).toBe(MEGA_ERROR_CODES.NOT_FOUND);
      });

      it("returns 400 for malformed create payloads", async () => {
        const response = await POST(
          authedRequest("/issues", sessionCookieHeader, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "x", packageId: "pkg", priority: "P9" }),
          }),
          { params: Promise.resolve({ segments: ["issues"] }) },
        );
        expect(response.status).toBe(400);
        const body: unknown = await response.json();
        assertMegaFailureEnvelope(body);
        expect(body.error.code).toBe(MEGA_ERROR_CODES.BAD_REQUEST);
      });

      it("denies non-member actors at the engine boundary (403 contract)", async () => {
        const client = createDatabaseClient({
          connectionString: process.env.DATABASE_URL!,
        });
        try {
          const issues = createIssuesService(client.db);
          await expect(
            issues.createIssue(
              { title: "Ghost", packageId: "pkg_engine", priority: "P2" },
              "usr_does_not_exist",
            ),
          ).rejects.toMatchObject({ code: MEGA_ERROR_CODES.FORBIDDEN });
        } finally {
          await client.close();
        }
      });

      it("toggleIssueWatch toggles membership without duplicating watcher ids", async () => {
        const createResponse = await POST(
          authedRequest("/issues", sessionCookieHeader, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: "Watch idempotency probe",
              packageId: "pkg_engine",
              priority: "P3",
            }),
          }),
          { params: Promise.resolve({ segments: ["issues"] }) },
        );
        const createBody: unknown = await createResponse.json();
        assertMegaSuccessEnvelope(createBody);
        const number = (createBody.data as { number: number; watcherIds: string[] }).number;
        const initialWatchers = (createBody.data as { watcherIds: string[] }).watcherIds;

        await POST(
          authedRequest(`/issues/${number}/watch`, sessionCookieHeader, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          }),
          { params: Promise.resolve({ segments: ["issues", String(number), "watch"] }) },
        );
        const afterToggle = await GET(
          authedRequest(`/issues/${number}`, sessionCookieHeader),
          { params: Promise.resolve({ segments: ["issues", String(number)] }) },
        );
        const toggleBody: unknown = await afterToggle.json();
        assertMegaSuccessEnvelope(toggleBody);
        const toggledWatchers = (toggleBody.data as { watcherIds: string[] }).watcherIds;
        expect(toggledWatchers.length).toBeLessThanOrEqual(initialWatchers.length + 1);

        await POST(
          authedRequest(`/issues/${number}/watch`, sessionCookieHeader, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          }),
          { params: Promise.resolve({ segments: ["issues", String(number), "watch"] }) },
        );
        const afterSecondToggle = await GET(
          authedRequest(`/issues/${number}`, sessionCookieHeader),
          { params: Promise.resolve({ segments: ["issues", String(number)] }) },
        );
        const secondBody: unknown = await afterSecondToggle.json();
        assertMegaSuccessEnvelope(secondBody);
        expect((secondBody.data as { watcherIds: string[] }).watcherIds).toEqual(
          initialWatchers,
        );
      });
    });

    describe("cls domain", () => {
      it("resolves the seeded CL and its comments through both the legacy and public links", async () => {
        const response = await GET(
          authedRequest(`/cls/${SAMPLE_CL.number}`, sessionCookieHeader),
          { params: Promise.resolve({ segments: ["cls", String(SAMPLE_CL.number)] }) },
        );
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        assertMegaSuccessEnvelope(body);
        expect(body.data).toMatchObject({ number: SAMPLE_CL.number });
        const { publicId } = body.data as { publicId: string };
        expect(isBlockId(publicId)).toBe(true);

        for (const tail of [[], ["comments"]]) {
          const read = (ref: string) => {
            const segments = ["cls", ref, ...tail];
            return GET(authedRequest(`/${segments.join("/")}`, sessionCookieHeader), {
              params: Promise.resolve({ segments }),
            });
          };
          const byPublicId = await read(publicId);
          const byNumber = await read(String(SAMPLE_CL.number));
          expect(byPublicId.status).toBe(200);
          expect(await byPublicId.json()).toEqual(await byNumber.json());
        }
      });

      it("returns 403 when a non-author mutates CL state", async () => {
        const response = await POST(
          authedRequest(`/cls/${SAMPLE_CL.publicId}/transition`, sessionCookieHeader, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ state: "wip" }),
          }),
          { params: Promise.resolve({
            segments: ["cls", SAMPLE_CL.publicId, "transition"],
          }) },
        );
        expect(response.status).toBe(403);
        const body: unknown = await response.json();
        assertMegaFailureEnvelope(body);
        expect(body.error.code).toBe(MEGA_ERROR_CODES.FORBIDDEN);
      });

      it.each(["999999", "missingCL123"])("returns 404 for an unknown CL reference %s", async (ref) => {
        const response = await GET(
          authedRequest(`/cls/${ref}`, sessionCookieHeader),
          { params: Promise.resolve({ segments: ["cls", ref] }) },
        );
        expect(response.status).toBe(404);
        const body: unknown = await response.json();
        assertMegaFailureEnvelope(body);
        expect(body.error.code).toBe(MEGA_ERROR_CODES.NOT_FOUND);
      });

      it("requires a signed-in actor before looking up a public ID", async () => {
        const ref = SAMPLE_CL.publicId;
        const response = await GET(new Request(megaUrl(`/cls/${ref}`)), {
          params: Promise.resolve({ segments: ["cls", ref] }),
        });
        expect(response.status).toBe(401);
      });

      it("GET cls/[n]/commits returns empty array when link is unset (WA-09)", async () => {
        const response = await GET(
          authedRequest(`/cls/${SAMPLE_CL.number}/commits`, sessionCookieHeader),
          {
            params: Promise.resolve({
              segments: ["cls", String(SAMPLE_CL.number), "commits"],
            }),
          },
        );
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        assertMegaSuccessEnvelope(body);
        expect(body.data).toEqual([]);
      });

      it("GET cls/[n]/commits returns 404 for a missing CL (WA-09)", async () => {
        const response = await GET(
          authedRequest("/cls/999999/commits", sessionCookieHeader),
          { params: Promise.resolve({ segments: ["cls", "999999", "commits"] }) },
        );
        expect(response.status).toBe(404);
        const body: unknown = await response.json();
        assertMegaFailureEnvelope(body);
      });

      it("returns 400 for malformed inline-comment payloads", async () => {
        const response = await POST(
          authedRequest(`/cls/${SAMPLE_CL.number}/inline-comments`, sessionCookieHeader, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filePath: "a.ts", line: 0, body: "   " }),
          }),
          { params: Promise.resolve({
            segments: ["cls", String(SAMPLE_CL.number), "inline-comments"],
          }) },
        );
        expect(response.status).toBe(400);
        const body: unknown = await response.json();
        assertMegaFailureEnvelope(body);
        expect(body.error.code).toBe(MEGA_ERROR_CODES.BAD_REQUEST);
      });

      it("exposes CL checks inline (EG-06)", async () => {
        const response = await GET(
          authedRequest(`/cls/${SAMPLE_CL.number}/checks`, sessionCookieHeader),
          { params: Promise.resolve({
            segments: ["cls", String(SAMPLE_CL.number), "checks"],
          }) },
        );
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        assertMegaSuccessEnvelope(body);
        expect(body.data).toMatchObject({ checks: expect.any(Array) });
      });

      it("toggleCLSubscription does not leave duplicate subscription rows", async () => {
        const created = await POST(
          authedRequest("/cls", sessionCookieHeader, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: "WA-04 CL subscribe probe",
              packageId: "pkg_engine",
              branch: "wa04-probe",
            }),
          }),
          { params: Promise.resolve({ segments: ["cls"] }) },
        );
        const createBody: unknown = await created.json();
        assertMegaSuccessEnvelope(createBody);
        const { publicId, subscribed: initialSubscribed } = createBody.data as {
          publicId: string; subscribed: boolean;
        };
        expect(isBlockId(publicId)).toBe(true);

        const first = await POST(
          authedRequest(`/cls/${publicId}/subscribe`, sessionCookieHeader, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          }),
          { params: Promise.resolve({ segments: ["cls", publicId, "subscribe"] }) },
        );
        expect(first.status).toBe(200);

        const second = await POST(
          authedRequest(`/cls/${publicId}/subscribe`, sessionCookieHeader, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          }),
          { params: Promise.resolve({ segments: ["cls", publicId, "subscribe"] }) },
        );
        expect(second.status).toBe(200);
        const toggled: unknown = await second.json();
        assertMegaSuccessEnvelope(toggled);
        expect((toggled.data as { subscribed: boolean }).subscribed).toBe(
          initialSubscribed,
        );
      });
    });
  },
);
