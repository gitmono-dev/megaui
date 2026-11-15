import { describe, expect, it } from "vitest";
import {
  isMegaError,
  MegaBadRequestError,
  MegaInternalError,
  MegaUnauthorizedError,
} from "../../errors";
import { COLLAB_TICKET_PREFIX_V2 } from "@megaui/core/collab/ticket";
import { COLLAB_TICKET_PREFIX_V3, COLLAB_TICKET_V3_MAX_TTL_MS, verifyCollabTicket } from "@megaui/core/collab/ticket";
import { createCollabTokenService } from "./token";

const SECRET = "test-collab-secret-do-not-use-in-prod";
const SESSION = { userId: "usr_1", username: "alex" };

describe("createCollabTokenService (EG-13)", () => {
  it("mints a token bound to the session userId and verifies it back", () => {
    const service = createCollabTokenService({ secret: SECRET, nowMs: 1000 });
    const minted = service.mintForSession(SESSION);
    expect(minted.userId).toBe("usr_1");
    expect(minted.expiresAtMs).toBeGreaterThan(1000);
    expect(service.verify(minted.token, { nowMs: 1000 })).toBe("usr_1");
  });

  it("rejects minting without a valid session (fail closed)", () => {
    const service = createCollabTokenService({ secret: SECRET });
    expect(() => service.mintForSession(null)).toThrow(MegaUnauthorizedError);
    expect(() => service.mintForSession({ userId: "usr_1" })).toThrow(
      MegaUnauthorizedError,
    );
    expect(() => service.mintForSession({ username: "alex" })).toThrow(
      MegaUnauthorizedError,
    );
  });

  it("rejects minting when the collab secret is not configured, without leaking a value", () => {
    const service = createCollabTokenService({ env: {} });
    try {
      service.mintForSession(SESSION);
      expect.unreachable("mintForSession should have thrown");
    } catch (error) {
      expect(isMegaError(error)).toBe(true);
      expect(error).toBeInstanceOf(MegaInternalError);
      expect((error as Error).message).toMatch(/MEGA_COLLAB_INTERNAL_TOKEN/);
      expect((error as Error).message).not.toContain(SECRET);
    }
  });

  it("verify fails closed (returns null, does not throw) when unconfigured", () => {
    const service = createCollabTokenService({ env: {} });
    expect(service.verify("anything")).toBeNull();
  });

  it("prefers an explicit secret over the env fallback", () => {
    const service = createCollabTokenService({
      secret: SECRET,
      env: { MEGA_COLLAB_INTERNAL_TOKEN: "wrong-env-secret" },
      nowMs: 0,
    });
    const minted = service.mintForSession(SESSION);
    expect(service.verify(minted.token, { nowMs: 0 })).toBe("usr_1");
  });

  it("falls back to MEGA_COLLAB_INTERNAL_TOKEN from the injected env", () => {
    const service = createCollabTokenService({
      env: { MEGA_COLLAB_INTERNAL_TOKEN: SECRET },
      nowMs: 0,
    });
    const minted = service.mintForSession(SESSION);
    expect(service.verify(minted.token, { nowMs: 0 })).toBe("usr_1");
  });

  it("reports isConfigured() based on secret resolution", () => {
    expect(createCollabTokenService({ secret: SECRET }).isConfigured()).toBe(true);
    expect(
      createCollabTokenService({
        env: { MEGA_COLLAB_INTERNAL_TOKEN: SECRET },
      }).isConfigured(),
    ).toBe(true);
    expect(createCollabTokenService({ env: {} }).isConfigured()).toBe(false);
  });

  describe("mint/verify/expire matrix (EG-13 AC1)", () => {
    it("accepts a fresh token and an unexpired token, rejects one past its TTL", () => {
      const service = createCollabTokenService({
        secret: SECRET,
        ttlMs: 1000,
        nowMs: 0,
      });
      const minted = service.mintForSession(SESSION);
      expect(minted.expiresAtMs).toBe(1000);
      expect(service.verify(minted.token, { nowMs: 0 })).toBe("usr_1");
      expect(service.verify(minted.token, { nowMs: 1000 })).toBe("usr_1");
      expect(service.verify(minted.token, { nowMs: 1001 })).toBeNull();
    });

    it("tolerates clock skew between the minting and verifying process clocks", () => {
      // Minted at nowMs=10_000 with a 60s TTL (absolute expiry = 70_000).
      // Verification carries its own explicit nowMs — a verifier whose clock
      // reads behind (5_000) or just under expiry (69_999) still accepts the
      // token because expiry is an absolute timestamp in the signed body,
      // not a delta recomputed against the verifier's own clock.
      const service = createCollabTokenService({
        secret: SECRET,
        nowMs: 10_000,
        ttlMs: 60_000,
      });
      const minted = service.mintForSession(SESSION);
      expect(minted.expiresAtMs).toBe(70_000);
      expect(service.verify(minted.token, { nowMs: 5_000 })).toBe("usr_1");
      expect(service.verify(minted.token, { nowMs: 69_999 })).toBe("usr_1");
      expect(service.verify(minted.token, { nowMs: 70_001 })).toBeNull();
    });

    it("mints a v2 ticket for a channel room and rejects illegal rooms", () => {
      const service = createCollabTokenService({ secret: SECRET, nowMs: 1000 });
      const minted = service.mintForSession(SESSION, {
        roomName: "collection:channel:chn_general",
      });
      expect(minted.token.startsWith(COLLAB_TICKET_PREFIX_V2)).toBe(true);
      expect(service.verify(minted.token, { nowMs: 1000 })).toBe("usr_1");
      expect(() =>
        service.mintForSession(SESSION, { roomName: "collection:inbox:usr_1" }),
      ).toThrow(MegaBadRequestError);
      expect(() =>
        service.mintForSession(SESSION, { roomName: "container:doc:doc-1" }),
      ).toThrow(MegaBadRequestError);
    });

    it("rejects a forged signature and a token verified with the wrong secret", () => {
      const service = createCollabTokenService({ secret: SECRET, nowMs: 0 });
      const other = createCollabTokenService({ secret: "different-secret", nowMs: 0 });
      const minted = service.mintForSession(SESSION);
      const tampered = `${minted.token.slice(0, -1)}${minted.token.endsWith("A") ? "B" : "A"}`;
      expect(service.verify(tampered, { nowMs: 0 })).toBeNull();
      expect(other.verify(minted.token, { nowMs: 0 })).toBeNull();
    });
  });

  it("mints an enterprise v3 ticket from explicit server metadata and caps its TTL", () => {
    const service = createCollabTokenService({ secret: SECRET, nowMs: 0, ttlMs: 60 * 60_000 });
    const minted = service.mintForSession(SESSION, {
      enterprise: { identityId: "identity-1", authEpoch: 4 },
    });
    expect(minted.token.startsWith(COLLAB_TICKET_PREFIX_V3)).toBe(true);
    expect(minted.expiresAtMs).toBe(COLLAB_TICKET_V3_MAX_TTL_MS);
    expect(verifyCollabTicket(minted.token, SECRET, { nowMs: 0 })).toMatchObject({
      userId: "usr_1",
      identityId: "identity-1",
      authEpoch: 4,
    });
  });
});
