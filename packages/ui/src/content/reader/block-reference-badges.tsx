"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";

type Badge = { blockId: string; count: number; top: number };

export function DocReferenceBadges({
  articleRef,
  counts,
  label,
  onOpen,
}: {
  articleRef: RefObject<HTMLDivElement | null>;
  counts: Readonly<Record<string, number>>;
  label: string;
  onOpen: (blockId: string) => void;
}) {
  const [badges, setBadges] = useState<Badge[]>([]);
  const sync = useCallback(() => {
    const article = articleRef.current;
    if (!article) return;
    const rect = article.getBoundingClientRect();
    const next: Badge[] = [];
    for (const block of article.querySelectorAll<HTMLElement>("[data-mega-block][data-block-id]")) {
      const blockId = block.dataset.blockId;
      if (!blockId || !counts[blockId] || block.closest('[data-mega-content="embed-block"]')) continue;
      if (block.parentElement?.closest('[data-mega-block][data-collapsed="true"]')) continue;
      const focusedOutline = block.closest<HTMLElement>('[data-mega-content="outliner"][data-mega-block-focus]');
      if (focusedOutline && !block.hasAttribute("data-mega-block-focus")) continue;
      next.push({ blockId, count: counts[blockId], top: block.getBoundingClientRect().top - rect.top + 3 });
    }
    setBadges((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  }, [articleRef, counts]);

  useEffect(() => {
    const article = articleRef.current;
    if (!article) return undefined;
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(article, { attributes: true, childList: true, subtree: true });
    const resize = new ResizeObserver(sync);
    resize.observe(article);
    window.addEventListener("resize", sync);
    return () => {
      observer.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [articleRef, sync]);

  return (
    <div data-mega-docs="reference-badges" style={{ inset: 0, pointerEvents: "none", position: "absolute" }}>
      {badges.map(({ blockId, count, top }) => (
        <button
          aria-label={label.replace("{count}", String(count))}
          data-block-id={blockId}
          data-mega-docs="reference-count"
          key={blockId}
          onClick={() => onOpen(blockId)}
          style={{
            background: "var(--mega-subtle)",
            border: "1px solid var(--mega-border)",
            borderRadius: 10,
            color: "var(--mega-muted)",
            cursor: "pointer",
            font: "inherit",
            fontSize: 11,
            minWidth: 18,
            padding: "0 4px",
            pointerEvents: "auto",
            position: "absolute",
            right: 0,
            top,
          }}
          type="button"
        >
          {count}
        </button>
      ))}
    </div>
  );
}
