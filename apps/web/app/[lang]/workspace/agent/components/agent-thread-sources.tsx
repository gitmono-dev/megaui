import type { Citation } from "@megaui/core";
import { MessageCitations } from "@megaui/ui/ai-elements";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

interface AgentThreadSourcesProps {
  readonly citations: readonly Citation[];
  readonly citationsLabel: string;
  readonly emptyLabel: string;
  readonly panelAriaLabel: string;
  readonly scopeHint: string;
  readonly scopeLabel: string;
}

export function AgentThreadSources({
  citations,
  citationsLabel,
  emptyLabel,
  panelAriaLabel,
  scopeHint,
  scopeLabel,
}: AgentThreadSourcesProps) {
  return (
    <aside
      aria-label={panelAriaLabel}
      data-mega-agent="sources"
      style={{
        borderLeft: `1px solid ${MEGA_TOKENS.border}`,
        minWidth: 220,
        paddingLeft: MEGA_SPACING_TOKENS[8],
      }}
    >
      <h2 style={{ fontSize: "0.95rem", fontWeight: 700 }}>{citationsLabel}</h2>
      {citations.length === 0 ? (
        <p data-mega-agent="citations-empty" style={{ color: MEGA_TOKENS.muted }}>
          {emptyLabel}
        </p>
      ) : (
        <MessageCitations citations={[...citations]} label={citationsLabel} />
      )}
      <h2 style={{ fontSize: "0.95rem", fontWeight: 700 }}>{scopeLabel}</h2>
      <p style={{ color: MEGA_TOKENS.muted }}>{scopeHint}</p>
    </aside>
  );
}
