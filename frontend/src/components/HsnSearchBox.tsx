/**
 * HsnSearchBox - HSN code / product typeahead backed by `GET /api/hsn/suggest` (top 8).
 *
 * Default behaviour (global search): choosing a suggestion opens `/product/:hsn8`; pressing Enter on
 * free text opens the product when it is an 8-digit code, otherwise `/explore?q=<text>`.
 * Override with `onSelect` (pick a line, e.g. for the compare tray or the "Enter HSN code" card)
 * and/or `onSubmit` (free-text Enter).
 *
 *   <HsnSearchBox />                                                  // top bar
 *   <HsnSearchBox onSelect={(s) => setCode(s.hsn8)} onSubmit={setCode} placeholder="Enter HSN code" />
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { CornerDownLeft, LoaderCircle, Search, X } from 'lucide-react';
import { api, normalizeCode } from '@/api/client';
import type { SuggestItem } from '@/api/types';
import { fmtCode } from '@/lib/format';
import { useDebouncedValue } from '@/lib/hooks';
import { routeForCode, routes } from '@/lib/routes';

export interface HsnSearchBoxProps {
  placeholder?: string;
  autoFocus?: boolean;
  /** 'topbar' = styled for the navy top bar. */
  variant?: 'default' | 'topbar';
  size?: 'md' | 'lg';
  /** Called when a suggestion is chosen (replaces navigation). */
  onSelect?: (item: SuggestItem) => void;
  /** Called on Enter with free text (replaces navigation). */
  onSubmit?: (query: string) => void;
  /** Clear the input after a selection / submit (default true when navigating). */
  clearOnSelect?: boolean;
  /** Initial text. */
  defaultValue?: string;
  className?: string;
  /** Accessible label (default "Search HSN codes and products"). */
  ariaLabel?: string;
  /** Render suggestions in the document flow instead of an overlay (bottom sheets). */
  inline?: boolean;
}

export function HsnSearchBox({
  placeholder = 'Search HSN code or product…',
  autoFocus,
  variant = 'default',
  size = 'md',
  onSelect,
  onSubmit,
  clearOnSelect,
  defaultValue = '',
  className,
  ariaLabel = 'Search HSN codes and products',
  inline = false,
}: HsnSearchBoxProps) {
  const navigate = useNavigate();
  const [text, setText] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const debounced = useDebouncedValue(text.trim(), 180);
  const enabled = debounced.length >= 2;

  const q = useQuery({
    queryKey: ['hsn', 'suggest', debounced],
    queryFn: ({ signal }) => api.suggest(debounced, { signal }),
    enabled,
    staleTime: 10 * 60 * 1000,
  });
  const items: SuggestItem[] = useMemo(() => (enabled ? (q.data ?? []) : []), [enabled, q.data]);
  const showSearchAll = text.trim().length > 0;
  const optionCount = items.length + (showSearchAll ? 1 : 0);

  useEffect(() => setActive(-1), [debounced]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const navigating = !onSelect && !onSubmit;
  const shouldClear = clearOnSelect ?? navigating;

  const finish = () => {
    setOpen(false);
    setActive(-1);
    if (shouldClear) setText('');
    inputRef.current?.blur();
  };

  const choose = (item: SuggestItem) => {
    if (onSelect) onSelect(item);
    else navigate(routes.product(item.hsn8));
    if (!shouldClear) setText(item.hsn8);
    finish();
  };

  const submitText = () => {
    const raw = text.trim();
    if (!raw) return;
    if (onSubmit) onSubmit(raw);
    else {
      const code = normalizeCode(raw);
      navigate(/^\d{2,8}$/.test(code) ? (routeForCode(code) ?? routes.explore({ q: raw })) : routes.explore({ q: raw }));
    }
    finish();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => (optionCount ? (a + 1) % optionCount : -1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (optionCount ? (a - 1 + optionCount) % optionCount : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && active < items.length) choose(items[active]);
      else submitText();
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const topbar = variant === 'topbar';
  const showPanel = open && text.trim().length > 0;

  return (
    <div ref={rootRef} className={clsx('relative min-w-0', className)}>
      <div className="relative">
        <Search
          className={clsx('pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2', topbar ? 'text-on-navy-muted' : 'text-muted')}
          aria-hidden
        />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={showPanel}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-opt-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className={clsx(
            'w-full rounded-xl pr-9 pl-9 transition-[border-color,background-color,box-shadow] focus:outline-none max-sm:h-11 max-sm:text-base',
            size === 'lg' ? 'h-11 text-[15px]' : 'h-9 text-sm',
            topbar
              ? 'border border-white/12 bg-white/[0.08] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] placeholder:text-on-navy-muted focus:border-white/30 focus:bg-white/[0.12]'
              : 'border border-line bg-surface text-ink shadow-[inset_0_1px_2px_rgba(10,28,53,0.03)] placeholder:text-muted focus:border-brand focus:ring-2 focus:ring-brand/15',
          )}
        />
        {text ? (
          <button
            type="button"
            onClick={() => {
              setText('');
              inputRef.current?.focus();
            }}
            className={clsx(
              'absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1',
              topbar ? 'text-on-navy-muted hover:bg-white/10 hover:text-white' : 'text-muted hover:bg-surface-3 hover:text-ink',
            )}
            aria-label="Clear"
          >
            {q.isFetching ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <X className="size-3.5" aria-hidden />}
          </button>
        ) : null}
      </div>

      {showPanel ? (
        <div
          id={listId}
          role="listbox"
          aria-label="Suggestions"
          className={clsx(
            'z-50 mt-1.5 min-w-0 animate-pop-in rounded-xl border border-line bg-surface p-1 text-ink shadow-pop',
            inline
              ? 'relative w-full'
              : 'absolute top-full right-0 left-0 max-h-[min(420px,60dvh)] overflow-y-auto sm:min-w-[300px]',
          )}
        >
          {enabled && q.isPending ? <div className="px-3 py-2.5 text-[13px] text-muted">Searching…</div> : null}
          {enabled && !q.isPending && !items.length && !q.isError ? (
            <div className="px-3 py-2.5 text-[13px] text-muted">No matching 8-digit lines. Press Enter to search the Explorer.</div>
          ) : null}
          {q.isError ? <div className="px-3 py-2.5 text-[13px] text-bad-ink">Suggestions unavailable right now.</div> : null}
          {!enabled ? <div className="px-3 py-2.5 text-[13px] text-muted">Type at least 2 characters…</div> : null}
          {items.map((it, i) => (
            <div
              key={it.hsn8}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={active === i}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(it)}
              className={clsx('flex cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2', active === i ? 'bg-brand-soft' : 'hover:bg-surface-3')}
            >
              <span className="mt-px shrink-0 font-mono text-[12.5px] text-brand-ink atlas-num">{fmtCode(it.hsn8)}</span>
              <span className="min-w-0 flex-1 text-[13px] leading-snug text-ink">{it.description}</span>
              {it.ministry_short ? <span className="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-[10.5px] font-medium text-ink-2">{it.ministry_short}</span> : null}
            </div>
          ))}
          {showSearchAll ? (
            <div
              id={`${listId}-opt-${items.length}`}
              role="option"
              aria-selected={active === items.length}
              onMouseEnter={() => setActive(items.length)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={submitText}
              className={clsx(
                'mt-1 flex cursor-pointer items-center gap-2 rounded-lg border-t border-line px-2.5 py-2 text-[13px] text-ink-2',
                active === items.length ? 'bg-brand-soft' : 'hover:bg-surface-3',
              )}
            >
              <Search className="size-3.5 text-muted" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                {onSubmit ? 'Use' : 'Search all products for'} “<span className="font-medium text-ink">{text.trim()}</span>”
              </span>
              <CornerDownLeft className="size-3.5 text-muted" aria-hidden />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
