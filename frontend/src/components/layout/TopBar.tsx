/**
 * TopBar - sticky navy bar: menu button (< 1024 px), global HSN search with typeahead, "Ask Atlas"
 * assistant button, theme toggle, role badge and the sign-in / user menu.
 *
 * On phones the inline search collapses to an icon that opens a bottom search sheet, leaving room
 * for a compact brand, the assistant and the account controls.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import clsx from 'clsx';
import { KeyRound, LogIn, LogOut, Menu as MenuIcon, Moon, Search, Sparkles, Sun, UserRound } from 'lucide-react';
import type { Role } from '@/api/types';
import { ROLE_LABELS, useAuth } from '@/auth/AuthContext';
import { DEMO_ROLES } from '@/auth/RequireRole';
import { routes } from '@/lib/routes';
import { useTheme } from '@/theme/ThemeContext';
import { errorMessage } from '@/api/client';
import { Button } from '../Button';
import { HsnSearchBox } from '../HsnSearchBox';
import { Menu, type MenuItem } from '../Menu';
import { Drawer } from '../Overlay';
import { useToast } from '../Toast';
import { useAssistant } from './AssistantContext';
import { BrandMark } from './BrandMark';

const ROLE_DOT: Record<Role, string> = {
  public: '#9fb0c9',
  industry: '#eb6834',
  analyst: '#3987e5',
  ministry: '#1baf7a',
  admin: '#e6007e',
};

/** Role indicator for the navy bar. */
export function RoleBadge({ role, className }: { role: Role; className?: string }) {
  return (
    <span className={clsx('inline-flex h-6 items-center gap-1.5 rounded-full border border-white/15 bg-white/8 px-2.5 text-[11.5px] font-medium text-white', className)}>
      <span className="size-2 rounded-full" style={{ backgroundColor: ROLE_DOT[role] }} aria-hidden />
      {ROLE_LABELS[role]}
    </span>
  );
}

export function TopBar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { user, role, isAuthenticated, logout, demoLogin } = useAuth();
  const { mode, toggle } = useTheme();
  const assistant = useAssistant();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const here = `${location.pathname}${location.search}`;

  // A suggestion navigates; close the phone search sheet on the resulting route change.
  useEffect(() => setSearchOpen(false), [location.pathname, location.search]);

  const switchItems: MenuItem[] = DEMO_ROLES.filter((d) => d.role !== role).map((d, i) => ({
    label: `Switch to demo ${d.label.toLowerCase()}`,
    icon: d.icon,
    divider: i === 0,
    onSelect: () => {
      demoLogin(d.role)
        .then((u) => toast.success(`Signed in as ${u.name ?? d.label}`))
        .catch((err) => toast.error('Demo sign-in failed', errorMessage(err)));
    },
  }));

  const userItems: MenuItem[] = [
    ...switchItems,
    { label: 'Sign in with another account', icon: KeyRound, divider: true, to: routes.login(here) },
    {
      label: 'Sign out',
      icon: LogOut,
      danger: true,
      onSelect: () => {
        logout();
        toast.info('Signed out', 'You are now using the public module.');
      },
    },
  ];

  return (
    <>
      <header className="atlas-no-print sticky top-0 z-40 border-b border-white/8 bg-[linear-gradient(180deg,rgba(7,24,47,0.97)_0%,rgba(7,24,47,0.92)_100%)] text-on-navy shadow-[0_1px_0_rgba(255,255,255,0.035),0_14px_32px_-30px_rgba(0,0,0,0.95)] backdrop-blur-xl">
        <div className="flex h-14 items-center gap-1.5 px-3 sm:gap-3 sm:px-5 lg:px-6">
          <button
            type="button"
            onClick={onOpenMenu}
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-on-navy-muted hover:bg-white/10 hover:text-white lg:hidden"
            aria-label="Open navigation"
          >
            <MenuIcon className="size-5" aria-hidden />
          </button>

          <Link to="/" className="flex min-w-0 items-center gap-2 sm:hidden" aria-label="India Manufacturing Atlas - home">
            <BrandMark size={26} />
            <span className="truncate text-[13px] font-bold tracking-tight text-white">Atlas</span>
          </Link>

          <HsnSearchBox
            variant="topbar"
            className="hidden max-w-xl flex-1 sm:block"
            placeholder="Search HSN code, product or ministry…"
          />

          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
            <button
              ref={searchButtonRef}
              type="button"
              onClick={() => setSearchOpen(true)}
              className="inline-flex size-9 items-center justify-center rounded-lg text-on-navy-muted hover:bg-white/10 hover:text-white sm:hidden"
              aria-label="Search HSN codes, products and ministries"
            >
              <Search className="size-[18px]" aria-hidden />
            </button>

            <Button
              variant="accent"
              size="sm"
              icon={Sparkles}
              onClick={() => assistant.open()}
              className="max-sm:h-9 max-sm:w-9 max-sm:px-0!"
              aria-label="Ask Atlas assistant"
            >
              <span className="max-sm:hidden">Ask Atlas</span>
            </Button>

            <button
              type="button"
              onClick={toggle}
              className="inline-flex size-9 items-center justify-center rounded-lg text-on-navy-muted hover:bg-white/10 hover:text-white"
              aria-label={mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={mode === 'dark' ? 'Light theme' : 'Dark theme'}
            >
              {mode === 'dark' ? <Sun className="size-[18px]" aria-hidden /> : <Moon className="size-[18px]" aria-hidden />}
            </button>

            <RoleBadge role={role} className="max-md:hidden" />

            {isAuthenticated ? (
              <Menu
                align="right"
                width={260}
                header={
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-ink">{user.name ?? user.email}</div>
                    {user.email ? <div className="truncate text-xs text-muted">{user.email}</div> : null}
                    <div className="mt-1 text-xs text-ink-2">
                      {ROLE_LABELS[role]}
                      {user.ministry_id ? ` · ${user.ministry_id.toUpperCase()}` : ''}
                      {user.organisation ? ` · ${user.organisation}` : ''}
                    </div>
                  </div>
                }
                items={userItems}
                trigger={(p) => (
                  <button
                    type="button"
                    {...p}
                    aria-label="Open account menu"
                    className="inline-flex h-8 items-center gap-2 rounded-full border border-white/15 bg-white/8 pr-3 pl-1 text-[13px] font-medium text-white hover:bg-white/15 max-sm:h-9 max-sm:pr-1"
                  >
                    <span className="inline-flex size-6 items-center justify-center rounded-full bg-brand text-[11px] font-bold uppercase">
                      {(user.name ?? user.email ?? '?').slice(0, 1)}
                    </span>
                    <span className="max-w-28 truncate max-sm:hidden">{user.name ?? user.email}</span>
                  </button>
                )}
              />
            ) : (
              <Menu
                align="right"
                width={272}
                header={<div className="text-xs text-muted">You are browsing the public module. Sign in for government or industry features.</div>}
                items={[
                  { label: 'Sign in', description: 'Email and password', icon: LogIn, to: routes.login(here) },
                  ...DEMO_ROLES.map((d, i) => ({
                    label: `Demo ${d.label.toLowerCase()}`,
                    description: d.blurb,
                    icon: d.icon,
                    divider: i === 0,
                    onSelect: () => {
                      demoLogin(d.role)
                        .then((u) => toast.success(`Signed in as ${u.name ?? d.label}`))
                        .catch((err) => toast.error('Demo sign-in failed', errorMessage(err)));
                    },
                  })),
                  { label: 'Create an industry account', icon: UserRound, divider: true, onSelect: () => navigate(routes.login(here, 'register')) },
                ]}
                trigger={(p) => (
                  <Button {...p} variant="navy" size="sm" icon={LogIn} aria-label="Sign in" className="max-sm:h-9 max-sm:w-9 max-sm:px-0!">
                    <span className="max-sm:hidden">Sign in</span>
                  </Button>
                )}
              />
            )}
          </div>
        </div>
      </header>

      <Drawer
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        returnFocusRef={searchButtonRef}
        side="bottom"
        title="Search the Atlas"
        subtitle="HSN code, product, ministry or sector"
      >
        <HsnSearchBox inline autoFocus size="lg" placeholder="e.g. 4011, car tyres, Ministry of Textiles…" />
        <div className="mt-4 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted">
          <span>Try</span>
          {['bumpers', 'car tyres', 'solar modules', 'smartphones'].map((q) => (
            <Link
              key={q}
              to={routes.explore({ q })}
              onClick={() => setSearchOpen(false)}
              className="rounded-full border border-line bg-surface-2 px-2.5 py-1 font-medium text-ink-2 hover:border-brand/40 hover:text-brand-ink"
            >
              {q}
            </Link>
          ))}
        </div>
      </Drawer>
    </>
  );
}
