// Root barrel for the `@megaui/ui` component surface (the package's "."
// export). UI-01 only builds this skeleton: four segment barrels, one per
// primitive group, each owned exclusively by its own card so their write
// sets never overlap (the UI plan UI-01 card).
//
//   index-structure.ts — UI-02 (button/badge/card/avatar/alert/...)
//   index-form.ts       — UI-03 (input/textarea/select/switch/...)
//   index-overlay.ts    — UI-10 (tooltip/dropdown-menu/popover/...)
//   index-feedback.ts   — UI-11 (pagination/sonner/input-otp/...)
//
// This file must only re-export those four segments — it must not define
// or re-export any component itself.
export * from './index-structure'
export * from './index-form'
export * from './index-overlay'
export * from './index-feedback'
