"use client";

import type { CSSProperties, ReactNode } from "react";

import type { Doc, DocTag, Folder } from "@megaui/core";
import { RailSection, SideNavItem } from "@megaui/ui/shell";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { UNSORTED_FOLDER_ID, type DocsScope } from "./docs-filter";
import { DocsIcon } from "./docs-icons";

export interface DocsSidebarLabels {
  allDocs: string;
  calendar: string;
  deferredTooltip: string;
  folders: string;
  imagine: string;
  newDoc: string;
  shared: string;
  starred: string;
  starredEmpty: string;
  tags: string;
  tasks: string;
  title: string;
}

export interface DocsSidebarProps {
  docs: readonly Doc[];
  folders: readonly Folder[];
  labels: DocsSidebarLabels;
  onNewDoc(): void;
  onOpenDoc(doc: Doc): void;
  onScopeChange(scope: DocsScope): void;
  scope: DocsScope;
  tags: readonly DocTag[];
}

const countStyle: CSSProperties = {
  color: MEGA_TOKENS.muted,
  fontSize: "calc(var(--mega-density-font-size) - 2px)",
};

function ActiveWrap({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div
      style={{
        background: active ? MEGA_TOKENS.activeBg : "transparent",
        borderRadius: MEGA_RADIUS_TOKENS.md,
      }}
    >
      {children}
    </div>
  );
}

/** v6 / WA-12 docs sidebar: new, All/Starred, deferred rows, starred list, derived folders/tags. */
export function DocsSidebar({
  docs,
  folders,
  labels,
  onNewDoc,
  onOpenDoc,
  onScopeChange,
  scope,
  tags,
}: DocsSidebarProps) {
  const folderCount = (folderId: string) =>
    folderId === UNSORTED_FOLDER_ID
      ? docs.filter((doc) => !doc.folderId).length
      : docs.filter((doc) => doc.folderId === folderId).length;
  const tagCount = (tagId: string) => docs.filter((doc) => doc.tags.some((tag) => tag.id === tagId)).length;
  const starredDocs = docs.filter((doc) => doc.starred);
  const deferredRows = [
    { icon: "check" as const, label: labels.tasks },
    { icon: "clock" as const, label: labels.calendar },
    { icon: "sparkle" as const, label: labels.imagine },
    { icon: "users" as const, label: labels.shared },
  ];

  return (
    <nav
      aria-label={labels.title}
      data-mega-docs="sidebar"
      style={{
        background: MEGA_TOKENS.subtle,
        borderRight: `1px solid ${MEGA_TOKENS.border}`,
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        minHeight: 0,
        overflow: "auto",
        width: 220,
      }}
    >
      <div
        style={{
          alignItems: "center",
          borderBottom: `1px solid ${MEGA_TOKENS.border}`,
          display: "flex",
          gap: MEGA_SPACING_TOKENS[8],
          padding: `calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[4]}) calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[6]})`,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            alignItems: "center",
            background: MEGA_TOKENS.accent,
            borderRadius: `calc(${MEGA_RADIUS_TOKENS.md} * 1.5)`,
            color: MEGA_TOKENS.accentForeground,
            display: "flex",
            fontSize: "calc(var(--mega-density-font-size) - 0.5px)",
            fontWeight: 700,
            height: 24,
            justifyContent: "center",
            width: 24,
          }}
        >
          M
        </span>
        <span style={{ color: MEGA_TOKENS.text, flex: 1, fontSize: "calc(var(--mega-density-font-size) - 0.5px)", fontWeight: 700 }}>
          {labels.title}
        </span>
        <DocsIcon aria-hidden="true" color={MEGA_TOKENS.muted} name="chevron-down" size={12} />
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: MEGA_SPACING_TOKENS[1],
          padding: `${MEGA_SPACING_TOKENS[8]} ${MEGA_SPACING_TOKENS[6]} ${MEGA_SPACING_TOKENS[4]}`,
        }}
      >
        <SideNavItem
          data-mega-docs="new"
          icon={<DocsIcon aria-hidden="true" color={MEGA_TOKENS.accent} name="plus" size={13} />}
          label={<span style={{ color: MEGA_TOKENS.accent, fontWeight: 600 }}>{labels.newDoc}</span>}
          onSelect={onNewDoc}
        />
        <ActiveWrap active={scope.kind === "all"}>
          <SideNavItem
            active={scope.kind === "all"}
            count={<span style={countStyle}>{docs.length}</span>}
            data-mega-docs={scope.kind === "all" ? "nav-active" : "nav"}
            data-nav="all"
            icon={
              <DocsIcon
                aria-hidden="true"
                color={scope.kind === "all" ? MEGA_TOKENS.activeFg : MEGA_TOKENS.muted}
                name="file"
                size={13}
              />
            }
            label={labels.allDocs}
            onSelect={() => onScopeChange({ kind: "all" })}
            semantics="filter"
          />
        </ActiveWrap>
        <ActiveWrap active={scope.kind === "starred"}>
          <SideNavItem
            active={scope.kind === "starred"}
            count={<span style={countStyle}>{starredDocs.length}</span>}
            data-mega-docs={scope.kind === "starred" ? "nav-active" : "nav"}
            data-nav="starred"
            icon={
              <DocsIcon
                aria-hidden="true"
                color={scope.kind === "starred" ? MEGA_TOKENS.activeFg : MEGA_TOKENS.muted}
                name="star"
                size={13}
              />
            }
            label={labels.starred}
            onSelect={() => onScopeChange({ kind: "starred" })}
            semantics="filter"
          />
        </ActiveWrap>
        {deferredRows.map((row) => (
          <SideNavItem
            disabled
            icon={<DocsIcon aria-hidden="true" color={MEGA_TOKENS.muted} name={row.icon} size={13} />}
            key={row.label}
            label={row.label}
            title={labels.deferredTooltip}
          />
        ))}
      </div>

      <RailSection label={labels.starred}>
        {starredDocs.length === 0 ? (
          <p
            style={{
              color: MEGA_TOKENS.muted,
              fontSize: "calc(var(--mega-density-font-size) - 2px)",
              lineHeight: 1.4,
              margin: 0,
              padding: `0 var(--mega-density-row-padding-x) ${MEGA_SPACING_TOKENS[6]}`,
            }}
          >
            {labels.starredEmpty}
          </p>
        ) : (
          starredDocs.map((doc) => (
            <SideNavItem
              data-mega-docs="starred-doc"
              icon={<DocsIcon aria-hidden="true" color={MEGA_TOKENS.warning} name="star" size={12} />}
              key={doc.id}
              label={doc.title}
              onSelect={() => onOpenDoc(doc)}
            />
          ))
        )}
      </RailSection>

      <RailSection label={labels.folders}>
        {folders.map((folder) => (
          <ActiveWrap active={scope.kind === "folder" && scope.folderId === folder.id} key={folder.id}>
            <SideNavItem
              active={scope.kind === "folder" && scope.folderId === folder.id}
              count={<span style={countStyle}>{folderCount(folder.id)}</span>}
              data-folder-id={folder.id}
              data-mega-docs="scope-folder"
              icon={<DocsIcon aria-hidden="true" color={MEGA_TOKENS.muted} name="folder" size={13} />}
              label={folder.name}
              onSelect={() =>
                onScopeChange(
                  scope.kind === "folder" && scope.folderId === folder.id
                    ? { kind: "all" }
                    : { kind: "folder", folderId: folder.id },
                )
              }
              semantics="filter"
            />
          </ActiveWrap>
        ))}
      </RailSection>

      <RailSection label={labels.tags}>
        {tags.map((tag) => (
          <ActiveWrap active={scope.kind === "tag" && scope.tagId === tag.id} key={tag.id}>
            <SideNavItem
              active={scope.kind === "tag" && scope.tagId === tag.id}
              count={<span style={countStyle}>{tagCount(tag.id)}</span>}
              data-mega-docs="scope-tag"
              data-tag-id={tag.id}
              icon={
                <span
                  aria-hidden="true"
                  style={{
                    background: tag.color ?? MEGA_TOKENS.accent,
                    borderRadius: MEGA_RADIUS_TOKENS.pill,
                    display: "inline-block",
                    height: 8,
                    width: 8,
                  }}
                />
              }
              label={tag.name}
              onSelect={() =>
                onScopeChange(
                  scope.kind === "tag" && scope.tagId === tag.id ? { kind: "all" } : { kind: "tag", tagId: tag.id },
                )
              }
              semantics="filter"
            />
          </ActiveWrap>
        ))}
      </RailSection>
    </nav>
  );
}
