"use client";

import {
  Columns2, Monitor, PanelLeftClose, PanelLeftOpen, Rows2, Search, SquareDot, SquareMinus, SquarePlus, X,
} from "lucide-react";
import { useMemo, useRef, type ReactNode } from "react";

import type { CLFile } from "@megaui/core";
import { MegaFileTree } from "@megaui/ui/file-tree";

import { useTranslation } from "@/hooks/use-translation";
import { buildChangedFilesTree } from "./changed-files-tree";
import styles from "./review-navigation.module.css";

type DiffStyle = "unified" | "split";

export function filterChangedFiles(files: readonly CLFile[], filter: string): readonly CLFile[] {
  const query = filter.trim().toLowerCase();
  return query ? files.filter((file) => file.path.toLowerCase().includes(query)) : files;
}

interface ToolbarProps {
  files: readonly CLFile[];
  viewedCount: number;
  treeOpen: boolean;
  onToggleTree(): void;
  diffStyle: DiffStyle;
  onDiffStyleChange(style: DiffStyle): void;
  rangeControl?: ReactNode;
  progressHint?: string;
}

export function ReviewToolbar({
  files, viewedCount, treeOpen, onToggleTree, diffStyle, onDiffStyleChange, rangeControl, progressHint,
}: ToolbarProps) {
  const { locale, t } = useTranslation();
  const { list, toolbar } = t.workspace.clDetail.files;
  const format = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      additions += file.additions;
      deletions += file.deletions;
    }
    return { additions, deletions };
  }, [files]);
  const fileCount = format.format(files.length);
  const viewed = list.viewedProgress.replace("{viewed}", format.format(viewedCount)).replace("{total}", fileCount);
  const treeLabel = treeOpen ? list.hideTree : list.showTree;
  const TreeIcon = treeOpen ? PanelLeftClose : PanelLeftOpen;

  return (
    <div className={styles.toolbar} data-mega-cls="review-toolbar">
      <div className={styles.controls}>
        <button aria-controls="cl-review-tree" aria-expanded={treeOpen} aria-label={treeLabel}
          className={styles.treeToggle} data-mega-cls="toggle-tree" data-mega-control="" onClick={onToggleTree} title={treeLabel} type="button">
          <TreeIcon size={16} aria-hidden="true" />
        </button>
        {rangeControl}
      </div>
      <div className={styles.summary}>
        <strong>{(files.length === 1 ? list.changedOne : list.changedCount).replace("{count}", fileCount)}</strong>
        <span className={styles.additions}>+{format.format(totals.additions)}</span>
        <span className={styles.deletions}>−{format.format(totals.deletions)}</span>
      </div>
      <div className={styles.preferences}>
        <span className={styles.progress} data-mega-cls="viewed-progress" title={progressHint}>
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">
            <circle className={styles.track} cx="8" cy="8" r="6" />
            <circle className={styles.fill} cx="8" cy="8" r="6" pathLength="1"
              strokeDasharray={`${files.length ? viewedCount / files.length : 0} 1`} transform="rotate(-90 8 8)" />
          </svg>
          {viewed}
          {progressHint && <Monitor size={13} role="img" aria-label={progressHint} />}
        </span>
        <div aria-label={toolbar.styleAriaLabel} className={styles.styleGroup} role="group">
          {(["unified", "split"] as const).map((style) => {
            const Icon = style === "unified" ? Rows2 : Columns2;
            return (
              <button key={style} aria-label={toolbar[style]} aria-pressed={style === diffStyle} data-mega-control=""
                onClick={() => onDiffStyleChange(style)} title={toolbar[style]} type="button">
                <Icon size={14} aria-hidden="true" />
                <span>{toolbar[style]}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface FileTreeProps {
  /** The parent's filtered list; this is also the scope of the patch cards. */
  files: readonly CLFile[];
  activePath?: string;
  filter: string;
  onFilterChange(filter: string): void;
  onSelectPath(path: string): void;
}

const statusIcons = { added: SquarePlus, modified: SquareDot, deleted: SquareMinus };

export function ReviewFileTree({ files, activePath, filter, onFilterChange, onSelectPath }: FileTreeProps) {
  const { t } = useTranslation();
  const { list } = t.workspace.clDetail.files;
  const input = useRef<HTMLInputElement>(null);
  const { nodes, filesByPath } = useMemo(() => buildChangedFilesTree(files), [files]);
  const query = filter.trim().toLowerCase();
  const expanded = useMemo(() => {
    if (!query) return undefined;
    const ancestors = new Set<string>();
    for (const file of files) {
      let path = file.path;
      for (let slash = path.lastIndexOf("/"); slash >= 0; slash = path.lastIndexOf("/")) {
        path = path.slice(0, slash);
        if (ancestors.has(path)) break;
        ancestors.add(path);
      }
    }
    return ancestors;
  }, [files, query]);

  return (
    <aside aria-label={list.treeAriaLabel} className={styles.sidebar} data-mega-cls="files-list" id="cl-review-tree">
      <div className={styles.treeNav}>
        <div className={styles.searchBar}>
          <label className={styles.filter}>
            <Search size={15} aria-hidden="true" />
            <input ref={input} aria-label={list.filterAriaLabel} data-mega-cls="file-filter"
              onChange={(event) => onFilterChange(event.currentTarget.value)} placeholder={list.filterPlaceholder}
              type="search" value={filter} />
          </label>
          {filter && <button type="button" className={styles.clear} aria-label={list.clearFilter} data-mega-control=""
            title={list.clearFilter} onClick={() => { onFilterChange(""); input.current?.focus(); }}>
            <X aria-hidden="true" size={14} />
          </button>}
        </div>
        {files.length > 0 && (
          <MegaFileTree key={query} nodes={nodes} activePath={activePath} defaultExpanded={expanded}
            labels={{ treeAriaLabel: list.treeAriaLabel }} directoryAction="toggle" revealActiveFile width="100%"
            onSelect={(node) => onSelectPath(node.path)}
            renderRowEnd={(node) => {
              const file = node.kind === "file" ? filesByPath.get(node.path) : undefined;
              if (!file) return null;
              const StatusIcon = statusIcons[file.status];
              return (
                <span className={styles.fileStats}>
                  <span className={styles.additions}>+{file.additions}</span>{" "}
                  <span className={styles.deletions}>−{file.deletions}</span>
                  <span className={styles.status} data-status={file.status} role="img" aria-label={list[file.status]} title={list[file.status]}>
                    <StatusIcon size={13} aria-hidden="true" />
                  </span>
                </span>
              );
            }}
          />
        )}
      </div>
    </aside>
  );
}
