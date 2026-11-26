import { isBlockId } from './block-id'

/** Older links use the positive PostgreSQL integer assigned to the CL. */
export function isLegacyCLNumber(value: string): boolean {
  return /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2_147_483_647
}

export function isCLReference(value: unknown): value is string {
  return typeof value === 'string' && (isBlockId(value) || isLegacyCLNumber(value))
}
