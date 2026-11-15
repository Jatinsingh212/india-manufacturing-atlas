/**
 * ValueChainContext - where the product sits in the curated value chains (one HSN -> many inputs,
 * one HSN -> many outputs): the chains and stages it belongs to, a small inline flow
 * diagram (inputs -> this product -> uses) and the full upstream / downstream lists with links.
 *
 * Edges come from vc_edges matching the line, its HS6 or its HS4. Solid connectors are curated value-
 * chain links; dashed connectors are "parts of" links derived from HS nomenclature text.
 */
import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowRight, Share2, Workflow } from 'lucide-react';
import type { ProductLink, ProductValueChainRef } from '@/api/types';
import { Badge, Button, Card, CodeLink, EmptyState } from '@/components';
import { fmtCode, humanize, truncate } from '@/lib/format';
import { shortLabel } from '@/pages/explore/shared';
import { routeForCode, routes } from '@/lib/routes';
import { isDerivedLink, type LinkExtras, type ValueChainRefExtras } from '../extras';

const RELATION_LABEL: Record<string, string> = {
  input_to: 'Input',
  component_of: 'Component',
  parts_of: 'Part (HS text)',
};

function relationLabel(r: string): string {
  return RELATION_LABEL[r] ?? humanize(r);
}

/** Badge text for a link: its relation. */
function linkLabel(l: LinkExtras): string {
  return relationLabel(l.relation);
}

/** One entry per code (several chains can list the same edge). */
function dedupe(links: ProductLink[]): ProductLink[] {
  const seen = new Map<string, ProductLink>();
  for (const l of links) if (!seen.has(l.code)) seen.set(l.code, l);
  return [...seen.values()];
}

const MAX_SIDE = 5;
const W = 760;
const COL_W = 228;
const CENTER_X = 266;
const CENTER_W = 228;
const RIGHT_X = W - COL_W;
const NODE_H = 42;
const GAP = 10;
const HEAD = 26;

interface FlowNode {
  code: string | null;
  title: string;
  sub: string;
  relation?: string;
  /** Derived from HS nomenclature text (dashed connector). */
  derived?: boolean;
  more?: boolean;
}

function sideNodes(links: LinkExtras[], emptyText: string): FlowNode[] {
  if (!links.length) return [{ code: null, title: emptyText, sub: '', more: true }];
  const shown: FlowNode[] = links.slice(0, MAX_SIDE).map((l) => ({
    code: l.code,
    title: fmtCode(l.code),
    sub: shortLabel(l.description ?? ''),
    relation: l.relation,
    derived: isDerivedLink(l),
  }));
  if (links.length > MAX_SIDE) shown.push({ code: null, title: `+${links.length - MAX_SIDE} more`, sub: 'listed below', more: true });
  return shown;
}

function FlowDiagram({ code, label, upstream, downstream }: { code: string; label: string; upstream: ProductLink[]; downstream: ProductLink[] }) {
  const navigate = useNavigate();
  const left = sideNodes(upstream, 'No inputs mapped');
  const right = sideNodes(downstream, 'No uses mapped');
  const rows = Math.max(left.length, right.length, 2);
  const bodyH = rows * (NODE_H + GAP) - GAP;
  const H = HEAD + bodyH + 4;
  const cy = HEAD + bodyH / 2;
  const top = (n: number) => HEAD + (bodyH - (n * (NODE_H + GAP) - GAP)) / 2;

  const go = (c: string | null) => {
    const to = routeForCode(c);
    if (to) navigate(to);
  };

  const node = (n: FlowNode, x: number, y: number, key: string) => {
    const clickable = Boolean(n.code);
    return (
      <g
        key={key}
        role={clickable ? 'link' : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-label={clickable ? `${n.title} ${n.sub}` : undefined}
        onClick={clickable ? () => go(n.code) : undefined}
        onKeyDown={clickable ? (e) => (e.key === 'Enter' ? go(n.code) : undefined) : undefined}
        style={{ cursor: clickable ? 'pointer' : 'default' }}
        className="outline-none [&:focus-visible>rect]:stroke-[var(--atlas-brand)]"
      >
        <title>{n.code ? `${n.title} ${n.sub}${n.relation ? ` (${relationLabel(n.relation)})` : ''}` : n.title}</title>
        <rect
          x={x}
          y={y}
          width={COL_W}
          height={NODE_H}
          rx={8}
          style={{
            fill: n.more ? 'transparent' : 'var(--atlas-surface-2)',
            stroke: 'var(--atlas-line-strong)',
            strokeDasharray: n.more ? '4 3' : undefined,
          }}
        />
        <text x={x + 10} y={y + (n.sub ? 17 : 26)} style={{ fill: n.more ? 'var(--atlas-muted)' : 'var(--atlas-brand-ink)', fontSize: 12, fontWeight: 600, fontFamily: n.code ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined }}>
          {n.title}
        </text>
        {n.sub ? (
          <text x={x + 10} y={y + 33} style={{ fill: 'var(--atlas-muted)', fontSize: 11 }}>
            {n.sub}
          </text>
        ) : null}
      </g>
    );
  };

  const edge = (x1: number, y1: number, x2: number, y2: number, dashed: boolean, key: string) => (
    <path
      key={key}
      d={`M ${x1} ${y1} C ${x1 + 26} ${y1}, ${x2 - 26} ${y2}, ${x2} ${y2}`}
      markerEnd="url(#vc-arrow)"
      style={{ fill: 'none', stroke: 'var(--atlas-chart-axis)', strokeWidth: 1.5, strokeDasharray: dashed ? '5 4' : undefined }}
    />
  );

  const lTop = top(left.length);
  const rTop = top(right.length);

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full min-w-[620px]" role="group" aria-label={`Value chain around ${fmtCode(code)}`}>
        <defs>
          <marker id="vc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" style={{ fill: 'var(--atlas-chart-axis)' }} />
          </marker>
        </defs>
        <text x={0} y={14} style={{ fill: 'var(--atlas-muted)', fontSize: 11, fontWeight: 600, letterSpacing: 0.6 }}>
          INPUTS (UPSTREAM)
        </text>
        <text x={CENTER_X + CENTER_W / 2} y={14} textAnchor="middle" style={{ fill: 'var(--atlas-muted)', fontSize: 11, fontWeight: 600, letterSpacing: 0.6 }}>
          THIS PRODUCT
        </text>
        <text x={W} y={14} textAnchor="end" style={{ fill: 'var(--atlas-muted)', fontSize: 11, fontWeight: 600, letterSpacing: 0.6 }}>
          USED IN (DOWNSTREAM)
        </text>

        {left.map((n, i) => (n.code ? edge(COL_W, lTop + i * (NODE_H + GAP) + NODE_H / 2, CENTER_X, cy, Boolean(n.derived), `le-${i}`) : null))}
        {right.map((n, i) => (n.code ? edge(CENTER_X + CENTER_W, cy, RIGHT_X, rTop + i * (NODE_H + GAP) + NODE_H / 2, Boolean(n.derived), `re-${i}`) : null))}

        {left.map((n, i) => node(n, 0, lTop + i * (NODE_H + GAP), `l-${i}`))}
        {right.map((n, i) => node(n, RIGHT_X, rTop + i * (NODE_H + GAP), `r-${i}`))}

        <g>
          <rect x={CENTER_X} y={cy - 32} width={CENTER_W} height={64} rx={10} style={{ fill: 'var(--atlas-brand)' }} />
          <text x={CENTER_X + 12} y={cy - 9} style={{ fill: 'var(--atlas-on-brand)', fontSize: 13, fontWeight: 700, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
            {fmtCode(code)}
          </text>
          <text x={CENTER_X + 12} y={cy + 10} style={{ fill: 'var(--atlas-on-brand)', fontSize: 11.5, opacity: 0.9 }}>
            {truncate(label, 34)}
          </text>
        </g>
      </svg>
    </div>
  );
}

function LinkList({ title, links, empty }: { title: string; links: LinkExtras[]; empty: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">
        {title} · {links.length}
      </div>
      {links.length ? (
        <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {links.map((l) => (
            <li key={`${l.code}-${l.relation}-${l.chain_id ?? ''}`} className="flex items-start gap-2 px-3 py-1.5 text-[12.5px]">
              <CodeLink code={l.code} className="shrink-0" />
              <span className="min-w-0 flex-1 leading-snug text-ink-2">{l.description ?? 'Description not available'}</span>
              <Badge tone={isDerivedLink(l) ? 'outline' : 'neutral'} size="xs">
                {linkLabel(l)}
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed border-line px-3 py-2 text-[12.5px] text-muted">{empty}</p>
      )}
    </div>
  );
}

export interface ValueChainContextProps {
  hsn8: string;
  description: string;
  chains: ProductValueChainRef[];
  upstream: ProductLink[];
  downstream: ProductLink[];
}

export function ValueChainContext({ hsn8, description, chains, upstream, downstream }: ValueChainContextProps) {
  const up = useMemo(() => dedupe(upstream), [upstream]);
  const down = useMemo(() => dedupe(downstream), [downstream]);
  const hasLinks = up.length > 0 || down.length > 0;

  return (
    <Card
      title="Value-chain context"
      subtitle="Inputs this product needs and the products that use it"
      icon={Workflow}
      actions={
        <Button to={routes.network({ center: hsn8, depth: 2 })} size="sm" icon={Share2}>
          Open in network
        </Button>
      }
      footer={
        hasLinks ? (
          <span>Solid connectors: curated value-chain links. Dashed: "parts of" links derived from HS nomenclature text. Click a box to open it.</span>
        ) : undefined
      }
    >
      {chains.length ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-ink-2">Part of</span>
          {(chains as ValueChainRefExtras[]).map((c) => {
            const items = (c.items ?? []).filter(Boolean);
            return (
              <Link
                key={`${c.chain_id}-${c.stage_id}`}
                to={routes.valueChain(c.chain_id)}
                title={items.length ? `Listed as: ${items.join(', ')}` : undefined}
                className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 text-[12px] hover:border-brand/50 hover:bg-brand-soft"
              >
                <span className="font-semibold text-ink">{c.name}</span>
                <ArrowRight className="size-3 shrink-0 text-muted" aria-hidden />
                <span className="truncate text-ink-2">
                  {c.stage_name}
                  {items.length ? <span className="text-muted"> · {truncate(items.join(', '), 40)}</span> : null}
                </span>
              </Link>
            );
          })}
        </div>
      ) : null}

      {hasLinks ? (
        <div className="space-y-4">
          <FlowDiagram code={hsn8} label={description} upstream={up} downstream={down} />
          <div className="grid gap-4 md:grid-cols-2">
            <LinkList title="Inputs (upstream)" links={up} empty="No inputs are mapped to this product yet." />
            <LinkList title="Used in (downstream)" links={down} empty="No downstream uses are mapped yet." />
          </div>
        </div>
      ) : (
        <EmptyState
          compact
          icon={Workflow}
          title={chains.length ? 'No input or output links for this line yet' : 'Not yet part of a curated value chain'}
          message="Value-chain links start with the curated sectors. Ministries can add input-output links through the Data Hub."
          action={
            <Button to={routes.valueChains()} size="sm">
              Browse value chains
            </Button>
          }
        />
      )}
    </Card>
  );
}
