import { generateBlockId, isBlockId, isLegacyCLNumber } from "@megaui/core";
import { megaClLinks, megaClPublicIds, megaCls, type Database } from "@megaui/database";
import { eq, max, sql } from "drizzle-orm";
import { MegaBadRequestError, MegaInternalError, MegaNotFoundError } from "../../errors";

/** All local and live writers take this transaction-scoped lock before choosing a CL number. */
export async function lockCLNumberAllocation(db: Pick<Database, "execute">): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(${1_396_386_881})`);
}

/** Run under lockCLNumberAllocation. Public identities outlive deleted local rows. */
export async function nextCLNumber(db: Pick<Database, "select">): Promise<number> {
  const [local] = await db.select({ maxNumber: max(megaCls.number) }).from(megaCls);
  const [live] = await db.select({ maxNumber: max(megaClLinks.number) }).from(megaClLinks);
  const [reserved] = await db.select({ maxNumber: max(megaClPublicIds.number) }).from(megaClPublicIds);
  return Math.max(local?.maxNumber ?? 0, live?.maxNumber ?? 0, reserved?.maxNumber ?? 0) + 1;
}

/** Reserve one code for a known CL. Both axes are unique, including under concurrent writers. */
export async function ensureCLPublicId(
  db: Pick<Database, "select" | "insert">,
  number: number,
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const [existing] = await db.select({ publicId: megaClPublicIds.publicId })
      .from(megaClPublicIds).where(eq(megaClPublicIds.number, number)).limit(1);
    if (existing) return existing.publicId;

    const [inserted] = await db.insert(megaClPublicIds)
      .values({ number, publicId: generateBlockId() })
      .onConflictDoNothing()
      .returning({ publicId: megaClPublicIds.publicId });
    if (inserted) return inserted.publicId;
    // An identical number can win concurrently, or another CL can already own the candidate.
  }
  throw new MegaInternalError("Unable to reserve a public CL identifier");
}

/** Resolving an address only yields a key; the caller still performs the normal CL access check. */
export async function resolveCLNumber(db: Pick<Database, "select">, ref: string): Promise<number> {
  if (isLegacyCLNumber(ref)) return Number(ref);
  if (!isBlockId(ref)) throw new MegaBadRequestError("Invalid CL reference");
  const [row] = await db.select({ number: megaClPublicIds.number })
    .from(megaClPublicIds).where(eq(megaClPublicIds.publicId, ref)).limit(1);
  if (!row) throw new MegaNotFoundError("CL", ref);
  return row.number;
}
