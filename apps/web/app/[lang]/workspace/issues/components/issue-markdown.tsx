"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MegaCodeBlock } from "@megaui/ui/code-view";
import styles from "./issue-markdown.module.css";

// GFM code fences and indented code blocks share the same renderer as code
// browsing and diffs. Inline code remains an ordinary <code> element.
const markdownComponents: Components = {
  pre({ node, children, ...props }) {
    const code = node?.children[0];
    if (code?.type !== "element" || code.tagName !== "code" || code.children.some(child => child.type !== "text")) {
      return <pre {...props}>{children}</pre>;
    }
    const classes: unknown = code.properties.className;
    const names: unknown[] = Array.isArray(classes) ? classes : typeof classes === "string" ? classes.split(/\s+/) : [];
    const languageClass = names.find(name => typeof name === "string" && name.startsWith("language-"));
    const language = typeof languageClass === "string" ? languageClass.slice("language-".length) || undefined : undefined;
    const text = code.children.map(child => child.type === "text" ? child.value : "").join("");
    return <MegaCodeBlock language={language} text={text} />;
  },
};

export function IssueMarkdown({ text }: { text: string }) {
  return <div className={styles.content}><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={markdownComponents}>{text}</ReactMarkdown></div>;
}
