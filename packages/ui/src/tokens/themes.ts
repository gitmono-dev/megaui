/**
 * megaui:libs/ui/themes.ts@0ff3a9d
 *
 * Theme management module for consistent theme handling across megaui
 * consumers. Built on the shadcn/ui theme convention: light/dark modes
 * crossed with named color schemes, applied to the document root via
 * CSS classes (see `../styles/index.css` / `../styles/themes/*.css`).
 */
export type Theme = 'light' | 'dark'
export type ColorScheme = 'default' | 'claude' | 'cosmic-night' | 'modern-minimal' | 'ocean-breeze' | 'perplexity'

export interface ThemeState {
  theme: Theme
  colorScheme: ColorScheme
}

// Available themes configuration (shadcn/ui compatible).
// Add new themes here and add the matching file under `../styles/themes/`.
export const THEMES: readonly Theme[] = ['light', 'dark'] as const
export const COLOR_SCHEMES: readonly ColorScheme[] = [
  'default',
  'claude',
  'cosmic-night',
  'modern-minimal',
  'ocean-breeze',
  'perplexity',
] as const

// Theme class mappings.
export const THEME_CLASSES = {
  light: '', // light is default, no class needed
  dark: 'dark',
} as const

export const COLOR_SCHEME_CLASSES = {
  default: '', // default doesn't need a class
  claude: 'theme-claude',
  'cosmic-night': 'theme-cosmic-night',
  'modern-minimal': 'theme-modern-minimal',
  'ocean-breeze': 'theme-ocean-breeze',
  perplexity: 'theme-perplexity',
} as const

// All possible theme-related classes, useful for cleanup before applying a
// new combination.
export const ALL_THEME_CLASSES = [
  'light',
  'dark',
  'theme-default',
  'theme-claude',
  'theme-cosmic-night',
  'theme-modern-minimal',
  'theme-ocean-breeze',
  'theme-perplexity',
] as const

// shadcn/ui theme configuration with display metadata for a theme picker UI.
// Colors match each theme's primary color.
export const THEME_CONFIG = {
  default: {
    name: 'Default',
    color: '#343434', // oklch(0.205 0 0) - classic gray
  },
  claude: {
    name: 'Claude',
    color: '#b45309', // oklch(0.6171 0.1375 39.0427) - warm orange
  },
  perplexity: {
    name: 'Perplexity',
    color: '#0d9488', // oklch(0.5322 0.0910 205.7465) - teal cyan
  },
  'cosmic-night': {
    name: 'Cosmic Night',
    color: '#7c3aed', // oklch(0.5417 0.1790 288.0332) - deep purple
  },
  'modern-minimal': {
    name: 'Modern Minimal',
    color: '#6366f1', // oklch(0.6231 0.1880 259.8145) - modern purple-blue
  },
  'ocean-breeze': {
    name: 'Ocean Breeze',
    color: '#10b981', // oklch(0.7227 0.1920 149.5793) - ocean teal-green
  },
} as const

/**
 * Apply theme classes to the document root.
 */
export function applyThemeToDocument(theme: Theme, colorScheme: ColorScheme): void {
  if (typeof document === 'undefined') return

  const root = document.documentElement

  root.classList.remove(...ALL_THEME_CLASSES)

  if (theme === 'dark') {
    root.classList.add(THEME_CLASSES.dark)
  }

  if (colorScheme !== 'default') {
    root.classList.add(COLOR_SCHEME_CLASSES[colorScheme])
  }
}

/**
 * Read a previously persisted theme state from `localStorage`.
 * Returns `null` if nothing is stored or the stored value fails validation.
 */
export function getStoredThemeState(storageKey: string): ThemeState | null {
  if (typeof localStorage === 'undefined') return null

  try {
    const stored = localStorage.getItem(storageKey)
    if (!stored) return null

    const parsed = JSON.parse(stored) as ThemeState

    if (THEMES.includes(parsed.theme) && COLOR_SCHEMES.includes(parsed.colorScheme)) {
      return parsed
    }

    return null
  } catch (error) {
    console.warn('Failed to parse stored theme preferences:', error)
    return null
  }
}

/**
 * Persist a theme state to `localStorage`.
 */
export function saveThemeState(storageKey: string, themeState: ThemeState): void {
  if (typeof localStorage === 'undefined') return

  try {
    localStorage.setItem(storageKey, JSON.stringify(themeState))
  } catch (error) {
    console.warn('Failed to save theme preference to localStorage:', error)
  }
}

/**
 * Initialize the theme as early as possible (ideally in `<head>`) to avoid
 * a flash of the wrong theme. Reads persisted preferences if present,
 * otherwise falls back to the supplied defaults and persists them.
 */
export function initializeThemeImmediate(
  storageKey: string,
  defaultTheme: Theme,
  defaultColorScheme: ColorScheme,
): ThemeState {
  const stored = getStoredThemeState(storageKey)

  const themeState: ThemeState = stored || {
    theme: defaultTheme,
    colorScheme: defaultColorScheme,
  }

  applyThemeToDocument(themeState.theme, themeState.colorScheme)

  if (!stored) {
    saveThemeState(storageKey, themeState)
  }

  return themeState
}
