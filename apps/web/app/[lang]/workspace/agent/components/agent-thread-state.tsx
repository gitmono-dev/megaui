import Link from "next/link";

import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

interface AgentThreadNotFoundProps {
  readonly label: string;
  readonly newThreadLabel: string;
  readonly workspaceBase: string;
}

export function AgentThreadNotFound({
  label,
  newThreadLabel,
  workspaceBase,
}: AgentThreadNotFoundProps) {
  return (
    <main data-mega-agent="thread">
      <div
        data-mega-agent="not-found"
        role="alert"
        style={{ padding: `calc(${MEGA_SPACING_TOKENS[8]} * 4)` }}
      >
        <h1 style={{ fontWeight: 700, margin: 0 }}>{label}</h1>
        <Link href={`${workspaceBase}/agent`}>{newThreadLabel}</Link>
      </div>
    </main>
  );
}

export function AgentThreadLoading({ label }: { readonly label: string }) {
  return (
    <main aria-busy="true" data-mega-agent="thread">
      <p style={{ color: MEGA_TOKENS.muted, padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)` }}>
        {label}
      </p>
    </main>
  );
}

interface AgentThreadErrorProps {
  readonly label: string;
  readonly onRetry: () => void;
  readonly retryLabel: string;
}

export function AgentThreadError({ label, onRetry, retryLabel }: AgentThreadErrorProps) {
  return (
    <main data-mega-agent="thread">
      <div
        role="alert"
        style={{
          display: "flex",
          gap: MEGA_SPACING_TOKENS[8],
          padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)`,
        }}
      >
        <p style={{ margin: 0 }}>{label}</p>
        <button data-mega-agent="retry" onClick={onRetry} type="button">
          {retryLabel}
        </button>
      </div>
    </main>
  );
}
