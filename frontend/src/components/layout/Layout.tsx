/**
 * Layout - the application shell: Sidebar + TopBar + routed page + the "Ask Atlas"
 * assistant drawer, plus scroll restoration and a background-fetch progress bar.
 *
 * Pages render inside a centred main column (max 1600 px). The window scrolls (not an inner div),
 * so ScrollRestoration and sticky elements behave normally; the sticky TopBar is 56 px tall
 * (`--atlas-topbar-h`).
 */
import { lazy, Suspense, useCallback, useState } from 'react';
import { Outlet, ScrollRestoration, useLocation } from 'react-router';
import { useIsFetching } from '@tanstack/react-query';
import clsx from 'clsx';
import { useLocalStorage } from '@/lib/hooks';
import { LoadingBlock, ProgressBar } from '../Loading';
import { AssistantProvider, useAssistant } from './AssistantContext';
import { MobileTabBar } from './MobileTabBar';
import { SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_WIDTH, Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

const AssistantDrawer = lazy(() => import('@/pages/assistant/AssistantDrawer'));

/** Mounts the assistant drawer lazily the first time it is opened. */
function AssistantSlot() {
  const { isOpen, close, question, requestId } = useAssistant();
  const [mounted, setMounted] = useState(false);
  if (isOpen && !mounted) setMounted(true);
  if (!mounted) return null;
  return (
    <Suspense fallback={null}>
      <AssistantDrawer open={isOpen} onClose={close} initialQuestion={question} requestId={requestId} />
    </Suspense>
  );
}

function Shell() {
  const [collapsed, setCollapsed] = useLocalStorage<boolean>('atlas.sidebar.collapsed', false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const fetching = useIsFetching();
  const { pathname } = useLocation();
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  return (
    <div className="min-h-dvh bg-transparent" style={{ ['--atlas-topbar-h' as string]: '56px' }}>
      <a
        href="#atlas-main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[200] focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:shadow-pop"
      >
        Skip to content
      </a>
      <Sidebar collapsed={collapsed} onToggleCollapsed={() => setCollapsed((c) => !c)} mobileOpen={mobileOpen} onCloseMobile={closeMobile} />
      <div
        className={clsx(
          'atlas-main atlas-pb-nav flex min-h-dvh min-w-0 flex-col transition-[margin] duration-200 lg:ml-(--atlas-sidebar-w)',
        )}
        style={{ ['--atlas-sidebar-w' as string]: `${collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH}px` }}
      >
        <TopBar onOpenMenu={() => setMobileOpen(true)} />
        <ProgressBar active={fetching > 0} className="sticky top-14 z-30 -mb-0.5" />
        <main id="atlas-main" tabIndex={-1} className="mx-auto w-full max-w-[1600px] min-w-0 flex-1 px-4 py-5 outline-none sm:px-6 sm:py-6 lg:px-8 lg:py-8">
          <div key={pathname} className="animate-page-in">
            <Suspense fallback={<LoadingBlock label="Loading module…" height={320} />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
      <MobileTabBar />
      <AssistantSlot />
      {/* Keyed by URL: back/forward restores positions; fresh loads and new pages start at the top. */}
      <ScrollRestoration getKey={(loc) => `${loc.pathname}${loc.search}`} />
    </div>
  );
}

export function Layout() {
  return (
    <AssistantProvider>
      <Shell />
    </AssistantProvider>
  );
}
