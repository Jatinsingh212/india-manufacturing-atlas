/**
 * MobileTabBar - the phone / tablet primary navigation.
 *
 * The three visible modules (HSN Explorer, Ministry Wise HSN, Product workflow), same order as the
 * sidebar. The bar sits above the iOS home indicator, and the shell reserves its height so no page
 * content hides underneath.
 */
import { Link, useLocation } from 'react-router';
import clsx from 'clsx';
import { Landmark, ListTree, Route } from 'lucide-react';
import { isNavActive, NAV_ITEMS } from '@/app/nav';

const CORE = ['/explore', '/ministries', '/workflow/sports_goods'] as const;

/** Short labels: the tabs must fit a 320 px phone without truncation. */
const CORE_LABELS: Record<(typeof CORE)[number], string> = {
  '/explore': 'HSN Explorer',
  '/ministries': 'Ministry HSN',
  '/workflow/sports_goods': 'Workflow',
};

const CORE_ICONS = {
  '/explore': ListTree,
  '/ministries': Landmark,
  '/workflow/sports_goods': Route,
} as const;

export function MobileTabBar() {
  const { pathname } = useLocation();

  return (
    <nav
      className="atlas-no-print fixed inset-x-0 bottom-0 z-50 border-t border-white/8 bg-[linear-gradient(180deg,rgba(7,24,47,0.94)_0%,rgba(7,24,47,0.99)_100%)] pb-[env(safe-area-inset-bottom,0px)] text-on-navy shadow-[0_-14px_32px_-26px_rgba(0,0,0,0.95)] backdrop-blur-xl lg:hidden"
      aria-label="Primary navigation"
    >
      <ul className="mx-auto flex h-[var(--atlas-bottomnav-h)] w-full max-w-lg items-stretch">
        {CORE.map((to) => {
          const item = NAV_ITEMS.find((i) => i.to === to);
          const active = item ? isNavActive(item, pathname) : pathname === to;
          const Icon = CORE_ICONS[to];
          return (
            <li key={to} className="min-w-0 flex-1">
              <Link
                to={to}
                aria-current={active ? 'page' : undefined}
                className={clsx(
                  'group relative flex h-full flex-col items-center justify-center gap-0.5 px-1 text-[9px] font-semibold transition-colors min-[360px]:text-[10px]',
                  active ? 'text-white' : 'text-on-navy-muted hover:text-white',
                )}
              >
                {active ? <span className="absolute top-0 h-0.5 w-7 rounded-b bg-kpi shadow-[0_1px_8px_rgba(214,0,113,0.65)]" aria-hidden /> : null}
                <span
                  className={clsx(
                    'flex h-7 w-11 items-center justify-center rounded-full transition-colors',
                    active ? 'bg-white/10' : 'group-hover:bg-white/[0.06]',
                  )}
                >
                  <Icon className="size-[19px]" aria-hidden />
                </span>
                <span className="max-w-full truncate">{CORE_LABELS[to]}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
