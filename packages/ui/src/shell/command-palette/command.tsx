// megaui:libs/react-shared/ui/command.tsx@0ff3a9d (subset: Command/CommandInput/CommandList/CommandGroup/CommandItem)
"use client"

import { Command as CommandPrimitive } from "cmdk"
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react"

// cmdk's own prop types don't declare a `data-*` index signature, so the
// palette's `data-mega-*` markup hooks (used by tests + `../styles/mega.css`
// selectors) are added explicitly on each wrapper below.
type DataMegaPalette = { "data-mega-palette"?: string }

export const Command = forwardRef<ElementRef<typeof CommandPrimitive>, ComponentPropsWithoutRef<typeof CommandPrimitive> & DataMegaPalette>(
  function Command(props, ref) {
    return <CommandPrimitive data-slot="command" ref={ref} {...props} />
  },
)

export const CommandInput = forwardRef<ElementRef<typeof CommandPrimitive.Input>, ComponentPropsWithoutRef<typeof CommandPrimitive.Input> & DataMegaPalette>(
  function CommandInput(props, ref) {
    return <CommandPrimitive.Input data-slot="command-input" ref={ref} {...props} />
  },
)

export const CommandList = forwardRef<ElementRef<typeof CommandPrimitive.List>, ComponentPropsWithoutRef<typeof CommandPrimitive.List> & DataMegaPalette>(
  function CommandList(props, ref) {
    return <CommandPrimitive.List data-slot="command-list" ref={ref} {...props} />
  },
)

export const CommandGroup = forwardRef<ElementRef<typeof CommandPrimitive.Group>, ComponentPropsWithoutRef<typeof CommandPrimitive.Group> & DataMegaPalette>(
  function CommandGroup(props, ref) {
    return <CommandPrimitive.Group data-slot="command-group" ref={ref} {...props} />
  },
)

export const CommandItem = forwardRef<ElementRef<typeof CommandPrimitive.Item>, ComponentPropsWithoutRef<typeof CommandPrimitive.Item> & DataMegaPalette & { "data-mega-href"?: string }>(
  function CommandItem(props, ref) {
    return <CommandPrimitive.Item data-slot="command-item" ref={ref} {...props} />
  },
)
