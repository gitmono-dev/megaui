// Every icon is its own module with a single named export and no
// module-level side effects, so `import { GoogleIcon } from '@megaui/ui/icons'`
// tree-shakes cleanly in any ESM-aware bundler (UI-01 AC2) — unlike a single
// object/array of components, which would force bundlers to keep every icon
// reachable from one shared module record.
export { AppleIcon } from './apple'
export { AuthIcon } from './auth'
export { GithubIcon } from './github'
export { GoogleIcon } from './google'
export { NextjsIcon } from './nextjs'
export { PhoneIcon } from './phone'
export { PostgresqlIcon } from './postgresql'
export { ReactIcon } from './react'
export { TailwindIcon } from './tailwind'
export { TypescriptIcon } from './typescript'

// megaui-only (not ported from upstream, see README "Diffs vs upstream").
export { MegauiLogo } from './logo'

export type { IconProps } from './types'
