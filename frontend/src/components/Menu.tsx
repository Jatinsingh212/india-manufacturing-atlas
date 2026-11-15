/**
 * Menu - small dropdown menu (download formats, user menu, row actions).
 *
 *   <Menu trigger={(p) => <Button {...p} iconRight={ChevronDown}>Actions</Button>}
 *         items={[{ label: 'Open', icon: ExternalLink, onSelect: open }, { label: 'Delete', danger: true, onSelect: del }]} />
 *
 * Closes on selection, outside click and Escape; arrow keys move between items.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';

export interface MenuItem {
  label: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  onSelect?: () => void;
  /** Navigate instead of calling onSelect. */
  to?: string;
  disabled?: boolean;
  danger?: boolean;
  /** Render a divider before this item. */
  divider?: boolean;
}

export interface MenuTriggerProps {
  onClick: () => void;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls': string;
}

export interface MenuProps {
  trigger: (props: MenuTriggerProps) => ReactNode;
  items: ReadonlyArray<MenuItem>;
  align?: 'left' | 'right';
  /** Header content inside the panel (e.g. the signed-in user). */
  header?: ReactNode;
  width?: number;
  className?: string;
}

export function Menu({ trigger, items, align = 'right', header, width = 224, className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const focusTrigger = () => rootRef.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // A menu opened inside a drawer/modal owns Escape first: close only the menu and return focus.
        e.stopPropagation();
        setOpen(false);
        window.requestAnimationFrame(focusTrigger);
        return;
      }
      if (e.key === 'Tab') {
        // Menus are not modal; Tab leaves the menu. Move focus to the trigger first so it does not
        // fall back to <body> when the panel unmounts, then let the browser continue the tab order.
        setOpen(false);
        focusTrigger();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const els = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
        if (!els.length) return;
        const idx = els.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'ArrowDown' ? (idx + 1) % els.length : (idx - 1 + els.length) % els.length;
        els[next]?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    const t = window.setTimeout(() => rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus(), 20);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={clsx('relative inline-flex', className)}>
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-controls': panelId })}
      {open ? (
        <div
          id={panelId}
          role="menu"
          className={clsx('absolute top-full z-50 mt-1.5 animate-pop-in rounded-xl border border-line bg-surface p-1 shadow-pop', align === 'right' ? 'right-0' : 'left-0')}
          style={{ width }}
        >
          {header ? <div className="border-b border-line px-3 pt-2 pb-2.5">{header}</div> : null}
          {items.map((it, i) => {
            const Icon = it.icon;
            return (
              <div key={i}>
                {it.divider ? <div className="my-1 border-t border-line" /> : null}
                <button
                  type="button"
                  role="menuitem"
                  disabled={it.disabled}
                  onClick={() => {
                    setOpen(false);
                    if (it.to) navigate(it.to);
                    else it.onSelect?.();
                  }}
                  className={clsx(
                    'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors focus:outline-none disabled:opacity-50',
                    it.danger ? 'text-bad-ink hover:bg-bad-soft focus:bg-bad-soft' : 'text-ink hover:bg-surface-3 focus:bg-surface-3',
                  )}
                >
                  {Icon ? <Icon className={clsx('mt-0.5 size-4 shrink-0', it.danger ? 'text-bad' : 'text-muted')} aria-hidden /> : null}
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{it.label}</span>
                    {it.description ? <span className="block text-xs text-muted">{it.description}</span> : null}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
