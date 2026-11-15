// megaui-only (WA-08): minimal README/prose renderer (MegaProse not ported).
"use client";

import type { ProseBlock } from "@megaui/core";
import { MegaCodeBlock } from "@megaui/ui/code-view";
import { MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

export function ReadmeProse({ blocks }: { blocks: readonly ProseBlock[] }) {
  return (
    <article data-mega-code="readme" style={{ display: "grid", gap: MEGA_SPACING_TOKENS[8], padding: MEGA_SPACING_TOKENS[8] }}>
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        switch (block.type) {
          case "heading": {
            const Tag = (`h${block.level}` as "h1" | "h2" | "h3");
            return (
              <Tag key={key} style={{ margin: 0 }}>
                {block.text}
              </Tag>
            );
          }
          case "paragraph":
            return (
              <p key={key} style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                {block.text}
              </p>
            );
          case "quote":
            return (
              <blockquote
                key={key}
                style={{
                  borderLeft: `3px solid ${MEGA_TOKENS.border}`,
                  color: MEGA_TOKENS.muted,
                  margin: 0,
                  paddingLeft: MEGA_SPACING_TOKENS[8],
                }}
              >
                {block.text}
              </blockquote>
            );
          case "list":
            return (
              <ul key={key} style={{ margin: 0, paddingLeft: `calc(${MEGA_SPACING_TOKENS[8]} * 2)` }}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>
                    {item.text}
                    {item.detail ? <span style={{ color: MEGA_TOKENS.muted }}> — {item.detail}</span> : null}
                  </li>
                ))}
              </ul>
            );
          case "code":
            return (
              <div key={key}>
                <MegaCodeBlock language={block.language} text={block.text} />
              </div>
            );
          case "divider":
            return <hr key={key} style={{ borderColor: MEGA_TOKENS.border, width: "100%" }} />;
          default:
            return null;
        }
      })}
    </article>
  );
}
