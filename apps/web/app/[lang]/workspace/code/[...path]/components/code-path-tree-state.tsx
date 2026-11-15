import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

interface CodePathLoadingProps {
  readonly label: string;
}

export function CodePathLoading({ label }: CodePathLoadingProps) {
  return (
    <main aria-busy="true" data-mega-code="page">
      <div
        data-mega-code="skeleton"
        style={{
          background: MEGA_TOKENS.bg,
          borderBottom: `1px solid ${MEGA_TOKENS.border}`,
          padding: `calc(${MEGA_SPACING_TOKENS[8]} * 1.5) calc(${MEGA_SPACING_TOKENS[8]} * 3.5)`,
        }}
      >
        <div
          style={{
            background: MEGA_TOKENS.subtle,
            borderRadius: MEGA_RADIUS_TOKENS.md,
            height: 32,
            maxWidth: 420,
          }}
        />
      </div>
      <span
        style={{
          clip: "rect(0 0 0 0)",
          clipPath: "inset(50%)",
          height: 1,
          overflow: "hidden",
          position: "absolute",
          whiteSpace: "nowrap",
          width: 1,
        }}
      >
        {label}
      </span>
    </main>
  );
}

interface CodePathTreeErrorProps {
  readonly label: string;
  readonly onRetry: () => void;
  readonly retryLabel: string;
}

export function CodePathTreeError({ label, onRetry, retryLabel }: CodePathTreeErrorProps) {
  return (
    <main data-mega-code="page">
      <div
        role="alert"
        style={{
          alignItems: "center",
          background: MEGA_TOKENS.bg,
          borderBottom: `1px solid ${MEGA_TOKENS.border}`,
          display: "flex",
          gap: MEGA_SPACING_TOKENS[8],
          padding: `calc(${MEGA_SPACING_TOKENS[8]} * 1.5) calc(${MEGA_SPACING_TOKENS[8]} * 3.5)`,
        }}
      >
        <p style={{ color: MEGA_TOKENS.muted, margin: 0 }}>{label}</p>
        <button data-mega-code="retry" onClick={onRetry} type="button">
          {retryLabel}
        </button>
      </div>
    </main>
  );
}
