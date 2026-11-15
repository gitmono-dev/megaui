/**
 * megaui:libs/ui/mega-tokens.ts@0ff3a9d
 *
 * Typed `var(--mega-*)` references for Mega workspace consumers.
 *
 * `../styles/mega.css` is the canonical source of the token *values*. Keep
 * this file limited to `var(--mega-*)` references so every consumer (DOM,
 * canvas/diagram surfaces, syntax highlighters) resolves the active
 * document theme at paint time instead of a value copied at import time.
 */
const cssVar = <TName extends `--mega-${string}`>(name: TName) =>
  `var(${name})` as `var(${TName})`

export const MEGA_TOKENS = {
  bg: cssVar('--mega-bg'),
  subtle: cssVar('--mega-subtle'),
  border: cssVar('--mega-border'),
  text: cssVar('--mega-text'),
  muted: cssVar('--mega-muted'),
  codeBg: cssVar('--mega-code-bg'),
  codeText: cssVar('--mega-code-text'),
  accent: cssVar('--mega-accent'),
  accentForeground: cssVar('--mega-accent-foreground'),
  activeBg: cssVar('--mega-active-bg'),
  activeFg: cssVar('--mega-active-fg'),
  selectedBorder: cssVar('--mega-selected-border'),
  success: cssVar('--mega-success'),
  danger: cssVar('--mega-danger'),
  warning: cssVar('--mega-warning'),
  merged: cssVar('--mega-merged'),
  fontMono: cssVar('--mega-font-mono'),
} as const

export const MEGA_ACCENT_TINTS = {
  5: cssVar('--mega-accent-tint-5'),
  8: cssVar('--mega-accent-tint-8'),
  10: cssVar('--mega-accent-tint-10'),
  14: cssVar('--mega-accent-tint-14'),
  18: cssVar('--mega-accent-tint-18'),
  22: cssVar('--mega-accent-tint-22'),
  44: cssVar('--mega-accent-tint-44'),
  55: cssVar('--mega-accent-tint-55'),
} as const

export const MEGA_DIFF_TOKENS = {
  add: {
    background: cssVar('--mega-diff-add-bg'),
    foreground: cssVar('--mega-diff-add-fg'),
  },
  del: {
    background: cssVar('--mega-diff-del-bg'),
    foreground: cssVar('--mega-diff-del-fg'),
  },
  hunk: {
    background: cssVar('--mega-diff-hunk-bg'),
    foreground: cssVar('--mega-diff-hunk-fg'),
  },
} as const

export const MEGA_CONSOLE_TOKENS = {
  background: cssVar('--mega-console-bg'),
  text: cssVar('--mega-console-text'),
  muted: cssVar('--mega-console-muted'),
  success: cssVar('--mega-console-success'),
  warning: cssVar('--mega-console-warning'),
  danger: cssVar('--mega-console-danger'),
  lineNumber: cssVar('--mega-console-line-number'),
} as const

export const MEGA_LAYER_TOKENS = {
  snapshot: cssVar('--mega-layer-snapshot'),
  event: cssVar('--mega-layer-event'),
  libra: cssVar('--mega-layer-libra'),
} as const

export const MEGA_KIND_TOKENS = {
  Intent: cssVar('--mega-kind-intent'),
  Plan: cssVar('--mega-kind-plan'),
  Task: cssVar('--mega-kind-task'),
  Run: cssVar('--mega-kind-run'),
  PatchSet: cssVar('--mega-kind-patch-set'),
  Provenance: cssVar('--mega-kind-provenance'),
  ContextSnapshot: cssVar('--mega-kind-context-snapshot'),
  IntentEvent: cssVar('--mega-kind-intent-event'),
  TaskEvent: cssVar('--mega-kind-task-event'),
  RunEvent: cssVar('--mega-kind-run-event'),
  PlanStepEvent: cssVar('--mega-kind-plan-step-event'),
  RunUsage: cssVar('--mega-kind-run-usage'),
  ToolInvocation: cssVar('--mega-kind-tool-invocation'),
  Evidence: cssVar('--mega-kind-evidence'),
  Decision: cssVar('--mega-kind-decision'),
  ContextFrame: cssVar('--mega-kind-context-frame'),
} as const

export const MEGA_SPACING_TOKENS = {
  1: cssVar('--mega-space-1'),
  3: cssVar('--mega-space-3'),
  4: cssVar('--mega-space-4'),
  5: cssVar('--mega-space-5'),
  6: cssVar('--mega-space-6'),
  8: cssVar('--mega-space-8'),
} as const

export const MEGA_RADIUS_TOKENS = {
  sm: cssVar('--mega-radius-sm'),
  md: cssVar('--mega-radius-md'),
  pill: cssVar('--mega-radius-pill'),
} as const

/** Visual baseline shared with the document detail page. */
export const MEGA_SURFACE_TOKENS = {
  pageTitleSize: cssVar('--mega-page-title-size'),
  sectionTitleSize: cssVar('--mega-section-title-size'),
  controlFontSize: cssVar('--mega-control-font-size'),
  fieldFontSize: cssVar('--mega-field-font-size'),
  controlRadius: cssVar('--mega-control-radius'),
  panelRadius: cssVar('--mega-panel-radius'),
} as const

export type MegaKindToken = keyof typeof MEGA_KIND_TOKENS
