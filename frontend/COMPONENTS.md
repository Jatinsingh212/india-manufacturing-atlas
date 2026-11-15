# Frontend foundation: guide for page builders

The foundation (owner D0) gives you the app shell, a typed API client, auth, a design system and
about forty components. **Your job is the pages.** This guide covers everything you need to build one.

- Contract: `docs/SPEC.md` §6 (API shapes) and §8 (pages). Types: `src/api/types.ts`.
- Live reference: run `npm run dev` and open **http://localhost:5173/_dev/components**. It is a
  development-only gallery of every component with sample values, and it is never in a production build.

---

## 1. Rules

| Rule | Detail |
|---|---|
| Own only your folders | D1 `pages/{overview,explore,product}`, D2 `pages/{ministries,sectors,valuechains}`, D3 `pages/{network,analytics,policy,risk}`, D4 `pages/{residual,helpdesk,datahub,roadmap,admin,about,auth,assistant}`. Never edit anything else under `frontend/`. |
| No new dependencies | Everything is installed: react 19, react-router 7, @tanstack/react-query 5, tailwindcss 4, echarts 6, cytoscape 3 + cytoscape-dagre, lucide-react, clsx, react-markdown + remark-gfm. |
| Default export per page file | The router lazy-loads `pages/<area>/<Name>Page.tsx` through its **default export**. Keep the file names from SPEC §8. |
| Page-local code stays in your folder | Put helpers in `pages/<area>/api.ts` (queries), `pages/<area>/components/*.tsx`, `pages/<area>/utils.ts`. |
| Verify | `npm run typecheck` (zero errors) and `npm run build`. Check the page in the dev server against the live API (`:8000`). The quality bar is no console errors. |
| Never invent data | Show `null` as "Not available" (the format helpers do this). Show provenance next to numbers. Label every score or forecast as a model estimate with `<ModelEstimateTag />`. |
| No placeholder text | No "lorem" or "TODO" in shipped UI. |

Imports use the `@/` alias (`@/` = `src/`):

```ts
import { api, errorMessage } from '@/api/client';
import type { ProductSummary } from '@/api/types';
import { useMinistries } from '@/api/hooks';
import { useAuth, RequireRole } from '@/auth';
import { Card, DataTable, KpiTile, PageHeader, type Column } from '@/components';
import { fmtUSD, fmtPct, NA_SHORT } from '@/lib/format';
import { routes } from '@/lib/routes';
import { ministryColor, CATEGORICAL } from '@/lib/theme';
import { useTheme } from '@/theme/ThemeContext';
```

---

## 2. Page skeleton

```tsx
// pages/ministries/MinistryPage.tsx
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Landmark } from 'lucide-react';
import { api } from '@/api/client';
import { Card, DownloadMenu, KpiTile, PageHeader, QueryState, StatGrid } from '@/components';
import { fmtNum, fmtUSD } from '@/lib/format';
import { routes } from '@/lib/routes';

export default function MinistryPage() {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['ministries', id], queryFn: ({ signal }) => api.ministry(id, { signal }), enabled: !!id });

  return (
    <QueryState query={q}>
      {(d) => (
        <>
          <PageHeader
            eyebrow="Ministry dashboard"
            title={d.ministry.name}
            icon={Landmark}
            iconColor={d.ministry.color}
            breadcrumbs={[{ label: 'Ministries', to: routes.ministries() }, { label: d.ministry.short_name }]}
            actions={<DownloadMenu kind="ministry" id={id} />}
          />
          <StatGrid cols={4}>
            <KpiTile label="HS codes owned" value={fmtNum(d.kpis.codes)} />
            <KpiTile label="India exports" value={fmtUSD(d.kpis.exports)} accent="brand" />
          </StatGrid>
          <div className="mt-6 grid gap-6 xl:grid-cols-2">
            <Card title="Top exports">…</Card>
          </div>
        </>
      )}
    </QueryState>
  );
}
```

Layout conventions:

- The shell adds page padding and a 1600 px maximum width. Do not add an outer container.
- `PageHeader` comes first. It also sets the browser tab title. If the title is not a plain string, pass `documentTitle`.
- Vertical rhythm is `space-y-6` or `mt-6` between sections. Grids are `grid gap-6 xl:grid-cols-2` (or `lg:grid-cols-3`). KPI rows use `<StatGrid cols={4|5|6}>`.
- Wide tables go in `<Card padding="none">` or a plain `<Card>`. DataTable has its own border.
- Pages must work down to 1024 px and stay usable on mobile. Avoid fixed widths and let grids collapse.

---

## 3. Routes and URL parameters

Always build links with `routes.*` from `src/lib/routes.ts`:

| Builder | URL | Notes |
|---|---|---|
| `routes.overview()` | `/` | |
| `routes.explore({ q })` | `/explore?q=` | `q` is free text or a code prefix (the Explorer reads `q`) |
| `routes.product(hsn8)` | `/product/:hsn8` | dots and spaces are stripped |
| `routes.ministry(id)` / `routes.sector(id)` | `/ministry/:id`, `/sector/:id` | |
| `routes.valueChains()` / `routes.valueChain(id)` | `/value-chains`, `/value-chains/:id` | |
| `routes.valueChainMapping(id, stage?)` | `/value-chains/:id/mapping?stage=` | |
| `routes.network({ chain, center, depth })` | `/network?chain=&center=&depth=` | the Network page reads these |
| `routes.analytics(tab?)`, `routes.policy(tab?)`, `routes.dataHub(tab?)` | `?tab=` | use `<Tabs urlParam="tab">` |
| `routes.helpdesk({ hsn8 })` | `/helpdesk?hsn8=` | pre-fills "raise a query" |
| `routes.login(next?, mode?)` | `/login?next=&mode=register` | Login returns to `next` after sign-in |
| `routes.about(hash?)`, `routes.methodology()` | `/about#methodology`, `/about#data-sources` | About must provide these ids |
| `routeForCode(code)` | product page for 8 digits, else Explorer | used by `CodeLink` |

Route-level role gates are already applied in `src/app/routes.tsx`:

- `/analytics`, `/risk` and `/residual` are open to `GOV_ROLES` (analyst, ministry, admin).
- `/admin` is admin only.

Those pages can assume an authorised user. Mixed pages (`/policy`, `/data-hub`, `/helpdesk`) must gate their own tabs and actions (§6).

Hooks for URL state are in `src/lib/hooks.ts`:

- `useSearchParamState('chain', '')` keeps one query param as state.
- `useHashScroll(ready)` scrolls to `#id` after data loads. AboutPage uses it for `#methodology`.
- Also available: `useDebouncedValue`, `useLocalStorage`, `useMediaQuery`, `useDocumentTitle`.

---

## 4. Data: client, types and React Query

### The client (`src/api/client.ts`)

`api.*` has one typed function for every SPEC §6 endpoint. Each one takes an optional trailing
`{ signal }`; pass React Query's signal so stale requests are cancelled.

| Area | Functions |
|---|---|
| System / auth | `health()`, `login({email,password})`, `demoLogin(role)`, `register(body)`, `me()` |
| Meta | `overview()`, `ministries()`, `sectors()`, `sections()`, `countries()`, `info()` |
| HSN | `searchProducts(params)`, `suggest(q)`, `lookup(code)`, `product(hsn8)`, `tree(code?)`, `compare(codes[])` |
| Ministries / sectors | `ministry(id)`, `ministryProducts(id, params)`, `sector(id)`, `sectorProducts(id, params)` |
| Value chains / network | `valueChains()`, `valueChain(id)`, `valueChainMapping(id, stageId?)`, `network(params)`, `trace(code, params)` |
| Analytics (GOV) | `opportunities(f)`, `importDependency(f)`, `importSubstitution(f)`, `competitiveness(f)`, `demandSupply(p)`, `archetypes(f)`, `forecast(code)`, `trends(p)`, `anomalies(p)` |
| Policy | `useCases()`, `schemes(kind?)`, `scheme(id)`, `agreements()`, `negotiation({partner}\|{agreement})`, `simulateTariff(body)`, `skilling(p)` |
| Risk (GOV) | `riskOverview(f)`, `riskAlerts(p)` |
| Residual | `residual(p)`, `residualSuggest(hsn8)`, `claimResidual(hsn8, body)`, `residualClaims(status?)`, `reviewClaim(id, body)` |
| Helpdesk | `createTicket(body)`, `tickets(p)`, `ticket(id)`, `addTicketMessage(id, text)`, `setTicketStatus(id, status)`, `ticketStats()` |
| Data hub | `dataSources()`, `refreshSource(id)`, `jobs()`, `upload(kind, file)`, `applyUpload(id)`, `uploads()`, `templateUrl(kind)`, `downloadTemplate(kind)`, `quality()` |
| Reports | `downloadReport(kind, id, format, params?)`, `downloadSearchReport(filters, 'csv'\|'xlsx')`, `reportUrl(...)` |
| Admin / roadmap / watchlist | `adminUsers()`, `createUser(b)`, `updateUser(id, b)`, `audit(p)`, `roadmap()`, `updateRoadmapItem(id, status)`, `risks()`, `updateRisk(id, b)`, `watchlist()`, `addToWatchlist(hsn8)`, `removeFromWatchlist(hsn8)` |
| Assistant | `assistantStatus()`, `assistantChat(messages)` |

Some list endpoints are left ambiguous by SPEC. The client normalises them so pages always get one shape:

- `tickets()` and `audit()` always return `Paginated<T>`.
- `jobs()`, `uploads()`, `adminUsers()`, `risks()`, `watchlist()`, `residualClaims()`, `riskAlerts()` and `anomalies()` always return `T[]`.

For anything else, the low-level helpers are `apiGet / apiPost / apiPatch / apiDelete / apiUpload`, plus
`downloadFile(path, params, fallbackName)`, `saveBlob(blob, name)`, `apiUrl(path, params)` and `normalizeCode('4011.10.10')`.

### Errors

Every failure throws `ApiError { status, detail }`. Status `0` means the network failed. A 502, 503 or 504 means
the API is not responding (`isUnavailable`). The class also has `isUnauthorized` (401), `isForbidden` (403),
`isAuthError` and `isNotFound`.

- `errorMessage(err)` gives a display string.
- `<ErrorState error={err} />` handles all of these. A 401 or 403 renders a sign-in prompt with demo buttons.
- A 401 on a request that carried a token signs the user out automatically.

### Queries

`queryClient` is configured for the whole app: 5 minute `staleTime`, no refetch on window focus, and no retry on 4xx.

```ts
// pages/analytics/api.ts  (page-local query hooks)
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { AnalyticsFilters } from '@/api/types';

export function useOpportunities(f: AnalyticsFilters) {
  return useQuery({
    queryKey: ['analytics', 'opportunities', f],
    queryFn: ({ signal }) => api.opportunities(f, { signal }),
    placeholderData: keepPreviousData, // keep the frame while filters change
  });
}
```

Query key convention: `['<area>', '<endpoint>', ...params]`. Shared reference data has ready-made
hooks in `src/api/hooks.ts`. Use them so every page shares one cache entry:

- `useMinistries`, `useSectors`, `useSections`, `useCountries`, `useValueChains`, `useAgreements`, `useHealth`, `useAssistantStatus`
- `useMinistryLookup()` and `useSectorLookup()` return an id-to-row `Map`.
- `useMinistryOptions()` and `useSectorOptions()` return options for `<Select>`.
- `queryKeys.*` holds the shared keys, for invalidation.

Mutations:

```ts
const qc = useQueryClient();
const toast = useToast();
const claim = useMutation({
  mutationFn: (v: { hsn8: string; ministry_id: string; justification: string }) =>
    api.claimResidual(v.hsn8, { ministry_id: v.ministry_id, justification: v.justification }),
  onSuccess: () => { toast.success('Claim submitted'); qc.invalidateQueries({ queryKey: ['residual'] }); },
  onError: (e) => toast.error('Claim failed', errorMessage(e)),
});
```

Server-paginated table (HSN search, ministry products, residual):

```tsx
const [page, setPage] = useState(1);
const [pageSize, setPageSize] = useState(25);
const [sort, setSort] = useState<SortState>({ key: 'exports', order: 'desc' });
const q = useQuery({
  queryKey: ['ministries', id, 'products', page, pageSize, sort],
  queryFn: ({ signal }) => api.ministryProducts(id, { page, page_size: pageSize, sort: sort.key as SearchSort, order: sort.order }, { signal }),
  placeholderData: keepPreviousData,
});
<DataTable columns={cols} rows={q.data?.items} rowKey={(r) => r.hsn8} loading={q.isFetching} error={q.error}
  sort={sort} onSortChange={setSort}
  pagination={{ mode: 'server', page, pageSize, total: q.data?.total ?? 0, onPageChange: setPage, onPageSizeChange: setPageSize }} />
```

In server mode, only columns with a `sortKey` (or `sortable: true`, which sends `key`) are sortable. Use the SPEC sort names: `exports`, `imports`, `rca`, `code`, `world_trade`, `relevance`.

---

## 5. Units and formatting (`src/lib/format.ts`)

Money is in US$ (not millions). Shares, CAGRs and YoY are fractions. Tariffs (`mfn_tariff`, `mfn_avg`) are percentages.

Every helper returns **"Not available"** for `null`. In dense tables, pass `{ na: NA_SHORT }` to get "—" instead.

| Helper | Example |
|---|---|
| `fmtUSD(v)` | `3.106e9` gives "$3.11 bn"; `8.12e8` gives "$812 mn"; `{ signed: true }` gives "+$12 mn" |
| `fmtUSDMn(v)` | compact style for "($ Mn.)" columns: `1.723e9` gives "1,723"; `{ withUnit: true }` gives "$1,723 Mn." |
| `fmtPct(frac)` | `0.0307` gives "3.1%"; `0.0005` gives "0.05%"; `{ signed: true }` gives "+5.0%" |
| `fmtRate(pct)` | tariffs: `12.5` gives "12.5%" (`bcd_display` is already a string) |
| `fmtNum(v)` | "13,110"; `{ unit: 'tonnes' }`; `{ compact: true }` gives "13.1K" |
| `fmtRatio(v)` | RCA: "1.20" |
| `fmtScore(v)` | 0–100 scores: "73" |
| `fmtCode(code)` | "4011.10.10" / "4011.10" / "4011"; `'plain'` leaves it as is |
| `fmtDate(iso, { withTime })`, `fmtAgo(iso)` | "19 Oct 2026", "3 h ago" |
| `cagrLabel(c, from, to)`, `yoyLabel(y)` | "+12.3% CAGR 2018–24", "+8.4% YoY" |
| `fmtOrdinal(8)` | "8th", for "India's rank is 8th in global suppliers" |
| `truncate(s, n)`, `plural(n, 'code')`, `humanize('not_verified')`, `hsLevelName(code)` | |

---

## 6. Auth (`src/auth`)

```ts
const { user, role, token, isGov, isAdmin, isAuthenticated, loading, login, demoLogin, register, logout, hasRole } = useAuth();
hasRole('gov');            // analyst | ministry | admin (admin always passes)
hasRole(['ministry']);     // ministry or admin
user.ministry_id;          // scope for ministry officers
```

Role gates:

- Gate a page section or tab: `<RequireRole roles="gov" title="Tariff simulator" description="…" compact>…</RequireRole>`.
- Gate a single action: render the button only if `hasRole([...])`, or show `<SignInPrompt roles={[...]} />`.
- Demo sign-in buttons are available on their own: `<DemoLoginButtons allowed="gov" />`. `DEMO_ROLES` lists the role, label, icon and blurb for the Login page.
- `ROLE_LABELS` holds display names. `roleAllowed(role, roles)` is the pure check.

The Login page (D4) should:

- Read `next` and `mode=register` from the URL.
- Call `login`, `register` or `demoLogin`.
- On success, run `navigate(next ?? '/', { replace: true })`.

Signing in or out resets the query cache, so data refetches with the new role.

---

## 7. Components (`@/components`)

| Component | Use | Key props |
|---|---|---|
| `PageHeader` | page title block | `title, subtitle, eyebrow, icon, iconColor, breadcrumbs, meta, actions, documentTitle` |
| `Card`, `SectionLabel` | white content card | `title, subtitle, icon, actions, footer, padding: none\|sm\|md\|lg, tone: default\|navy\|subtle, id` |
| `KpiTile`, `StatGrid` | headline numbers (magenta numerals) | `label, value (pre-formatted; null shows Not available), sub, icon, accent: kpi\|brand\|ink\|ok\|bad, provenance \| status, trend (number[]), delta {value, label, upIsGood}, hint, to \| onClick, size` |
| `DataTable<T>` | sortable, paginated table | `columns: Column<T>[]` (`key, header, value, render, align, width, sortable, sortKey, csv, hint, sticky, hideBelow`), `rows, rowKey, loading, error, onRetry, onRowClick, isRowSelected, sort/onSortChange` (server), `defaultSort`, `pagination: false\|{mode:'client'}\|{mode:'server',…}`, `maxHeight` (sticky header area, default 70vh; `null` for none), `dense, csvFilename` (CSV of the current rows), `toolbar, toolbarRight, footer, emptyTitle, emptyMessage` |
| `QueryState` | loading / error / empty / data for a query | `query, children: (data) => …, isEmpty, emptyTitle, emptyMessage, roles, compact` |
| `EChart` | ECharts with the Atlas theme | `option, height, onEvents {click: (p, chart) => …}, loading, notMerge, onReady, ariaLabel, renderer` |
| `Sparkline` | inline trend | `values, width, height, color, accent, area` |
| `CountryBars` | `CountryValue[]` bars, India in magenta | `items, limit, valueFormat, showShare, showRank, highlightIso3, onCountryClick` |
| `NetworkGraph` | cytoscape graph for `NetworkResponse` | `nodes, edges, height, layout: 'dagre-lr'\|'dagre-tb'\|'cose'\|'concentric'\|LayoutOptions, sizeBy, selectedId, highlightIds, dimOthers, wheelZoom (default off), showControls, onNodeClick, onEdgeClick, onBackgroundClick, onReady(cy)` |
| `ProvenanceBadge`, `ProvenanceDot`, `ProvenanceLegend` | provenance legend: Verified, Not verified, Not available | `provenance \| status, showSource, compact, size` |
| `ModelEstimateTag` | "Model estimate" chip that links to `/about#methodology` | `method` |
| `MinistryPill`, `SectorPill` | entity chip in the curated colour, links to the dashboard | `ministry {id, short_name, name, color}`, `link, full, role, size` |
| `CodeLink` | monospace HS code linking to the right page | `code, label, style, to, noLink` |
| `ArchetypeBadge` | Champion, Established, Emerging, Dependent, Marginal | `archetype` |
| `ScoreBar` | 0–100 meter | `value, scale: 'sequential'` (higher = more) or `'risk'` (higher = worse), `label, showValue, size, width` |
| `Badge` | small label | `tone: neutral\|brand\|success\|danger\|warning\|orange\|info\|magenta\|navy\|outline, icon, dot, size` |
| `Button`, `IconButton` | the only button style | `variant: primary\|secondary\|ghost\|danger\|accent\|link\|navy, size, icon, iconRight, loading, to` (router link), `href` (external) |
| `Menu` | dropdown | `trigger: (props) => <Button {...props}/>, items: {label, description, icon, onSelect \| to, danger, divider}[], align, header` |
| `DownloadMenu` | PDF, XLSX or CSV report | `kind: product\|ministry\|sector\|valuechain\|search, id, params, formats, label` |
| `HsnSearchBox` | typeahead over `/api/hsn/suggest` | navigates by default; `onSelect(item)` and `onSubmit(text)` override it; `placeholder, size, autoFocus, clearOnSelect` |
| `Tabs` | tab bar (URL-synced with `urlParam`) | `tabs: {id, label, icon, badge, disabled}[], urlParam \| value/onChange \| defaultValue, children: (active) => …, actions` |
| `Drawer`, `Modal` | overlays (Escape, scroll lock, focus) | `open, onClose, title, subtitle/description, footer, side/width \| size, flush` |
| `Select`, `SearchInput`, `TextInput`, `TextArea`, `FormField`, `Toggle`, `SegmentedControl` | form controls | `Select {value, onChange, options, placeholder, label}`, `SearchInput {value, onChange, debounce}`, `SegmentedControl {value, onChange, options}` (e.g. Top 5 / All) |
| `KeyValueList` | label/value rows (the slide-11 lookup table) | `items: {label, value, numeric, aside}[], variant: table\|plain, labelWidth` |
| `Markdown` | renders `body_md` and assistant replies | `children (string), size` |
| `EmptyState`, `ErrorState`, `LoadingBlock`, `Skeleton`, `SkeletonRows`, `Spinner`, `ProgressBar` | states | |
| `Tooltip` | portal tooltip (extra detail only, never the only place a value appears) | `content, side, maxWidth, block` |
| `useToast()` | global toasts | `toast.success(title, msg)`, `.error`, `.info`, `.push({...})` |
| `useAssistant()` | open the "Ask Atlas" drawer from any page | `open(question?)`, `close()`, `isOpen` |

EChart, NetworkGraph and Markdown load their libraries lazily. Importing from `@/components` stays cheap.

---

## 8. Charts and colour

The `dataviz` method was applied; follow it in your options.

- **Pick the form first.** A single headline number is a `KpiTile`, not a chart. Magnitude across categories is a horizontal bar. Change over time is a line. Part-to-whole with 6 or fewer segments can be a donut (sectoral distribution); for close values, use bars.
- **Colour follows the entity.**
  - Ministries: `ministryColor(id, apiColor)`. Sectors: `sectorColor(id, apiColor)`. These are the curated colours.
  - Other series: `CATEGORICAL[mode][i]` in fixed order, or `colorForKey(key, allKeys, mode)` so filtering never repaints survivors.
  - Past 8 series, fold the rest into "Other" (`OTHER_GREY`). Never generate a 9th hue.
  - Scatter or bubble charts take at most 3 categorical colours. For archetypes, use `archetypeColor()` with direct labels.
- **One y-axis.** Never use dual axes. Put two measures in two charts or index them to a common base.
- **Magnitude** (0–100 scores, heatmaps): `sequentialColor(v)` / `SEQUENTIAL_BLUE`. **Polarity** (trade balance): `DIVERGING[mode]`. **Risk**: `riskColor(v)`.
- **Status colours are reserved.** Provenance (`PROVENANCE_COLORS`) and severity (`SEVERITY_COLORS`) are never series colours.
- **India highlight**: `INDIA_COLOR[mode]`, the magenta.
- **Text stays in ink tokens.** The theme already sets label colours; do not colour labels with series hues.
- **Legend and labels.** Use a legend for 2 or more series. Direct-label selectively (bar ends, the latest point). Keep a table view (`DataTable`) for the numbers.
- **Marks.** The theme handles 24 px bar max with 4 px rounded data-ends and 2 px lines. On horizontal bars, set `itemStyle.borderRadius: [0, 4, 4, 0]`. `horizontalBarOption({...})` in `lib/theme.ts` is a ready-made helper.
- **Height includes the axis band.** Use `grid: { ...BASE_GRID }` (`containLabel: true`).
- **Theme switching.** `const { mode } = useTheme()` gives `'light' | 'dark'`. `<EChart>` re-themes automatically; read `mode` only when you pick colours yourself.

Example: a forecast band on a line chart. Draw the band as an area wash and the forecast as a separate line, with no second axis.

```ts
const option: EChartsOption = {
  grid: { ...BASE_GRID, top: 32 },
  legend: { top: 0, left: 0 },
  tooltip: { trigger: 'axis', valueFormatter: (v) => fmtUSD(v as number) },
  xAxis: { type: 'category', data: years },
  yAxis: { type: 'value', axisLabel: { formatter: (v: number) => fmtUSD(v) } },
  series: [
    { type: 'line', name: 'Exports', data: history },
    { type: 'line', name: 'Forecast (model estimate)', data: forecast, lineStyle: { type: 'dashed' } },
  ],
};
```

---

## 9. Design tokens (Tailwind v4 classes)

The tokens follow the light and dark theme automatically:

| Group | Classes |
|---|---|
| Planes | `bg-bg` (page), `bg-surface` (cards), `bg-surface-2` (insets, table heads), `bg-surface-3` (hover) |
| Ink | `text-ink`, `text-ink-2`, `text-muted` |
| Lines | `border-line`, `border-line-strong` |
| Brand | `bg-brand` / `hover:bg-brand-hover`, `text-brand-ink` (links), `bg-brand-soft`, `bg-navy`, `text-on-navy`, `text-kpi` (magenta numerals), `bg-kpi-soft` |
| Status | `text-ok` / `bg-ok-soft` / `text-ok-ink`; `bad`, `na` (orange), `warn` and `info` follow the same pattern |
| Series | `bg-series-1` … `bg-series-8`, `text-india` |
| Effects | `shadow-card`, `shadow-pop`, `font-mono` |
| Utilities | `atlas-num` (tabular figures in columns), `atlas-link`, `atlas-scroll-x`, `atlas-prose` |

The raw CSS variables are `--atlas-*` (see `src/index.css`). `dark:` targets `<html data-theme="dark">`.

Typography: system UI stack with Inter first. Sizes:

- Page title 22–24 px, bold
- Card title 15 px, semibold
- Body 13–14 px
- Table text 13 px, with 11.5 px uppercase headers

Use `atlas-num` on numeric columns only. Large KPI values use proportional figures.

---

## 10. Assistant drawer contract (D4)

`components/layout/Layout.tsx` renders the default export of `pages/assistant/AssistantDrawer.tsx`:

```tsx
<AssistantDrawer open={isOpen} onClose={close} initialQuestion={question} requestId={requestId} />
```

Keep the `AssistantDrawerProps` interface: `{ open; onClose; initialQuestion?: string | null; requestId?: number }`.

- `requestId` changes on every `useAssistant().open(...)` call. Use it to pre-fill or send `initialQuestion` again.
- Use `<Drawer side="right" width={460} flush>` and `<Markdown>` for replies.
- Render `citations[].route` as router links.

Other pages open the drawer with `useAssistant().open('Which ministry owns 40111010?')`.

---

## 11. Shell facts

- **Sidebar**: groups from `src/app/nav.ts`. Gov-only modules show a lock. It collapses to a rail (the state persists) and becomes a drawer under 1024 px.
- **Top bar**:
  - global `HsnSearchBox`
  - "Ask Atlas" button
  - theme toggle
  - role badge
  - sign-in menu with demo roles, or the user menu
- **Footer**:
  - data credits
  - provenance legend
  - the plain-language mapping caveat
  - links to methodology and data sources
  - the latest year and build date from `/api/health`
- **404 page and route error boundary.** Errors render inside the shell. Window scroll restores on back and forward; new pages start at the top.
- **Commands**:
  - `npm run dev` (port 5173, proxies `/api` to 127.0.0.1:8000; override with `ATLAS_API_TARGET`)
  - `npm run build` (output in `frontend/dist`, served by FastAPI)
  - `npm run typecheck`
  - `npm run preview`
