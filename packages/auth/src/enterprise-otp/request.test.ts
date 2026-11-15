// megaui-only (FS-11): auth owns alias/flow admission; the injected port owns persistence.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createEnterprisePairingRequest } from "./request";
import type { EnterprisePairingPort } from "./types";

const rawFlow = Buffer.alloc(32, 17).toString("base64url");
const token = Buffer.alloc(32, 29).toString("base64url");
const transport = { peerAddress: "192.0.2.1" };
const accepted = () => ({ kind: "accepted" as const, status: 202 as const,
  body: { pairingId: "0322af72-124b-4e48-aabd-88b58241e51e", pairingToken: token,
    expiresIn: 120 as const, resendAfter: 60 as const } });

describe("enterprise pairing request boundary (FS-11)", () => {
  it("binds the exact existing flow and returns only the committed DTO and host cookie", async () => {
    const port = vi.fn<EnterprisePairingPort>(async () => ({ ...accepted(), internalIdentity: "must-not-leak" }));
    const request = createEnterprisePairingRequest(port);
    const result = await request({ alias: "alice.smith", flow: rawFlow, transport });
    expect(port).toHaveBeenCalledExactlyOnceWith({ loginName: "alice.smith", transport,
      flowHash: createHash("sha256").update(rawFlow, "utf8").digest("hex") });
    expect(result).toEqual({ ...accepted(), cookie: { name: "__Host-megaui.enterprise-flow",
      value: rawFlow, path: "/", httpOnly: true, secure: true, sameSite: "lax", maxAge: 600 } });
  });

  it("creates independent canonical 32-byte flows when none is supplied", async () => {
    const port = vi.fn<EnterprisePairingPort>(async () => accepted());
    const request = createEnterprisePairingRequest(port);
    const first = await request({ alias: "alice", transport });
    const second = await request({ alias: "alice", transport });
    expect(first.kind).toBe("accepted"); expect(second.kind).toBe("accepted");
    if (first.kind !== "accepted" || second.kind !== "accepted") throw Error("expected accepted");
    expect(first.cookie.value).not.toBe(second.cookie.value);
    for (const [index, result] of [first, second].entries()) {
      expect(result.cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(result.cookie.value, "base64url")).toHaveLength(32);
      expect(port.mock.calls[index]?.[0]).toEqual({ loginName: "alice", transport,
        flowHash: createHash("sha256").update(result.cookie.value).digest("hex") });
    }
  });

  it.each([null, 1, {}, "", "ab", "Alice", " alice", "alice ", "alice\n", "a".repeat(65), "álîce", "alice@example.com"])(
    "rejects invalid alias %s without entering the persistence port", async alias => {
      const port = vi.fn(async () => accepted());
      expect(await createEnterprisePairingRequest(port)({ alias, flow: rawFlow, transport })).toEqual({ kind: "invalid-input" });
      expect(port).not.toHaveBeenCalled();
    });

  it.each([null, 1, {}, "", "A".repeat(42), "A".repeat(44), "A".repeat(42) + "B", rawFlow + "=", rawFlow + "\n", "+".repeat(43)])(
    "rejects invalid or noncanonical existing flow %s before the port", async flow => {
      const port = vi.fn(async () => accepted());
      expect(await createEnterprisePairingRequest(port)({ alias: "alice", flow, transport })).toEqual({ kind: "invalid-input" });
      expect(port).not.toHaveBeenCalled();
    });

  it("keeps a valid alias verbatim and does not expose persistence fields", async () => {
    const port = vi.fn<EnterprisePairingPort>(async () => accepted());
    expect((await createEnterprisePairingRequest(port)({ alias: "a.b_c-9", flow: rawFlow, transport })).kind).toBe("accepted");
    expect(port.mock.calls[0]?.[0]).toMatchObject({ loginName: "a.b_c-9" });
  });

  it("returns no cookie or success body for budget refusal, unavailability or a thrown failure", async () => {
    const port = vi.fn().mockResolvedValueOnce({ kind: "rate-limited", status: 429, code: "RATE_LIMITED" })
      .mockResolvedValueOnce({ kind: "unavailable" }).mockRejectedValueOnce(Error("private database detail"));
    const request = createEnterprisePairingRequest(port);
    expect(await request({ alias: "alice", flow: rawFlow, transport })).toEqual({ kind: "rate-limited", status: 429, code: "RATE_LIMITED" });
    expect(await request({ alias: "alice", flow: rawFlow, transport })).toEqual({ kind: "unavailable" });
    expect(await request({ alias: "alice", flow: rawFlow, transport })).toEqual({ kind: "unavailable" });
  });

  it("does not issue a cookie before the port confirms its commit", async () => {
    let resolvePort!: (value: ReturnType<typeof accepted>) => void;
    const committed = new Promise<ReturnType<typeof accepted>>(resolve => { resolvePort = resolve; });
    let settled = false;
    const result = createEnterprisePairingRequest(() => committed)({ alias: "alice", transport })
      .then(value => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolvePort(accepted());
    expect((await result).kind).toBe("accepted");
  });

  it.each([undefined, {}, { kind: "accepted" }, { ...accepted(), body: { ...accepted().body, pairingToken: "bad" } }])(
    "fails closed on a malformed trusted port result", async value => {
      const port = vi.fn().mockResolvedValue(value);
      expect(await createEnterprisePairingRequest(port)({ alias: "alice", transport })).toEqual({ kind: "unavailable" });
    });
});
