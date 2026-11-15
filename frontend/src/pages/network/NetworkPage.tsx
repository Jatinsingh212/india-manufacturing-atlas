/**
 * NetworkPage - Value-chain Network (route /network, public; SPEC section 8, API section 6.5).
 *
 * The HSN interlinkage network, interactive: one HSN -> many
 * inputs (left) and many outputs (right), each node with Production / EXPORT / Demand-Sales stats.
 *
 * - cytoscape + dagre, left to right (foundation <NetworkGraph>); nodes coloured by owning ministry
 *   and sized by trade (world market / India exports / India imports, log scale); critical nodes
 *   (vulnerability >= 60) get a red outline; edges are styled by relation (graphStyle.ts).
 * - Filters (URL-synced): value chains (multi-select, `?chain=a,b`), centre on a code (`?center=`,
 *   typeahead, or one-click examples such as bumpers) with depth 1-4 (`?depth=`), HS-text
 *   "parts of" links (`?parts=1`), size metric (`?size=`).
 * - After the dagre layout the stages are spread to the canvas width (graphStyle.stretchToCanvas), so
 *   even the all-chains overview fills the canvas instead of a narrow strip.
 * - Clicking a node opens the side panel (NodePanel.tsx) with the production / trade stat boxes and
 *   "Trace upstream / downstream" (GET /api/network/trace), which highlights the paths and lists the
 *   critical inputs. Legend, zoom / fit controls, scroll-zoom toggle, PNG export, and a table view of
 *   every node for accessibility.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Core } from 'cytoscape';
import clsx from 'clsx';
import { Crosshair, Download, Info, Network as NetworkIcon, RotateCcw, SlidersHorizontal, Table2, X } from 'lucide-react';
import { normalizeCode, saveBlob } from '@/api/client';
import { useValueChains } from '@/api/hooks';
import type { NetworkEdge, NetworkNode, TraceDirection, TraceResponse } from '@/api/types';
import {
  Button,
  Card,
  CodeLink,
  DataTable,
  Drawer,
  EmptyState,
  ErrorState,
  HsnSearchBox,
  LoadingBlock,
  MinistryPill,
  NetworkGraph,
  PageHeader,
  ProvenanceLegend,
  ScoreBar,
  SegmentedControl,
  Spinner,
  Toggle,
  useToast,
  type Column,
} from '@/components';
import { fmtCode, fmtNum, NA_SHORT } from '@/lib/format';
import { useMediaQuery, useSearchParamState } from '@/lib/hooks';
import { CHART_TOKENS } from '@/lib/theme';
import { useTheme } from '@/theme/ThemeContext';
import { ratio, SourceNote, usd, useTradeProvenance } from '../analytics/shared/ui';
import { useNetworkView, useTrace, type TraceRequest } from './api';
import { applyGraphClasses, CRITICAL_VULNERABILITY, extraGraphStyle, labelsHiddenAt, networkGeometry, networkLayout, stretchToCanvas } from './graphStyle';
import { NetworkLegend } from './NetworkLegend';
import { NodePanel } from './NodePanel';

type SizeBy = 'world_trade' | 'exports' | 'imports';
const SIZE_OPTIONS: ReadonlyArray<{ value: SizeBy; label: string }> = [
  { value: 'world_trade', label: 'World market' },
  { value: 'exports', label: 'India exports' },
  { value: 'imports', label: 'India imports' },
];
const TRACE_DEPTH = 3;
/** One-click centres: a familiar auto component and anchor products of the curated chains. */
const CENTER_EXAMPLES: ReadonlyArray<{ code: string; label: string }> = [
  { code: '870810', label: 'Bumpers' },
  { code: '40111010', label: 'Car tyres' },
  { code: '85171300', label: 'Smartphones' },
  { code: '85414300', label: 'Solar modules' },
];
/** Padding (px) kept around the drawing when it is fitted to the canvas. */
const FIT_PADDING = 28;
/** Canvas height range (px): the canvas grows with the most crowded stage so labels stay legible. */
const GRAPH_HEIGHT = { wide: [560, 900], narrow: [460, 720] } as const;
/** Smallest zoom, so even the all-chains overview fits the canvas (the foundation allows 0.15). */
const MIN_ZOOM = 0.06;
/** dagre options shared by every view (stages are spread to the canvas after the layout). */
const LAYOUT = networkLayout();

/** Union of the base graph and a trace graph; returns the base arrays unchanged when nothing is new. */
function withTrace(nodes: NetworkNode[], edges: NetworkEdge[], trace: TraceResponse | undefined) {
  if (!trace) return { nodes, edges };
  const ids = new Set(nodes.map((n) => n.id));
  const extraNodes = trace.nodes.filter((n) => !ids.has(n.id));
  const edgeKeys = new Set(edges.map((e) => `${e.source}->${e.target}`));
  const allIds = new Set([...ids, ...extraNodes.map((n) => n.id)]);
  const extraEdges = trace.edges.filter((e) => !edgeKeys.has(`${e.source}->${e.target}`) && allIds.has(e.source) && allIds.has(e.target));
  if (!extraNodes.length && !extraEdges.length) return { nodes, edges };
  return { nodes: [...nodes, ...extraNodes], edges: [...edges, ...extraEdges] };
}

export default function NetworkPage() {
  const { mode } = useTheme();
  const toast = useToast();
  const trade = useTradeProvenance();
  const wide = useMediaQuery('(min-width: 1280px)');
  const chainsQ = useValueChains();

  // ---------------------------------------------------------------- URL-synced filters
  const [chainParam, setChainParam] = useSearchParamState('chain', '');
  const [centerParam, setCenterParam] = useSearchParamState('center', '');
  const [depthParam, setDepthParam] = useSearchParamState('depth', '2');
  const [partsParam, setPartsParam] = useSearchParamState('parts', '');
  const [sizeParam, setSizeParam] = useSearchParamState('size', 'world_trade');
  const chains = useMemo(() => chainParam.split(',').map((c) => c.trim()).filter(Boolean), [chainParam]);
  const center = normalizeCode(centerParam);
  const depth = Math.min(4, Math.max(1, Number.parseInt(depthParam, 10) || 2));
  const includeParts = partsParam === '1';
  const sizeBy: SizeBy = (SIZE_OPTIONS.some((o) => o.value === sizeParam) ? sizeParam : 'world_trade') as SizeBy;

  const filters = useMemo(() => ({ chains, center, depth, includeParts }), [chains, center, depth, includeParts]);
  const view = useNetworkView(filters);

  // ---------------------------------------------------------------- selection & trace
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [traceReq, setTraceReq] = useState<TraceRequest | null>(null);
  const traceQ = useTrace(traceReq);
  const [wheelZoom, setWheelZoom] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const base = view.data;
  const { nodes, edges } = useMemo(() => withTrace(base?.nodes ?? [], base?.edges ?? [], traceReq ? traceQ.data : undefined), [base, traceReq, traceQ.data]);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const idByCode = useMemo(() => new Map(nodes.map((n) => [n.code, n.id])), [nodes]);
  const selected = selectedId ? (nodeById.get(selectedId) ?? null) : null;

  // Clear a selection / trace that no longer exists after the filters change.
  useEffect(() => {
    if (selectedId && base && !nodeById.has(selectedId)) {
      setSelectedId(null);
      setTraceReq(null);
    }
  }, [base, nodeById, selectedId]);

  const critical = useMemo(() => new Set(nodes.filter((n) => (n.vulnerability_score ?? -1) >= CRITICAL_VULNERABILITY).map((n) => n.id)), [nodes]);
  const traceSets = useMemo(() => {
    const t = traceReq ? traceQ.data : undefined;
    if (!t) return { nodes: null as Set<string> | null, edges: null as Set<string> | null };
    const mapId = (id: string, code?: string) => (nodeById.has(id) ? id : (code && idByCode.get(code)) || id);
    const codeOf = new Map(t.nodes.map((n) => [n.id, n.code]));
    const tn = new Set(t.nodes.map((n) => mapId(n.id, n.code)));
    if (selectedId) tn.add(selectedId);
    const te = new Set(t.edges.map((e) => `${mapId(e.source, codeOf.get(e.source))}->${mapId(e.target, codeOf.get(e.target))}`));
    return { nodes: tn, edges: te };
  }, [traceReq, traceQ.data, nodeById, idByCode, selectedId]);

  // ---------------------------------------------------------------- cytoscape instance & classes
  const [cy, setCy] = useState<Core | null>(null);
  const [labelsHidden, setLabelsHidden] = useState(false);
  const classesRef = useRef({ critical, traceSets, selectedId });
  classesRef.current = { critical, traceSets, selectedId };
  const onReady = useCallback(
    (instance: Core) => {
      instance.style().append(extraGraphStyle(mode)).update();
      const c = classesRef.current;
      applyGraphClasses(instance, { critical: c.critical, traceNodes: c.traceSets.nodes, traceEdges: c.traceSets.edges, traceRoot: c.selectedId });
      const syncLabels = () => setLabelsHidden(!instance.destroyed() && labelsHiddenAt(instance.zoom()));
      // A many-chain overview is taller than the foundation's minimum zoom can fit; allow a smaller one.
      instance.minZoom(Math.min(instance.minZoom(), MIN_ZOOM));
      // Spread the stages to the canvas width once the layout has placed the nodes, then refit on the
      // full bounding box (dagre fits node boxes only) so the side labels are not clipped.
      let stretched = false;
      const settle = () => {
        if (instance.destroyed() || !instance.nodes().length) return;
        if (!stretched) stretched = stretchToCanvas(instance);
        instance.fit(instance.elements(), FIT_PADDING);
        syncLabels();
      };
      instance.on('zoom', syncLabels);
      instance.one('layoutstop', settle);
      settle();
      setCy(instance);
    },
    [mode],
  );
  useEffect(() => {
    if (!cy || cy.destroyed()) return;
    applyGraphClasses(cy, { critical, traceNodes: traceSets.nodes, traceEdges: traceSets.edges, traceRoot: traceReq ? selectedId : null });
  }, [cy, critical, traceSets, traceReq, selectedId]);

  // ---------------------------------------------------------------- actions
  const chainName = useCallback((id: string) => chainsQ.data?.find((c) => c.id === id)?.name ?? id, [chainsQ.data]);
  const toggleChain = (id: string) => {
    const next = chains.includes(id) ? chains.filter((c) => c !== id) : [...chains, id];
    setChainParam(next.length ? next.join(',') : null);
  };
  const centerOn = (raw: string) => {
    const c = normalizeCode(raw);
    if (!/^\d{4}(\d{2}){0,2}$/.test(c)) {
      toast.info('Enter a 4, 6 or 8-digit HS code', 'The graph centres on a heading, subheading or tariff line.');
      return;
    }
    setCenterParam(c);
    setSelectedId(null);
    setTraceReq(null);
  };
  const resetAll = () => {
    setChainParam(null);
    setCenterParam(null);
    setDepthParam(null);
    setPartsParam(null);
    setSelectedId(null);
    setTraceReq(null);
  };
  const exportPng = () => {
    if (!cy || cy.destroyed()) return;
    try {
      // Twice the on-screen resolution, capped so the many-chain overview stays within canvas limits.
      const bb = cy.elements().boundingBox();
      const scale = Math.min(2, 5000 / Math.max(1, bb.w, bb.h));
      const blob = cy.png({ output: 'blob', full: true, scale, bg: CHART_TOKENS[mode].surface });
      const name = center ? `atlas-network-${center}.png` : chains.length ? `atlas-network-${chains.join('-')}.png` : 'atlas-network.png';
      saveBlob(blob, name);
    } catch (err) {
      toast.error('Could not export the image', err instanceof Error ? err.message : undefined);
    }
  };
  const trace = (direction: TraceDirection) => {
    if (!selected) return;
    if (traceReq && traceReq.code === selected.code && traceReq.direction === direction) {
      setTraceReq(null);
      return;
    }
    setTraceReq({ code: selected.code, direction, depth: TRACE_DEPTH });
  };
  const selectNode = (n: NetworkNode | null) => {
    setSelectedId(n?.id ?? null);
    if (!n || (traceReq && traceReq.code !== n.code)) setTraceReq(null);
  };

  // Centre param from a deep link (e.g. /network?center=40111010): select the centre node once loaded.
  useEffect(() => {
    if (!center || selectedId) return;
    const c = nodes.find((n) => n.is_center) ?? nodes.find((n) => n.code === center);
    if (c) setSelectedId(c.id);
    // Only when the centre or the data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center, base]);

  const nCritical = critical.size;
  const nFilters = chains.length + (center ? 1 : 0) + (includeParts ? 1 : 0);
  const filterSummary = [
    chains.length ? `${chains.length} chain${chains.length === 1 ? '' : 's'}` : 'All chains',
    center ? `centre ${fmtCode(center)}` : null,
    includeParts ? 'parts links' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  // Canvas height follows the most crowded stage; the layout options are a module constant, so
  // selecting, tracing or resizing never re-runs dagre (only new data does).
  const geometry = useMemo(() => networkGeometry(nodes, edges), [nodes, edges]);
  const [minH, maxH] = wide ? GRAPH_HEIGHT.wide : GRAPH_HEIGHT.narrow;
  const graphHeight = Math.round(Math.min(maxH, Math.max(minH, geometry.height * 0.9 + 64)));

  // ---------------------------------------------------------------- table view
  const columns: Column<NetworkNode>[] = [
    { key: 'code', header: 'HS code', value: (n) => n.code, render: (n) => <CodeLink code={n.code} />, width: 110 },
    { key: 'label', header: 'Product', value: (n) => n.label, render: (n) => <span className="line-clamp-2 min-w-48 text-[12.5px]">{n.label}</span> },
    {
      key: 'ministry',
      header: 'Ministry',
      value: (n) => n.ministry_short,
      render: (n) => (n.ministry_id ? <MinistryPill size="xs" ministry={{ id: n.ministry_id, short_name: n.ministry_short, color: n.color }} /> : NA_SHORT),
      hideBelow: 'md',
    },
    { key: 'chains', header: 'Value chains', value: (n) => (n.chain_ids ?? []).map(chainName).join(', '), hideBelow: 'xl' },
    { key: 'exports', header: 'India exports', align: 'right', value: (n) => n.exports, render: (n) => usd(n.exports) },
    { key: 'imports', header: 'India imports', align: 'right', value: (n) => n.imports, render: (n) => usd(n.imports) },
    { key: 'world', header: 'World market', align: 'right', value: (n) => n.world_trade, render: (n) => usd(n.world_trade), hideBelow: 'lg' },
    { key: 'rca', header: 'RCA', align: 'right', value: (n) => n.rca, render: (n) => ratio(n.rca), hideBelow: 'lg' },
    {
      key: 'vul',
      header: 'Vulnerability',
      value: (n) => n.vulnerability_score,
      render: (n) => <ScoreBar value={n.vulnerability_score} scale="risk" width={60} />,
      firstSort: 'desc',
      width: 120,
    },
  ];

  // Shared between the desktop side panel and the phone bottom sheet.
  const nodePanel = selected ? (
    <NodePanel
      node={selected}
      chainName={chainName}
      tradeProvenance={trade}
      trace={traceReq ? { direction: traceReq.direction, data: traceQ.data, loading: traceQ.isFetching && !traceQ.data, error: traceQ.error } : null}
      onTrace={trace}
      onClearTrace={() => setTraceReq(null)}
      onCenter={() => centerOn(selected.code)}
      onClose={() => selectNode(null)}
      onSelectCode={(code) => {
        const id = idByCode.get(code) ?? (nodeById.has(code) ? code : null);
        if (id) setSelectedId(id);
        else centerOn(code);
      }}
    />
  ) : null;

  return (
    <>
      <PageHeader
        eyebrow="Atlas"
        title="Value-chain Network"
        icon={NetworkIcon}
        subtitle="How HSN codes interlink: one product draws on many inputs and feeds many outputs. Select a node for its production, export and demand statistics, then trace upstream or downstream to find critical inputs."
        meta={<ProvenanceLegend compact />}
        actions={
          <>
            <Button size="sm" icon={RotateCcw} onClick={resetAll} disabled={!chains.length && !center && !includeParts}>
              Reset view
            </Button>
            <Button size="sm" variant="primary" icon={Download} onClick={exportPng} disabled={!cy || !nodes.length}>
              Export PNG
            </Button>
          </>
        }
      />

      {/* ------------------------------------------------------------ filter row */}
      <div className="mb-5 rounded-xl border border-line bg-surface p-3 shadow-card sm:p-4">
        <div className="mb-3 flex items-center justify-between gap-2 lg:hidden">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
              Filters
              {nFilters > 0 ? (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-semibold text-on-brand">{nFilters}</span>
              ) : null}
            </div>
            <div className="mt-0.5 truncate text-[11.5px] text-muted">{filterSummary}</div>
          </div>
          <Button
            size="sm"
            variant="secondary"
            icon={SlidersHorizontal}
            onClick={() => setFiltersOpen((o) => !o)}
            aria-expanded={filtersOpen}
            className="h-9! shrink-0"
          >
            {filtersOpen ? 'Hide' : 'Show'}
          </Button>
        </div>

        <div className={clsx('flex flex-wrap items-start gap-x-6 gap-y-3', !filtersOpen && 'max-lg:hidden')}>
          <div className="min-w-0 flex-1 basis-[28rem]">
            <div className="mb-1.5 text-xs font-medium text-ink-2">Value chains</div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Value chains">
              <button
                type="button"
                aria-pressed={!chains.length}
                onClick={() => setChainParam(null)}
                className={clsx(
                  'h-8 rounded-full border px-3 text-xs font-medium transition-colors sm:h-7',
                  !chains.length ? 'border-brand bg-brand-soft text-brand-ink' : 'border-line bg-surface text-ink-2 hover:border-line-strong hover:text-ink',
                )}
              >
                All chains
              </button>
              {chainsQ.isError ? (
                <span className="inline-flex h-7 items-center text-xs text-muted">The value-chain list could not be loaded; the graph shows every curated chain.</span>
              ) : null}
              {chainsQ.isPending ? <Spinner /> : null}
              {(chainsQ.data ?? []).map((c) => {
                const on = chains.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleChain(c.id)}
                    title={c.title ?? c.name}
                    className={clsx(
                      'h-8 rounded-full border px-3 text-xs font-medium transition-colors sm:h-7',
                      on ? 'border-brand bg-brand-soft text-brand-ink' : 'border-line bg-surface text-ink-2 hover:border-line-strong hover:text-ink',
                    )}
                  >
                    {c.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="w-full min-w-0 sm:w-80">
            <div className="mb-1.5 text-xs font-medium text-ink-2">Centre on a code</div>
            {center ? (
              <div className="flex h-10 items-center gap-2 rounded-lg border border-brand/50 bg-brand-soft px-3 sm:h-9">
                <Crosshair className="size-4 text-brand-ink" aria-hidden />
                <span className="font-mono text-[13px] text-brand-ink atlas-num">{fmtCode(center)}</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">{nodes.find((n) => n.code === center)?.label ?? ''}</span>
                <button type="button" onClick={() => setCenterParam(null)} className="inline-flex size-7 items-center justify-center rounded text-muted hover:text-ink" aria-label="Clear centre">
                  <X className="size-4" aria-hidden />
                </button>
              </div>
            ) : (
              <HsnSearchBox placeholder="Product name or HS code…" onSelect={(s) => centerOn(s.hsn8)} onSubmit={centerOn} clearOnSelect ariaLabel="Centre the network on a code" />
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-muted">
              <span>Examples:</span>
              {CENTER_EXAMPLES.map((e) => (
                <button
                  key={e.code}
                  type="button"
                  onClick={() => centerOn(e.code)}
                  aria-pressed={center === e.code}
                  title={`Centre on HS ${fmtCode(e.code)}`}
                  className={clsx('font-medium hover:underline', center === e.code ? 'text-ink' : 'text-brand-ink')}
                >
                  {e.label}
                </button>
              ))}
            </div>
          </div>

          <div className="w-44 max-sm:w-full">
            <label htmlFor="net-depth" className="mb-1.5 flex items-center justify-between text-xs font-medium text-ink-2">
              <span>Depth from centre</span>
              <span className="font-semibold text-ink atlas-num">{depth}</span>
            </label>
            <input
              id="net-depth"
              type="range"
              min={1}
              max={4}
              step={1}
              value={depth}
              disabled={!center}
              onChange={(e) => setDepthParam(e.target.value)}
              className="h-2 w-full cursor-pointer accent-[var(--atlas-brand)] disabled:cursor-not-allowed disabled:opacity-40"
              aria-valuetext={`${depth} steps`}
            />
            <div className="mt-1 text-[11px] text-muted">{center ? 'Steps up and downstream' : 'Centre on a code to use'}</div>
          </div>

          <div className="flex flex-col gap-2 pt-5 max-sm:w-full max-sm:pt-0">
            <Toggle checked={includeParts} onChange={(v) => setPartsParam(v ? '1' : null)} label="Include HS-text “parts of” links" size="sm" />
            <Toggle checked={wheelZoom} onChange={setWheelZoom} label="Scroll to zoom" size="sm" />
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------ graph + panel */}
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card padding="none" className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5">
            <div className="flex items-center gap-2 text-[13px] text-ink-2">
              {view.isFetching ? <Spinner /> : null}
              <span>
                <b className="text-ink atlas-num">{fmtNum(nodes.length)}</b> products · <b className="text-ink atlas-num">{fmtNum(edges.length)}</b> links
                {nCritical ? (
                  <>
                    {' '}
                    · <b className="text-bad-ink atlas-num">{fmtNum(nCritical)}</b> critical
                  </>
                ) : null}
              </span>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-muted">Size by</span>
              <SegmentedControl value={sizeBy} onChange={(v) => setSizeParam(v)} options={SIZE_OPTIONS} size="xs" ariaLabel="Node size metric" />
            </div>
          </div>
          <div className={clsx('relative', view.isFetching && base && 'opacity-70 transition-opacity')}>
            {view.isPending ? (
              <LoadingBlock label="Building the network…" height={graphHeight} />
            ) : view.error && !base ? (
              <div style={{ minHeight: graphHeight }} className="flex items-center justify-center">
                <ErrorState error={view.error} onRetry={view.refetch} roles={['industry', 'analyst', 'ministry', 'admin']} />
              </div>
            ) : !nodes.length ? (
              <div style={{ minHeight: graphHeight }} className="flex items-center justify-center">
                <EmptyState
                  icon={NetworkIcon}
                  title="No interlinkages for this selection"
                  message={center ? 'This code has no curated or HS-text links yet. Try another code, a larger depth or include “parts of” links.' : 'Choose another value chain.'}
                  action={<Button onClick={resetAll}>Show all value chains</Button>}
                />
              </div>
            ) : (
              <NetworkGraph
                nodes={nodes}
                edges={edges}
                height={graphHeight}
                layout={LAYOUT}
                sizeBy={sizeBy}
                selectedId={selectedId}
                dimOthers={!traceReq}
                wheelZoom={wheelZoom}
                onNodeClick={(n) => selectNode(n.id === selectedId ? null : n)}
                onBackgroundClick={() => selectNode(null)}
                onReady={onReady}
              />
            )}
          </div>
          {nodes.length ? (
            <div className="flex items-center gap-2 border-t border-line px-4 py-2 text-[12px] text-ink-2" aria-live="polite">
              <Info className="size-4 shrink-0 text-brand-ink" aria-hidden />
              {labelsHidden
                ? 'Labels appear as you zoom in (use + or turn on scroll to zoom). Pick a value chain or centre on a code for a closer view.'
                : selected
                  ? 'Trace upstream or downstream from the panel to highlight the paths and list the critical inputs.'
                  : 'Click a product to see its statistics and trace its supply chain. Inputs flow left to right.'}
            </div>
          ) : null}
          <div className="border-t border-line px-4 py-3">
            <NetworkLegend nodes={nodes} edges={edges} mode={mode} sizeBy={sizeBy} />
          </div>
        </Card>

        <div className="hidden xl:sticky xl:top-4 xl:block">
          <Card padding="md" className="xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto">
            {nodePanel ?? (
              <div className="space-y-3">
                <h3 className="text-[15px] font-semibold text-ink">Product statistics</h3>
                <p className="text-[13px] leading-relaxed text-ink-2">
                  Select a node to open its <b>Production</b>, <b>EXPORT</b> and <b>Demand / Sales</b> statistics, with the
                  data status of every figure.
                </p>
                <ul className="list-disc space-y-1 pl-5 text-[12.5px] text-ink-2">
                  <li>Arrows run from inputs to the products that use them.</li>
                  <li>
                    A red outline marks a critical input: vulnerability score {CRITICAL_VULNERABILITY} or more (import-dependent, concentrated
                    sources).
                  </li>
                  <li>Trace upstream to list the critical inputs a product depends on; trace downstream to see who is exposed to it.</li>
                </ul>
                <SourceNote provenances={[trade]} className="pt-1 text-xs" />
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* Phones and tablets: the selected node opens as a bottom sheet over the graph. */}
      {!wide ? (
        <Drawer
          open={Boolean(selected)}
          onClose={() => selectNode(null)}
          side="bottom"
          title="Product statistics"
          subtitle={selected ? `${fmtCode(selected.code)} · production, exports and demand` : undefined}
        >
          {nodePanel}
        </Drawer>
      ) : null}

      {/* ------------------------------------------------------------ table view */}
      <Card
        className="mt-5"
        title="Products in this view"
        subtitle="Table view of every node in the graph (select a row to open it in the panel)"
        icon={Table2}
        actions={
          <Button size="sm" variant="ghost" onClick={() => setShowTable((s) => !s)} aria-expanded={showTable}>
            {showTable ? 'Hide table' : `Show table (${fmtNum(nodes.length)})`}
          </Button>
        }
        footer={<SourceNote provenances={[trade]} />}
      >
        {showTable ? (
          <DataTable
            columns={columns}
            rows={nodes}
            rowKey={(n) => n.id}
            onRowClick={(n) => selectNode(n)}
            isRowSelected={(n) => n.id === selectedId}
            defaultSort={{ key: 'vul', order: 'desc' }}
            csvFilename="atlas-network-nodes"
            dense
          />
        ) : (
          <p className="text-[13px] text-muted">
            {fmtNum(nodes.length)} products and {fmtNum(edges.length)} links. Trade figures are India's {trade.year ?? 'latest-year'} values; codes shorter than 8
            digits aggregate their HS6 subheadings.
          </p>
        )}
      </Card>
    </>
  );
}
