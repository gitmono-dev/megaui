"use client";

import type { Doc } from "@megaui/core";
import { ShellAvatar } from "@megaui/ui/shell";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { DocsIcon } from "./docs-icons";
import { previewLines } from "./docs-filter";
import { RelativeTime } from "./relative-time";

export interface DocCardLabels {
  commentsAriaLabel: string;
  starAriaLabel: string;
  unstarAriaLabel: string;
}

export interface DocCardProps {
  doc: Doc;
  labels: DocCardLabels;
  locale: string;
  now: string;
  onOpen(doc: Doc): void;
  onToggleStar(doc: Doc): void;
}

function Hero({ doc }: { doc: Doc }) {
  if (doc.hero === "mountain") {
    return (
      <svg aria-hidden="true" style={{ display: "block", height: "100%", width: "100%" }} viewBox="0 0 200 100">
        <defs>
          <linearGradient id={`mega-doc-sky-${doc.id}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#fde68a" />
            <stop offset="1" stopColor="#fb923c" />
          </linearGradient>
        </defs>
        <rect fill={`url(#mega-doc-sky-${doc.id})`} height="100" width="200" />
        <circle cx="150" cy="32" fill="#fef3c7" opacity="0.9" r="16" />
        <polygon fill="#3b2d26" opacity="0.85" points="0,80 40,40 80,65 110,30 150,70 200,50 200,100 0,100" />
        <polygon fill="#1f2937" points="0,100 60,70 100,85 140,60 200,90 200,100" />
      </svg>
    );
  }
  if (doc.hero === "stream") {
    return (
      <svg aria-hidden="true" style={{ display: "block", height: "100%", width: "100%" }} viewBox="0 0 200 100">
        <rect fill={MEGA_TOKENS.subtle} height="100" width="200" />
        {[MEGA_TOKENS.accent, "#22c55e", "#f59e0b", "#e11d48", "#8b5cf6"].map((fill, index) => (
          <rect fill={fill} height={60} key={fill} opacity="0.85" rx={5} width={28} x={12 + index * 36} y={20} />
        ))}
        {Array.from({ length: 4 }, (_, index) => (
          <line
            key={index}
            stroke={MEGA_TOKENS.muted}
            strokeWidth="1.5"
            x1={40 + index * 36}
            x2={48 + index * 36}
            y1={50}
            y2={50}
          />
        ))}
      </svg>
    );
  }
  return null;
}

/** Masonry card: tag + relative time, title, optional hero, preview, author/comments/star. */
export function DocCard({ doc, labels, locale, now, onOpen, onToggleStar }: DocCardProps) {
  const tag = doc.tags[0];
  const tagColor = tag?.color ?? MEGA_TOKENS.accent;
  const lines = previewLines(doc);

  return (
    <article
      data-doc-id={doc.id}
      data-mega-docs="card"
      data-starred={doc.starred ? "true" : "false"}
      style={{
        background: MEGA_TOKENS.bg,
        border: `1px solid ${MEGA_TOKENS.border}`,
        borderRadius: `calc(${MEGA_RADIUS_TOKENS.md} * 2.5)`,
        breakInside: "avoid",
        display: "flex",
        flexDirection: "column",
        marginBottom: `calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[6]})`,
        overflow: "hidden",
        position: "relative",
      }}
    >
      <button
        data-mega-docs="card-open"
        onClick={() => onOpen(doc)}
        style={{
          background: "transparent",
          border: "none",
          color: "inherit",
          cursor: "pointer",
          display: "block",
          fontFamily: "inherit",
          padding: 0,
          textAlign: "left",
          width: "100%",
        }}
        type="button"
      >
        <div
          style={{
            padding: `calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[4]}) calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[6]}) calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[1]})`,
          }}
        >
          <div
            style={{
              alignItems: "center",
              display: "flex",
              gap: MEGA_SPACING_TOKENS[6],
              marginBottom: MEGA_SPACING_TOKENS[6],
            }}
          >
            {tag ? (
              <span
                style={{
                  background: `color-mix(in srgb, ${tagColor} 13%, transparent)`,
                  borderRadius: MEGA_RADIUS_TOKENS.md,
                  color: tagColor,
                  fontSize: "calc(var(--mega-density-font-size) - 3px)",
                  fontWeight: 700,
                  padding: `${MEGA_SPACING_TOKENS[1]} ${MEGA_SPACING_TOKENS[6]}`,
                }}
              >
                {tag.name}
              </span>
            ) : null}
            <span style={{ color: MEGA_TOKENS.muted, fontSize: "calc(var(--mega-density-font-size) - 2.5px)" }}>
              <RelativeTime locale={locale} now={now} value={doc.updatedAt} />
            </span>
          </div>
          <h3
            style={{
              color: MEGA_TOKENS.text,
              display: "-webkit-box",
              fontSize: "calc(var(--mega-density-font-size) + 1.5px)",
              fontWeight: 700,
              lineHeight: 1.3,
              margin: 0,
              overflow: "hidden",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: 2,
            }}
          >
            {doc.title}
          </h3>
        </div>

        {doc.hero ? (
          <div
            style={{
              aspectRatio: "2 / 1",
              background: MEGA_TOKENS.subtle,
              borderBottom: `1px solid ${MEGA_TOKENS.border}`,
              borderTop: `1px solid ${MEGA_TOKENS.border}`,
            }}
          >
            <Hero doc={doc} />
          </div>
        ) : null}

        {lines.length > 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: MEGA_SPACING_TOKENS[3],
              padding: `calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[1]}) calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[6]}) calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[4]})`,
            }}
          >
            {lines.map((line, index) => (
              <div
                key={line}
                style={{
                  color: index === 0 ? MEGA_TOKENS.text : MEGA_TOKENS.muted,
                  fontSize: "calc(var(--mega-density-font-size) - 2px)",
                  fontWeight: index === 0 ? 500 : 400,
                  lineHeight: 1.5,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {line}
              </div>
            ))}
          </div>
        ) : null}
      </button>

      <div
        style={{
          alignItems: "center",
          background: MEGA_TOKENS.subtle,
          borderTop: `1px solid ${MEGA_TOKENS.border}`,
          display: "flex",
          gap: MEGA_SPACING_TOKENS[6],
          padding: `${MEGA_SPACING_TOKENS[8]} calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[4]})`,
        }}
      >
        <ShellAvatar size={16} user={doc.author} />
        <span
          style={{
            color: MEGA_TOKENS.muted,
            flex: 1,
            fontSize: "calc(var(--mega-density-font-size) - 2px)",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {doc.author.displayName}
        </span>
        <span
          aria-label={labels.commentsAriaLabel.replace("{count}", String(doc.commentCount))}
          role="img"
          style={{
            alignItems: "center",
            color: MEGA_TOKENS.muted,
            display: "inline-flex",
            fontSize: "calc(var(--mega-density-font-size) - 2.5px)",
            gap: MEGA_SPACING_TOKENS[3],
          }}
        >
          <DocsIcon aria-hidden="true" color={MEGA_TOKENS.muted} name="chat" size={11} /> {doc.commentCount}
        </span>
        <button
          aria-label={(doc.starred ? labels.unstarAriaLabel : labels.starAriaLabel).replace("{title}", doc.title)}
          aria-pressed={doc.starred}
          className="mega-doc-star"
          data-mega-docs="star"
          data-starred={doc.starred ? "true" : "false"}
          onClick={(event) => {
            event.stopPropagation();
            onToggleStar(doc);
          }}
          style={{
            alignItems: "center",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            display: "inline-flex",
            opacity: doc.starred ? 1 : undefined,
            padding: 0,
          }}
          type="button"
        >
          <DocsIcon color={doc.starred ? MEGA_TOKENS.warning : MEGA_TOKENS.muted} name="star" size={13} />
        </button>
      </div>
    </article>
  );
}
