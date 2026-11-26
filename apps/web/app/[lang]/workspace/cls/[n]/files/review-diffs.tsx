"use client";

import { Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Copy, FileDiff } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import type { CLFile } from "@megaui/core";
import { MegaPatchView } from "@megaui/ui/code-view";
import { useTranslation } from "@/hooks/use-translation";

import styles from "./review-diffs.module.css";

const FILES_PER_PAGE = 5;

export function DiffStatBlocks({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  const added = total > 0 ? Math.round(5 * additions / total) : 0;
  const green = additions > 0 && deletions > 0 ? Math.min(4, Math.max(1, added)) : added;
  return (
    <span aria-hidden="true" className={styles.blocks}>
      {Array.from({ length: 5 }, (_, i) => (
        <i key={i} data-change={i < green ? "added" : deletions ? "deleted" : undefined} />
      ))}
    </span>
  );
}

interface ReviewDiffsProps {
  files: readonly CLFile[];
  activePath: string;
  jumpTarget?: { path: string } | null;
  onSelectFile: (path: string) => void;
  diffStyle?: "unified" | "split";
  viewedPending: boolean;
  onViewedChange: (path: string, viewed: boolean) => void;
}

type FileCardProps = Pick<ReviewDiffsProps, "diffStyle" | "viewedPending" | "onViewedChange"> & {
  file: CLFile;
  active: boolean;
  jumpTarget?: ReviewDiffsProps["jumpTarget"];
};

function FileCard({ file, active, jumpTarget, diffStyle, viewedPending, onViewedChange }: FileCardProps) {
  const { t } = useTranslation();
  const text = t.workspace.clDetail.files;
  const toolbar = text.toolbar;
  const bodyId = useId();
  const article = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [visited, setVisited] = useState(false);
  const [copyState, setCopyState] = useState<"copied" | "failed" | null>(null);

  useLayoutEffect(() => {
    if (active && jumpTarget?.path === file.path) setCollapsed(false);
  }, [active, jumpTarget, file.path]);

  // Only the current page can have mounted diff renderers. Within it, start syntax
  // highlighting when a card approaches the viewport, or immediately for a tree jump.
  useEffect(() => {
    if (visited || collapsed) return;
    if (active || !article.current || typeof IntersectionObserver === "undefined") {
      setVisited(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) setVisited(true);
    }, { rootMargin: "160px 0px" });
    observer.observe(article.current);
    return () => observer.disconnect();
  }, [active, collapsed, visited]);

  useEffect(() => {
    if (!copyState) return;
    const timer = window.setTimeout(() => setCopyState(null), 2500);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(file.path);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  const toggleLabel = (collapsed ? toolbar.expandFile : toolbar.collapseFile).replace("{path}", file.path);
  const copyMessage = copyState === "copied" ? toolbar.pathCopied : copyState === "failed" ? toolbar.copyFailed : "";
  const CopyIcon = copyState === "copied" ? Check : copyState === "failed" ? CircleAlert : Copy;
  return (
    <article
      aria-label={file.path}
      className={styles.card}
      data-active={active}
      data-mega-cls="file-card"
      data-path={file.path}
      ref={article}
    >
      <header className={styles.header}>
        <div className={styles.identity}>
          <button
            aria-controls={bodyId}
            aria-expanded={!collapsed}
            aria-label={toggleLabel}
            className={styles.toggle}
            data-mega-cls="file-toggle"
            type="button"
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? <ChevronRight aria-hidden="true" size={16} /> : <ChevronDown aria-hidden="true" size={16} />}
          </button>
          <span className={styles.fileIcon} data-status={file.status} title={text.list[file.status]}>
            <FileDiff size={16} aria-label={text.list[file.status]} role="img" />
          </span>
          <span className={styles.path}>
            {file.oldPath && file.oldPath !== file.path && (
              <><bdi className={styles.oldPath}>{file.oldPath}</bdi>{" → "}</>
            )}
            <bdi title={file.path}>{file.path}</bdi>
          </span>
          <button
            aria-label={toolbar.copyPath}
            className={styles.copy}
            title={copyMessage || toolbar.copyPath}
            type="button"
            onClick={() => void copyPath()}
          >
            <CopyIcon aria-hidden="true" size={14} />
          </button>
          <span className={styles.srOnly} role="status">{copyMessage}</span>
        </div>
        <div className={styles.actions}>
          <span className={styles.stats}>
            <span className={styles.add}>+{file.additions}</span>
            <span className={styles.del}>−{file.deletions}</span>
            <DiffStatBlocks additions={file.additions} deletions={file.deletions} />
          </span>
          <label className={styles.viewed}>
            <input
              checked={Boolean(file.viewed)}
              data-mega-cls="file-viewed"
              disabled={viewedPending}
              onChange={(event) => onViewedChange(file.path, event.currentTarget.checked)}
              type="checkbox"
            />
            {toolbar.viewed}
          </label>
        </div>
      </header>
      <div className={styles.content} data-mega-cls="diff-patch" hidden={collapsed} id={bodyId}>
        {!collapsed && (visited || active ? (
          <MegaPatchView
            path={file.path}
            patch={file.patch}
            diffStyle={diffStyle}
            binaryLabel={text.binary}
            emptyLabel={t.workspace.clDetail.conversation.emptyPatch}
          />
        ) : <div aria-busy="true" aria-label={text.loading} className={styles.placeholder} />)}
      </div>
    </article>
  );
}

export function ReviewDiffs({ files, activePath, jumpTarget, onSelectFile, ...cardProps }: ReviewDiffsProps) {
  const { t } = useTranslation();
  const toolbar = t.workspace.clDetail.files.toolbar;
  const list = useRef<HTMLDivElement>(null);
  const completedJump = useRef<ReviewDiffsProps["jumpTarget"]>(null);
  const activeIndex = Math.max(0, files.findIndex((file) => file.path === activePath));
  const start = Math.floor(activeIndex / FILES_PER_PAGE) * FILES_PER_PAGE;
  const end = Math.min(files.length, start + FILES_PER_PAGE);
  const previous = files[start - FILES_PER_PAGE];
  const next = files[end];

  useLayoutEffect(() => {
    if (!jumpTarget || jumpTarget.path !== activePath || completedJump.current === jumpTarget) return;
    const cards = Array.from(list.current?.querySelectorAll<HTMLElement>("article[data-path]") ?? []);
    const index = cards.findIndex((card) => card.dataset.path === activePath);
    const target = cards[index];
    if (!target) return;

    const input = new AbortController();
    let anchoredTop: number | undefined;
    function align() {
      if (!target || input.signal.aborted) return;
      // Before this file, a virtual diff or Shiki result can replace its shorter placeholder.
      // Browsers with working scroll anchoring already keep the same top coordinate.
      if (anchoredTop !== undefined && Math.abs(target.getBoundingClientRect().top - anchoredTop) < 1) return;
      completedJump.current = jumpTarget;
      target.scrollIntoView?.({ block: "start", inline: "nearest" });
      anchoredTop = target.getBoundingClientRect().top;
    }
    let frame = requestAnimationFrame(align);
    const observer = index > 0 && typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(align);
    }) : null;
    for (const card of cards.slice(0, index)) observer?.observe(card);
    const stop = () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      input.abort();
    };
    for (const event of ["wheel", "pointerdown", "touchstart", "keydown"]) {
      window.addEventListener(event, stop, { capture: true, passive: true, signal: input.signal });
    }
    return stop;
  }, [activePath, jumpTarget, start]);

  return (
    <div className={styles.stream} data-mega-cls="file-stream">
      <div className={styles.cards} ref={list}>
        {files.slice(start, end).map((file) => (
          <FileCard
            {...cardProps}
            active={file.path === activePath}
            file={file}
            jumpTarget={file.path === activePath ? jumpTarget : undefined}
            key={file.path}
          />
        ))}
      </div>
      {files.length > FILES_PER_PAGE && (
        <div className={styles.pager}>
          <span>{toolbar.filesRange.replace("{from}", String(start + 1)).replace("{to}", String(end)).replace("{total}", String(files.length))}</span>
          <div>
            <button data-mega-cls="previous-files" disabled={!previous} type="button" onClick={() => previous && onSelectFile(previous.path)}>
              <ChevronLeft aria-hidden="true" size={14} />{toolbar.previousPage}
            </button>
            <button data-mega-cls="next-files" disabled={!next} type="button" onClick={() => next && onSelectFile(next.path)}>
              {toolbar.nextPage}<ChevronRight aria-hidden="true" size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
