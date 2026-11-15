/**
 * Navigation model (SPEC section 8): sidebar groups, page titles / blurbs and the access level of
 * each module. Used by the Sidebar, the route-level role gates in routes.tsx and the page stubs.
 */
import {
  Database,
  Layers,
  Landmark,
  ListTree,
  Network,
  Scale,
  ShieldAlert,
  TrendingUp,
  Compass,
  Route,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { Role } from '@/api/types';

export interface NavItem {
  /** Route path (exact path for the sidebar link). */
  to: string;
  label: string;
  icon: LucideIcon;
  /** One-line purpose, shown in tooltips, page stubs and restricted panels. */
  description: string;
  /** Roles allowed to open the module; undefined = public. */
  roles?: readonly Role[];
  /** Extra path prefixes that keep this item highlighted (e.g. /ministry/:id under Ministries). */
  match?: readonly string[];
  /** Left out of the sidebar; the route still works by URL. */
  hidden?: boolean;
}

export interface NavGroup {
  id: 'atlas' | 'intelligence' | 'operations' | 'about';
  label: string;
  items: NavItem[];
  /** Whole group left out of the sidebar; its routes still work by URL. */
  hidden?: boolean;
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'atlas',
    label: 'Atlas',
    items: [
      {
        to: '/explore',
        label: 'HSN Explorer',
        icon: ListTree,
        description: 'Search and browse every 8-digit HSN line by code, product, ministry or sector.',
        match: ['/product/'],
      },
      {
        to: '/ministries',
        label: 'Ministry Wise HSN',
        icon: Landmark,
        description: 'Ministry-specific dashboards: codes owned, trade performance, value-chain linkages.',
        match: ['/ministry/', '/sector/'],
      },
      {
        to: '/workflow/sports_goods',
        label: 'Product workflow',
        icon: Route,
        description: 'One product end to end: who makes it and where, raw materials and their HSN codes, trade and duty, world competitors, standards, and export-market flags.',
        match: ['/workflow/'],
      },
      {
        to: '/',
        label: 'Overview',
        hidden: true,
        icon: Compass,
        description: 'Decisions Studio: Strategic manufacturing opportunity assessment, location viability, and verified supplier matching.',
      },
      {
        to: '/value-chains',
        label: 'Value chains',
        hidden: true,
        icon: Workflow,
        description: 'Sector deep-dives for the value chains with ministry-wise product mapping.',
      },
      {
        to: '/deep-dive/sports_equipment',
        label: 'Product deep-dive',
        hidden: true,
        icon: Layers,
        description: 'Sports equipment (the study\'s 28 HS codes) or any HS heading, down to 8-digit lines: trade, tariffs, standards, clusters, land and export readiness by market.',
        match: ['/deep-dive/'],
      },
      {
        to: '/network',
        label: 'Network',
        hidden: true,
        icon: Network,
        description: 'HSN interlinkage graph: one HSN to many inputs and outputs across the ecosystem.',
      },

    ],
  },
  {
    id: 'intelligence',
    label: 'Intelligence',
    hidden: true,
    items: [
      {
        to: '/analytics',
        label: 'Opportunity Lab',
        icon: TrendingUp,
        description: 'Export potential, import dependency, substitution, RCA competitiveness, forecasts and archetypes.',
      },
      {
        to: '/policy',
        label: 'Policy Workbench',
        icon: Scale,
        description: 'PLI targeting, quality control, FTA negotiation analysis, tariff simulation and skilling.',
      },
      {
        to: '/risk',
        label: 'Supply-chain Risk',
        icon: ShieldAlert,
        description: 'Import-concentration vulnerability index, China dependence and automated alerts.',
      },
    ],
  },
  {
    id: 'operations',
    label: 'Operations',
    hidden: true,
    items: [
      {
        to: '/data-hub',
        label: 'Data Hub',
        icon: Database,
        description: 'Data sources and connectors, refresh jobs, official uploads and data-quality checks.',
      },

    ],
  },
];

/** Groups and items shown in the sidebar (hidden ones removed). */
export const VISIBLE_NAV_GROUPS: NavGroup[] = NAV_GROUPS.filter((g) => !g.hidden)
  .map((g) => ({ ...g, items: g.items.filter((i) => !i.hidden) }))
  .filter((g) => g.items.length > 0);

/** Flat list of all nav items. */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** Nav item for a path (exact `to` match). */
export function navItem(to: string): NavItem | undefined {
  return NAV_ITEMS.find((i) => i.to === to);
}

/** Whether `pathname` belongs to the nav item (for the active state). */
export function isNavActive(item: NavItem, pathname: string): boolean {
  if (item.to === '/') return pathname === '/';
  if (pathname === item.to || pathname.startsWith(`${item.to}/`)) return true;
  return (item.match ?? []).some((p) => pathname.startsWith(p));
}
