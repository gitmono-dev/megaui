"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./issue-markdown.module.css";

export function IssueMarkdown({ text }: { text: string }) {
  return <div className={styles.content}><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>;
}
