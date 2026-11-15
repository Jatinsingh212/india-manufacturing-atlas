/**
 * Small, generic React hooks shared by pages.
 *
 * - useDebouncedValue(value, ms)        debounce search input before querying
 * - useLocalStorage(key, initial)       persisted UI preference (JSON), safe when storage is blocked
 * - useMediaQuery(query)                responsive logic in JS (e.g. '(min-width: 1024px)')
 * - useSearchParamState(key, default)   one URL query param as React state (shareable filters / tabs)
 * - useHashScroll(ready)                scroll to location.hash once async content has rendered
 * - useDocumentTitle(title)             "<title> · India Manufacturing Atlas"
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';

/** Returns `value` after it stopped changing for `delay` ms. */
export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/** JSON value persisted in localStorage. Falls back to in-memory state when storage is unavailable. */
export function useLocalStorage<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [key],
  );
  return [value, set];
}

/** `true` while the media query matches. */
export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/**
 * One URL search param as state. Setting the default value removes the param, so URLs stay short.
 * Uses `replace` navigation so filter tweaks do not flood the history, and `preventScrollReset` so a tab or
 * filter change does not scroll the page back to the top (ScrollRestoration is keyed on pathname + search).
 *
 *   const [tab, setTab] = useSearchParamState('tab', 'potential');
 */
export function useSearchParamState(key: string, defaultValue = ''): [string, (v: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(key) ?? defaultValue;
  const set = useCallback(
    (v: string | null) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (v === null || v === '' || v === defaultValue) next.delete(key);
          else next.set(key, v);
          return next;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [key, defaultValue, setParams],
  );
  return [value, set];
}

/**
 * Scroll to the element named by `location.hash` once `ready` is true (e.g. after a query resolved),
 * for deep links such as `/about#methodology`.
 */
export function useHashScroll(ready = true): void {
  const { hash } = useLocation();
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !hash || done.current === hash) return;
    const id = decodeURIComponent(hash.slice(1));
    const t = window.setTimeout(() => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        done.current = hash;
      }
    }, 60);
    return () => window.clearTimeout(t);
  }, [hash, ready]);
}

const APP_NAME = 'India Manufacturing Atlas';

/** Sets document.title to "<title> · India Manufacturing Atlas" while mounted. */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    const prev = document.title;
    document.title = title ? `${title} · ${APP_NAME}` : APP_NAME;
    return () => {
      document.title = prev;
    };
  }, [title]);
}
