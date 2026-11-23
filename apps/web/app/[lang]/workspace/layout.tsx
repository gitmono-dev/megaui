// megaui:apps/next-app/app/[lang]/workspace/layout.tsx@0ff3a9d
//
// Diff vs upstream (GC-03 / WA-07):
// - MegaSettingsProvider persists workspace appearance preferences locally.
// - JetBrains Mono via next/font/google (local ttf was not in megaui tree).

import { JetBrains_Mono } from "next/font/google";
import type { CSSProperties, ReactNode } from "react";
import type { Metadata } from "next";
import { getTranslation, isValidLocale } from "@megaui/i18n";
import { MegaQueryProvider } from "@megaui/ui/query";

import { MegaSettingsProvider } from "@/lib/mega-settings/provider";
import { applySiteName } from "@/lib/site-name";

import { WorkspaceShellClient } from "./workspace-shell-client";

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mega-mono",
  display: "swap",
});

const workspaceFontStyle = {
  "--mega-font-mono": "var(--font-mega-mono)",
} as CSSProperties;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  const locale = isValidLocale(lang) ? lang : "en";
  const t = getTranslation(locale);
  return {
    title: applySiteName(t.workspace.metadata.title),
    description: applySiteName(t.workspace.metadata.description),
    keywords: applySiteName(t.workspace.metadata.keywords),
  };
}

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <MegaQueryProvider>
      <MegaSettingsProvider
        className={jetbrainsMono.variable}
        style={{ ...workspaceFontStyle, height: "100dvh" }}
      >
        <WorkspaceShellClient>{children}</WorkspaceShellClient>
      </MegaSettingsProvider>
    </MegaQueryProvider>
  );
}
