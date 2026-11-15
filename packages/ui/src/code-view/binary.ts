/**
 * New for UI-08. `@pierre/diffs`'s `FileContents`/`FileDiffMetadata` types
 * carry no `isBinary` flag — highlighting/diffing binary content is the
 * caller's responsibility to avoid before handing it to `File`/`FileDiff`.
 * This mirrors git's own heuristic: a NUL byte anywhere in a bounded
 * prefix is a cheap, reliable binary signal that real source text never
 * produces.
 */
const BINARY_SNIFF_LENGTH = 8_000

export function isLikelyBinaryContent(contents: string): boolean {
  const sample = contents.length > BINARY_SNIFF_LENGTH ? contents.slice(0, BINARY_SNIFF_LENGTH) : contents
  return sample.includes("\u0000")
}
