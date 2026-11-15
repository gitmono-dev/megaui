// megaui-only: responsive document/sidebar split; ratio survives closing the sidebar.
"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { MEGA_TOKENS } from "@megaui/ui/tokens";

function widthLimits(width: number) {
  const min = width ? Math.max(25, 320 / width * 100) : 25;
  const max = width ? Math.min(65, (width - 360) / width * 100) : 65;
  return { min, max, clamp: (value: number) => Math.min(max, Math.max(min, value)) };
}

export function DocSplitPane({ children, panel, resizeLabel }: {
  children: ReactNode;
  panel?: ReactNode;
  resizeLabel: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<number | null>(null);
  const [width, setWidth] = useState(0);
  const [ratio, setRatio] = useState(45);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(entry.contentRect.width); });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  const stacked = width > 0 && width < 760;
  const { min, max, clamp } = widthLimits(width);
  const actualRatio = clamp(ratio);
  return (
    <div data-mega-docs="split-pane" ref={rootRef} style={{ display: "flex", flex: 1, flexDirection: stacked ? "column" : "row", minWidth: 0, minHeight: 0 }}>
      <div data-mega-docs="main-pane" style={{ display: "flex", flex: 1, minWidth: 0, minHeight: 0 }}>{children}</div>
      {panel ? <>
        {!stacked ? <div
          role="separator" tabIndex={0} aria-label={resizeLabel} aria-orientation="vertical"
          aria-valuemin={Math.round(min)} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(actualRatio)}
          data-mega-docs="sidebar-resizer"
          onDoubleClick={() => setRatio(45)}
          onKeyDown={(event) => {
            const limits = widthLimits(rootRef.current?.getBoundingClientRect().width ?? width);
            const current = limits.clamp(ratio);
            const step = event.shiftKey ? 10 : 2;
            const next = event.key === "ArrowLeft" ? current + step : event.key === "ArrowRight" ? current - step
              : event.key === "Home" ? limits.min : event.key === "End" ? limits.max : null;
            if (next === null) return;
            event.preventDefault();
            setRatio(limits.clamp(next));
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = event.pointerId;
            setDragging(true);
          }}
          onPointerMove={(event) => {
            if (dragRef.current !== event.pointerId) return;
            const bounds = rootRef.current?.getBoundingClientRect();
            if (bounds) setRatio(widthLimits(bounds.width).clamp((bounds.right - event.clientX) / bounds.width * 100));
          }}
          onPointerUp={(event) => {
            if (dragRef.current !== event.pointerId) return;
            event.currentTarget.releasePointerCapture(event.pointerId);
            dragRef.current = null;
            setDragging(false);
          }}
          onLostPointerCapture={() => { dragRef.current = null; setDragging(false); }}
          style={{ flex: "0 0 8px", cursor: "col-resize", touchAction: "none", background: dragging ? MEGA_TOKENS.accent : MEGA_TOKENS.border }}
        /> : null}
        <div data-mega-docs="sidebar-pane" style={{ flex: stacked ? "0 0 45%" : `0 0 ${actualRatio}%`, minWidth: 0, minHeight: 0 }}>
          {panel}
        </div>
      </> : null}
    </div>
  );
}
