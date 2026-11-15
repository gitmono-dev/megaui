# `@megaui/engine/services/mega2` (EG-11)

HTTP client for the 5 mega2 `/api/v1/*` read endpoints pinned by
`REF-02` (mega2 `80ddff4`, `docs/openapi.json` verified 2026-09-02):

| Endpoint | Wire shape | Domain output |
|---|---|---|
| `GET /api/v1/latest-commit` | raw `LatestCommitInfo` (not `CommonResult`-wrapped) | `Workspace` (`@megaui/core`) via `fetchWorkspace` |
| `GET /api/v1/tree/commit-info` | `CommonResult<TreeCommitItem[]>` | `RootEntry[]` (`@megaui/core`) via `fetchRootEntries` |
| `GET /api/v1/tree` | `CommonResult<TreeResponse>` | `TreeNode[]` (`@megaui/core`) via `fetchCodeTree` |
| `GET /api/v1/blob` | `CommonResult<string>` | `SourceFileView` via `fetchSourceFile` |
| `GET /api/v1/cl/{link}/commits` | `CommonResult<ClCommitRes[]>` (snake_case) | `ClCommit[]` (camelCase) via `fetchClCommits` |

Session/cookie propagation is the caller's (BFF) responsibility — every
`fetch*` function forwards only the `cookie` header from
`options.headers`, and never reads a session out of `process.env`.

## Provenance

`megaui:libs/mega/services/monoengine/{client,mappers,code-backend,types}.ts@0ff3a9d`.
See each file's header comment for the specific diff vs upstream (GC-03).

## Registered contract differences (this card)

- **No mock runtime fallback (DEBT-04 / ADR-ARCH-03).** Upstream
  `libs/mega/services/code.ts` switches between a fixture-backed mock
  store and mega2 via `MEGA_CODE_DATA_BACKEND`. That selector file is
  intentionally **not** ported: every function here always calls
  mega2, and a missing/unreachable backend always throws a domain
  error (fail-closed) instead of silently degrading to fixture data.
- **Single domain-error exit (DEBT-03 / GC-04).** Upstream's
  `Mega2ApiError` / `Mega2ConfigError` are standalone `Error`
  subclasses with their own `code`/`name`. This port throws the engine's
  own `Mega*` errors directly (`MegaUnauthorizedError` / `MegaForbiddenError`
  / `MegaNotFoundError` / `MegaBadRequestError` / `MegaInternalError`);
  `Mega2ConfigError` now extends `MegaInternalError` so config
  failures still fail closed through the same single mapping surface that
  `packages/engine/src/result.ts` (`serializeMegaError`) already knows how
  to redact/serialize.
- **Runtime-validated wire→domain mapping.** Upstream cast
  `response.json()` to a TypeScript interface without runtime validation.
  Every response here is zod-validated at the transport boundary
  (`getMega2Json` / `getMega2CommonResult`); a schema mismatch
  (contract drift, or a genuinely malformed upstream response) is
  classified as `MegaInternalError` (upstream/contract fault, not caller
  input).
- **`ClCommit` / `clCommitWireSchema` / `SourceFileView` moved from
  `@megaui/core` into this service directory**, per `@megaui/core`'s own
  README ("mega2 wire-format mapping is a BFF/engine adapter concern,
  not a core domain shape ... belongs in `@megaui/engine`").
- **README rendering not ported.** Upstream's `fetchReadmeBlocks` /
  `readme-markdown.ts` build `ProseBlock[]` from a source file's markdown
  content — not a distinct wire endpoint, and out of this card's REF-02
  scope. A page card can compose `fetchSourceFile` with the existing
  `packages/engine/src/services/docs/blocks.ts` markdown parser instead of
  duplicating that logic here.
- **Read-only.** `client.ts` only ports the `GET` helpers; the upstream
  `postJson`/`putJson`/`deleteJson`/`*CommonResult*` write helpers (backing
  `create-entry`, `edit/*`, credentials, notifications) are out of this
  card's write set.

## Testing

- `*.contract.test.ts` — stub-server contract tests (`node:http`, no mock
  library dependency added). Cover all 5 endpoints' success mapping, the
  401/403/404/400/422/5xx → `Mega*` classification matrix, `CommonResult`
  unwrap (including the not-found-vs-bad-request `err_message` heuristic),
  malformed-response handling, and the fail-closed missing-base-URL case.
- `live.contract.test.ts` — DEP-02 gated: probes
  `${MEGA2_LIVE_BASE_URL:-http://127.0.0.1:19180}/api/openapi.json`
  and skips with an explicit `console.warn` when unreachable (never a
  silent pass).
