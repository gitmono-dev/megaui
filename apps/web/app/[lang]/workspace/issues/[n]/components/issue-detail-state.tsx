import { WorkspaceLoading } from "../../../components/workspace-loading";
import Link from "next/link";

import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

interface IssueDetailNotFoundProps {
  readonly backToListLabel: string;
  readonly body: string;
  readonly title: string;
  readonly workspaceBase: string;
}

export function IssueDetailNotFound({
  backToListLabel,
  body,
  title,
  workspaceBase,
}: IssueDetailNotFoundProps) {
  return (
    <main data-mega-issues="detail">
      <div
        data-mega-issues="not-found"
        role="alert"
        style={{ padding: `calc(${MEGA_SPACING_TOKENS[8]} * 4)` }}
      >
        <h1 style={{ fontWeight: 700, margin: 0 }}>{title}</h1>
        <p style={{ color: MEGA_TOKENS.muted }}>{body}</p>
        <Link href={`${workspaceBase}/issues`}>{backToListLabel}</Link>
      </div>
    </main>
  );
}

export function IssueDetailLoading({ label }: { readonly label: string }) {
  return (
    <main aria-busy="true" data-mega-issues="detail">
      <WorkspaceLoading label={label} variant="page" />
    </main>
  );
}

interface IssueDetailErrorProps {
  readonly label: string;
  readonly onRetry: () => void;
  readonly retryLabel: string;
}

export function IssueDetailError({ label, onRetry, retryLabel }: IssueDetailErrorProps) {
  return (
    <main data-mega-issues="detail">
      <div
        role="alert"
        style={{
          alignItems: "center",
          display: "flex",
          gap: MEGA_SPACING_TOKENS[8],
          padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3)`,
        }}
      >
        <WorkspaceLoading label={label} variant="page" />
        <button data-mega-issues="retry" onClick={onRetry} type="button">
          {retryLabel}
        </button>
      </div>
    </main>
  );
}
