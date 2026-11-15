// megaui:apps/next-app/app/[lang]/workspace/components/hero.tsx@0ff3a9d
"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";
import type { Workspace } from "@megaui/core";
import { ShellIcon } from "@megaui/ui/shell";
import { MEGA_RADIUS_TOKENS, MEGA_SPACING_TOKENS, MEGA_TOKENS } from "@megaui/ui/tokens";

export interface HomeHeroLabels {
  askAgent: string;
  greetings: {
    day: string;
    evening: string;
    afternoon: string;
    morning: string;
  };
  newDoc: string;
}

type DayPeriod = keyof HomeHeroLabels["greetings"];

function periodOfHour(hour: number): DayPeriod {
  if (hour < 5) return "evening";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function useDayPeriod(): DayPeriod {
  const [period, setPeriod] = useState<DayPeriod>("day");
  useEffect(() => {
    setPeriod(periodOfHour(new Date().getHours()));
  }, []);
  return period;
}

const actionStyle: CSSProperties = {
  alignItems: "center",
  borderRadius: `calc(${MEGA_RADIUS_TOKENS.md} * 2)`,
  cursor: "pointer",
  display: "inline-flex",
  fontSize: "calc(var(--mega-density-font-size) - 0.5px)",
  gap: MEGA_SPACING_TOKENS[6],
  padding: `calc(${MEGA_SPACING_TOKENS[6]} + ${MEGA_SPACING_TOKENS[1]}) calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[5]})`,
  textDecoration: "none",
};

export function HomeHero({
  displayName,
  labels,
  workspace,
  workspaceBase,
}: {
  displayName: string;
  labels: HomeHeroLabels;
  workspace?: Workspace;
  workspaceBase: string;
}) {
  const period = useDayPeriod();
  const greeting = labels.greetings[period].replace("{name}", displayName);

  return (
    <div
      data-mega-home="hero"
      style={{
        alignItems: "center",
        display: "flex",
        gap: `calc(${MEGA_SPACING_TOKENS[8]} + ${MEGA_SPACING_TOKENS[6]})`,
      }}
    >
      <span
        aria-hidden="true"
        data-mega-home="hero-mark"
        style={{
          alignItems: "center",
          background: `linear-gradient(135deg, var(--mega-accent), color-mix(in srgb, var(--mega-accent) 67%, transparent))`,
          borderRadius: `calc(${MEGA_RADIUS_TOKENS.md} * 2.75)`,
          color: MEGA_TOKENS.accentForeground,
          display: "inline-flex",
          flexShrink: 0,
          fontSize: 22,
          fontWeight: 800,
          height: 46,
          justifyContent: "center",
          width: 46,
        }}
      >
        {workspace?.name?.slice(0, 1).toUpperCase() || "M"}
      </span>
      <div style={{ flex: 1 }}>
        <h1
          data-mega-home="hero-greeting"
          style={{
            color: MEGA_TOKENS.text,
            fontSize: 28,
            fontWeight: 650,
            letterSpacing: "-0.03em",
            lineHeight: 1.15,
            margin: 0,
          }}
        >
          {greeting}
        </h1>
      </div>
      <Link href={`${workspaceBase}/agent`} style={{ ...actionStyle, color: MEGA_TOKENS.text }}>
        <ShellIcon name="sparkle" size={14} />
        {labels.askAgent}
      </Link>
      <Link href={`${workspaceBase}/docs`} style={{ ...actionStyle, color: MEGA_TOKENS.text }}>
        <ShellIcon name="book" size={14} />
        {labels.newDoc}
      </Link>
    </div>
  );
}
