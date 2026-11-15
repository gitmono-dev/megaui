"use client"

// megaui:libs/react-shared/components/ai-elements/conversation.tsx@0ff3a9d
//
// Diff vs upstream (GC-03, registered on the UI-09 task card):
// - Upstream's "stick to bottom" behavior comes from the third-party
//   `use-stick-to-bottom` package, which is not a `packages/ui` dependency.
//   This port implements the same is-at-bottom tracking + smooth
//   scroll-to-bottom with a small local context instead of adding that
//   dependency for one composite.
// - `ConversationEmptyState` delegates to the shared `EmptyState` control
//   (see that module's header) instead of inlining its own copy, and its
//   `title`/`description` have no hardcoded default (upstream defaulted to
//   "No messages yet" / "Start a conversation to see messages here" —
//   this card's AC requires zero hardcoded user-facing strings, GC-14).
// - Spreading `{...props}` after `onScroll`/`ref` was rejected (ER-05):
//   compose caller handlers instead of letting props overwrite internals.
// - Bottom state is also recomputed on content resize/mutation so the
//   scroll button stays correct when the transcript grows without a scroll.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type Ref,
  type UIEvent,
} from "react"
import { ArrowDownIcon } from "lucide-react"

import { EmptyState, type EmptyStateProps } from "../controls/empty-state"
import { cn } from "../lib/cn"
import { Button } from "../ui/button"

interface ConversationContextValue {
  isAtBottom: boolean
  scrollToBottom(): void
}

const ConversationContext = createContext<ConversationContextValue | null>(null)

function useConversationContext(): ConversationContextValue {
  const context = useContext(ConversationContext)
  if (!context) throw new Error("Conversation* components must be rendered inside <Conversation>")
  return context
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") {
    ref(value)
  } else if (ref && typeof ref === "object") {
    ;(ref as { current: T | null }).current = value
  }
}

export type ConversationProps = ComponentProps<"div">

/** A scrollable chat/agent transcript container that tracks bottom-anchoring. */
export function Conversation({
  children,
  className,
  onScroll,
  ref: refProp,
  ...props
}: ConversationProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)

  const updateBottom = useCallback((el: HTMLDivElement) => {
    setIsAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 16)
  }, [])

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      updateBottom(event.currentTarget)
      onScroll?.(event)
    },
    [onScroll, updateBottom],
  )

  const setContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node
      assignRef(refProp, node)
    },
    [refProp],
  )

  const scrollToBottom = useCallback(() => {
    containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight, behavior: "smooth" })
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    updateBottom(el)
    const resizeObserver = new ResizeObserver(() => updateBottom(el))
    resizeObserver.observe(el)
    const mutationObserver = new MutationObserver(() => updateBottom(el))
    mutationObserver.observe(el, { childList: true, subtree: true, characterData: true })
    return () => {
      resizeObserver.disconnect()
      mutationObserver.disconnect()
    }
  }, [children, updateBottom])

  return (
    <ConversationContext.Provider value={{ isAtBottom, scrollToBottom }}>
      <div
        {...props}
        className={cn("relative flex-1 overflow-y-auto", className)}
        onScroll={handleScroll}
        ref={setContainerRef}
        role="log"
      >
        {children}
      </div>
    </ConversationContext.Provider>
  )
}

export type ConversationContentProps = ComponentProps<"div">

export function ConversationContent({ className, ...props }: ConversationContentProps) {
  return <div className={cn("p-4", className)} {...props} />
}

export type ConversationEmptyStateProps = EmptyStateProps

export function ConversationEmptyState(props: ConversationEmptyStateProps) {
  return <EmptyState {...props} />
}

export interface ConversationScrollButtonProps extends ComponentProps<typeof Button> {
  /** Accessible label for the scroll-to-bottom action (required; GC-14). */
  label: string
  icon?: ReactNode
}

export function ConversationScrollButton({
  className,
  icon,
  label,
  onClick,
  ...props
}: ConversationScrollButtonProps) {
  const { isAtBottom, scrollToBottom } = useConversationContext()

  if (isAtBottom) return null

  return (
    <Button
      {...props}
      aria-label={label}
      className={cn("absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full", className)}
      onClick={(event) => {
        scrollToBottom()
        onClick?.(event)
      }}
      size="icon"
      type="button"
      variant="outline"
    >
      {icon ?? <ArrowDownIcon className="size-4" />}
    </Button>
  )
}
