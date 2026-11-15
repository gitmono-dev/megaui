// megaui:apps/next-app/.../agent/page.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-15): redirect to latest thread (or create one)
// instead of rendering the latest thread in place.
"use client";

import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import type { AgentThread } from "@megaui/core";
import { MegaApiError, megaGet, megaPost, megaQueryKeys } from "@megaui/ui/query";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";

type ThreadPage = { items: AgentThread[]; total: number; offset: number; limit: number };

export default function AgentIndexPage() {
  const { locale, t } = useTranslation();
  const router = useRouter();
  const agentText = t.workspace.agent;
  const started = useRef(false);

  const listQuery = useQuery({
    queryKey: megaQueryKeys.agentThreads(),
    queryFn: () => megaGet<ThreadPage>("agent"),
  });

  const createMutation = useMutation({
    mutationFn: () => megaPost<AgentThread>("agent", { title: agentText.rail.untitled }),
    onSuccess: (thread) => {
      router.replace(`/${locale}/workspace/agent/${encodeURIComponent(thread.id)}`);
    },
  });

  useEffect(() => {
    if (started.current || listQuery.isPending || listQuery.isError) return;
    started.current = true;
    const latest = listQuery.data?.items[0];
    if (latest) {
      router.replace(`/${locale}/workspace/agent/${encodeURIComponent(latest.id)}`);
      return;
    }
    createMutation.mutate();
  }, [createMutation, listQuery.data?.items, listQuery.isError, listQuery.isPending, locale, router]);

  if (listQuery.isError || createMutation.isError) {
    return (
      <main data-mega-agent="index">
        <div role="alert" style={{ display: "flex", gap: MEGA_SPACING_TOKENS[8], padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>
          <p style={{ margin: 0 }}>
            {(listQuery.error ?? createMutation.error) instanceof MegaApiError
              ? agentText.askError
              : agentText.notFound}
          </p>
          <button
            data-mega-agent="retry"
            onClick={() => {
              started.current = false;
              void listQuery.refetch();
            }}
            type="button"
          >
            {agentText.retry}
          </button>
        </div>
      </main>
    );
  }

  return (
    <main aria-busy="true" data-mega-agent="index">
      <p style={{ color: MEGA_TOKENS.muted, padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>{agentText.loading}</p>
    </main>
  );
}
