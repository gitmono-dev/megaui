/**
 * megaui:libs/react-shared/components/mega/query/provider.tsx@0ff3a9d
 *
 * `MegaQueryProvider` — mounts one lazily-created `QueryClient` per
 * subtree via `useState` (never recreated across re-renders), matching the
 * `'use client'` + lazy-singleton-via-`useState` shape reviewed in
 * `libs/react-shared/providers/app-context.tsx`'s `SharedAppProvider`.
 * Unlike `SharedAppProvider` this has no `useX()` accessor of its own —
 * `@tanstack/react-query`'s own `useQueryClient()` already covers that.
 *
 * Diff vs upstream (GC-03, registered on the UI-04 task card): none —
 * ported verbatim (defaults unchanged: 30s staleTime, 1 retry, no
 * refetch-on-window-focus).
 */
'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'

export function MegaQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 30_000,
          retry: 1,
          refetchOnWindowFocus: false,
        },
      },
    }),
  )

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
