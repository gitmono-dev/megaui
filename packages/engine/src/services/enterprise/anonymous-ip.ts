// megaui-only (FS-74): approved peer resolution and daily anonymous IP pseudonyms.
import { createHmac } from "node:crypto";
import { BlockList, isIP, SocketAddress } from "node:net";
import type { AnonymousTransport } from "./anonymous-budget-types";

interface CanonicalIp { address: string; family: "ipv4" | "ipv6" }

/** Reject zone identifiers before SocketAddress silently removes them. */
export function canonicalAnonymousIp(value: unknown): CanonicalIp | null {
  if (typeof value !== "string" || value.length > 45 || /[^\x21-\x7e]|[%[\]]/.test(value)) return null;
  const version = isIP(value);
  if (!version) return null;
  try {
    const family = version === 4 ? "ipv4" : "ipv6";
    const address = new SocketAddress({ address: value, family }).address;
    if (family === "ipv6" && address.startsWith("::ffff:") && isIP(address.slice(7)) === 4) {
      return { address: address.slice(7), family: "ipv4" };
    }
    return { address, family };
  } catch { return null; }
}

/** Separate families: Node's IPv6 ::/0 BlockList otherwise also trusts IPv4. */
export function createAnonymousIpResolver(cidrs: readonly string[]): (transport: AnonymousTransport) => string | null {
  if (!Array.isArray(cidrs) || cidrs.length > 64) throw new Error("INVALID_ANONYMOUS_BUDGET_CONFIG");
  const lists = { ipv4: new BlockList(), ipv6: new BlockList() };
  for (const entry of cidrs) {
    if (typeof entry !== "string") throw new Error("INVALID_ANONYMOUS_BUDGET_CONFIG");
    const parts = entry.split("/");
    const ip = canonicalAnonymousIp(parts[0]);
    if (parts.length !== 2 || !ip || !/^(?:0|[1-9][0-9]{0,2})$/.test(parts[1] ?? "")) {
      throw new Error("INVALID_ANONYMOUS_BUDGET_CONFIG");
    }
    let prefix = Number(parts[1]);
    if (isIP(parts[0]!) === 6 && ip.family === "ipv4") {
      if (prefix < 96 || prefix > 128) throw new Error("INVALID_ANONYMOUS_BUDGET_CONFIG");
      prefix -= 96;
    }
    if (prefix > (ip.family === "ipv4" ? 32 : 128)) throw new Error("INVALID_ANONYMOUS_BUDGET_CONFIG");
    lists[ip.family].addSubnet(ip.address, prefix, ip.family);
  }
  const trusted = (ip: CanonicalIp) => lists[ip.family].check(ip.address, ip.family);
  return (transport) => {
    if (!transport || typeof transport !== "object" || Array.isArray(transport)) return null;
    const peer = canonicalAnonymousIp(transport.peerAddress);
    if (!peer) return null;
    // Do not even consult a forwarding header supplied by an unapproved peer.
    if (!trusted(peer)) return peer.address;
    const raw = transport.forwardedFor;
    if (raw === undefined) return peer.address;
    if (typeof raw !== "string" || raw.length > 2048 || /[^\x20-\x7e\t]/.test(raw)) return null;
    const parts = raw.split(",");
    if (parts.length > 16) return null;
    const chain = parts.map(part => canonicalAnonymousIp(part.replace(/^[ \t]+|[ \t]+$/g, "")));
    if (chain.some(ip => ip === null)) return null;
    for (let index = chain.length - 1; index >= 0; index--) {
      const ip = chain[index]!;
      if (ip && (!trusted(ip) || index === 0)) return ip.address;
    }
    return null;
  };
}

/** Explicit T is internal so real-PG tests can exercise an actual midnight boundary. */
export function anonymousIpSubjects(master: Uint8Array, scope: string, role: string, ip: string, nowMs: number): readonly [string, string] {
  const subject = (at: number): string => {
    const day = new Date(at).toISOString().slice(0, 10);
    const dayKey = createHmac("sha256", master)
      .update(JSON.stringify(["megaui:anonymous-ip:day:v1", scope, role, day]), "utf8").digest();
    return createHmac("sha256", dayKey)
      .update(JSON.stringify(["megaui:anonymous-ip:subject:v1", ip]), "utf8").digest("hex");
  };
  return [subject(nowMs), subject(nowMs - 86_400_000)];
}
