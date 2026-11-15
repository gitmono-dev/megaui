// megaui:libs/i18n/locales/types.ts@0ff3a9d
//
// Loose runtime shape for a locale dictionary. `en` and `zhCN` are the
// source of truth for the actual key set; `Translations` (see
// `../get-translation.ts`) infers the canonical shape from `en` rather than
// this type. Key-set parity between locales is enforced by
// `locales/parity.test.ts`, not by the type system.
export type Locale = Record<string, unknown>
