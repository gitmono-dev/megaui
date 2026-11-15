"use client";

import { useState } from "react";

import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

export function ChatComposer({
  disabled,
  onSend,
  placeholder,
  sendAriaLabel,
  testId = "composer",
}: {
  disabled?: boolean;
  onSend: (body: string) => void | Promise<void>;
  placeholder: string;
  sendAriaLabel: string;
  testId?: string;
}) {
  const [draft, setDraft] = useState("");

  const submit = async () => {
    const body = draft.trim();
    if (!body || disabled) return;
    try {
      await onSend(body);
      setDraft("");
    } catch {
      // Keep draft so the user can retry after a failed send.
    }
  };

  return (
    <form
      data-mega-chat={testId}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      style={{
        borderTop: `1px solid ${MEGA_TOKENS.border}`,
        display: "flex",
        gap: MEGA_SPACING_TOKENS[8],
        paddingTop: MEGA_SPACING_TOKENS[8],
      }}
    >
      <textarea
        aria-label={placeholder}
        data-mega-chat={`${testId}-input`}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder={placeholder}
        rows={2}
        style={{
          border: `1px solid ${MEGA_TOKENS.border}`,
          borderRadius: MEGA_RADIUS_TOKENS.md,
          flex: 1,
          font: "inherit",
          padding: MEGA_SPACING_TOKENS[8],
          resize: "vertical",
        }}
        value={draft}
      />
      <button
        aria-label={sendAriaLabel}
        data-mega-chat={`${testId}-send`}
        disabled={disabled || !draft.trim()}
        type="submit"
      >
        {sendAriaLabel}
      </button>
    </form>
  );
}
