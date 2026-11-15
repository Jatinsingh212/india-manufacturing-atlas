/**
 * Tabs - underline tab bar, optionally synced to a URL query param (shareable deep links such as
 * `/analytics?tab=dependency`). Controlled (`value` + `onChange`), URL-synced (`urlParam`), or
 * uncontrolled (`defaultValue`).
 *
 *   <Tabs urlParam="tab" tabs={[{ id: 'potential', label: 'Export potential', icon: TrendingUp }, ...]}>
 *     {(active) => active === 'potential' ? <PotentialTab /> : ...}
 *   </Tabs>
 *
 * Only the active panel is rendered (lazy tabs: each tab's queries run when first opened).
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type TouchEvent } from 'react';
import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';
import { useSearchParamState } from '@/lib/hooks';

export interface TabDef<V extends string = string> {
  id: V;
  label: ReactNode;
  icon?: LucideIcon;
  /** Small count / marker after the label. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<V extends string = string> {
  tabs: ReadonlyArray<TabDef<V>>;
  value?: V;
  onChange?: (id: V) => void;
  defaultValue?: V;
  /** Sync the active tab to this URL search param (e.g. "tab"). */
  urlParam?: string;
  /** Render function (receives the active id) or static children rendered under the bar. */
  children?: ReactNode | ((active: V) => ReactNode);
  /** Extra content at the right end of the tab bar (filters, actions). */
  actions?: ReactNode;
  size?: 'sm' | 'md';
  className?: string;
  panelClassName?: string;
}

function TabsInner<V extends string>({
  tabs,
  active,
  setActive,
  children,
  actions,
  size = 'md',
  className,
  panelClassName,
}: Omit<TabsProps<V>, 'value' | 'onChange' | 'defaultValue' | 'urlParam'> & { active: V; setActive: (v: V) => void }) {
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the active tab in view on narrow screens without scrolling the page itself.
  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLButtonElement>(`[data-tab="${active}"]`);
    if (!list || !el) return;
    const listRect = list.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    if (elRect.left < listRect.left) {
      list.scrollTo({ left: list.scrollLeft + elRect.left - listRect.left - 8, behavior: 'smooth' });
    } else if (elRect.right > listRect.right) {
      list.scrollTo({ left: list.scrollLeft + elRect.right - listRect.right + 8, behavior: 'smooth' });
    }
  }, [active]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const enabled = tabs.filter((t) => !t.disabled);
    const idx = enabled.findIndex((t) => t.id === active);
    const next = enabled[(idx + (e.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length];
    if (next) {
      setActive(next.id);
      listRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)?.focus();
    }
  };

  // Swipe between tabs on touch screens: a clearly horizontal swipe of 60px+ on the panel moves to the
  // neighbouring tab. Swipes that start inside something that scrolls sideways (tables, charts, carousels)
  // are left to that element.
  const touch = useRef<{ x: number; y: number; t: number } | null>(null);
  const swipeDir = useRef<'left' | 'right' | null>(null);
  const onTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    let el = e.target as HTMLElement | null;
    while (el && el !== e.currentTarget) {
      const s = getComputedStyle(el);
      if (/(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 4) return;
      if (el.tagName === 'CANVAS' || el.dataset.noSwipe !== undefined) return;
      el = el.parentElement;
    }
    const p = e.touches[0];
    touch.current = { x: p.clientX, y: p.clientY, t: Date.now() };
  };
  const onTouchEnd = (e: TouchEvent<HTMLDivElement>) => {
    const start = touch.current;
    touch.current = null;
    if (!start) return;
    const p = e.changedTouches[0];
    const dx = p.clientX - start.x;
    const dy = p.clientY - start.y;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.8 || Date.now() - start.t > 700) return;
    const enabled = tabs.filter((t) => !t.disabled);
    const idx = enabled.findIndex((t) => t.id === active);
    const next = enabled[idx + (dx < 0 ? 1 : -1)];
    if (next) {
      swipeDir.current = dx < 0 ? 'left' : 'right';
      setActive(next.id);
    }
  };
  useEffect(() => {
    const id = window.setTimeout(() => { swipeDir.current = null; }, 400);
    return () => window.clearTimeout(id);
  }, [active]);

  return (
    <div className={className}>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2 border-b border-line">
        <div
          ref={listRef}
          role="tablist"
          aria-orientation="horizontal"
          className="atlas-scrollbar-none atlas-scroll-fade -mb-px flex min-w-0 flex-1 gap-1 overflow-x-auto pr-6"
          onKeyDown={onKeyDown}
        >
          {tabs.map((t) => {
            const on = t.id === active;
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                data-tab={t.id}
                id={`${baseId}-tab-${t.id}`}
                aria-selected={on}
                aria-controls={`${baseId}-panel`}
                tabIndex={on ? 0 : -1}
                disabled={t.disabled}
                onClick={() => setActive(t.id)}
                className={clsx(
                  'inline-flex shrink-0 items-center gap-1.5 border-b-2 font-medium whitespace-nowrap transition-colors disabled:opacity-40',
                  size === 'sm' ? 'h-10 px-2.5 text-[13px] sm:h-9' : 'h-11 px-3 text-sm sm:h-10',
                  on ? 'border-brand text-brand-ink' : 'border-transparent text-muted hover:border-line-strong hover:text-ink',
                )}
              >
                {Icon ? <Icon className="size-4" aria-hidden /> : null}
                {t.label}
                {t.badge !== undefined && t.badge !== null ? (
                  <span className={clsx('rounded-full px-1.5 text-[10.5px] leading-4', on ? 'bg-brand-soft text-brand-ink' : 'bg-surface-3 text-muted')}>{t.badge}</span>
                ) : null}
              </button>
            );
          })}
        </div>
        {actions ? <div className="flex items-center gap-2 pb-1.5 max-sm:w-full max-sm:flex-wrap">{actions}</div> : null}
      </div>
      {children !== undefined ? (
        <div
          role="tabpanel"
          id={`${baseId}-panel`}
          aria-labelledby={`${baseId}-tab-${active}`}
          className={clsx('pt-4', panelClassName)}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          <div key={active} className={swipeDir.current === 'left' ? 'animate-slide-in-right' : swipeDir.current === 'right' ? 'animate-slide-in-left' : 'animate-fade-in'}>
            {typeof children === 'function' ? children(active) : children}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function UrlTabs<V extends string>(props: TabsProps<V> & { urlParam: string }) {
  const first = (props.defaultValue ?? props.tabs[0]?.id ?? '') as V;
  const [raw, setRaw] = useSearchParamState(props.urlParam, first);
  const valid = props.tabs.some((t) => t.id === raw && !t.disabled);
  const active = (valid ? raw : first) as V;
  return (
    <TabsInner
      {...props}
      active={active}
      setActive={(v) => {
        setRaw(v);
        props.onChange?.(v);
      }}
    />
  );
}

function LocalTabs<V extends string>(props: TabsProps<V>) {
  const [local, setLocal] = useState<V>((props.defaultValue ?? props.tabs[0]?.id) as V);
  const active = props.value ?? local;
  return (
    <TabsInner
      {...props}
      active={active}
      setActive={(v) => {
        if (props.value === undefined) setLocal(v);
        props.onChange?.(v);
      }}
    />
  );
}

export function Tabs<V extends string = string>(props: TabsProps<V>) {
  if (props.urlParam) return <UrlTabs {...props} urlParam={props.urlParam} />;
  return <LocalTabs {...props} />;
}
