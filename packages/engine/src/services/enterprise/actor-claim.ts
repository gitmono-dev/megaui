// megaui-only (FS-71): local actor claims have no upstream writer.
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  beginActorClaimBatch, lockActorClaimScope, lockActorInventoryInputs, readCreatedActorBindings,
  insertClaimedActorReservations, updateActorInventoryLocalDigests,
  type StoredActorReservation, type StoredActorInventory,
} from "@megaui/database";
import { canonicalizeJson } from "../../cli/admin-payload";
import { createEnterpriseEligibilityService, type EnterpriseEligibilityServiceOptions } from "./eligibility";
import {
  actorInventoryDigests, deriveHistoricalActor, inspectActorReservationCoverage, readActorInventoryState,
} from "./actor-reservations";

export interface ActorClaimRequest {
  readonly localUserId: string;
  readonly openId: string;
  readonly loginName: string;
}
export interface NewActorSubject extends ActorClaimRequest {
  readonly tenantKey: string;
  readonly appId: string;
  readonly backendUsername: string;
}
export interface ActorClaimResult {
  localUserId: string;
  identityId: string;
  backendUsername: string;
}
export interface ExistingActorOwner {
  localUserId: string;
  backendUsername: string;
  quarantined: boolean;
}
export type ActorClaimRejection = "INVALID_ACTOR_CLAIM" | "ENTERPRISE_ACTIVATION_REQUIRED" |
  "DIRECTORY_ADMISSION_REJECTED" | "ACTOR_INVENTORY_REJECTED" | "ACTOR_CLAIM_REJECTED" | "ACTOR_CREATION_MISMATCH" |
  "ACTOR_CLAIM_TRANSACTION_REJECTED";

/** Stable internal error keys, with no member or actor values in the message. */
export class ActorClaimRejected extends Error {
  constructor(readonly key: ActorClaimRejection) { super(key); this.name = "ActorClaimRejected"; }
}

function validText(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) return false;
  try { canonicalizeJson(value); return true; } catch { return false; }
}
function inventoryKey(inventory: StoredActorInventory): string {
  return canonicalizeJson({ ...inventory, observedAt: inventory.observedAt.toISOString() });
}

/**
 * Only trusted bootstrap supplies authority and the creation port. FS-05 will
 * supply the approved account writer; each request carries no replaceable authority.
 * The caller retains its FS-81 transaction through operation-ledger completion.
 */
export function createActorClaimService(options: {
  eligibility: EnterpriseEligibilityServiceOptions;
  createSubject: (client: PoolClient, input: NewActorSubject) => Promise<void>;
}) {
  const eligibility = createEnterpriseEligibilityService(options.eligibility);
  const scope = options.eligibility.policyScope.trim();
  const tenantKey = options.eligibility.directoryScope.tenantKey.trim();
  const appId = options.eligibility.directoryScope.appId.trim();
  const now = options.eligibility.now ?? (() => new Date());
  const createSubject = options.createSubject;

  async function provisionBatch(client: PoolClient, requests: readonly ActorClaimRequest[]): Promise<ActorClaimResult[]> {
    if (!Array.isArray(requests) || requests.length < 1 || requests.length > 100) {
      throw new ActorClaimRejected("INVALID_ACTOR_CLAIM");
    }
    // Freeze the complete approved batch before any asynchronous work.
    const inputs = requests.map((request): NewActorSubject => {
      if (!request || !validText(request.localUserId) || !validText(request.openId) ||
        typeof request.loginName !== "string" || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(request.loginName)) {
        throw new ActorClaimRejected("INVALID_ACTOR_CLAIM");
      }
      return Object.freeze({ localUserId: request.localUserId, openId: request.openId, loginName: request.loginName,
        tenantKey, appId, backendUsername: "mgu_" + createHash("sha256").update(request.localUserId).digest("hex").slice(0, 32) });
    });
    const ids = new Set(inputs.map(input => input.localUserId));
    const openIds = new Set(inputs.map(input => input.openId));
    const aliases = new Set(inputs.map(input => input.loginName));
    const actors = new Set(inputs.map(input => input.backendUsername));
    if ([ids, openIds, aliases, actors].some(set => set.size !== inputs.length) || inputs.some(input => aliases.has(input.backendUsername))) {
      throw new ActorClaimRejected("INVALID_ACTOR_CLAIM");
    }
    // PostgreSQL rejects SAVEPOINT outside a transaction before any callback can run.
    await client.query("savepoint fs71_actor_claim");
    try {
      if (!await beginActorClaimBatch(client)) throw new ActorClaimRejected("ACTOR_CLAIM_TRANSACTION_REJECTED");
      // Promote the once-per-transaction marker before opening the business savepoint.
      // A failed batch rolls back its data and timeout settings, but cannot re-enter via another factory.
      await client.query("release savepoint fs71_actor_claim");
      await client.query("savepoint fs71_actor_claim");
      const policy = await lockActorClaimScope(client, scope);
      if (!policy || policy.activationState !== "enterprise" || !Number.isSafeInteger(policy.authEpoch) || policy.authEpoch < 1) {
        throw new ActorClaimRejected("ENTERPRISE_ACTIVATION_REQUIRED");
      }
      const before = await readActorInventoryState(client, scope);
      const inventory = before.inventory;
      if (!inventory || !inspectActorReservationCoverage(before, { now: now() }).complete) {
        throw new ActorClaimRejected("ACTOR_INVENTORY_REJECTED");
      }
      if (before.subjects.some(row => ids.has(row.id)) || before.rows.some(row => aliases.has(row.actor) || actors.has(row.actor))) {
        throw new ActorClaimRejected("ACTOR_CLAIM_REJECTED");
      }
      for (const input of inputs) {
        if (!await eligibility.directoryAdmission(input.openId)) throw new ActorClaimRejected("DIRECTORY_ADMISSION_REJECTED");
      }
      for (const input of inputs) await createSubject(client, input);
      // Lock upgrades can deadlock with unrelated writers: propagate failure, never retry without locks.
      await lockActorInventoryInputs(client);
      const bindings = await readCreatedActorBindings(client, [...ids]);
      const results: ActorClaimResult[] = [];
      const reservations: (StoredActorReservation & { identityId: string })[] = [];
      for (const input of inputs) {
        const matches = bindings.filter(binding => binding.localUserId === input.localUserId);
        const binding = matches[0];
        if (matches.length !== 1 || !binding || !validText(binding.identityId) || binding.tenantKey !== tenantKey ||
          binding.profileTenant !== tenantKey || binding.appId !== appId || binding.openId !== input.openId ||
          binding.status !== "active" || binding.loginName !== input.loginName || binding.backendUsername !== input.backendUsername) {
          throw new ActorClaimRejected("ACTOR_CREATION_MISMATCH");
        }
        reservations.push({ actor: input.backendUsername, state: "reserved", localUserId: input.localUserId,
          identityId: binding.identityId, quarantined: false, sourceDigest: inventory.sourceDigest, observedAt: inventory.observedAt });
        results.push({ localUserId: input.localUserId, identityId: binding.identityId, backendUsername: input.backendUsername });
      }
      await insertClaimedActorReservations(client, reservations);
      const after = await readActorInventoryState(client, scope);
      const subjects = after.subjects.filter(row => ids.has(row.id));
      if (subjects.length !== inputs.length || subjects.some(subject => subject.quarantined ||
        subject.frozenBackendUsername !== inputs.find(input => input.localUserId === subject.id)?.backendUsername)) {
        throw new ActorClaimRejected("ACTOR_CREATION_MISMATCH");
      }
      if (!after.inventory || inventoryKey(after.inventory) !== inventoryKey(inventory)) {
        throw new ActorClaimRejected("ACTOR_INVENTORY_REJECTED");
      }
      const expected = actorInventoryDigests([...before.subjects, ...subjects], inventory.upstreamActors, [...before.rows, ...reservations]);
      const actual = actorInventoryDigests(after.subjects, inventory.upstreamActors, after.rows);
      if (actual.subjectsDigest !== expected.subjectsDigest || actual.ownershipDigest !== expected.ownershipDigest ||
        !await updateActorInventoryLocalDigests(client, inventory, expected)) {
        throw new ActorClaimRejected("ACTOR_INVENTORY_REJECTED");
      }
      const currentPolicy = await lockActorClaimScope(client, scope);
      if (currentPolicy?.activationState !== "enterprise" || currentPolicy.authEpoch !== policy.authEpoch) {
        throw new ActorClaimRejected("ENTERPRISE_ACTIVATION_REQUIRED");
      }
      if (!inspectActorReservationCoverage(await readActorInventoryState(client, scope), { now: now() }).complete) {
        throw new ActorClaimRejected("ACTOR_INVENTORY_REJECTED");
      }
      await client.query("release savepoint fs71_actor_claim");
      return results;
    } catch (error) {
      await client.query("rollback to savepoint fs71_actor_claim");
      await client.query("release savepoint fs71_actor_claim");
      throw error;
    }
  }

  /** The caller protects the inventory inputs and retains those locks through its outer transaction. */
  async function existingOwners(client: PoolClient, localUserIds: readonly string[]): Promise<ExistingActorOwner[] | undefined> {
    if (!Array.isArray(localUserIds) || localUserIds.length < 1 || localUserIds.length > 100 ||
      !Array.from(localUserIds).every(validText) || new Set(localUserIds).size !== localUserIds.length) return undefined;
    const ids = [...localUserIds];
    const state = await readActorInventoryState(client, scope);
    if (!inspectActorReservationCoverage(state, { now: now() }).complete) return undefined;
    const subjects = new Map(state.subjects.map(row => [row.id, row]));
    const rows = new Map(state.rows.map(row => [row.actor, row]));
    const results: ExistingActorOwner[] = [];
    for (const localUserId of ids) {
      const subject = subjects.get(localUserId);
      if (!subject) return undefined;
      const actor = deriveHistoricalActor(subject), row = actor === undefined ? undefined : rows.get(actor);
      if (!row || row.state !== "reserved" || row.localUserId !== localUserId) return undefined;
      results.push({ localUserId, backendUsername: row.actor, quarantined: row.quarantined || subject.quarantined });
    }
    return results;
  }

  return Object.freeze({
    existingOwners,
    /** Read-only ownership evidence, including reservations retained during quarantine/maintenance. */
    async existingOwner(client: PoolClient, localUserId: string): Promise<{
      backendUsername: string; quarantined: boolean;
    } | undefined> {
      const owner = (await existingOwners(client, [localUserId]))?.[0];
      return owner ? { backendUsername: owner.backendUsername, quarantined: owner.quarantined } : undefined;
    },

    provisionBatch,
    async provision(client: PoolClient, request: ActorClaimRequest): Promise<ActorClaimResult> {
      const [result] = await provisionBatch(client, [request]);
      if (!result) throw new ActorClaimRejected("ACTOR_CREATION_MISMATCH");
      return result;
    },
  });
}
