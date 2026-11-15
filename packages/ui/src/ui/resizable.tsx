"use client"

// megaui:libs/react-shared/ui/resizable.tsx@0ff3a9d
//
// Adapted for the `react-resizable-panels@2.1.7` API actually installed in
// this package (`PanelGroup`/`Panel`/`PanelResizeHandle` + the
// `data-panel-group-direction` attribute it sets), which differs from the
// `Group`/`Panel`/`Separator` names the upstream source imports.
import { GripVerticalIcon } from "lucide-react"
import { Panel, PanelGroup, PanelResizeHandle, type PanelGroupProps, type PanelProps, type PanelResizeHandleProps } from "react-resizable-panels"

import { cn } from "../lib/cn"

function ResizablePanelGroup({ className, ...props }: PanelGroupProps) {
  return (
    <PanelGroup
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full data-[panel-group-direction=vertical]:flex-col",
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: PanelProps) {
  return <Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: PanelResizeHandleProps & { withHandle?: boolean }) {
  return (
    <PanelResizeHandle
      data-slot="resizable-handle"
      className={cn(
        "relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:outline-hidden data-[panel-group-direction=horizontal]:h-px data-[panel-group-direction=horizontal]:w-full data-[panel-group-direction=horizontal]:after:left-0 data-[panel-group-direction=horizontal]:after:h-1 data-[panel-group-direction=horizontal]:after:w-full data-[panel-group-direction=horizontal]:after:translate-x-0 data-[panel-group-direction=horizontal]:after:-translate-y-1/2 [&[data-panel-group-direction=horizontal]>div]:rotate-90",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-4 w-3 items-center justify-center rounded-xs border bg-border">
          <GripVerticalIcon className="size-2.5" />
        </div>
      )}
    </PanelResizeHandle>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
