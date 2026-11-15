/**
 * Light / dark theme state.
 *
 * - Preference: 'light' | 'dark' | 'system' (default 'system' = follows prefers-color-scheme),
 *   persisted in localStorage under 'atlas.theme'.
 * - The resolved mode is written to <html data-theme="..."> (index.html does the same before first
 *   paint), which drives the CSS variables in src/index.css and Tailwind's `dark:` variant.
 *
 * `useTheme()` -> { preference, mode, setPreference, toggle }.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ThemeMode } from '@/lib/theme';

export type ThemePreference = ThemeMode | 'system';

export const THEME_STORAGE_KEY = 'atlas.theme';

interface ThemeContextValue {
  /** What the user chose ('system' follows the OS). */
  preference: ThemePreference;
  /** The mode actually applied. */
  mode: ThemeMode;
  setPreference: (p: ThemePreference) => void;
  /** Flip between light and dark (stores an explicit preference). */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

function systemMode(): ThemeMode {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyMode(mode: ThemeMode): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', mode);
  root.style.colorScheme = mode;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', mode === 'dark' ? '#070F1D' : '#0B1F3A');
}

/** Provides the theme to the app. Mount once, near the root. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const [system, setSystem] = useState<ThemeMode>(systemMode);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = () => setSystem(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const mode: ThemeMode = preference === 'system' ? system : preference;

  useEffect(() => {
    applyMode(mode);
  }, [mode]);

  const setPreference = useCallback((p: ThemePreference) => {
    setPreferenceState(p);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, p);
    } catch {
      /* storage blocked: preference lasts for this session only */
    }
  }, []);

  const toggle = useCallback(() => setPreference(mode === 'dark' ? 'light' : 'dark'), [mode, setPreference]);

  const value = useMemo(() => ({ preference, mode, setPreference, toggle }), [preference, mode, setPreference, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Current theme + setters. Must be used under <ThemeProvider>. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
