/**
 * Extra cytoscape styling for the Network page, layered on top of the foundation NetworkGraph
 * (components/impl/NetworkGraphCore.tsx) through its `onReady(cy)` hook:
 *
 * - edge style by relation: `input_to` thin solid arrow, `component_of` heavier solid arrow,
 *   `parts_of` (derived from HS text) dashed with an open arrow, and `hs_hierarchy` (a heading and
 *   the longer codes under it, added by the API so linked chains read as connected) dotted with no
 *   arrow - it is a "same product family" tie, not a flow of goods;
 * - `.d3-critical`: red outline on nodes whose vulnerability score is >= CRITICAL_VULNERABILITY;
 * - `.d3-trace` / `.d3-trace-root`: brand-blue halo and edges on a traced upstream / downstream path;
 * - `.d3-fade`: everything off the traced path recedes;
 * - node labels are hidden while too small to read (LABEL_MIN_ZOOMED_FONT); `networkLayout` packs the
 *   dagre stages and `stretchToCanvas` spreads them to the canvas width after the layout.
 *
 * The rules are appended after the base stylesheet, so they win for the properties they set, while
 * the foundation's selection ring (border) and centre ring keep working.
 */
import type { Core, LayoutOptions, StylesheetJsonBlock } from 'cytoscape';
import { CHART_TOKENS, type ThemeMode } from '@/lib/theme';

/** Vulnerability score (0-100) from which a node counts as a critical input (red outline). */
export const CRITICAL_VULNERABILITY = 60;

/** Relation the API uses for its synthetic heading -> line ("same HS family") links. */
export const HIERARCHY_RELATION = 'hs_hierarchy';

export const CRITICAL_COLOR: Record<ThemeMode, string> = { light: '#d03b3b', dark: '#e05252' };
export const TRACE_COLOR: Record<ThemeMode, string> = { light: '#0033a0', dark: '#93b2ff' };

export type RelationKey = 'input_to' | 'component_of' | 'parts_of' | 'hs_hierarchy';

/** Stroke colours of the relation styles (also used by the legend). */
export function relationColors(mode: ThemeMode): Record<RelationKey, string> {
  const t = CHART_TOKENS[mode];
  return { input_to: t.axis, component_of: t.ink2, parts_of: t.muted, hs_hierarchy: t.muted };
}

export function extraGraphStyle(mode: ThemeMode): StylesheetJsonBlock[] {
  const rel = relationColors(mode);
  const trace = TRACE_COLOR[mode];
  return [
    {
      // Labels beside the node (on a surface-coloured plate that masks the edges passing behind it).
      selector: 'node',
      style: {
        'min-zoomed-font-size': LABEL_MIN_ZOOMED_FONT,
        'text-halign': 'right',
        'text-valign': 'center',
        'text-justification': 'left',
        'text-margin-x': 6,
        'text-margin-y': 0,
        'text-max-width': `${LABEL_WIDTH}px`,
      },
    },
    { selector: 'edge[relation = "input_to"]', style: { 'line-color': rel.input_to, 'target-arrow-color': rel.input_to, width: 1.5 } },
    { selector: 'edge[relation = "component_of"]', style: { 'line-color': rel.component_of, 'target-arrow-color': rel.component_of, width: 2.4 } },
    {
      selector: 'edge[relation = "parts_of"]',
      style: { 'line-color': rel.parts_of, 'target-arrow-color': rel.parts_of, 'line-style': 'dashed', 'line-dash-pattern': [6, 4], 'target-arrow-shape': 'vee', width: 1.3 },
    },
    {
      selector: `edge[relation = "${HIERARCHY_RELATION}"]`,
      style: { 'line-color': rel.hs_hierarchy, 'line-style': 'dotted', 'target-arrow-shape': 'none', width: 1.2, opacity: 0.75 },
    },
    {
      selector: 'node.d3-critical',
      style: { 'outline-width': 3, 'outline-color': CRITICAL_COLOR[mode], 'outline-offset': 2, 'outline-opacity': 1 },
    },
    { selector: '.d3-fade', style: { opacity: 0.14 } },
    {
      selector: 'node.d3-trace',
      style: { 'underlay-color': trace, 'underlay-opacity': 0.2, 'underlay-padding': 7, 'underlay-shape': 'ellipse', opacity: 1 },
    },
    { selector: 'node.d3-trace-root', style: { 'underlay-opacity': 0.36, 'underlay-padding': 11 } },
    { selector: 'edge.d3-trace', style: { 'line-color': trace, 'target-arrow-color': trace, width: 3, opacity: 1, 'z-index': 10 } },
  ];
}

/**
 * Labels are hidden while they would render smaller than this many pixels (the foundation draws node
 * labels at 10 px), so a fitted overview of many chains reads as a clean pattern and labels appear as
 * the user zooms in. `labelsHiddenAt` tells the page when to show its "zoom in to read labels" hint.
 */
export const LABEL_MIN_ZOOMED_FONT = 5;
export const LABEL_FONT_SIZE = 10;

/** Node labels (code + short name, wrapped at 150 px) sit to the right of the node, in the gap before the next stage. */
const LABEL_WIDTH = 150;
/** Typical node diameter (the foundation sizes nodes 22-52 px by log trade). */
const NODE_SIZE = 36;
/** Vertical gap between nodes of one stage: room for a label of up to three lines beside each node. */
const NODE_SEP = 12;
/** Gap between stages: at least the label width plus room for the arrows. */
const RANK_SEP = { min: LABEL_WIDTH + 40 };

/** Number of graph nodes per rank under a ranking, and how many ranks are used. */
function rankStats(rank: ReadonlyMap<string, number>): { ranks: number; widest: number } {
  const per = new Map<number, number>();
  rank.forEach((r) => per.set(r, (per.get(r) ?? 0) + 1));
  return { ranks: Math.max(1, per.size), widest: Math.max(1, ...per.values()) };
}

/**
 * Estimate the stages of a directed graph two ways - every node as early as possible (sources first)
 * and as late as possible (sinks last, dagre's longest-path ranker) - via Kahn's algorithm in both
 * directions; nodes on a cycle keep rank 0. dagre's network-simplex ranking lies between the two.
 */
function estimateRanks(ids: ReadonlySet<string>, edges: ReadonlyArray<{ source: string; target: string }>): { ranks: number; widest: number } {
  const succ = new Map<string, string[]>();
  const pred = new Map<string, string[]>();
  ids.forEach((id) => {
    succ.set(id, []);
    pred.set(id, []);
  });
  for (const e of edges) {
    if (e.source === e.target || !ids.has(e.source) || !ids.has(e.target)) continue;
    succ.get(e.source)?.push(e.target);
    pred.get(e.target)?.push(e.source);
  }
  const sweep = (fwd: Map<string, string[]>, back: Map<string, string[]>, step: 1 | -1) => {
    const rank = new Map<string, number>();
    const left = new Map<string, number>();
    const queue: string[] = [];
    ids.forEach((id) => {
      left.set(id, back.get(id)?.length ?? 0);
      if (!left.get(id)) {
        rank.set(id, 0);
        queue.push(id);
      }
    });
    for (let i = 0; i < queue.length; i += 1) {
      const u = queue[i];
      for (const v of fwd.get(u) ?? []) {
        const r = (rank.get(u) ?? 0) + step;
        rank.set(v, rank.has(v) ? (step > 0 ? Math.max(rank.get(v) as number, r) : Math.min(rank.get(v) as number, r)) : r);
        const n = (left.get(v) ?? 1) - 1;
        left.set(v, n);
        if (n === 0) queue.push(v);
      }
    }
    ids.forEach((id) => {
      if (!rank.has(id)) rank.set(id, 0);
    });
    return rankStats(rank);
  };
  const early = sweep(succ, pred, 1);
  const late = sweep(pred, succ, -1);
  return { ranks: Math.max(early.ranks, late.ranks), widest: Math.min(early.widest, late.widest) };
}

/** Estimated drawing size of a graph under the Network page's dagre settings (before zoom). */
export interface NetworkGeometry {
  /** Production stages (dagre ranks). */
  ranks: number;
  /** Nodes in the most crowded stage. */
  widest: number;
  /** Height of the drawing in graph units (the most crowded stage stacked vertically). */
  height: number;
}

export function networkGeometry(nodes: ReadonlyArray<{ id: string }>, edges: ReadonlyArray<{ source: string; target: string }>): NetworkGeometry {
  const { ranks, widest } = estimateRanks(new Set(nodes.map((n) => n.id)), edges);
  return { ranks, widest, height: widest * (NODE_SIZE + NODE_SEP) };
}

/**
 * Left-to-right dagre layout for the Network page: stages packed tightly (labels go beside the nodes,
 * see extraGraphStyle) with the narrowest stage gap that still leaves room for a label. The drawing is
 * then widened to the canvas by `stretchToCanvas`, which works on the real drawing rather than an
 * estimate, so the layout does not depend on the canvas size (resizing never re-runs dagre).
 */
export function networkLayout(): LayoutOptions {
  return { name: 'dagre', rankDir: 'LR', nodeSep: NODE_SEP, rankSep: RANK_SEP.min, edgeSep: 8, padding: 32, animate: false } as LayoutOptions;
}

/** Largest factor by which `stretchToCanvas` widens the gaps between stages. */
const MAX_STRETCH = 3.2;

/**
 * Widen a laid-out drawing horizontally until its aspect ratio approaches the canvas's.
 *
 * A value-chain graph is shallow (a few production stages) and broad (many products per stage), so
 * dagre draws a tall, narrow column that the fit then shrinks into a strip down the middle of the
 * canvas. Spreading the stages apart (positions only, no relayout) lets the fit use the full width,
 * which keeps more of the many-chain overview legible. Returns false while the layout has not placed
 * the nodes yet (every node still at the origin), so the caller can retry on `layoutstop`.
 */
export function stretchToCanvas(cy: Core): boolean {
  if (cy.destroyed()) return true;
  const nodes = cy.nodes();
  if (nodes.length < 2) return true;
  const xs = new Set<number>();
  const ys = new Set<number>();
  nodes.forEach((n) => {
    xs.add(Math.round(n.position('x')));
    ys.add(Math.round(n.position('y')));
  });
  if (xs.size < 2) return ys.size > 1; // a single stage cannot be spread; not laid out if ys collapsed too
  const bb = nodes.boundingBox({ includeLabels: false });
  const w = cy.width();
  const h = cy.height();
  if (bb.w <= 0 || bb.h <= 0 || w <= 0 || h <= 0) return false;
  // Leave room for the labels to the right of the last stage.
  const target = (w / h) * bb.h - LABEL_WIDTH;
  const k = Math.min(MAX_STRETCH, target / bb.w);
  if (k <= 1.05) return true;
  const x0 = bb.x1;
  nodes.positions((n) => ({ x: x0 + (n.position('x') - x0) * k, y: n.position('y') }));
  return true;
}

/**
 * Whether node labels are currently hidden by the `min-zoomed-font-size` rule. cytoscape compares
 * the label size in device pixels, hence the pixel ratio.
 */
export function labelsHiddenAt(zoom: number): boolean {
  const ratio = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  return LABEL_FONT_SIZE * zoom * ratio < LABEL_MIN_ZOOMED_FONT;
}

export interface GraphClasses {
  critical: ReadonlySet<string>;
  /** null = no trace active. */
  traceNodes: ReadonlySet<string> | null;
  /** Edge keys "source->target" on the traced path. */
  traceEdges: ReadonlySet<string> | null;
  traceRoot: string | null;
}

/** Apply the page's classes to a live cytoscape instance (no relayout). */
export function applyGraphClasses(cy: Core, c: GraphClasses): void {
  if (cy.destroyed()) return;
  cy.batch(() => {
    cy.elements().removeClass('d3-critical d3-trace d3-trace-root d3-fade');
    cy.nodes().forEach((n) => {
      if (c.critical.has(n.id())) n.addClass('d3-critical');
    });
    if (!c.traceNodes) return;
    cy.nodes().forEach((n) => {
      if (c.traceNodes?.has(n.id())) n.addClass('d3-trace');
      else n.addClass('d3-fade');
    });
    cy.edges().forEach((e) => {
      if (c.traceEdges?.has(`${e.source().id()}->${e.target().id()}`)) e.addClass('d3-trace');
      else e.addClass('d3-fade');
    });
    if (c.traceRoot) cy.getElementById(c.traceRoot).addClass('d3-trace-root');
  });
}
