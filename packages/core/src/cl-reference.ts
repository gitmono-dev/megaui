import { generateBlockId, isBlockId } from './block-id'

/** Shareable CL codes use the document block alphabet with the hyphen excluded. */
export function isCLPublicId(value: unknown): value is string {
  return isBlockId(value) && !value.includes('-')
}

export function generateCLPublicId(): string {
  // Resampling keeps all 63 allowed characters equally likely.
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
