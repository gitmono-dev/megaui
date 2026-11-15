# `@megaui/ui`

Zero-component UI foundation package (UI-01): mega design tokens
(`--mega-*` CSS variables + typed `var()` references), the shadcn/ui-style
theme system (6 color schemes × light/dark), global styles (`mega.css`,
`prose.css`, per-scheme theme files), and a tree-shakeable icon set
(brand SVGs + a megaui-only placeholder logo).

React primitive components (button, input, dialog, tooltip, sonner, ...)
are **out of scope for this card** — they're added by UI-02 / UI-03 /
UI-10 / UI-11, each writing exclusively to its own segment file under
`src/ui/`. This card only builds the skeleton those cards fill in:

```
src/ui/index.ts            — root barrel ("." export); re-exports the 4 segments below, nothing else
src/ui/index-structure.ts  — UI-02 (button/badge/card/avatar/alert/alert-dialog/separator/skeleton)
src/ui/index-form.ts       — UI-03 (input/textarea/label/select/switch/slider/progress/dialog/table)
src/ui/index-overlay.ts    — UI-10 (tooltip/dropdown-menu/popover/collapsible/scroll-area/tabs/bento-grid)
src/ui/index-feedback.ts   — UI-11 (pagination/resizable/sonner/input-otp/file-upload/steps/social-button/form-error)
```

Each segment file is empty (`export {}`) until its owning card lands; this
keeps the four cards' write sets non-overlapping (see the UI plan,
concurrency group `{UI-02, UI-03, UI-04, UI-10, UI-11}`).

## Exports

| Subpath | Points at | Contents |
|---|---|---|
| `@megaui/ui` (`.`) | `src/ui/index.ts` | Component surface (empty until UI-02/03/10/11) |
| `@megaui/ui/tokens` | `src/tokens/index.ts` | `MEGA_TOKENS`, theme/color-scheme types + helpers |
| `@megaui/ui/icons` | `src/icons/index.ts` | Named icon components + `MegauiLogo` |
| `@megaui/ui/styles/*` | `src/styles/*` | Raw CSS to `@import` (e.g. `@megaui/ui/styles/index.css`) |
| `@megaui/ui/lib/cn` | `src/lib/cn.ts` | `cn()` classname merge (clsx + tailwind-merge); shared by UI-02..11 |

The package's pre-existing `src/index.ts` placeholder (from the initial
workspace scaffold) is left untouched by this card — it is not part of the
UI-01 write set and the `.` export now points at `src/ui/index.ts` instead.
It is dead code pending removal by whichever future card owns cleanup of
that file.

## Provenance (GC-03)

Ported surfaces carry a `upstream-frontend:<path>@<sha>` header (`.ts`/`.tsx` as a
leading comment, `.css` as a leading `/* ... */` comment). Baseline SHA
`0ff3a9d` (plan `REF-07`).

| File | Source path (under REF-07 `libs/ui/`) |
|---|---|
| `src/tokens/mega-tokens.ts` | `mega-tokens.ts` |
| `src/tokens/themes.ts` | `themes.ts` |
| `src/styles/index.css` | `styles/index.css` |
| `src/styles/mega.css` | `styles/mega.css` |
| `src/styles/prose.css` | `styles/prose.css` |
| `src/styles/themes/default.css` | `styles/themes/default.css` |
| `src/styles/themes/claude.css` | `styles/themes/claude.css` |
| `src/styles/themes/cosmic-night.css` | `styles/themes/cosmic-night.css` |
| `src/styles/themes/modern-minimal.css` | `styles/themes/modern-minimal.css` |
| `src/styles/themes/ocean-breeze.css` | `styles/themes/ocean-breeze.css` |
| `src/styles/themes/perplexity.css` | `styles/themes/perplexity.css` |
| `src/icons/apple.tsx` | `icons/apple.svg` |
| `src/icons/auth.tsx` | `icons/auth.svg` |
| `src/icons/github.tsx` | `icons/github.svg` |
| `src/icons/google.tsx` | `icons/google.svg` |
| `src/icons/nextjs.tsx` | `icons/nextjs.svg` |
| `src/icons/phone.tsx` | `icons/phone.svg` |
| `src/icons/postgresql.tsx` | `icons/postgresql.svg` |
| `src/icons/react.tsx` | `icons/react.svg` |
| `src/icons/tailwind.tsx` | `icons/tailwind.svg` |
| `src/icons/typescript.tsx` | `icons/typescript.svg` |
| `src/icons/logo.tsx` | `N/A（megaui-only）` |
| `src/ui/index.ts`, `index-{structure,form,overlay,feedback}.ts` | `N/A（megaui-only — upstream-frontend has no per-segment barrel split）` |

`src/provenance.test.ts` guards production sources under `src/**`
(`.ts`/`.tsx`/`.css`): zero `legacy-demo-brand` occurrences, and every `upstream-frontend`
occurrence must be in the `upstream-frontend:<path>@<sha>` form.

## Diffs vs upstream (intentional — registered on the UI-01 task card)

| Upstream surface | Disposition here | Why |
|---|---|---|
| `styles/index.css` opens with `/* legacy-demo-brand UI Styles */` | Comment removed; replaced with the provenance header | Brand strip (ADR-ARCH-07 / GC-03) — plan card explicitly calls this out ("`styles/index.css` 头部品牌注释删除"). |
| `icons/wechat.svg` | Not ported | Domain strip — plan card explicitly cuts wechat from the icon set ("图标集裁剪 wechat（域剥离）"); no wechat login/social surface exists in megaui. |
| `libs/ui/index.ts` (root barrel re-exporting `themes` + `utils/cn`) | Not ported | Out of this card's `Reference source` (only `mega-tokens.ts`, `themes.ts`, `styles/**`, `icons/**` are listed — `index.ts` and `utils/cn.ts` are not). The classname-merge utility is deferred to whichever component card (UI-02+) first needs it, since UI-01's write set has no `utils`/`lib` directory. |
| Icons imported as raw `.svg` assets via a bundler SVG-to-component loader (`import GoogleIcon from '.../google.svg'`, consumed as `<Icon />`) | Hand-authored `.tsx` components with the SVG markup inlined as JSX | This monorepo has no SVGR-style webpack/Turbopack loader configured; inlining as JSX needs no extra build tooling and is what makes each icon a separately tree-shakeable ES module (UI-01 AC2). |
| `icons/auth.svg` had a hardcoded `stroke="#805ad5"` | Changed to `stroke="currentColor"` | This icon is a generic UI glyph (not a third-party brand mark), so it should inherit the active theme's foreground/accent color instead of an arbitrary fixed purple. |
| `nextjs.svg`/`postgresql.svg`/`react.svg`/`tailwind.svg`/`typescript.svg` had hardcoded `width="32" height="32"` | Dropped; size is left to the consumer via `className`/`width`/`height` props (all icon components spread `...props` onto the `<svg>` root) | Consistent, CSS-controllable sizing across every icon in the set — `google.svg`/`github.svg`/`apple.svg`/`phone.svg` never had a hardcoded size either. |
| `libs/ui` is a plain `libs/` folder consumed via relative import inside a single Next.js app (no `package.json`, no npm-style exports) | `@megaui/ui` is a real pnpm workspace package with a `package.json` `exports` map (`.`, `./tokens`, `./icons`, `./styles/*`) | ADR-ARCH-01 (pnpm workspace, package boundaries enforced by `.dependency-cruiser.cjs`'s `ui-restricted-deps` rule). |
| `styles/mega.css` uses `var(--mega-selected-bg)` on `[aria-current="page"]` rail profile link, but never defines `--mega-selected-bg` | Uses `var(--mega-active-bg)` (already defined as accent-tint-8) | DEBT-11 / GC-13 — do not silently reproduce the undefined custom property. |
| upstream-frontend has no emit/`dist/` for UI CSS or `.d.ts` | Same as every `@megaui/*` sibling: `build` = `tsc --noEmit`; CSS + TS types ship via package `exports` pointing at source | SC-01 / ADR-ARCH-01 source-distributed packages; UI-01 AC3 means the consumer-facing surface, not a separate emit tree. |

## UI-09 — Business composites, controls & AI elements

Ported from `upstream-frontend@0ff3a9d` (plan `REF-05`):
`libs/react-shared/components/mega/{composites/**,controls/**}` and
`libs/react-shared/components/ai-elements/**`. Every surface is adapted to
`packages/ui`'s existing shadcn-style primitives (`Avatar`, `Badge`,
`Button`, `Input`, `DropdownMenu`, `Skeleton`, ...) instead of upstream's
`MEGA_TOKENS` inline styles + `mega/atoms`/`mega/icons` — neither of those
two upstream modules is assigned to any plan card, so nothing from them is
depended on (GC-02: one styling system, one icon set). No new runtime
dependency was introduced; `@megaui/core`'s domain types (`CL`, `Issue`,
`Label`, `Citation`) are used for props where upstream used its own
equivalents.

### Exports

| Subpath | Points at | Contents |
|---|---|---|
| `@megaui/ui/composites` | `src/composites/index.ts` | `CLSummaryCard`, `IssueCard`, `CommentThread`, `ReactionsBar`, `ChatMessage` + `ChatSystemMessage`/`ChatMessageQuote`, `NotificationListItem` |
| `@megaui/ui/controls` | `src/controls/index.ts` | `EmptyState`, `FilterBar`, `ViewToggle` |
| `@megaui/ui/ai-elements` | `src/ai-elements/index.ts` | `Conversation` (+ scroll-to-bottom, empty/error state), `Loader`, `Message`/`MessageContent`/`MessageAvatar`/`MessageCitations`/`MessageUsage`, `Response` |

### Provenance (GC-03)

| File | Source path (`libs/react-shared/components/...`) |
|---|---|
| `src/composites/cl-summary-card.tsx` | `mega/composites/cl-summary-card.tsx` |
| `src/composites/issue-card.tsx` | `N/A（megaui-only — no shared upstream composite for issues; see file header）` |
| `src/composites/comment-thread.tsx` | `mega/composites/comment-card.tsx` |
| `src/composites/reactions-bar.tsx` | `mega/composites/comment-card.tsx` (reaction row extracted into its own composite) |
| `src/composites/chat-message.tsx` | `mega/composites/message-row.tsx` |
| `src/composites/notification-list-item.tsx` | `mega/composites/dashboard.tsx` (`DashboardListRow`, adapted) |
| `src/controls/empty-state.tsx` | `ai-elements/conversation.tsx` (`ConversationEmptyState`, generalized beyond chat) |
| `src/controls/filter-bar.tsx` | `mega/controls/filter-query-bar.tsx` + `mega/controls/dropdown.tsx` |
| `src/controls/view-toggle.tsx` | `mega/controls/tabs.tsx` (`SegmentedControl`, adapted) |
| `src/ai-elements/conversation.tsx` | `ai-elements/conversation.tsx` |
| `src/ai-elements/loader.tsx` | `ai-elements/loader.tsx` |
| `src/ai-elements/message.tsx` | `ai-elements/message.tsx` |
| `src/ai-elements/response.tsx` | `ai-elements/response.tsx` |

Each file's leading comment carries the full `upstream-frontend:<path>@<sha>` header
plus a "Diff vs upstream" list of the specific adaptations made (styling
system, dropped/replaced dependencies, i18n-via-props changes, etc.);
`src/provenance.test.ts` guards the header form.

### SaaS cut list (GC-03)

Two upstream `libs/react-shared/components/**` files ship SaaS-only smart
components that are **not** ported here. Both are excluded from this
card's `Reference source` regardless (they live directly under
`libs/react-shared/components/`, not under the `mega/{composites,controls}`
or `ai-elements` subtrees this card ports), and are called out explicitly
by name per the task's "strip SaaS cards" instruction:

| Upstream file | What it does | Why it's cut |
|---|---|---|
| `libs/react-shared/components/affiliate-card.tsx` | Self-fetching affiliate dashboard card (`fetch("/api/affiliate/stats")` etc.) — referral link, commission history, referral list, payout status badges | Affiliate/referral monetization has no product surface in megaui: no `Affiliate*`/`Commission*`/`Referral*` type in `@megaui/core`, and no `/api/affiliate/**` route for this card's built-in data fetching to call |
| `libs/react-shared/components/withdrawal-card.tsx` | Self-fetching withdrawal request card with its own `react-hook-form` + `zod` form (via `@libs/validators`'s `createWithdrawalValidators`) — balance/minimum-payout, payment-method picker, withdrawal history | Payout/withdrawal is SaaS-billing-specific; `@libs/validators` is not a `packages/ui` dependency and megaui has no payments domain for the form to submit against |

Both are "smart" components (own data-fetching + form validation), not
props-driven presentational cards like everything else this card ports —
an additional reason they don't fit `packages/ui`'s composite shape even
setting the SaaS-domain gap aside. If a future card introduces an
affiliate/payments domain and its own API layer, these should be re-ported
as presentational composites (data-fetching left to the caller) against
that domain's real `@megaui/core` types, consistent with how every other
UI-09 composite takes already-resolved data via props (GC-14).

### Diffs vs upstream (intentional — registered on the UI-09 task card)

| Upstream surface | Disposition here | Why |
|---|---|---|
| `mega/atoms/**` (`ShellAvatar`, `CLStatePill`, `DiffStatText`, `PackageChip`) + `mega/icons.tsx` glyph set | Not depended on; composites use `packages/ui`'s existing `Avatar`/`Badge` primitives + `lucide-react` icons | Neither module is assigned to any plan card's write set (no `mega/atoms` or `mega/icons` `REF-05` subpath exists), and GC-02 calls for one shared styling/icon system rather than a second parallel one |
| Every ported surface's raw `MEGA_TOKENS`/`MEGA_SPACING_TOKENS` inline styles | Tailwind utility classes + `cn()`, matching every other `packages/ui` surface | GC-02; consistent with UI-01/02/03/10/11's styling approach |
| `libs/react-shared/components/ai-elements/conversation.tsx`'s scroll tracking (`use-stick-to-bottom`) | Hand-rolled `onScroll` + `ResizeObserver`-free distance-from-bottom tracking | `use-stick-to-bottom` is not a `packages/ui` dependency and this card doesn't add new runtime deps for a feature coverable with native DOM APIs |
| `ai-elements/message.tsx`'s `from: UIMessage["role"]` (the `ai` SDK's type) | Local `"assistant" \| "system" \| "user"` union | The `ai` package is not a `packages/ui` dependency; this card's description only calls for the three roles it already covers |
| Hardcoded fallback strings (e.g. `MessageAvatar`'s `"ME"` default, upstream copy embedded in JSX across composites) | Every user-facing string is a caller-supplied prop; no built-in fallback text | GC-14 (i18n via props) — this card's explicit AC |
| `libs/react-shared/components/affiliate-card.tsx`, `withdrawal-card.tsx` | Not ported | SaaS cut list (GC-03) — see above |
| `mega/composites/**` has no shared issue-row composite | `IssueCard` (megaui-only) mirrors `CLSummaryCard`'s API | GC-02 — one shared row/unfurl/detail shape for both CLs and issues instead of each surface rolling its own |

## Usage

```ts
// Design tokens
import { MEGA_TOKENS, THEME_CONFIG, applyThemeToDocument } from '@megaui/ui/tokens'

// Tree-shakeable icons (only the icons you import end up in the bundle)
import { GoogleIcon, GithubIcon, MegauiLogo } from '@megaui/ui/icons'

// Business composites / controls / AI chat elements (UI-09)
import { CLSummaryCard, CommentThread } from '@megaui/ui/composites'
import { EmptyState, FilterBar } from '@megaui/ui/controls'
import { Conversation, Message, Response } from '@megaui/ui/ai-elements'
```

```css
/* apps/web globals.css (wired up by WA-01, out of scope for this card) */
@import "@megaui/ui/styles/index.css";
```

Component imports (`import { Button } from '@megaui/ui'`) become available
once UI-02/03/10/11 fill in their segment files.
