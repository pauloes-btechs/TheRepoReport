/**
 * Device-only preferences kept in localStorage. Nothing here leaves the browser.
 */
import { useCallback, useSyncExternalStore } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
export type Level = 'beginner' | 'intermediate' | 'technical';

export const PREF_KEYS = {
  theme: 'trr.theme',
  rate: 'trr.playbackRate',
  level: 'trr.level',
  minScore: 'trr.minScore',
  draft: 'trr.configDraft',
} as const;

export const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

export function readRaw(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeRaw(key: string, value: string | null): void {
  try {
    const s = storage();
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    // Storage full or blocked: the preference simply is not remembered.
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = () => listener();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** A string-backed preference with parsing and a fallback. */
export function usePref<T>(key: string, parse: (raw: string | null) => T, serialize: (value: T) => string = String) {
  const raw = useSyncExternalStore(subscribe, () => readRaw(key), () => null);
  const value = parse(raw);
  const set = useCallback((next: T) => writeRaw(key, serialize(next)), [key, serialize]);
  return [value, set] as const;
}

export function parseTheme(raw: string | null): ThemePref {
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

export function parseRate(raw: string | null): number {
  const n = Number(raw);
  return (SPEEDS as readonly number[]).includes(n) ? n : 1;
}

export function parseLevel(raw: string | null): Level {
  return raw === 'intermediate' || raw === 'technical' ? raw : 'beginner';
}

export function parseMinScore(raw: string | null): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : 0;
}

export const useThemePref = () => usePref(PREF_KEYS.theme, parseTheme);
export const useRatePref = () => usePref(PREF_KEYS.rate, parseRate);
export const useLevelPref = () => usePref(PREF_KEYS.level, parseLevel);
export const useMinScorePref = () => usePref(PREF_KEYS.minScore, parseMinScore);

export function resolvedTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref !== 'system') return pref;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(pref: ThemePref): void {
  const theme = resolvedTheme(pref);
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0d1424' : '#f2f4f7');
}
