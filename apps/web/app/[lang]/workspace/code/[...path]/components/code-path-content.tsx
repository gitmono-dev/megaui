import Link from "next/link";

import type { ProseBlock, TreeNode } from "@megaui/core";
import { MegaBlobView, MegaDiffsWorkerProvider } from "@megaui/ui/code-view";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";

import { ReadmeProse } from "../../components/readme-prose";
import type { SourceFilePayload } from "../lib/code-path-source";

export type CodePathContentState =
  | {
      readonly children: readonly TreeNode[];
      readonly kind: "directory";
      readonly pending: boolean;
    }
  | { readonly kind: "not-found" }
  | { readonly kind: "source-error"; readonly onRetry: () => void }
  | { readonly kind: "file-loading" }
  | { readonly kind: "preview-loading" }
  | { readonly kind: "preview-error"; readonly onRetry: () => void }
  | { readonly blocks: readonly ProseBlock[]; readonly kind: "preview" }
  | {
      readonly forcePlainText: boolean;
      readonly kind: "blob";
      readonly sourceFile: SourceFilePayload;
    };

interface CodePathContentProps {
  readonly fullPath: string;
  readonly state: CodePathContentState;
  readonly workspaceBase: string;
}

const contentPadding = { padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` };
const sectionStyle = {
  background: MEGA_TOKENS.bg,
  borderBottom: `1px solid ${MEGA_TOKENS.border}`,
  padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2)`,
};

export function CodePathContent({ fullPath, state, workspaceBase }: CodePathContentProps) {
  const { t } = useTranslation();
  const code = t.workspace.code;

  switch (state.kind) {
    case "directory":
      return (
        <div data-mega-code="dir-table" style={contentPadding}>
          {state.pending ? (
            <p aria-busy="true" data-mega-code="dir-loading">
              {code.loading}
            </p>
          ) : null}
          {!state.pending && state.children.length === 0 ? (
            <p data-mega-code="empty">{code.file.dir.empty}</p>
          ) : null}
          {!state.pending && state.children.length > 0 ? (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {state.children.map((child) => (
                <li data-mega-code="dir-row" key={child.path}>
                  <Link
                    href={`${workspaceBase}/code/${child.path.split("/").map(encodeURIComponent).join("/")}`}
                    style={{ color: MEGA_TOKENS.text, textDecoration: "none" }}
                  >
                    {child.name}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      );
    case "not-found":
      return (
        <div data-mega-code="not-found" role="status" style={contentPadding}>
          <h2>{code.file.notFoundTitle}</h2>
          <p>{code.file.notFoundBody.replace("{path}", fullPath)}</p>
          <Link href={`${workspaceBase}/code`}>{code.file.backToCode}</Link>
        </div>
      );
    case "source-error":
      return <ContentError onRetry={state.onRetry} />;
    case "file-loading":
      return (
        <div aria-busy="true" data-mega-code="file-loading" style={sectionStyle}>
          {code.loading}
        </div>
      );
    case "preview-loading":
      return <div aria-busy="true">{code.loading}</div>;
    case "preview-error":
      return <ContentError onRetry={state.onRetry} />;
    case "preview":
      return <ReadmeProse blocks={[...state.blocks]} />;
    case "blob":
      return (
        <MegaDiffsWorkerProvider>
          <div data-mega-code="blob">
            <MegaBlobView
              file={{
                name: state.sourceFile.path.split("/").at(-1) ?? state.sourceFile.path,
                contents: state.sourceFile.content,
              }}
              forcePlainText={state.forcePlainText}
              labels={{
                binaryFallback: code.file.contentUnavailable,
                copy: code.file.header.copy,
                copied: code.file.header.copied,
              }}
            />
          </div>
        </MegaDiffsWorkerProvider>
      );
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

function ContentError({ onRetry }: { readonly onRetry: () => void }) {
  const { t } = useTranslation();
  const code = t.workspace.code;
  return (
    <div role="alert" style={{ ...sectionStyle, display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
      <p style={{ margin: 0 }}>{code.file.contentUnavailable}</p>
      <button data-mega-code="retry" onClick={onRetry} type="button">
        {code.retry}
      </button>
    </div>
  );
}
