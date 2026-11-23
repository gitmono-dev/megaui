// megaui:apps/next-app/app/[lang]/workspace/page.tsx@0ff3a9d
"use client";

import { useQuery } from "@tanstack/react-query";
import type { CSSProperties } from "react";
import type { Workspace } from "@megaui/core";
import { megaGet, megaQueryKeys } from "@megaui/ui/query";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import { useTranslation } from "@/hooks/use-translation";
import type { HomeDashboard } from "@/lib/adapter/home";
import { authClient } from "@/lib/auth-client";
import { selfDisplayName } from "@/lib/self-display-name";

import { HomeHero } from "./components/hero";
import { HomeCardGrid } from "./components/home-card-grid";
import { KpiStrip } from "./components/kpi-strip";
import { sessionDisplayName } from "./workspace-shell-client";

const heroSectionStyle: CSSProperties = {
  background: MEGA_TOKENS.bg,
  borderBottom: `1px solid ${MEGA_TOKENS.border}`,
  padding: `calc(${MEGA_SPACING_TOKENS[8]} * 3) calc(${MEGA_SPACING_TOKENS[8]} * 3.5) calc(${MEGA_SPACING_TOKENS[8]} * 2.25)`,
};

function HomeSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" data-mega-home="skeleton" style={heroSectionStyle}>
      <span
        style={{
          clip: "rect(0 0 0 0)",
          clipPath: "inset(50%)",
          height: 1,
          overflow: "hidden",
          position: "absolute",
          whiteSpace: "nowrap",
          width: 1,
        }}
      >
        {label}
      </span>
      <div
        data-mega-home="skeleton-hero"
        style={{ background: MEGA_TOKENS.subtle, borderRadius: MEGA_RADIUS_TOKENS.md, height: 46, maxWidth: 460 }}
      />
    </div>
  );
}

export default function WorkspaceHomePage() {
  const { locale, t } = useTranslation();
  const workspaceBase = `/${locale}/workspace`;
  const { data: session, isPending: sessionPending } = authClient.useSession();

  const homeQuery = useQuery({
    queryKey: megaQueryKeys.home(),
    queryFn: () => megaGet<HomeDashboard>("home"),
  });
  const workspaceQuery = useQuery({
    queryKey: megaQueryKeys.workspace(),
    queryFn: () => megaGet<Workspace>("workspace"),
  });
  const profilePrefsQuery = useQuery({
    queryKey: ["mega", "profile-prefs"],
    queryFn: () => megaGet<{ username?: string }>("profile-prefs"),
    enabled: !sessionPending && Boolean(session?.user),
  });

  const home = t.workspace.home;

  if (homeQuery.isPending) {
    return (
      <main data-mega-home="page">
        <HomeSkeleton label={home.loading} />
      </main>
    );
  }

  if (homeQuery.isError) {
    return (
      <main data-mega-home="page">
        <div role="alert" style={{ ...heroSectionStyle, alignItems: "center", display: "flex", gap: MEGA_SPACING_TOKENS[8] }}>
          <p style={{ color: MEGA_TOKENS.muted, fontSize: "var(--mega-density-font-size)", margin: 0 }}>
            {home.error}
          </p>
          <code style={{ color: MEGA_TOKENS.muted, fontFamily: MEGA_TOKENS.fontMono, fontSize: "calc(var(--mega-density-font-size) - 3px)" }}>
            MEGA-HOME-LOAD
          </code>
          <button data-mega-shell="rail-retry" data-mega-home="retry" onClick={() => void homeQuery.refetch()} type="button">
            {home.retry}
          </button>
        </div>
      </main>
    );
  }

  // FSL-182: the greeting reads the own name only through `selfDisplayName`.
  const displayName = sessionDisplayName(
    selfDisplayName(session?.user),
    undefined,
    profilePrefsQuery.data?.username ?? home.fallbackName,
  );

  return (
    <main data-mega-home="page">
      <div style={heroSectionStyle}>
        <HomeHero
          displayName={displayName}
          labels={{ greetings: home.greetings, newDoc: home.newDoc }}
          workspace={workspaceQuery.data}
          workspaceBase={workspaceBase}
        />
        <KpiStrip kpis={homeQuery.data.kpis} labels={home.kpis} />
      </div>
      <HomeCardGrid
        cards={homeQuery.data.cards}
        labels={home.cards}
        workspaceBase={workspaceBase}
      />
    </main>
  );
}
