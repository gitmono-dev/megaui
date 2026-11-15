import type { FormEvent } from "react";

import type { AgentMessage } from "@megaui/core";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

interface AgentThreadComposerProps {
  readonly busy: boolean;
  readonly draft: string;
  readonly inputAriaLabel: string;
  readonly messages: readonly AgentMessage[];
  readonly placeholder: string;
  readonly regenerateLabel: string;
  readonly sendLabel: string;
  readonly onDraftChange: (value: string) => void;
  readonly onRegenerate: (messageId: string | undefined) => void;
  readonly onSubmit: (message: string) => void;
}

export function AgentThreadComposer({
  busy,
  draft,
  inputAriaLabel,
  messages,
  placeholder,
  regenerateLabel,
  sendLabel,
  onDraftChange,
  onRegenerate,
  onSubmit,
}: AgentThreadComposerProps) {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = draft.trim();
    if (message && !busy) onSubmit(message);
  };

  return (
    <form
      data-mega-agent="composer"
      onSubmit={submit}
      style={{
        borderTop: `1px solid ${MEGA_TOKENS.border}`,
        display: "flex",
        gap: MEGA_SPACING_TOKENS[8],
        paddingTop: MEGA_SPACING_TOKENS[8],
      }}
    >
      <textarea
        aria-label={inputAriaLabel}
        data-mega-agent="composer-input"
        disabled={busy}
        onChange={(event) => onDraftChange(event.target.value)}
        placeholder={placeholder}
        rows={2}
        style={{
          border: `1px solid ${MEGA_TOKENS.border}`,
          borderRadius: MEGA_RADIUS_TOKENS.md,
          flex: 1,
          font: "inherit",
          padding: MEGA_SPACING_TOKENS[8],
        }}
        value={draft}
      />
      <button data-mega-agent="composer-send" disabled={busy || !draft.trim()} type="submit">
        {sendLabel}
      </button>
      <button
        data-mega-agent="regenerate"
        disabled={busy || !lastAssistant}
        onClick={() => onRegenerate(lastAssistant?.id)}
        type="button"
      >
        {regenerateLabel}
      </button>
    </form>
  );
}
