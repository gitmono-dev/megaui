import Link from "next/link";

import type { AgentThread } from "@megaui/core";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

interface AgentThreadRailProps {
  readonly activeThreadId: string;
  readonly ariaLabel: string;
  readonly isCreating: boolean;
  readonly newThreadLabel: string;
  readonly recentLabel: string;
  readonly threads: readonly AgentThread[];
  readonly untitledLabel: string;
  readonly workspaceBase: string;
  readonly onCreate: () => void;
}

export function AgentThreadRail({
  activeThreadId,
  ariaLabel,
  isCreating,
  newThreadLabel,
  recentLabel,
  threads,
  untitledLabel,
  workspaceBase,
  onCreate,
}: AgentThreadRailProps) {
  return (
    <aside
      aria-label={ariaLabel}
      data-mega-agent="rail"
      style={{
        borderRight: `1px solid ${MEGA_TOKENS.border}`,
        minWidth: 200,
        paddingRight: MEGA_SPACING_TOKENS[8],
      }}
    >
      <button data-mega-agent="new-thread" disabled={isCreating} onClick={onCreate} type="button">
        {newThreadLabel}
      </button>
      <p style={{ color: MEGA_TOKENS.muted, fontSize: "0.85rem" }}>{recentLabel}</p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {threads.map((thread) => (
          <li key={thread.id}>
            <Link
              data-active={thread.id === activeThreadId ? "true" : "false"}
              data-mega-agent="rail-item"
              href={`${workspaceBase}/agent/${encodeURIComponent(thread.id)}`}
            >
              {thread.title || untitledLabel}
            </Link>
          </li>
        ))}
      </ul>
    </aside>
  );
}
