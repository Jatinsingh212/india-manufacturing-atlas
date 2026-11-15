/**
 * Route table (SPEC section 8). Every page is lazy-loaded (its own chunk). Pages render inside
 * <Layout> through a pathless child route whose `errorElement` keeps errors inside the shell.
 *
 * Route-level role gates: modules whose whole API is government-only (SPEC section 5) are wrapped in
 * <RequireRole> here - /analytics, /risk, /residual (GOV_ROLES) and /admin (admin) - so their pages
 * can assume an authorised user. Mixed modules (/policy, /data-hub, /helpdesk) gate individual tabs
 * or actions themselves.
 */
import { lazy, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import type { Role } from '@/api/types';
import { RequireRole } from '@/auth/RequireRole';
import { Layout } from '@/components/layout/Layout';
import { navItem } from './nav';
import RouteError from './RouteError';

type Page = LazyExoticComponent<ComponentType>;

const pages = {
  overview: lazy(() => import('@/pages/overview/OverviewPage')),
  explore: lazy(() => import('@/pages/explore/ExplorePage')),
  product: lazy(() => import('@/pages/product/ProductPage')),
  ministries: lazy(() => import('@/pages/ministries/MinistriesPage')),
  ministry: lazy(() => import('@/pages/ministries/MinistryPage')),
  sector: lazy(() => import('@/pages/sectors/SectorPage')),
  valueChains: lazy(() => import('@/pages/valuechains/ValueChainsPage')),
  valueChain: lazy(() => import('@/pages/valuechains/ValueChainPage')),
  valueChainMapping: lazy(() => import('@/pages/valuechains/ValueChainMappingPage')),
  network: lazy(() => import('@/pages/network/NetworkPage')),
  deepDive: lazy(() => import('@/pages/deepdive/DeepDivePage')),
  workflow: lazy(() => import('@/pages/workflow/WorkflowPage')),
  decisions: lazy(() => import('@/pages/decisions/DecisionsPage')),
  analytics: lazy(() => import('@/pages/analytics/AnalyticsPage')),
  policy: lazy(() => import('@/pages/policy/PolicyPage')),
  risk: lazy(() => import('@/pages/risk/RiskPage')),
  dataHub: lazy(() => import('@/pages/datahub/DataHubPage')),
  login: lazy(() => import('@/pages/auth/LoginPage')),
  notFound: lazy(() => import('./NotFoundPage')),
} satisfies Record<string, Page>;

/** Role gate helper retained for future gated modules if needed. */
export function gated(path: string, Page: Page, roles: readonly Role[] | 'gov'): ReactNode {
  const item = navItem(path);
  return (
    <RequireRole roles={roles} title={item?.label} description={item?.description}>
      <Page />
    </RequireRole>
  );
}

function el(Page: Page): ReactNode {
  return <Page />;
}

/** Development-only component gallery (/_dev/components); never part of a production build. */
const devRoutes: RouteObject[] =
  import.meta.env.DEV || import.meta.env.VITE_ATLAS_GALLERY === '1'
    ? [{ path: '_dev/components', element: el(lazy(() => import('./DevGallery'))) }]
    : [];

export const routeObjects: RouteObject[] = [
  {
    path: '/',
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      {
        errorElement: <RouteError />,
        children: [
          { index: true, element: el(pages.decisions) },
          { path: 'explore', element: el(pages.explore) },
          { path: 'product/:hsn8', element: el(pages.product) },
          { path: 'ministries', element: el(pages.ministries) },
          { path: 'ministry/:id', element: el(pages.ministry) },
          { path: 'sector/:id', element: el(pages.sector) },
          { path: 'value-chains', element: el(pages.valueChains) },
          { path: 'value-chains/:id', element: el(pages.valueChain) },
          { path: 'value-chains/:id/mapping', element: el(pages.valueChainMapping) },
          { path: 'network', element: el(pages.network) },
          { path: 'workflow', element: <Navigate to="/workflow/sports_goods" replace /> },
          { path: 'workflow/:chainId', element: el(pages.workflow) },
          { path: 'deep-dive', element: <Navigate to="/deep-dive/sports_equipment" replace /> },
          { path: 'deep-dive/:hs4', element: el(pages.deepDive) },
          { path: 'decisions', element: <Navigate to="/" replace /> },
          { path: 'guidebook', element: el(pages.overview) },
          { path: 'analytics', element: el(pages.analytics) },
          { path: 'policy', element: el(pages.policy) },
          { path: 'risk', element: el(pages.risk) },
          { path: 'data-hub', element: el(pages.dataHub) },
          // retired pages: old links land on the Overview instead of a 404
          ...['about', 'admin', 'roadmap', 'helpdesk', 'residual', 'bids'].map((path) => ({ path, element: <Navigate to="/" replace /> })),
          { path: 'login', element: el(pages.login) },
          ...devRoutes,
          { path: '*', element: el(pages.notFound) },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routeObjects);
