/**
 * Sidebar - grouped navigation (SPEC section 8: Atlas / Intelligence / Operations / About) on navy
 * chrome. Desktop (>= 1024 px): fixed rail that collapses to icons. Below 1024 px: an
 * off-canvas drawer opened from the top bar. Modules that need a government role show a lock for
 * users without it (the page then explains the access model).
 */
import { useEffect, useRef } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import clsx from 'clsx';
import { ChevronsLeft, ChevronsRight, Lock, X } from 'lucide-react';
import { roleAllowed, useAuth } from '@/auth/AuthContext';
import { isNavActive, VISIBLE_NAV_GROUPS, type NavItem } from '@/app/nav';
import { isTopOverlay, popOverlay, pushOverlay, trapTab } from '@/lib/focus';
import { Tooltip } from '../Tooltip';
import { BrandWordmark } from './BrandMark';

export const SIDEBAR_WIDTH = 248;
export const SIDEBAR_COLLAPSED_WIDTH = 68;

export interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

function NavEntry({ item, collapsed, locked, mobile }: { item: NavItem; collapsed: boolean; locked: boolean; mobile?: boolean }) {
  const { pathname } = useLocation();
  const active = isNavActive(item, pathname);
  const Icon = item.icon;
  const link = (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'group relative flex items-center gap-3 rounded-[10px] text-[13px] font-semibold transition-colors',
        mobile ? 'h-10' : 'h-9',
        collapsed ? 'justify-center px-0' : 'px-3',
        active
          ? 'bg-[linear-gradient(90deg,rgba(11,58,161,0.95),rgba(11,58,161,0.5))] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_10px_24px_-18px_rgba(0,0,0,0.9)] ring-1 ring-white/10'
          : 'text-on-navy-muted hover:bg-white/[0.06] hover:text-white',
      )}
    >
      {active ? <span className="absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-r bg-kpi" aria-hidden /> : null}
      <Icon className="size-[18px] shrink-0" aria-hidden />
      {!collapsed ? <span className="min-w-0 flex-1 truncate">{item.label}</span> : <span className="sr-only">{item.label}</span>}
      {locked && !collapsed ? <Lock className="size-3.5 shrink-0 opacity-60" aria-label="Government users" /> : null}
    </NavLink>
  );
  if (!collapsed) return link;
  return (
    <Tooltip content={`${item.label}${locked ? ' (government users)' : ''}`} block>
      {link}
    </Tooltip>
  );
}

function SidebarBody({ collapsed, onToggleCollapsed, onCloseMobile, mobile }: { collapsed: boolean; onToggleCollapsed?: () => void; onCloseMobile?: () => void; mobile?: boolean }) {
  const { role } = useAuth();
  return (
    <div className={clsx('flex h-full flex-col bg-[linear-gradient(180deg,#07182f_0%,#081c36_55%,#0a2141_100%)] text-on-navy', mobile && 'pt-[env(safe-area-inset-top,0px)]')}>
      <div className={clsx('flex h-14 shrink-0 items-center border-b border-white/8', collapsed ? 'justify-center px-2' : 'px-4')}>
        <Link to="/" className="min-w-0 flex-1" aria-label="India Manufacturing Atlas - home">
          <BrandWordmark collapsed={collapsed} />
        </Link>
        {mobile ? (
          <button
            type="button"
            onClick={onCloseMobile}
            data-autofocus
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-on-navy-muted hover:bg-white/10 hover:text-white"
            aria-label="Close navigation"
          >
            <X className="size-5" aria-hidden />
          </button>
        ) : null}
      </div>

      <nav className={clsx('flex-1 overflow-y-auto overscroll-contain px-3 py-4', mobile && 'pb-[max(1rem,env(safe-area-inset-bottom,0px))]')} aria-label="Main navigation">
        {VISIBLE_NAV_GROUPS.map((group) => (
          <div key={group.id} className="mb-5 last:mb-0">
            {!collapsed ? (
              <div className="mb-2 px-3 text-[10px] font-bold tracking-[0.16em] text-on-navy-muted/60 uppercase">{group.label}</div>
            ) : (
              <div className="mx-auto mb-2 h-px w-6 bg-white/10" aria-hidden />
            )}
            <ul className="space-y-0.5">
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavEntry
                    item={item}
                    collapsed={collapsed}
                    mobile={mobile}
                    locked={Boolean(item.roles) && !roleAllowed(role, item.roles ?? [])}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {!mobile && onToggleCollapsed ? (
        <div className="shrink-0 border-t border-white/10 p-3">
          <button
            type="button"
            onClick={onToggleCollapsed}
            className={clsx(
              'flex h-9 w-full items-center gap-3 rounded-[10px] text-[13px] text-on-navy-muted transition-colors hover:bg-white/[0.06] hover:text-white',
              collapsed ? 'justify-center' : 'px-3',
            )}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronsRight className="size-[18px]" aria-hidden /> : <ChevronsLeft className="size-[18px]" aria-hidden />}
            {!collapsed ? <span>Collapse</span> : null}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function Sidebar({ collapsed, onToggleCollapsed, mobileOpen, onCloseMobile }: SidebarProps) {
  const { pathname } = useLocation();
  const panelRef = useRef<HTMLDivElement>(null);

  // Close the mobile drawer on navigation.
  useEffect(() => {
    onCloseMobile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const panel = panelRef.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    if (panel) pushOverlay(panel);
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (!panel || !isTopOverlay(panel)) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseMobile();
        return;
      }
      trapTab(e, panel);
    };
    window.addEventListener('keydown', onKey);
    const t = window.setTimeout(() => {
      const focusable =
        panel?.querySelector<HTMLElement>('[data-autofocus]') ??
        panel?.querySelector<HTMLElement>('a[href], button:not([disabled])');
      focusable?.focus();
    }, 30);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey);
      if (panel) popOverlay(panel);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus?.();
    };
  }, [mobileOpen, onCloseMobile]);

  return (
    <>
      <aside
        className="atlas-no-print fixed inset-y-0 left-0 z-30 hidden transition-[width] duration-200 lg:block"
        style={{ width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH }}
      >
        <SidebarBody collapsed={collapsed} onToggleCollapsed={onToggleCollapsed} />
      </aside>

      {mobileOpen ? (
        <div className="atlas-no-print fixed inset-0 z-[80] lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 animate-fade-in bg-overlay" onClick={onCloseMobile} aria-hidden />
          <div ref={panelRef} className="absolute inset-y-0 left-0 w-[292px] max-w-[86vw] animate-slide-in-left shadow-pop">
            <SidebarBody collapsed={false} onCloseMobile={onCloseMobile} mobile />
          </div>
        </div>
      ) : null}
    </>
  );
}
