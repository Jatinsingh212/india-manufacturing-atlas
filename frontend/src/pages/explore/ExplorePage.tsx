/**
 * ExplorePage (`/explore`) - the HSN Explorer (docs/SPEC.md section 8): the static Guidebook turned
 * into a searchable, drill-down register of every 8-digit line.
 *
 * - HS tree (sections -> chapters -> headings -> subheadings -> lines, lazy, with line counts and export
 *   values): beside the table on wide screens (collapsible), in a left drawer otherwise. Selecting a
 *   section scopes the table to its chapters, a chapter sets the `chapter` facet, and a heading,
 *   subheading or line scopes the table to its code prefix - while any free-text query is kept, so
 *   "cotton" can be searched within heading 6109.
 * - Main: one filter row (search, ministry, sector, chapter, mapping status / source, minimum exports /
 *   imports, RCA range) over a server-sorted, server-paginated table from GET /api/hsn/search, with
 *   CSV / XLSX export of the current filters via GET /api/reports/search. The toolbar says when the
 *   text query had to be relaxed (any word, or ministry / sector names).
 * - Compare tray: pin up to 5 rows -> GET /api/hsn/compare -> comparison table + overlaid trend chart.
 *
 * All search state is URL-synced (see useExploreState), so every view is shareable.
 */
import { useCallback, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import clsx from 'clsx';
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Download, FolderTree, Info, PanelLeftClose, Pin, PinOff, ScanSearch, X } from 'lucide-react';
import { normalizeCode } from '@/api/client';
import { useSections } from '@/api/hooks';
import type { ProductSummary, SearchSort, TreeNode } from '@/api/types';
import { useAuth } from '@/auth';
import {
  Badge,
  Button,
  Card,
  DataTable,
  DownloadMenu,
  Drawer,
  PageHeader,
  ProvenanceBadge,
  ProvenanceLegend,
  Select,
  Tooltip,
  type Column,
  type SortState,
} from '@/components';
import { fmtCode, fmtNum, hsLevelName } from '@/lib/format';
import { useLocalStorage, useMediaQuery } from '@/lib/hooks';
import { routes } from '@/lib/routes';
import { useHsTree, useProductSearch, type SearchMatch } from './api';
import { CompareModal, CompareTray, MAX_COMPARE, usePinned } from './components/Compare';
import { FilterPanel } from './components/FilterPanel';
import { HsTree } from './components/HsTree';
import { productColumns, tradeProvenance } from './shared';
import {
  isCodeQuery,
  isSectionScope,
  scopeFromTypedCode,
  toReportParams,
  toSearchParams,
  useExploreState,
  PAGE_SIZES,
  type ExplorePatch,
} from './useExploreState';

const SORT_LABELS: Record<SearchSort, string> = {
  relevance: 'Best match',
  exports: 'India exports',
  imports: 'India imports',
  world_trade: 'World trade',
  rca: 'RCA',
  code: 'HS code',
};

/** How the query matched, when that is worth saying (plain code / text matches need no note). */
const MATCH_NOTE: Partial<Record<SearchMatch, { label: string; hint: string; tone: 'info' | 'warning' }>> = {
  text_all_columns: {
    label: 'Matched on ministry or sector names',
    hint: 'No product description contains every word, so the search also looked at the owning ministry and sector names.',
    tone: 'info',
  },
  text_any: {
    label: 'Showing lines that match any word',
    hint: 'No line contains every word of the query, so the results list lines that match at least one of them, best matches first.',
    tone: 'warning',
  },
};

/** Describes the selected tree node ("Heading 4011 - New pneumatic tyres") using the cached tree level. */
function ScopeLabel({ code }: { code: string }) {
  const numeric = /^\d+$/.test(code);
  const parent = !numeric || code.length === 2 ? null : code.length === 4 ? code.slice(0, 2) : code.length === 6 ? code.slice(0, 4) : code.slice(0, 6);
  const siblings = useHsTree(parent, Boolean(parent));
  const sections = useSections();
  const description = numeric
    ? code.length === 2
      ? sections.data?.flatMap((s) => s.chapters).find((c) => c.code === code)?.description
      : siblings.data?.find((n) => n.code === code)?.description
    : sections.data?.find((s) => s.id === code)?.name;
  return (
    <span className="min-w-0 truncate">
      <span className="font-semibold">
        {numeric ? `${hsLevelName(code)} ${fmtCode(code)}` : `Section ${code}`}
      </span>
      {description ? <span className="text-ink-2"> · {description}</span> : null}
    </span>
  );
}

export default function ExplorePage() {
  const [state, update, reset] = useExploreState();
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuthenticated, loading: authLoading } = useAuth();
  // Side-by-side tree only where the table still has room for its columns (the shell sidebar takes ~240 px);
  // narrower screens open the tree in a drawer.
  const wide = useMediaQuery('(min-width: 1280px)');
  // Between 1280 and 1536 px the table beside the tree folds the ministry / sector pills into the product cell.
  const xxl = useMediaQuery('(min-width: 1536px)');
  const [drawerOpen, setDrawerOpen] = useState(false);
  // On wide screens the tree is shown by default and can be collapsed to give the table full width.
  const [treeCollapsed, setTreeCollapsed] = useLocalStorage<boolean>('atlas.explore.treeCollapsed', false);
  const [compareOpen, setCompareOpen] = useState(false);
  const pins = usePinned();
  const sideTree = wide && !treeCollapsed;

  // A section scope is sent as the list of its chapters, so the search waits for the sections.
  const sections = useSections();
  const sectionScope = isSectionScope(state.code);
  const sectionChapters = useMemo(
    () => (sectionScope ? (sections.data?.find((sec) => sec.id === state.code)?.chapters.map((c) => c.code) ?? null) : null),
    [sectionScope, sections.data, state.code],
  );
  const searchReady = !sectionScope || sectionChapters !== null || sections.isError;
  const searchParams = useMemo(() => toSearchParams(state, sectionChapters), [state, sectionChapters]);
  const reportParams = useMemo(() => toReportParams(state, sectionChapters), [state, sectionChapters]);
  const q = useProductSearch(searchParams, searchReady);

  const onSearch = useCallback(
    (text: string) => {
      const t = text.trim();
      const typed = isCodeQuery(t) ? normalizeCode(t) : null;
      let code: string | null;
      if (typed) {
        // A typed code selects its tree node.
        code = typed;
      } else if (scopeFromTypedCode(state)) {
        // The scope came from the previous typed code: free text replaces it (a chosen chapter stays).
        code = state.chapter || null;
      } else {
        // A scope picked in the tree stays, so text can be searched within it.
        code = state.code || null;
      }
      const patch: ExplorePatch = { q: t, code, sort: null, order: null };
      // A typed code outside the selected chapter would match nothing: drop the chapter facet.
      if (typed && state.chapter && !typed.startsWith(state.chapter)) patch.chapter = null;
      update(patch);
    },
    [update, state],
  );

  const onTreeSelect = useCallback(
    (node: TreeNode) => {
      // A code typed into the search would conflict with the new scope; free text is kept.
      const keepQ = isCodeQuery(state.q) ? null : state.q;
      if (node.level === 2) {
        // A chapter is also the chapter facet (the "More filters" select shows it).
        update({ chapter: node.code, code: node.code, q: keepQ, sort: null, order: null });
      } else {
        update({ code: node.code, chapter: null, q: keepQ, sort: null, order: null });
      }
      // In the drawer, a heading or deeper usually ends the drill-down: show the results.
      if (!wide && node.level >= 4) setDrawerOpen(false);
    },
    [update, state.q, wide],
  );

  const clearScope = () => {
    if (scopeFromTypedCode(state)) update({ q: null, code: null, chapter: state.chapter === state.code ? null : state.chapter || null });
    else if (state.chapter && state.chapter === state.code) update({ chapter: null, code: null });
    else update({ code: null });
  };

  const sort: SortState = { key: state.sort, order: state.order };
  const setSort = (s: SortState) => update({ sort: s.key, order: s.order });

  const columns = useMemo<Column<ProductSummary>[]>(
    () => [
      {
        key: 'pin',
        header: <span className="sr-only">Compare</span>,
        width: 40,
        sortable: false,
        csv: false,
        mobileAction: true,
        render: (r) => {
          const on = pins.isPinned(r.hsn8);
          const Icon = on ? PinOff : Pin;
          return (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                pins.toggle(r);
              }}
              onKeyDown={(e) => e.stopPropagation()}
              aria-pressed={on}
              aria-label={on ? `Remove ${fmtCode(r.hsn8)} from compare` : `Add ${fmtCode(r.hsn8)} to compare`}
              title={on ? 'Remove from compare' : `Add to compare (max ${MAX_COMPARE})`}
              className={clsx(
                'inline-flex size-7 items-center justify-center rounded-md transition-colors',
                on ? 'bg-kpi-soft text-kpi' : 'text-muted hover:bg-surface-3 hover:text-ink',
              )}
            >
              <Icon className="size-3.5" aria-hidden />
            </button>
          );
        },
      },
      // With the tree beside it the table drops World trade (still available in the sort menu).
      ...productColumns({ variant: 'full', serverSort: true, ownerInProduct: sideTree && !xxl }).filter(
        (c) => !(sideTree && c.key === 'world_trade'),
      ),
    ],
    [pins, sideTree, xxl],
  );

  const sortOptions = (Object.keys(SORT_LABELS) as SearchSort[])
    .filter((s) => s !== 'relevance' || state.q)
    .map((s) => ({ value: s, label: SORT_LABELS[s] }));

  const total = q.data?.total ?? 0;
  const matchNote = state.q && q.data?.match ? MATCH_NOTE[q.data.match as SearchMatch] : undefined;
  const treeVisible = wide ? !treeCollapsed : drawerOpen;
  const toggleTree = () => (wide ? setTreeCollapsed((c) => !c) : setDrawerOpen((o) => !o));
  const tree = <HsTree selected={state.code} onSelect={onTreeSelect} />;

  return (
    <>
      <PageHeader
        eyebrow="Atlas"
        title="HSN Explorer"
        icon={ScanSearch}
        subtitle="Drill through the 2-, 4-, 6- and 8-digit HS tree: Guidebook owners aggregated from accepted lines at every level, plus sector, mapping status, India's trade, world market, RCA and tariff."
        meta={<ProvenanceLegend compact />}
        actions={
          <>
            <Button icon={FolderTree} onClick={toggleTree} aria-expanded={treeVisible}>
              {treeVisible ? 'Hide HS tree' : 'Browse HS tree'}
            </Button>
            {/* SPEC section 5: search exports are for signed-in users (product / ministry reports stay public). */}
            {isAuthenticated ? (
              <DownloadMenu kind="search" params={reportParams} label="Export results" />
            ) : authLoading ? null : (
              <Button to={routes.login(`${location.pathname}${location.search}`)} icon={Download} title="Exports of the search table need a free sign-in">
                Sign in to export
              </Button>
            )}
          </>
        }
      />

      <div className={clsx('grid gap-5', sideTree && 'grid-cols-[minmax(14rem,17rem)_minmax(0,1fr)]')}>
        {sideTree ? (
          <aside aria-label="HS tree" className="sticky top-[72px] self-start">
            <Card
              title="HS nomenclature"
              subtitle="21 sections · select any level to filter"
              icon={FolderTree}
              padding="sm"
              actions={
                <Button size="xs" variant="ghost" icon={PanelLeftClose} onClick={() => setTreeCollapsed(true)} aria-label="Hide the HS tree" title="Hide the HS tree" />
              }
              bodyClassName="max-h-[calc(100vh-11rem)] overflow-y-auto"
            >
              {tree}
            </Card>
          </aside>
        ) : null}

        <div className="min-w-0 space-y-4">
          <FilterPanel state={state} update={update} reset={reset} onSearch={onSearch} />

          <Card padding="md">
            <DataTable
              columns={columns}
              rows={q.data?.items}
              rowKey={(r) => r.hsn8}
              loading={q.isFetching}
              error={q.error}
              onRetry={() => void q.refetch()}
              onRowClick={(r) => navigate(routes.product(r.hsn8))}
              isRowSelected={(r) => pins.isPinned(r.hsn8)}
              sort={sort}
              onSortChange={setSort}
              maxHeight="calc(100vh - 14rem)"
              caption="HSN search results"
              emptyIcon={ScanSearch}
              emptyTitle="No lines match these filters"
              emptyMessage="Try a shorter code, another product word, or clear some filters."
              toolbar={
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-[13px]">
                  <span className="font-semibold text-ink atlas-num">{q.data ? `${fmtNum(total)} ${total === 1 ? 'line' : 'lines'}` : 'Searching…'}</span>
                  {matchNote ? (
                    <Tooltip content={matchNote.hint} maxWidth={320}>
                      <Badge tone={matchNote.tone} icon={Info} size="sm">
                        {matchNote.label}
                      </Badge>
                    </Tooltip>
                  ) : null}
                  {state.code ? (
                    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border border-line bg-surface-2 py-0.5 pr-1 pl-2 text-[12px] text-ink">
                      <ScopeLabel code={state.code} />
                      <button type="button" onClick={clearScope} className="rounded p-0.5 text-muted hover:bg-surface-3 hover:text-ink" aria-label="Clear the tree selection">
                        <X className="size-3.5" aria-hidden />
                      </button>
                    </span>
                  ) : null}
                </div>
              }
              toolbarRight={
                <div className="flex items-center gap-1.5">
                  <Select
                    size="sm"
                    value={state.sort}
                    onChange={(v) => update({ sort: v || null, order: null })}
                    options={sortOptions}
                    aria-label="Sort by"
                    className="w-40"
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={state.order === 'desc' ? ArrowDownWideNarrow : ArrowUpNarrowWide}
                    onClick={() => update({ order: state.order === 'desc' ? 'asc' : 'desc' })}
                    aria-label={state.order === 'desc' ? 'Sorted descending; switch to ascending' : 'Sorted ascending; switch to descending'}
                    title={state.order === 'desc' ? 'Descending' : 'Ascending'}
                  />
                </div>
              }
              pagination={{
                mode: 'server',
                page: state.page,
                pageSize: state.page_size,
                total,
                onPageChange: (p) => update({ page: p }),
                onPageSizeChange: (n) => update({ page_size: n }),
                pageSizeOptions: [...PAGE_SIZES],
              }}
              footer={
                <span className="inline-flex flex-wrap items-center gap-2">
                  <ProvenanceBadge provenance={tradeProvenance()} size="xs" />
                  Trade values are HS6 subheading totals for 2024; lines that share a subheading show the same value. Click a row for the product page; use the pin to compare.
                </span>
              }
            />
          </Card>
          <CompareTray api={pins} onCompare={() => setCompareOpen(true)} />
        </div>
      </div>

      {!wide ? (
        <Drawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          side="left"
          width={400}
          title="HS nomenclature"
          subtitle="Select a section, chapter, heading or line to filter the table"
          footer={
            <Button variant="primary" fullWidth onClick={() => setDrawerOpen(false)}>
              {q.data ? `Show ${fmtNum(total)} ${total === 1 ? 'line' : 'lines'}` : 'Show results'}
            </Button>
          }
        >
          {tree}
        </Drawer>
      ) : null}

      <CompareModal open={compareOpen} onClose={() => setCompareOpen(false)} pinned={pins.pinned} />
    </>
  );
}
