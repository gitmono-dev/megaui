/**
 * megaui:libs/mega/collab/presence-color.ts@0ff3a9d
 *
 * Stable caret / presence color derived from a user id.
 * Deterministic HSL so the same peer always gets the same hue.
 */

const GOLDEN_RATIO = 0.618_033_988_75

function hashUserId(userId: string): number {
  let hash = 0
  for (let i = 0; i < userId.length; i += 1) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0
  }
  return hash
}

/**
 * @returns CSS color string, e.g. `hsl(210 70% 45%)`
 */
export function colorFromUserId(userId: string): string {
  const hash = hashUserId(userId.trim() || 'anon')
  const hue = Math.floor(((hash * GOLDEN_RATIO) % 1) * 360)
  return `hsl(${hue} 70% 45%)`
}
