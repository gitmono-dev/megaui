// N/A（megaui-only）— original mark, not ported from upstream. Placeholder
// wordmark for the megaui product until real brand assets land; see
// `packages/ui/README.md` "Diffs vs upstream" for the GC-03 rationale.
import type { IconProps } from './types'

/**
 * Minimal geometric monogram: three bars of ascending height suggesting an
 * "M", rendered in `currentColor` so it inherits the active theme's
 * foreground/accent color. Intentionally abstract — swap for a real mark
 * without changing the component's name or prop shape.
 */
export function MegauiLogo(props: IconProps) {
  return (
    <svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" fill="currentColor" {...props}>
      <rect x="4" y="18" width="6" height="10" rx="1.5" />
      <rect x="13" y="10" width="6" height="18" rx="1.5" />
      <rect x="22" y="4" width="6" height="24" rx="1.5" />
    </svg>
  )
}
