import { generateBlockId, isBlockId } from './block-id'

/** Canonical CL codes consist of twelve case-sensitive ASCII letters and digits. */
export function isCLPublicId(value: unknown): value is string {
  return isBlockId(value) && !/[-_]/.test(value)
}

export function generateCLPublicId(): string {
  // Resampling keeps the 62 alphanumeric characters equally likely.
  let id = generateBlockId()
  while (!isCLPublicId(id)) id = generateBlockId()
  return id
}

/** Older links use the positive PostgreSQL integer assigned to the CL. */
export function isLegacyCLNumber(value: string): boolean {
  return /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2_147_483_647
}

export function isCLReference(value: unknown): value is string {
  // Historical block-style codes and numeric bookmarks remain readable.
  return typeof value === 'string' && (isBlockId(value) || isLegacyCLNumber(value))
}
