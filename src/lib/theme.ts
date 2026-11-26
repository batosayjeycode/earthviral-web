/**
 * Day/night theme. Night (dark) is the default for every visitor, whatever the device's
 * colour scheme; the header toggle switches to day and the pick is kept in localStorage under
 * THEME_KEY. BaseLayout applies it to <html data-theme> before first paint.
 */
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'ev-theme';

/** Browser UI colour (<meta name="theme-color">) per theme — matches the masthead, dark in both. */
export const THEME_COLOR: Record<Theme, string> = {
  dark: '#050811',
  light: '#050811',
};

export const isTheme = (value: unknown): value is Theme => value === 'light' || value === 'dark';

/** The theme for a visitor who hasn't picked one. */
export const DEFAULT_THEME: Theme = 'dark';

/** Saved pick → the default (night). */
export const resolveTheme = (saved: string | null): Theme =>
  isTheme(saved) ? saved : DEFAULT_THEME;
