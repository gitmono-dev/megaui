"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import type { Doc } from "@megaui/core";
import { ShellAvatar } from "@megaui/ui/shell";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { DocsIcon } from "./docs-icons";
import { RelativeTime } from "./relative-time";

export interface DocMetaSidebarLabels {
  collaborators: string;
  linked: string;
  none: string;
  recentVersions: string;
  roleAuthor: string;
  roleEditor: string;
  tags: string;
  versionAriaLabel: string;
  versionLine: string;
  versionsTitle: string;
}

export interface DocMetaSidebarProps {
  activeVersion?: number;
  doc: Doc;
  labels: DocMetaSidebarLabels;
  locale: string;
  now: string;
  pathname: string;
  versionPanel?: ReactNode;
  workspaceBase: string;
}

const sectionTitleStyle = {
  color: MEGA_TOKENS.muted,
  fontSize: "calc(var(--mega-density-font-size) - 2px)",
  fontWeight: 700,
  letterSpacing: 0.5,
  marginBottom: MEGA_SPACING_TOKENS[8],
  textTransform: "uppercase" as const,
};

function Divider() {
  return (
    <div
      style={{
        borderBottom: `1px solid ${MEGA_TOKENS.border}`,
        margin: `calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[6]}) 0`,
      }}
    />
  );
}

function interpolateVersionLine(
  template: string,
  version: { createdAt: string; summary?: string; version: number },
  locale: string,
  now: string,
) {
  return template.split(/(\{version\}|\{time\}|\{summary\})/u).map((token, index) => {
    if (token === "{version}") return <span key={index}>v{version.version}</span>;
    if (token === "{time}") return <RelativeTime key={index} locale={locale} now={now} value={version.createdAt} />;
    if (token === "{summary}") {
      return (
        <span key={index} style={{ color: MEGA_TOKENS.text }}>
          {version.summary ?? "—"}
        </span>
      );
    }
    return <span key={index}>{token}</span>;
  });
}

/** DC-02 right rail: people, tags, linked CLs/issues, versions. */
export function DocMetaSidebar({
  activeVersion,
  doc,
  labels,
  locale,
  now,
  pathname,
  versionPanel,
  workspaceBase,
}: DocMetaSidebarProps) {
  const people = [
    { role: labels.roleAuthor, user: doc.author },
    ...doc.collaborators
      .filter((user) => user.id !== doc.author.id)
      .map((user) => ({ role: labels.roleEditor, user })),
  ];
  const versions = [...doc.versions].sort((left, right) => right.version - left.version);

  return (
    <aside
      data-mega-docs="sidebar"
      style={{
        background: MEGA_TOKENS.bg,
        borderLeft: `1px solid ${MEGA_TOKENS.border}`,
        flexShrink: 0,
        minHeight: 0,
        overflow: "auto",
        padding: `calc(${MEGA_SPACING_TOKENS[8]} * 2.25) calc(${MEGA_SPACING_TOKENS[8]} * 2)`,
        width: 260,
      }}
    >
      <section>
        <div style={sectionTitleStyle}>{labels.collaborators}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: MEGA_SPACING_TOKENS[6] }}>
          {people.length === 0 ? (
            <span style={{ color: MEGA_TOKENS.muted, fontSize: "calc(var(--mega-density-font-size) - 1.5px)" }}>
              {labels.none}
            </span>
          ) : (
            people.map((entry) => (
              <div
                key={entry.user.id}
                style={{
                  alignItems: "center",
                  display: "flex",
                  fontSize: "calc(var(--mega-density-font-size) - 1px)",
                  gap: MEGA_SPACING_TOKENS[6],
                }}
              >
                <ShellAvatar size={20} user={entry.user} />
                <span style={{ color: MEGA_TOKENS.text, flex: 1 }}>{entry.user.displayName}</span>
                <span style={{ color: MEGA_TOKENS.muted, fontSize: "calc(var(--mega-density-font-size) - 2.5px)" }}>
                  {entry.role}
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      <Divider />

      <section>
        <div style={sectionTitleStyle}>{labels.tags}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: MEGA_SPACING_TOKENS[5] }}>
          {doc.tags.length === 0 ? (
            <span style={{ color: MEGA_TOKENS.muted, fontSize: "calc(var(--mega-density-font-size) - 1.5px)" }}>
              {labels.none}
            </span>
          ) : (
            doc.tags.map((tag) => {
              const color = tag.color ?? MEGA_TOKENS.accent;
              return (
                <span
                  key={tag.id}
                  style={{
                    background: `color-mix(in srgb, ${color} 9%, transparent)`,
                    borderRadius: MEGA_RADIUS_TOKENS.pill,
                    color,
                    fontSize: "calc(var(--mega-density-font-size) - 2.5px)",
                    padding: `${MEGA_SPACING_TOKENS[1]} ${MEGA_SPACING_TOKENS[8]}`,
                  }}
                >
                  {tag.name}
                </span>
              );
            })
          )}
        </div>
      </section>

      <Divider />

      <section>
        <div style={sectionTitleStyle}>{labels.linked}</div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            fontSize: "calc(var(--mega-density-font-size) - 1px)",
            gap: MEGA_SPACING_TOKENS[5],
          }}
        >
          {doc.linkedCLs.length === 0 && doc.linkedIssues.length === 0 ? (
            <span style={{ color: MEGA_TOKENS.muted }}>{labels.none}</span>
          ) : null}
          {doc.linkedCLs.map((publicId) => (
            <Link
              href={`${workspaceBase}/cls/${publicId}`}
              key={`cl-${publicId}`}
              style={{
                alignItems: "center",
                color: MEGA_TOKENS.accent,
                display: "inline-flex",
                gap: MEGA_SPACING_TOKENS[5],
                textDecoration: "none",
              }}
            >
              <DocsIcon aria-hidden="true" color={MEGA_TOKENS.accent} name="git-pull" size={11} />{publicId}
            </Link>
          ))}
          {doc.linkedIssues.map((number) => (
            <Link
              href={`${workspaceBase}/issues/${number}`}
              key={`issue-${number}`}
              style={{
                alignItems: "center",
                color: MEGA_TOKENS.accent,
                display: "inline-flex",
                gap: MEGA_SPACING_TOKENS[5],
                textDecoration: "none",
              }}
            >
              <DocsIcon aria-hidden="true" color={MEGA_TOKENS.accent} name="diamond" size={11} />#{number}
            </Link>
          ))}
        </div>
      </section>

      <Divider />

      {versionPanel ?? (
        <section data-mega-docs="versions">
          <div style={sectionTitleStyle}>{labels.versionsTitle}</div>
          {versions.length === 0 ? (
            <p style={{ color: MEGA_TOKENS.muted, margin: 0 }}>{labels.none}</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: MEGA_SPACING_TOKENS[3] }}>
              {versions.map((version) => {
                const active = version.version === activeVersion;
                return (
                  <Link
                    aria-current={active ? "true" : undefined}
                    aria-label={labels.versionAriaLabel.replace("{version}", String(version.version))}
                    data-mega-docs="version-link"
                    href={`${pathname}?v=${version.version}`}
                    key={version.id}
                    style={{
                      background: active ? MEGA_TOKENS.activeBg : "transparent",
                      borderLeft: `2px solid ${active ? MEGA_TOKENS.accent : "transparent"}`,
                      borderRadius: MEGA_RADIUS_TOKENS.md,
                      color: MEGA_TOKENS.muted,
                      display: "block",
                      fontFamily: MEGA_TOKENS.fontMono,
                      fontSize: "calc(var(--mega-density-font-size) - 2px)",
                      padding: `${MEGA_SPACING_TOKENS[3]} ${MEGA_SPACING_TOKENS[6]}`,
                      textDecoration: "none",
                    }}
                  >
                    {interpolateVersionLine(labels.versionLine, version, locale, now)}
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      )}
    </aside>
  );
}
