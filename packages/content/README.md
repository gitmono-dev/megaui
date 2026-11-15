# `@megaui/content`

Lexical `nodes-core`: the mega content-model node classes, server-importable
(node environment) with **zero React dependency**. Depends only on
`lexical` and `@megaui/core`.

## Provenance

Every ported file carries a `upstream-frontend:<path>@<sha>` header comment (GC-03).
Source: `upstream-frontend` @ `0ff3a9d`.

| File | Source |
|---|---|
| `src/nodes/ref-node.ts` | `libs/react-shared/components/mega/content/nodes/ref-node.tsx` |
| `src/nodes/embed-node.ts` | `libs/react-shared/components/mega/content/nodes/embed-node.tsx` (+ `embedHref` from `libs/react-shared/components/mega/content/embed-context.tsx`) |
| `src/nodes/block-ref-node.ts` | `libs/react-shared/components/mega/content/nodes/block-ref-node.tsx` |
| `src/nodes/nodes-core.ts` | `libs/react-shared/components/mega/content/nodes-core.ts` |

## Intentional diff vs upstream (GC-03 / ADR-ARCH-01)

The upstream-frontend source bundles each Lexical `DecoratorNode` subclass together
with its React `decorate()` chip (and, for `RefNode`/`EmbedNode`, a route
`Context`) in a single `.tsx` file under `libs/react-shared`. That file is
imported by upstream-frontend's server-side mega services (e.g.
`libs/mega/services/docs.ts`) purely to register the node classes for
Lexical JSON parsing — pulling a React-and-route-context module into a
Node-only service path, and creating the mega ↔ react-shared import cycle
this task sinks away from (ADR-ARCH-01).

This port splits each node file into two halves along an existing Lexical
seam:

- **Kept here (`@megaui/content`, this package):** the `DecoratorNode`
  subclass itself — `getType`/`clone`/constructor/`importJSON`/`exportJSON`/
  getters/setters/`isInline`/`getTextContent` — plus the **pure "export
  contract" function** (`refExportContract`, `embedExportContract`,
  `blockRefExportContract`) that upstream used to compute chip
  text/href/status inside `decorate()` and `exportDOM()`. These functions
  take plain data in, return plain data out — no DOM, no React — so any
  consumer (a server route building an HTML/plain-text projection, or a
  future UI package building a chip) can call them.
- **Not ported (belongs to UI-06, out of scope for this task):** the React
  chip component and route `Context`. `decorate()` is left at the Lexical
  `DecoratorNode` base-class default (returns `null`); `createDOM()` /
  `updateDOM()` / `exportDOM()` are left at the `LexicalNode` base-class
  defaults (throw if actually invoked — which headless/server usage never
  does). A future UI package can subclass e.g. `RefNode` and override
  `decorate()` / `createDOM()` with the real React rendering, reusing this
  package's types and export-contract functions for the text/href/status
  logic.

This is why AC 2 (`@megaui/content` only depends on `lexical` +
`@megaui/core`, importable in a node environment) holds: nothing in this
package ever touches `document`, `HTMLElement`, or `react`.

## Nodes

- `RefNode` (`mega-ref`) — CE-40 unified `[[wikilink]]` / entity reference
  (`doc` / `issue` / `cl` / `user` / `block` kinds).
- `EmbedNode` (`mega-embed`) — CE-52/53 `{{` embed (page or block scope).
- `BlockRefNode` (`mega-block-ref`) — CE-51 `((` block reference (with
  `ok` / `unresolved` / `forbidden` status chrome).
- `MegaBlockNode` (`mega-block`) — CE-30 unified recursive block (`text` /
  `h1` / `h2` / `h3` / `quote` / `todo` variants, nested-list marker kind,
  collapsed state). Unlike the three decorator nodes above, this is already
  a plain React-free Lexical `ElementNode` upstream, so it is ported
  verbatim rather than split. Also exports `generateBlockId`,
  which delegates to the core 12-character URL-safe cryptographic ID generator,
  `createEmptyMegaDocumentEditorStateJSON` (plain-JSON empty-doc seed, no
  `createEditor` call), `$createMegaBlock`/`$isMegaBlockNode`, and
  `registerMegaContentInvariants` (auto-fills missing `blockId`, strips
  illegal leaf nesting).
- `MegaCodeBlockNode` (`mega-code-block`) — leaf code container extending
  `@lexical/code-core`'s `CodeNode`; cannot host nested `MegaBlockNode`
  children.
- `MegaTableBlockNode` (`mega-table-block`) — leaf container wrapping a
  `@lexical/table` `TableNode` subtree (`$createMegaTableBlockWithEmptyGrid`
  builds a minimal one-cell grid). Existing documents retain this format.
- `MegaOutlineTableNode` (`mega-outline-table`) — a view node holding a stable
  `sourceBlockId`. Its cells are the text of ordinary nested `MegaBlockNode`
  rows below it; the view has no copy of the cell data. `$createOutlineTable`
  seeds the source and a 2×2 grid of nested blocks.
- `MegaHrBlockNode` (`mega-hr-block`) — leaf horizontal-rule block.

`NODES_CORE` is the ready-to-spread array — the three decorator nodes plus
`MEGA_CONTENT_BLOCK_NODES` (the four mega block `ElementNode` classes, the
outline-table `DecoratorNode`, and their required `@lexical/code-core` / `@lexical/table` support nodes:
`CodeNode`, `CodeHighlightNode`, `TableNode`, `TableRowNode`,
`TableCellNode`) — for a Lexical editor's `nodes` config:

```ts
import { createHeadlessEditor } from '@lexical/headless'
import { NODES_CORE } from '@megaui/content'

const editor = createHeadlessEditor({ namespace: 'mega', nodes: [...NODES_CORE] })
```
