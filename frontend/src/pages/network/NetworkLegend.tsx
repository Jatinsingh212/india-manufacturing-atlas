/**
 * Legend for the Value-chain Network: node colour (ministry, as in the rest of the Atlas), node size
 * metric, edge styles by relation (only the relations present in the view, plus the curated
 * "input to" style which is always explained), and the outline / ring / halo encodings (critical
 * input, centre, traced path). Swatches are drawn in SVG with the exact graph colours.
 */
import { useMemo } from 'react';
import type { NetworkEdge, NetworkNode } from '@/api/types';
import { useMinistryLookup } from '@/api/hooks';
import { INDIA_COLOR, ministryColor, type ThemeMode } from '@/lib/theme';
import { CRITICAL_COLOR, CRITICAL_VULNERABILITY, HIERARCHY_RELATION, relationColors, TRACE_COLOR } from './graphStyle';

const SIZE_LABEL: Record<string, string> = {
  world_trade: 'world market',
  exports: 'India exports',
  imports: 'India imports',
};

function EdgeSwatch({ color, width, dash, arrow = 'filled' }: { color: string; width: number; dash?: string; arrow?: 'filled' | 'open' | 'none' }) {
  return (
    <svg width="34" height="10" viewBox="0 0 34 10" aria-hidden className="shrink-0">
      <line x1="1" y1="5" x2={arrow === 'none' ? 32 : 26} y2="5" stroke={color} strokeWidth={width} strokeDasharray={dash} strokeLinecap={dash === '1 3' ? 'round' : undefined} />
      {arrow === 'open' ? <polyline points="25,1.5 31,5 25,8.5" fill="none" stroke={color} strokeWidth={1.4} /> : null}
      {arrow === 'filled' ? <polygon points="25,1.5 32,5 25,8.5" fill={color} /> : null}
    </svg>
  );
}

function RingSwatch({ color, kind }: { color: string; kind: 'outline' | 'ring' | 'halo' }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="shrink-0">
      {kind === 'halo' ? <circle cx="9" cy="9" r="8.5" fill={color} opacity={0.25} /> : null}
      <circle cx="9" cy="9" r={kind === 'outline' ? 5 : 6} fill="var(--atlas-series-1)" stroke={kind === 'ring' ? color : 'var(--atlas-surface)'} strokeWidth={kind === 'ring' ? 2.5 : 1.5} />
      {kind === 'outline' ? <circle cx="9" cy="9" r="7.6" fill="none" stroke={color} strokeWidth={2} /> : null}
    </svg>
  );
}

export function NetworkLegend({
  nodes,
  edges,
  mode,
  sizeBy,
}: {
  nodes: ReadonlyArray<NetworkNode>;
  edges: ReadonlyArray<NetworkEdge>;
  mode: ThemeMode;
  sizeBy: string;
}) {
  const lookup = useMinistryLookup();
  const ministries = useMemo(() => {
    const counts = new Map<string, { id: string; short: string; color: string; n: number }>();
    for (const n of nodes) {
      const id = n.ministry_id ?? 'unmapped';
      const prev = counts.get(id);
      if (prev) prev.n += 1;
      else
        counts.set(id, {
          id,
          short: n.ministry_short ?? lookup.get(id)?.short_name ?? (id === 'unmapped' ? 'Not mapped' : id),
          color: ministryColor(n.ministry_id, n.color ?? lookup.get(id)?.color),
          n: 1,
        });
    }
    return [...counts.values()].sort((a, b) => b.n - a.n);
  }, [nodes, lookup]);
  const shown = ministries.slice(0, 12);
  const rel = relationColors(mode);
  const relations = useMemo(() => new Set(edges.map((e) => e.relation)), [edges]);

  return (
    <div className="grid grid-cols-1 gap-4 text-[12px] text-ink-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
      <div>
        <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">Node colour = owning ministry</div>
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {shown.map((m) => (
            <li key={m.id} className="inline-flex items-center gap-1.5" title={lookup.get(m.id)?.name ?? m.short}>
              <span className="size-2.5 rounded-full" style={{ backgroundColor: m.color }} aria-hidden />
              {m.short}
              <span className="text-muted atlas-num">{m.n}</span>
            </li>
          ))}
          {ministries.length > shown.length ? <li className="text-muted">+{ministries.length - shown.length} more</li> : null}
        </ul>
        <div className="mt-1.5 text-muted">Node size = {SIZE_LABEL[sizeBy] ?? 'trade'} (log scale)</div>
      </div>
      <div>
        <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">Links</div>
        <ul className="space-y-1">
          <li className="flex items-center gap-2">
            <EdgeSwatch color={rel.input_to} width={1.5} />
            Input to (raw material or intermediate)
          </li>
          {relations.has('component_of') ? (
            <li className="flex items-center gap-2">
              <EdgeSwatch color={rel.component_of} width={2.4} />
              Component of (assembled into)
            </li>
          ) : null}
          {relations.has('parts_of') ? (
            <li className="flex items-center gap-2">
              <EdgeSwatch color={rel.parts_of} width={1.3} dash="5 3" arrow="open" />
              Parts of (derived from HS text)
            </li>
          ) : null}
          {relations.has(HIERARCHY_RELATION) ? (
            <li className="flex items-center gap-2">
              <EdgeSwatch color={rel.hs_hierarchy} width={1.4} dash="1 3" arrow="none" />
              Same HS family (heading and its lines)
            </li>
          ) : null}
        </ul>
      </div>
      <div>
        <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">Highlights</div>
        <ul className="space-y-1">
          <li className="flex items-center gap-2">
            <RingSwatch color={CRITICAL_COLOR[mode]} kind="outline" />
            Critical input (vulnerability ≥ {CRITICAL_VULNERABILITY})
          </li>
          <li className="flex items-center gap-2">
            <RingSwatch color={INDIA_COLOR[mode]} kind="ring" />
            Centre of the view
          </li>
          <li className="flex items-center gap-2">
            <RingSwatch color={TRACE_COLOR[mode]} kind="halo" />
            On the traced path
          </li>
        </ul>
      </div>
    </div>
  );
}
