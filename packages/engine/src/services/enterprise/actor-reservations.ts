// megaui-only (FS-70): historical actor preservation has no upstream writer.
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  readHistoricalActorSubjects, readActorReservations, readActorInventory, writeActorInventory,
  type HistoricalActorSubject, type StoredActorReservation, type StoredActorInventory,
} from "@megaui/database";
import { createApprovedMutationCapability, registerApprovedMutationHandler,
  type GuardedWriteContext, type VerbSchema } from "../../cli/admin-approval";
import { ApprovedMutationRejection } from "../../cli/admin-mutation";
import { canonicalizeJson } from "../../cli/admin-payload";

const SOURCE_MAX_AGE_MS = 86_400_000;

/** REF-10 WebsiteAuthUserJson::into_login_user: preserve nonblank name bytes. */
export function deriveHistoricalActor(input: {
  name: string; email: string; frozenBackendUsername?: string | null;
}): string | undefined {
  if (input.frozenBackendUsername !== undefined && input.frozenBackendUsername !== null) return input.frozenBackendUsername;
  if (rustTrim(input.name) !== "") return input.name;
  const at = input.email.indexOf("@");
  const localPart = at < 0 ? undefined : rustTrim(input.email.slice(0, at));
  return localPart === "" ? undefined : localPart;
}

// Rust str::trim uses Unicode White_Space, not ECMAScript's whitespace set.
function rustTrim(value: string): string {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}

export interface ApprovedActorSource {
  readonly actor: string;
  readonly owners: readonly string[];
}
export interface ApprovedActorSnapshot {
  readonly observedAt: Date;
  readonly actors: readonly ApprovedActorSource[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && rustTrim(value) !== "" && !value.includes("\0");
}
function canonicalActors(value: unknown): readonly ApprovedActorSource[] {
  if (!Array.isArray(value)) throw new ApprovedMutationRejection("INVALID_ARGUMENT");
  const seen = new Set<string>();
  const actors = value.map((entry): ApprovedActorSource => {
    if (!isRecord(entry) || !exactKeys(entry, ["actor", "owners"]) || !validIdentifier(entry.actor) ||
      !Array.isArray(entry.owners) || entry.owners.length === 0 || !entry.owners.every(validIdentifier) ||
      new Set(entry.owners).size !== entry.owners.length || seen.has(entry.actor)) {
      throw new ApprovedMutationRejection("INVALID_ARGUMENT");
    }
    seen.add(entry.actor);
    return Object.freeze({ actor: entry.actor, owners: Object.freeze([...entry.owners].sort()) });
  }).sort((a, b) => compare(a.actor, b.actor));
  // Reject unpaired UTF-16 surrogates before hashing or writing PostgreSQL text.
  try { canonicalizeJson(actors); }
  catch { throw new ApprovedMutationRejection("INVALID_ARGUMENT"); }
  return Object.freeze(actors);
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function finiteTime(value: unknown): number {
  return value instanceof Date ? value.getTime() : NaN;
}
function fresh(observedAt: unknown, now: number): boolean {
  const observed = finiteTime(observedAt);
  return Number.isFinite(now) && Number.isFinite(observed) && now >= observed && now - observed <= SOURCE_MAX_AGE_MS;
}

/** Source timestamps are UTC ISO seconds or milliseconds; never coerce invalid calendar dates. */
export function parseApprovedActorSnapshot(bytes: Uint8Array, now = new Date()): ApprovedActorSnapshot {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new ApprovedMutationRejection("INVALID_ARGUMENT"); }
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "observedAt", "actors"]) ||
    value.schemaVersion !== 1 || typeof value.observedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.observedAt)) {
    throw new ApprovedMutationRejection("INVALID_ARGUMENT");
  }
  const observedAt = new Date(value.observedAt);
  const normalized = value.observedAt.includes(".") ? value.observedAt : value.observedAt.replace("Z", ".000Z");
  if (!Number.isFinite(observedAt.getTime()) || observedAt.toISOString() !== normalized) {
    throw new ApprovedMutationRejection("INVALID_ARGUMENT");
  }
  const actors = canonicalActors(value.actors);
  if (!fresh(observedAt, now.getTime())) throw new ApprovedMutationRejection("ACTOR_SOURCE_REJECTED");
  return Object.freeze({ observedAt, actors });
}

export const actorReservationAdminSchema: VerbSchema = Object.freeze({ flags: Object.freeze({
  upstream: { kind: "file" as const, required: true },
  digest: { kind: "string" as const, required: true, emitSafe: true as const },
}) });

export function registerActorReservationAdminVerb(): void {
  registerApprovedMutationHandler("reserve-actors",
    createApprovedMutationCapability(actorReservationAdminSchema, runActorReservationMutation));
}
function subjectActor(subject: HistoricalActorSubject): string | null {
  const actor = deriveHistoricalActor(subject);
  return actor === undefined || rustTrim(actor) === "" ? null : actor;
}
function subjectCoverage(subjects: readonly HistoricalActorSubject[]) {
  return subjects.map((subject) => ({ id: subject.id, actor: subjectActor(subject), quarantined: subject.quarantined }))
    .sort((a, b) => compare(a.id, b.id));
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonicalizeJson(value)).digest("hex");
}
function ownership(
  subjects: readonly HistoricalActorSubject[], upstream: readonly ApprovedActorSource[], rows: readonly StoredActorReservation[],
): string {
  return digest({ subjects: subjectCoverage(subjects), upstream,
    reservations: rows.map((row) => ({ actor: row.actor, state: row.state, localUserId: row.localUserId, quarantined: row.quarantined }))
      .sort((a, b) => compare(a.actor, b.actor)) });
}

/** Shared by an approved scan and the narrowly authorized FS-71 local addition. */
export function actorInventoryDigests(
  subjects: readonly HistoricalActorSubject[], upstream: unknown, rows: readonly StoredActorReservation[],
): { subjectsDigest: string; ownershipDigest: string } {
  return { subjectsDigest: digest(subjectCoverage(subjects)), ownershipDigest: ownership(subjects, canonicalActors(upstream), rows) };
}

export interface ActorInventoryState {
  inventory: StoredActorInventory | undefined;
  subjects: HistoricalActorSubject[];
  rows: StoredActorReservation[];
}

export async function readActorInventoryState(client: PoolClient, scope: string): Promise<ActorInventoryState> {
  return { inventory: await readActorInventory(client, scope), subjects: await readHistoricalActorSubjects(client),
    rows: await readActorReservations(client) };
}

/** Called only in the approved transaction; scope and epoch have already been locked and verified. */
export async function runActorReservationMutation(context: GuardedWriteContext, client: PoolClient): Promise<Record<string, number>> {
  if (context.verb !== "reserve-actors" || typeof context.args.target !== "string" || context.args.target === "") {
    throw new ApprovedMutationRejection("INVALID_ARGUMENT");
  }
  const bytes = context.files.bytes("upstream");
  if (!bytes || context.args.digest !== createHash("sha256").update(bytes).digest("hex")) {
    throw new ApprovedMutationRejection("APPROVAL_DIGEST_MISMATCH");
  }
  const sourceDigest = context.args.digest as string;
  const snapshot = parseApprovedActorSnapshot(bytes);
  const inventory = await readActorInventory(client, context.args.target);
  const subjects = await readHistoricalActorSubjects(client);
  const previous = new Map((await readActorReservations(client)).map((row) => [row.actor, row]));
  if ([...previous.values()].some((row) => !["reserved", "ambiguous", "unclaimable"].includes(row.state))) {
    throw new Error("invalid persisted actor reservation state");
  }
  const times = [...previous.values()].map((row) => row.observedAt).filter((value) => value !== null);
  if (inventory) times.push(inventory.observedAt);
  if (times.some((value) => !Number.isFinite(finiteTime(value)) || finiteTime(value) > snapshot.observedAt.getTime())) {
    throw new ApprovedMutationRejection("ACTOR_SOURCE_REJECTED");
  }
  const locals = new Map<string, HistoricalActorSubject[]>();
  const quarantines: { userId: string; reason: "actor_missing" | "actor_conflict" }[] = [];
  for (const subject of subjects) {
    const actor = subjectActor(subject);
    if (actor === null) {
      quarantines.push({ userId: subject.id, reason: "actor_missing" });
      subject.quarantined = true;
    } else {
      const group = locals.get(actor) ?? [];
      group.push(subject);
      locals.set(actor, group);
    }
  }
  const upstream = new Map(snapshot.actors.map((row) => [row.actor, row.owners]));
  const actors = [...new Set([...previous.keys(), ...locals.keys(), ...upstream.keys()])].sort();
  const reservations = actors.map((actor): StoredActorReservation => {
    const old = previous.get(actor);
    const group = locals.get(actor) ?? [];
    const localOwners = new Set(group.map((subject) => subject.id));
    if (old?.localUserId) localOwners.add(old.localUserId);
    const owners = new Set([...localOwners, ...upstream.get(actor) ?? []]);
    const ambiguous = owners.size > 1 || old?.state === "ambiguous";
    // ON DELETE SET NULL loses the original owner's id, never its permanent reservation.
    const orphaned = old?.state === "reserved" && old.localUserId === null;
    const state = ambiguous ? "ambiguous" : old?.state === "unclaimable" || orphaned || localOwners.size === 0
      ? "unclaimable" : "reserved";
    if (state !== "reserved") {
      for (const subject of group) {
        quarantines.push({ userId: subject.id, reason: "actor_conflict" });
        subject.quarantined = true;
      }
    }
    return { actor, state, localUserId: state === "reserved" ? [...localOwners][0] ?? null : null,
      quarantined: state === "reserved" && (old?.quarantined === true || group.some((subject) => subject.quarantined)),
      sourceDigest, observedAt: snapshot.observedAt };
  });
  await writeActorInventory(client, { reservations, quarantines, inventory: {
    scope: context.args.target, operationId: context.operationId, sourceDigest,
    observedAt: snapshot.observedAt, upstreamActors: snapshot.actors,
    subjectsDigest: digest(subjectCoverage(subjects)), ownershipDigest: ownership(subjects, snapshot.actors, reservations),
  } });
  // A blocked or slow batch must not commit a source that expired during the scan.
  if (!fresh(snapshot.observedAt, Date.now())) throw new ApprovedMutationRejection("ACTOR_SOURCE_REJECTED");
  return { subjects: subjects.length, reserved: reservations.filter((row) => row.state === "reserved").length,
    ambiguous: reservations.filter((row) => row.state === "ambiguous").length,
    unclaimable: reservations.filter((row) => row.state === "unclaimable").length };
}

export interface ActorReservationCoverage {
  complete: boolean;
  missingUserIds: string[];
  staleActors: string[];
  ownershipDigest: string;
  ownershipMatches: boolean;
}

/** Read-only: callers bind the scope to their trusted instance and retain their transaction through admission. */
export async function checkActorReservationCoverage(
  client: PoolClient, options: { scope: string; now?: Date; expectedOwnershipDigest?: string },
): Promise<ActorReservationCoverage> {
  return inspectActorReservationCoverage(await readActorInventoryState(client, options.scope), options);
}

/** Evaluate one explicitly supplied state without re-reading it during an approved local delta. */
export function inspectActorReservationCoverage(
  state: ActorInventoryState, options: { now?: Date; expectedOwnershipDigest?: string },
): ActorReservationCoverage {
  const { inventory, subjects, rows } = state;
  const byActor = new Map(rows.map((row) => [row.actor, row]));
  const missingUserIds = subjects.filter((subject) => {
    const actor = subjectActor(subject);
    if (actor === null) return !subject.quarantined;
    const row = byActor.get(actor);
    return !row || (row.state === "reserved" ? row.localUserId !== subject.id :
      !["ambiguous", "unclaimable"].includes(row.state) || !subject.quarantined);
  }).map((subject) => subject.id).sort();
  const now = (options.now ?? new Date()).getTime();
  const staleActors = rows.filter((row) => !fresh(row.observedAt, now)).map((row) => row.actor).sort();
  let upstream: readonly ApprovedActorSource[] = [];
  let sourceValid = false;
  if (inventory) {
    try { upstream = canonicalActors(inventory.upstreamActors); sourceValid = true; }
    catch { /* Malformed persisted source is never treated as approved empty inventory. */ }
  }
  const ownershipDigest = ownership(subjects, upstream, rows);
  const ownershipMatches = options.expectedOwnershipDigest === undefined || options.expectedOwnershipDigest === ownershipDigest;
  const sealed = inventory !== undefined && sourceValid && inventory.subjectsDigest === digest(subjectCoverage(subjects)) &&
    inventory.ownershipDigest === ownershipDigest && fresh(inventory.observedAt, now) &&
    rows.every((row) => row.sourceDigest === inventory.sourceDigest &&
      finiteTime(row.observedAt) === finiteTime(inventory.observedAt));
  return { complete: sealed && missingUserIds.length === 0 && staleActors.length === 0 && ownershipMatches,
    missingUserIds, staleActors, ownershipDigest, ownershipMatches };
}
