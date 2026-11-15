/**
 * Route builders - the one place that knows URL shapes (SPEC section 8). Always link with these so
 * every page agrees on query-param names:
 *
 *   /explore?q=<text or code prefix>                   HSN Explorer (search + tree)
 *   /explore?sector_id=&ministry_id=&chapter=&mapping_status=&mapping_source=   filtered Explorer
 *   /product/:hsn8                                     product page
 *   /ministry/:id   /sector/:id                        dashboards
 *   /value-chains/:id/mapping?stage=<stage_id>         ministry-wise mapping table, optionally one stage
 *   /network?chain=<chain_id>&center=<code>&depth=2    value-chain network
 *   /analytics?tab=<tab>   /policy?tab=<tab>           tabbed pages (Tabs urlParam="tab")
 *   /helpdesk?hsn8=<code>                              pre-fills "raise a query" for a product
 *   /login?next=<path>&mode=register                   returns to `next` after signing in; mode=register opens sign-up
 *   /about#methodology                                 "Model estimate" explanations
 */
import { normalizeCode } from '@/api/client';

const enc = encodeURIComponent;

function qs(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const routes = {
  overview: () => '/',
  explore: (p: {
    q?: string | null;
    sector_id?: string | null;
    ministry_id?: string | null;
    chapter?: string | null;
    mapping_status?: string | null;
    mapping_source?: string | null;
  } = {}) =>
    `/explore${qs({
      q: p.q,
      sector_id: p.sector_id,
      ministry_id: p.ministry_id,
      chapter: p.chapter,
      mapping_status: p.mapping_status,
      mapping_source: p.mapping_source,
    })}`,
  product: (hsn8: string) => `/product/${enc(normalizeCode(hsn8))}`,
  ministries: () => '/ministries',
  ministry: (id: string) => `/ministry/${enc(id)}`,
  sector: (id: string) => `/sector/${enc(id)}`,
  deepDive: (hs4: string) => `/deep-dive/${enc(hs4)}`,
  valueChains: () => '/value-chains',
  valueChain: (id: string) => `/value-chains/${enc(id)}`,
  valueChainMapping: (id: string, stage?: string | null) => `/value-chains/${enc(id)}/mapping${qs({ stage })}`,
  network: (p: { chain?: string | null; center?: string | null; depth?: number | null } = {}) =>
    `/network${qs({ chain: p.chain, center: p.center ? normalizeCode(p.center) : undefined, depth: p.depth })}`,
  decisions: (tab?: string | null) => `/decisions${qs({ tab })}`,
  analytics: (tab?: string | null) => `/analytics${qs({ tab })}`,
  policy: (tab?: string | null) => `/policy${qs({ tab })}`,
  risk: () => '/risk',
  dataHub: (tab?: string | null) => `/data-hub${qs({ tab })}`,
  /** `mode: 'register'` opens the industry registration form. */
  login: (next?: string | null, mode?: 'register' | null) => `/login${qs({ next, mode })}`,
} as const;

/**
 * Best page for any HS code: 8-digit lines -> product page; 2/4/6-digit codes -> Explorer search
 * (code prefixes match). Returns null for empty input.
 */
export function routeForCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const c = normalizeCode(code);
  if (/^\d{8}$/.test(c)) return routes.product(c);
  return routes.explore({ q: c });
}
