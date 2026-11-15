/**
 * megaui:libs/react-shared/components/mega/query/optimistic.ts@0ff3a9d
 *
 * Generic optimistic-cache arithmetic shared by workspace mutations.
 *
 * Diff vs upstream (GC-03, registered on the UI-04 task card):
 * - Upstream imported `InlineComment`/`InlineCommentReply` from
 *   `@libs/mega`. In megaui those types port 1:1 into `@megaui/core`
 *   (CL domain, `packages/core/README.md` "Kept as-is"), but
 *   `packages/ui` does not declare a `@megaui/core` workspace dependency
 *   yet — UI-04's write set is `packages/ui/src/query/**` only, and
 *   adding the dependency touches `package.json` (out of scope;
 *   ADR-ARCH-01 permits `ui -> core` for a future card that needs it).
 *   The thread-reply helpers below therefore declare the minimal local
 *   `InlineComment`/`InlineCommentReply` shape they actually touch
 *   (`id`/`resolvedAt`/`replies` and `id`, respectively); `@megaui/core`'s
 *   richer types satisfy this structurally, so callers passing the real
 *   domain objects need no cast.
 * - Behavior is otherwise unchanged: these stay pure array/object
 *   transforms with no `QueryClient` coupling, so callers own the
 *   `onMutate` snapshot + `onError` rollback wiring (see
 *   `optimistic.test.ts`'s "rollback on failure (GC-08)" suite for the
 *   expected snapshot/apply/rollback cycle these functions compose into).
 */

/** Minimal local mirror of `@megaui/core`'s `InlineCommentReply` (see module header). */
interface InlineCommentReply {
  id: string
}

/** Minimal local mirror of `@megaui/core`'s `InlineComment` (see module header). */
interface InlineComment {
  id: string
  resolvedAt?: string
  replies: readonly InlineCommentReply[]
}

/** Replaces the temporary optimistic entry with the server result. */
export function replaceById<T extends { id: string }>(
  list: readonly T[] | undefined,
  temporaryId: string,
  replacement: T,
): T[] | undefined {
  if (!list) return [replacement]
  return list.map((candidate) => (candidate.id === temporaryId ? replacement : candidate))
}

export function appendItem<T>(list: readonly T[] | undefined, item: T): T[] {
  return list ? [...list, item] : [item]
}

/** Appends a reply to one inline thread (CL-05 optimistic reply). */
export function appendThreadReply(
  comments: readonly InlineComment[] | undefined,
  commentId: string,
  reply: InlineCommentReply,
): InlineComment[] | undefined {
  return comments?.map((comment) => comment.id === commentId
    ? { ...comment, replies: [...comment.replies, reply] }
    : comment)
}

/** Swaps the temporary optimistic reply for the server reply inside its thread. */
export function replaceThreadReply(
  comments: readonly InlineComment[] | undefined,
  commentId: string,
  temporaryId: string,
  reply: InlineCommentReply,
): InlineComment[] | undefined {
  return comments?.map((comment) => comment.id === commentId
    ? { ...comment, replies: comment.replies.map((candidate) => candidate.id === temporaryId ? reply : candidate) }
    : comment)
}

/** Sets one thread's resolved timestamp (CL-05 optimistic resolve/unresolve toggle). */
export function setThreadResolved(
  comments: readonly InlineComment[] | undefined,
  commentId: string,
  resolvedAt: string | undefined,
): InlineComment[] | undefined {
  return comments?.map((comment) => comment.id === commentId ? { ...comment, resolvedAt } : comment)
}

/** Removes one entry by id (surgical rollback for an optimistic insert). */
export function removeItemById<T extends { id: string }>(
  list: readonly T[] | undefined,
  id: string,
): T[] | undefined {
  return list?.filter((candidate) => candidate.id !== id)
}

/** Removes one reply from its thread (surgical rollback for an optimistic reply). */
export function removeThreadReply(
  comments: readonly InlineComment[] | undefined,
  commentId: string,
  replyId: string,
): InlineComment[] | undefined {
  return comments?.map((comment) => comment.id === commentId
    ? { ...comment, replies: comment.replies.filter((candidate) => candidate.id !== replyId) }
    : comment)
}
