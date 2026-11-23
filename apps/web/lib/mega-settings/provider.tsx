"use client";

import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

import {
  applyMegaSettings,
  DEFAULT_MEGA_SETTINGS,
  MEGA_SETTINGS_STORAGE_KEY,
  MEGA_THEME_MODE_STORAGE_KEY,
  parseMegaSettings,
  serializeMegaSettings,
  toMegaSettingsCssVariables,
  type MegaSettings,
} from "./model";

type MegaSettingsContextValue = {
  settings: MegaSettings;
  updateSettings: (update: Partial<MegaSettings>) => void;
};

const MegaSettingsContext = createContext<MegaSettingsContextValue | null>(null);

export function MegaSettingsProvider({ children, className, style }: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [settings, setSettings] = useState(DEFAULT_MEGA_SETTINGS);

  useEffect(() => {
    const next = parseMegaSettings(localStorage.getItem(MEGA_SETTINGS_STORAGE_KEY));
    setSettings(next);
    applyMegaSettings(next);
    localStorage.setItem(MEGA_THEME_MODE_STORAGE_KEY, next.mode);
  }, []);

  const updateSettings = (update: Partial<MegaSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...update };
      localStorage.setItem(MEGA_SETTINGS_STORAGE_KEY, serializeMegaSettings(next));
      localStorage.setItem(MEGA_THEME_MODE_STORAGE_KEY, next.mode);
      applyMegaSettings(next);
      return next;
    });
  };

  return (
    <MegaSettingsContext.Provider value={{ settings, updateSettings }}>
      <div className={className} data-mega-settings="provider" style={{ ...toMegaSettingsCssVariables(settings), ...style }}>
        {children}
      </div>
    </MegaSettingsContext.Provider>
  );
}

export function useMegaSettingsOptional(): MegaSettingsContextValue | null {
  return useContext(MegaSettingsContext);
}

export function useMegaSettings(): MegaSettingsContextValue {
  const value = useMegaSettingsOptional();
  if (!value) throw new Error("useMegaSettings must be used inside MegaSettingsProvider");
  return value;
}
