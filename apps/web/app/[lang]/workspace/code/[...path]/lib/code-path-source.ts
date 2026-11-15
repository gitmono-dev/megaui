import { isLikelyBinaryContent } from "@megaui/ui/code-view";

export interface SourceFilePayload {
  readonly content: string;
  readonly language: string;
  readonly lines: number;
  readonly path: string;
  readonly sizeBytes: number;
}

const PLAINTEXT_LINE_LIMIT = 5_000;
const PLAINTEXT_BYTE_LIMIT = 512 * 1024;

export function shouldForcePlainText(sourceFile: SourceFilePayload): boolean {
  return (
    sourceFile.lines > PLAINTEXT_LINE_LIMIT ||
    sourceFile.sizeBytes > PLAINTEXT_BYTE_LIMIT ||
    isLikelyBinaryContent(sourceFile.content)
  );
}
