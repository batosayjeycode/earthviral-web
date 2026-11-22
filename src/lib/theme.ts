/**
 * Day/night theme. The reader's pick is kept in localStorage under THEME_KEY; with no pick
 * the theme follows the device's prefers-color-scheme. BaseLayout applies it to
 * <html data-theme> before first paint; the header toggle changes it.
 */
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'ev-theme';

/** Browser UI colour (<meta name="theme-color">) per theme — matches the header. */
export const THEME_COLOR: Record<Theme, string> = {
  dark: '#050811',
  light: '#ffffff',
};

export const isTheme = (value: unknown): value is Theme => value === 'light' || value === 'dark';

/** Saved pick → device preference. */
export const resolveTheme = (saved: string | null, prefersLight: boolean): Theme =>
  isTheme(saved) ? saved : prefersLight ? 'light' : 'dark';
