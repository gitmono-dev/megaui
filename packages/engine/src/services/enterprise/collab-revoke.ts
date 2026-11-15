// megaui-only (FS-17): idempotent per-user collaboration connection revoke call.
const REVOKE_PATH = "/internal/revoke";
const DEFAULT_TIMEOUT_MS = 3_000;

export interface CollabRevokeTarget {
  readonly url: string;
  readonly token: string;
}

export interface CollabRevokeServiceOptions {
  readonly targets: readonly CollabRevokeTarget[];
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface CollabRevokeResult {
  readonly delivered: number;
  readonly closed: number;
}

export class CollabRevokeError extends Error {
  readonly code = "COLLAB_REVOKE_UNAVAILABLE" as const;

  constructor(message = "Collab revocation delivery failed") {
    super(message);
    this.name = "CollabRevokeError";
  }
}

function baseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error();
    }
    return url.toString().replace(/\/$/u, "");
  } catch {
    throw new CollabRevokeError("Invalid collab revoke target");
  }
}

function validToken(value: string): boolean {
  return typeof value === "string" && value.trim() !== "" && value.length <= 4096 &&
    ![...value].some(character => (character.codePointAt(0) ?? 0) <= 0x1f || character === "\u007f");
}

function parseResponse(value: unknown): number {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CollabRevokeError();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || record.data === null || typeof record.data !== "object" || Array.isArray(record.data)) {
    throw new CollabRevokeError();
  }
  const data = record.data as Record<string, unknown>;
  if (Object.keys(data).sort().join(",") !== "closed,revoked" || data.revoked !== true ||
    !Number.isSafeInteger(data.closed) || (data.closed as number) < 0) throw new CollabRevokeError();
  return data.closed as number;
}

export function createEnterpriseCollabRevokeService(options: CollabRevokeServiceOptions) {
  if (options.targets.length < 1 || options.targets.length > 64) throw new CollabRevokeError("Invalid collab revoke targets");
  const targets = options.targets.map(target => {
    if (!validToken(target.token)) throw new CollabRevokeError("Invalid collab revoke credential");
    return Object.freeze({ url: baseUrl(target.url), token: target.token });
  });
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new CollabRevokeError("Invalid collab revoke timeout");
  }

  const revokeUser = async (userId: string, authEpoch: number): Promise<CollabRevokeResult> => {
    if (!userId.trim() || userId.length > 256 || !Number.isSafeInteger(authEpoch) || authEpoch < 0) {
      throw new CollabRevokeError("Invalid collab revocation");
    }
    const deliveries = await Promise.all(targets.map(async target => {
      let response: Response;
      try {
        response = await fetchImpl(`${target.url}${REVOKE_PATH}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${target.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ userId, authEpoch }),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "error",
        });
      } catch {
        throw new CollabRevokeError();
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        throw new CollabRevokeError();
      }
      try {
        const text = await response.text();
        if (text.length > 4096) throw new Error();
        return parseResponse(JSON.parse(text) as unknown);
      } catch (error) {
        if (error instanceof CollabRevokeError) throw error;
        throw new CollabRevokeError();
      }
    }));
    return { delivered: deliveries.length, closed: deliveries.reduce((sum, value) => sum + value, 0) };
  };

  return Object.freeze({ revokeUser });
}

export type EnterpriseCollabRevokeService = ReturnType<typeof createEnterpriseCollabRevokeService>;
