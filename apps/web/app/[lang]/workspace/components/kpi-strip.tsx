// megaui:apps/next-app/app/[lang]/workspace/components/kpi-strip.tsx@0ff3a9d
"use client";

import { ShellIcon, type ShellIconName } from "@megaui/ui/shell";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

import type { HomeKpis } from "@/lib/adapter/home";

export interface KpiStripLabels {
  agentSessions: string;
  ci: Record<HomeKpis["mainCI"], string>;
  mainCI: string;
  mentions: string;
  myOpenIssues: string;
  reviewsRequested: string;
  sessionsToday: string;
}

function StatTile({
  icon,
  label,
  value,
}: {
  icon: ShellIconName;
  label: string;
  value: string | number;
}) {
  return (
    <div
      data-mega-home="kpi"
      style={{
        background: MEGA_TOKENS.subtle,
        border: `1px solid ${MEGA_TOKENS.border}`,
        borderRadius: MEGA_RADIUS_TOKENS.md,
        padding: MEGA_SPACING_TOKENS[8],
      }}
    >
      <div style={{ alignItems: "center", color: MEGA_TOKENS.muted, display: "flex", gap: MEGA_SPACING_TOKENS[6], fontSize: "calc(var(--mega-density-font-size) - 1px)" }}>
        <ShellIcon name={icon} size={14} />
        {label}
      </div>
      <div style={{ color: MEGA_TOKENS.text, fontSize: 22, fontWeight: 650, marginTop: MEGA_SPACING_TOKENS[6] }}>
        {value}
      </div>
    </div>
  );
}

export function KpiStrip({ kpis, labels }: { kpis: HomeKpis; labels: KpiStripLabels }) {
  return (
    <div
      data-mega-home="kpi-strip"
      style={{
        display: "grid",
        gap: `calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[1]} + ${MEGA_SPACING_TOKENS[1]})`,
        gridTemplateColumns: "repeat(5, 1fr)",
        marginTop: `calc(${MEGA_SPACING_TOKENS[8]} * 2 + ${MEGA_SPACING_TOKENS[1]} * 2)`,
      }}
    >
      <StatTile icon="git-pull" label={labels.reviewsRequested} value={kpis.reviewsRequested} />
      <StatTile icon="chat" label={labels.mentions} value={kpis.mentions} />
      <StatTile icon="diamond" label={labels.myOpenIssues} value={kpis.myOpenIssues} />
      <StatTile icon="code" label={labels.mainCI} value={labels.ci[kpis.mainCI]} />
      <StatTile
        icon="sparkle"
        label={labels.agentSessions}
        value={labels.sessionsToday.replace("{count}", String(kpis.agentSessionsToday))}
      />
    </div>
  );
}
