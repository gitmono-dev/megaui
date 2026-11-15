"use client";

import type { CSSProperties } from "react";
import { applyThemeToDocument, type ColorScheme } from "@megaui/ui/tokens";

export const MEGA_ACCENTS = [
  { id: "default", color: "#343434" },
  { id: "claude", color: "#b45309" },
  { id: "perplexity", color: "#0d9488" },
  { id: "cosmic-night", color: "#7c3aed" },
  { id: "modern-minimal", color: "#6366f1" },
  { id: "ocean-breeze", color: "#10b981" },
] as const;

export const MEGA_DENSITIES = ["comfortable", "compact"] as const;
export type MegaDensity = (typeof MEGA_DENSITIES)[number];
export type MegaThemeMode = "light" | "dark" | "system";
export type MegaAccent = (typeof MEGA_ACCENTS)[number]["id"];

export interface MegaSettings {
  mode: MegaThemeMode;
  density: MegaDensity;
  accent: MegaAccent;
}

export const MEGA_SETTINGS_STORAGE_KEY = "mega-settings";
export const MEGA_THEME_MODE_STORAGE_KEY = "mega-theme-mode";
export const DEFAULT_MEGA_SETTINGS: MegaSettings = {
  mode: "light",
  density: "comfortable",
  accent: "default",
};

export function parseMegaSettings(value: string | null): MegaSettings {
  try {
    const parsed: unknown = value ? JSON.parse(value) : undefined;
    if (!parsed || typeof parsed !== "object") return DEFAULT_MEGA_SETTINGS;
    const candidate = parsed as Partial<MegaSettings>;
    return {
      mode: candidate.mode === "dark" || candidate.mode === "system" ? candidate.mode : "light",
      density: candidate.density === "compact" ? "compact" : "comfortable",
      accent: MEGA_ACCENTS.some(({ id }) => id === candidate.accent) ? candidate.accent! : "default",
    };
  } catch {
    return DEFAULT_MEGA_SETTINGS;
  }
}

export function serializeMegaSettings(settings: MegaSettings): string {
  return JSON.stringify(settings);
}

export function resolvedMegaTheme(mode: MegaThemeMode): "light" | "dark" {
  return mode === "system"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    : mode;
}

export function applyMegaSettings(settings: MegaSettings): void {
  const root = document.documentElement;
  applyThemeToDocument(resolvedMegaTheme(settings.mode), settings.accent as ColorScheme);
  root.dataset.megaDensity = settings.density;
}

export function toMegaSettingsCssVariables(settings: MegaSettings): CSSProperties {
  if (settings.density !== "compact") {
    return { ["--mega-tree-width" as never]: "320px" } as CSSProperties;
  }
  return {
    ["--mega-tree-width" as never]: "320px",
    ["--mega-density-row-height" as never]: "var(--mega-density-compact-row-height)",
    ["--mega-density-row-padding-x" as never]: "var(--mega-density-compact-row-padding-x)",
    ["--mega-density-font-size" as never]: "var(--mega-density-compact-font-size)",
  } as CSSProperties;
}

export function createMegaSettingsInitScript(): string {
  return '(function(){try{var raw=localStorage.getItem("mega-settings");var s={"mode":"light","density":"comfortable","accent":"default"};if(raw){var p=JSON.parse(raw);s.mode=p.mode==="dark"||p.mode==="system"?p.mode:"light";s.density=p.density==="compact"?"compact":"comfortable";s.accent=["default","claude","perplexity","cosmic-night","modern-minimal","ocean-breeze"].indexOf(p.accent)>=0?p.accent:"default";}localStorage.setItem("mega-theme-mode",s.mode);document.documentElement.dataset.megaDensity=s.density;}catch(e){}})();';
}
