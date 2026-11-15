// megaui-only: blocking inline script that applies the saved theme before first
// paint, so a reload never flashes the wrong colours.
import { ALL_THEME_CLASSES, COLOR_SCHEME_CLASSES } from "@megaui/ui/tokens";

const SCRIPT_CONFIG = {
  /** Legacy key holding `{ theme, colorScheme }` as JSON. */
  themeKey: "megaui-theme",
  /** Workspace key holding the light / dark / system mode string. */
  modeKey: "mega-theme-mode",
  /** Workspace key holding `{ mode, accent, density }` as JSON. */
  settingsKey: "mega-settings",
  fallbackTheme: "light",
  fallbackScheme: "default",
  themeClasses: ALL_THEME_CLASSES,
  schemeClasses: COLOR_SCHEME_CLASSES,
};

// Plain ES5 on purpose: it is serialised into the HTML and runs unbundled.
// Every storage / parse step is guarded so a failure can never block rendering.
const BOOT_SOURCE = `
(function (cfg) {
  function readJson(key) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }
  function readRaw(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  try {
    var theme = cfg.fallbackTheme;
    var scheme = cfg.fallbackScheme;

    var legacy = readJson(cfg.themeKey);
    if (legacy) {
      theme = legacy.theme || theme;
      scheme = legacy.colorScheme || scheme;
    }

    var settings = readJson(cfg.settingsKey);
    var mode = readRaw(cfg.modeKey) || (settings && settings.mode);
    if (mode === "light" || mode === "dark") {
      theme = mode;
    } else if (mode === "system") {
      var prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      theme = prefersDark ? "dark" : "light";
    }
    if (settings && settings.accent) scheme = settings.accent;

    var root = document.documentElement;
    if (settings && settings.density) root.dataset.megaDensity = settings.density;

    root.classList.remove.apply(root.classList, cfg.themeClasses);
    if (theme === "dark") root.classList.add("dark");
    var schemeClass = scheme !== "default" ? cfg.schemeClasses[scheme] : undefined;
    if (schemeClass) root.classList.add(schemeClass);
  } catch (_) {
    /* keep the server-rendered defaults */
  }
})(${JSON.stringify(SCRIPT_CONFIG)});
`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: BOOT_SOURCE }} suppressHydrationWarning />;
}
