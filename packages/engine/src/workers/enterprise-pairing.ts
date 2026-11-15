// megaui-only (FS-11): native client ownership for the two independent worker lanes.
import { Client, Pool, type ClientConfig } from "pg";
import { workerConnectionConfig, workerDeadline } from "./enterprise-config";

interface NativeRecord {
  readonly client: Client;
  readonly ended: Promise<void>;
  pid?: number;
  connected?: boolean;
}

export interface OwnedWorkerDatabase {
  readonly pool: Pool;
  readonly cancelBackend: (pid: number) => Promise<void>;
  readonly close: () => Promise<void>;
}

const owners = new WeakMap<Pool, OwnedWorkerDatabase>();
const transferred = new WeakSet<Pool>();

/** An arbitrary previously used Pool cannot provide complete dial/socket ownership evidence. */
export function takeWorkerDatabase(pool: Pool): OwnedWorkerDatabase {
  const owner = owners.get(pool);
  if (!owner || transferred.has(pool)) throw new Error("INVALID_ENTERPRISE_WORKER_CONFIG");
  transferred.add(pool); return owner;
}

export function createOwnedWorkerDatabase(connectionString: string, kind: "ordinary" | "cleanup" = "ordinary"): OwnedWorkerDatabase {
  const config = workerConnectionConfig(connectionString, kind);
  const controlConfig = workerConnectionConfig(connectionString, "control");
  const records = new Set<NativeRecord>();
  // Socket EOF is not PostgreSQL cancellation evidence: retain each backend responsibility.
  const retired = new Map<number, NativeRecord>();
  const controls = new Set<Promise<void>>();
  let closing = false; let closePromise: Promise<void> | undefined;
  let retirement: Promise<void> | undefined; let backgroundFailed = false;
  class OwnedClient extends Client {
    constructor(input?: string | ClientConfig) {
      super(input);
      let finish!: () => void;
      const record: NativeRecord = { client: this, ended: new Promise(resolve => { finish = resolve; }) };
      records.add(record);
      // Observe the native protocol's non-secret PID; never retain or report its cancel key.
      this.connection.on("backendKeyData", (message: { processID?: unknown }) => {
        if (Number.isInteger(message.processID) && Number(message.processID) > 0) record.pid = Number(message.processID);
      });
      this.once("end", () => {
        records.delete(record);
        if (record.pid !== undefined) retired.set(record.pid, record);
        finish();
        queueMicrotask(() => {
          if (retired.size > 32) {
            backgroundFailed = true; void owner.close().catch(() => undefined);
          } else verifyRetired();
        });
      });
      this.on("error", () => { /* The operation reports only its stable failure key. */ });
      this.once("connect", () => {
        record.connected = true;
        if (closing) { void this.end().catch(() => undefined); this.connection.stream.destroy(); }
      });
    }
  }
  const pool = new Pool({ ...config, Client: OwnedClient, max: kind === "cleanup" ? 1 : 10, idleTimeoutMillis: 10_000 });
  pool.on("error", () => { /* The owner/operation retains responsibility for the client end. */ });

  function cancel(pids: readonly number[]): Promise<void> {
    const ids = [...new Set(pids)].filter(pid => Number.isInteger(pid) && pid > 0);
    if (ids.length === 0) return Promise.resolve();
    const control = new Client(controlConfig);
    control.on("error", () => {});
    let socketEnded = false; let finish!: () => void;
    const ended = new Promise<void>(resolve => { finish = resolve; });
    control.once("end", () => { socketEnded = true; finish(); });
    const work = (async () => {
      try {
        await control.connect();
        const result = await control.query<{ pid: number; cancelled: boolean }>(`select pid,pg_cancel_backend(pid) as cancelled
          from pg_stat_activity where pid=any($1::int[]) and usename=current_user and application_name=$2`, [ids, config.application_name]);
        if (result.rows.some(row => typeof row.cancelled !== "boolean")) throw new Error("ENTERPRISE_WORKER_CANCEL_FAILED");
        for (let attempt = 0; ; attempt += 1) {
          const remaining = await control.query<{ count: number }>(`select count(*)::int as count from pg_stat_activity
            where pid=any($1::int[]) and usename=current_user and application_name=$2`, [ids, config.application_name]);
          if (remaining.rows[0]?.count === 0) break;
          if (attempt >= 10) throw new Error("ENTERPRISE_WORKER_CANCEL_FAILED");
          await new Promise(resolveWait => setTimeout(resolveWait, 20));
        }
      } finally {
        const closingControl = control.end(); control.connection.stream.destroy(); await closingControl;
        if (!socketEnded) await ended;
      }
    })();
    const bounded = workerDeadline(work, 2000).catch(async () => {
      const closingControl = control.end(); control.connection.stream.destroy(); await closingControl;
      throw new Error("ENTERPRISE_WORKER_CANCEL_FAILED");
    });
    controls.add(bounded);
    void bounded.finally(() => controls.delete(bounded)).catch(() => undefined);
    return bounded;
  }

  function forgetVerified(snapshot: ReadonlyMap<number, NativeRecord>): void {
    for (const [pid, record] of snapshot) if (retired.get(pid) === record) retired.delete(pid);
  }
  function verifyRetired(): void {
    if (closing || retirement || retired.size === 0) return;
    const work = (async () => {
      while (!closing && retired.size > 0) {
        const snapshot = new Map(retired);
        await cancel([...snapshot.keys()]); forgetVerified(snapshot);
      }
    })();
    retirement = work;
    void work.catch(() => {
      backgroundFailed = true; void owner.close().catch(() => undefined);
    });
    void work.finally(() => {
      if (retirement === work) retirement = undefined;
      if (!closing) verifyRetired();
    }).catch(() => undefined);
  }

  const owner: OwnedWorkerDatabase = {
    pool, cancelBackend: pid => cancel([pid]),
    close() {
      if (closePromise) return closePromise;
      closing = true;
      // Pool.end seals acquisition immediately; it is only one of the close receipts.
      const poolEnd = pool.end();
      const native = [...records];
      const backends = new Map(retired);
      for (const record of native) if (record.pid !== undefined) backends.set(record.pid, record);
      const cancellation = cancel([...backends.keys()]).then(() => forgetVerified(backends));
      // Client.end seals later query calls and closes active native sockets. A queued borrower
      // still releases its own checkout in its finally; do not invoke release twice here.
      const ends = native.map(record => {
        // During handshake Client.end suppresses pg's connect callback, leaving Pool.end
        // and the borrower pending forever. A native disconnect must reject acquisition.
        const ending = record.connected ? record.client.end() : record.ended;
        record.client.connection.stream.destroy(); return ending;
      });
      const work = Promise.allSettled([poolEnd, cancellation, retirement, ...ends, ...native.map(record => record.ended), ...controls])
        .then(async results => {
          // A handshake can deliver its PID after the first snapshot. Its native end above
          // is now known, and every still-unverified backend must also disappear.
          const late = new Map(retired);
          await cancel([...late.keys()]); forgetVerified(late);
          if (backgroundFailed || results.some(result => result.status === "rejected") || records.size !== 0 || retired.size !== 0) {
            throw new Error("ENTERPRISE_WORKER_SHUTDOWN_FAILED");
          }
        });
      closePromise = workerDeadline(work, 9000);
      return closePromise;
    },
  };
  owners.set(pool, owner);
  return owner;
}
