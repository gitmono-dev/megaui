/**
 * UI-04: workspace react-query data layer barrel.
 *
 * `@megaui/ui/query` — query-key factory, `/api/mega/*` fetcher, optimistic
 * cache helpers, and `MegaQueryProvider`. See `keys.ts`/`fetcher.ts`/
 * `optimistic.ts`/`provider.tsx` for per-file provenance headers.
 */
export * from './keys'
export * from './fetcher'
export * from './optimistic'
export * from './provider'
