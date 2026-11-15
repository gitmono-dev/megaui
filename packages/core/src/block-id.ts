/** Canonical block identity: 12 URL-safe symbols, 72 bits of random entropy. */
export const BLOCK_ID_LENGTH = 12
export const BLOCK_ID_SOURCE = '[A-Za-z0-9_-]{12}'
export const BLOCK_ID_PATTERN = new RegExp(`^${BLOCK_ID_SOURCE}$`)
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'

export function isBlockId(value: unknown): value is string {
  return typeof value === 'string' && value.length === BLOCK_ID_LENGTH && BLOCK_ID_PATTERN.test(value)
}

/** Each of the 64 symbols has four byte representations, so masking is unbiased. */
export function generateBlockId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(BLOCK_ID_LENGTH))
  return Array.from(bytes, byte => ALPHABET[byte & 63]).join('')
}
