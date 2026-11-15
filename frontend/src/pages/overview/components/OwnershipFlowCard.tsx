/**
 * OwnershipFlowCard - the Guidebook register as an interactive four-column tree:
 *
 *   1 · SECTOR  ->  2 · HSN REGISTER  ->  3 · OWNING MINISTRY  ->  4 · MAPPING STATUS
 *
 * Every node is a branch. Clicking one keeps the exact HSN lines that pass the choices to its left,
 * so the register column and the downstream columns always count the same real set of lines. A
 * breadcrumb records the drill-down, the register shows the exact intersection, and the panel below
 * resolves the selection to its sector / ministry / status breakdown and largest 8-digit lines.
 *
 * All figures come from GET /api/meta/flow (folded top nodes + exact triples) and
 * GET /api/meta/flow/detail (the selected intersection). Long tails stay selectable as "other"; the
 * detail endpoint expands them to their real members. Breakdown rows outside the top flow nodes link
 * to the Explorer with the same filters because they are not separate branches of this tree.
 *
 * Keyboard: nodes are native buttons (Tab / Enter / Space); Esc clears the drill-down.
 */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router';
import clsx from 'clsx';
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  LoaderCircle,
  RotateCcw,
  Search,
  Workflow,
  X,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  ProvenanceBadge,
  SegmentedControl,
  type BadgeTone,
} from '@/components';
import { fmtNum, fmtPct, fmtUSD } from '@/lib/format';
import { routes } from '@/lib/routes';
import {
  useFlowDetail,
  useOwnershipFlow,
  type FlowDetail,
  type FlowDetailBreakdown,
  type FlowNode,
  type FlowSelection,
  type FlowTriple,
  type OwnershipFlow,
} from '../api';

type Measure = 'codes' | 'exports';
type Dim = 'sector_id' | 'ministry_id' | 'status';

const DIMS: readonly Dim[] = ['sector_id', 'ministry_id', 'status'];
const DIM_LABEL: Record<Dim, string> = { sector_id: 'Sector', ministry_id: 'Ministry', status: 'Status' };
const FIELD: Record<Dim, 'sector' | 'ministry' | 'status'> = {
  sector_id: 'sector',
  ministry_id: 'ministry',
  status: 'status',
};

const STATUS_COLOR: Record<string, string> = {
  dpiit_guidebook: 'var(--color-ok)',
  official_upload: 'var(--color-ok)',
  manual: 'var(--color-ok)',
  rule: 'var(--color-info)',
  unmapped: 'var(--color-bad)',
  residual: 'var(--color-bad)',
};

const STATUS_TONE: Record<string, BadgeTone> = {
  dpiit_guidebook: 'success',
  official_upload: 'success',
  manual: 'success',
  rule: 'info',
  unmapped: 'danger',
  residual: 'danger',
};

/** True when a triple passes every selected dimension except `ignore`. */function matches(t: FlowTriple, selection: FlowSelection, ignore?: Dim): boolean {
  return DIMS.every((dim) => dim === ignore || !selection[dim] || t[FIELD[dim]] === selection[dim]);
}

function totalFor(triples: FlowTriple[], selection: FlowSelection, ignore?: Dim): { codes: number; exports: number } {
  let codes = 0;
  let exports = 0;
  for (const t of triples) {
    if (!matches(t, selection, ignore)) continue;
    codes += t.codes;
    exports += t.exports;
  }
  return { codes, exports };
}

/** Count a candidate node under the choices made in the columns before it. */
function nodeTotal(triples: FlowTriple[], selection: FlowSelection, dim: Dim, id: string): { codes: number; exports: number } {
  const rank = DIMS.indexOf(dim);
  let codes = 0;
  let exports = 0;
  for (const t of triples) {
    if (t[FIELD[dim]] !== id) continue;
    if (DIMS.slice(0, rank).some((d) => selection[d] && t[FIELD[d]] !== selection[d])) continue;
    codes += t.codes;
    exports += t.exports;
  }
  return { codes, exports };
}

/** Totals behind a column: only the choices to its left, matching how its rows are counted. */
function upstreamTotal(triples: FlowTriple[], selection: FlowSelection, dim: Dim): { codes: number; exports: number } {
  const rank = DIMS.indexOf(dim);
  const upstream: FlowSelection = {};
  for (const d of DIMS.slice(0, rank)) upstream[d] = selection[d];
  return totalFor(triples, upstream);
}

function nodesFor(flow: OwnershipFlow, dim: Dim): FlowNode[] {
  if (dim === 'sector_id') return flow.sectors;
  if (dim === 'ministry_id') return flow.ministries;
  return flow.statuses;
}

function nodeLabel(flow: OwnershipFlow, dim: Dim, id: string | null | undefined): string | null {
  if (!id) return null;
  const node = nodesFor(flow, dim).find((n) => n.id === id);
  if (!node) return id;
  return dim === 'ministry_id' ? node.short_name ?? node.name : node.name;
}

function nodeColor(flow: OwnershipFlow, dim: Dim, id: string | null | undefined): string {
  if (!id) return 'var(--color-brand)';
  if (dim === 'status') return STATUS_COLOR[id] ?? 'var(--color-info)';
  const node = nodesFor(flow, dim).find((n) => n.id === id);
  if (id === 'residual') return 'var(--color-bad)';
  return node?.color ?? 'var(--color-brand)';
}

function sameSelection(filters: FlowDetail['filters'], selection: FlowSelection): boolean {
  return (filters.sector_id ?? null) === (selection.sector_id ?? null)
    && (filters.ministry_id ?? null) === (selection.ministry_id ?? null)
    && (filters.status ?? null) === (selection.status ?? null);
}

/** Explorer URL for the current filters, optionally replacing one dimension with a concrete row. */
function exploreHref(selection: FlowSelection, replace?: { dim: Dim; id: string }): string {
  const pick = (dim: Dim) => (replace?.dim === dim ? replace.id : selection[dim] ?? null);
  const sector = pick('sector_id');
  const ministry = pick('ministry_id');
  const status = pick('status');
  const params: {
    sector_id?: string;
    ministry_id?: string;
    mapping_status?: string;
    mapping_source?: string;
  } = {};
  // "other" is a folded bucket, not an id the Explorer knows; the concrete rows below carry links.
  if (sector && sector !== 'other') params.sector_id = sector;
  if (ministry && ministry !== 'other') params.ministry_id = ministry;
  if (status) {
    if (status === 'residual') params.mapping_status = 'residual';
    else params.mapping_source = status;
  }
  return routes.explore(params);
}

// ---------------------------------------------------------------- tree connectors

interface TreeBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  y: number;
}

interface TreeGeometry {
  width: number;
  height: number;
  register: TreeBox;
  root: TreeBox | null;
  nodes: Record<string, TreeBox>;
}

function boxFrom(rect: DOMRect, origin: DOMRect): TreeBox {
  return {
    left: rect.left - origin.left,
    right: rect.right - origin.left,
    top: rect.top - origin.top,
    bottom: rect.bottom - origin.top,
    y: (rect.top + rect.bottom) / 2 - origin.top,
  };
}

/** Measure the real DOM rows so the SVG branches always meet their buttons, at any font size or width. */
function useTreeGeometry(rootRef: RefObject<HTMLDivElement | null>, revision: string): TreeGeometry | null {
  const [geometry, setGeometry] = useState<TreeGeometry | null>(null);

  useLayoutEffect(() => {
    const container = rootRef.current;
    if (!container) {
      setGeometry(null);
      return;
    }
    let frame = 0;
    let disposed = false;

    const measure = () => {
      frame = 0;
      if (disposed) return;
      const origin = container.getBoundingClientRect();
      const registerEl = container.querySelector<HTMLElement>('[data-flow-register]');
      const rootEl = container.querySelector<HTMLElement>('[data-flow-root]');
      if (!origin.width || !registerEl) return;
      const nodes: Record<string, TreeBox> = {};
      container.querySelectorAll<HTMLElement>('[data-flow-dim][data-flow-id]').forEach((el) => {
        const dim = el.dataset.flowDim;
        const id = el.dataset.flowId;
        if (!dim || !id) return;
        nodes[`${dim}:${id}`] = boxFrom(el.getBoundingClientRect(), origin);
      });
      const rootRect = rootEl?.getBoundingClientRect();
      setGeometry({
        width: origin.width,
        height: origin.height,
        register: boxFrom(registerEl.getBoundingClientRect(), origin),
        root: rootRect && rootRect.width > 0 ? boxFrom(rootRect, origin) : null,
        nodes,
      });
    };

    const schedule = () => {
      if (disposed || frame) return;
      frame = window.requestAnimationFrame(measure);
    };

    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    container.querySelectorAll<HTMLElement>('[data-flow-dim], [data-flow-register], [data-flow-root]').forEach((el) => observer.observe(el));
    window.addEventListener('resize', schedule);
    document.fonts?.ready.then(schedule).catch(() => {});
    return () => {
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [rootRef, revision]);

  return geometry;
}

interface BranchPoint {
  x: number;
  y: number;
}

interface TreeCurve {
  p0: BranchPoint;
  p1: BranchPoint;
  p2: BranchPoint;
  p3: BranchPoint;
}

type BranchKind = 'sector' | 'ministry' | 'status';

interface BranchSpec {
  key: string;
  curve: TreeCurve;
  kind: BranchKind;
  weight: number;
  fill: string;
  selected: boolean;
  related: boolean;
  tag?: string;
}

interface TreeBranch extends BranchSpec {
  d: string;
  band: string;
  mid: BranchPoint;
  width: number;
  opacity: number;
  seeds: BranchPoint[];
}

interface TreeKnot {
  key: string;
  x: number;
  y: number;
  color: string;
  hot: boolean;
}

interface TreeTrunk {
  leader: string;
  twigs: string[];
  trunk: string;
  roots: string[];
  ground: { cx: number; cy: number; rx: number; ry: number };
  groundLine: { x1: number; x2: number; y: number };
  leaves: Array<{ cx: number; cy: number; rx: number; ry: number; rotate: number }>;
}

function cubicAt(curve: TreeCurve, t: number): BranchPoint {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * curve.p0.x + b * curve.p1.x + c * curve.p2.x + d * curve.p3.x,
    y: a * curve.p0.y + b * curve.p1.y + c * curve.p2.y + d * curve.p3.y,
  };
}

function cubicTangent(curve: TreeCurve, t: number): BranchPoint {
  const mt = 1 - t;
  return {
    x: 3 * mt * mt * (curve.p1.x - curve.p0.x) + 6 * mt * t * (curve.p2.x - curve.p1.x) + 3 * t * t * (curve.p3.x - curve.p2.x),
    y: 3 * mt * mt * (curve.p1.y - curve.p0.y) + 6 * mt * t * (curve.p2.y - curve.p1.y) + 3 * t * t * (curve.p3.y - curve.p2.y),
  };
}

function curvePath(curve: TreeCurve): string {
  return `M ${curve.p0.x.toFixed(1)} ${curve.p0.y.toFixed(1)} C ${curve.p1.x.toFixed(1)} ${curve.p1.y.toFixed(1)}, ${curve.p2.x.toFixed(1)} ${curve.p2.y.toFixed(1)}, ${curve.p3.x.toFixed(1)} ${curve.p3.y.toFixed(1)}`;
}

/** A filled, tapered branch: thick at the trunk, thin at the leaf. */
function bandPath(curve: TreeCurve, startWidth: number, endWidth: number, phase = 0): string {
  const steps = 30;
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const point = cubicAt(curve, t);
    const tangent = cubicTangent(curve, t);
    const length = Math.hypot(tangent.x, tangent.y) || 1;
    const nx = -tangent.y / length;
    const ny = tangent.x / length;
    // A very small wobble keeps the silhouette organic without changing the measured endpoints.
    const wobble = 1 + Math.sin(t * Math.PI * 2.1 + phase) * 0.05;
    const half = Math.max(0.8, (startWidth + (endWidth - startWidth) * t) * wobble) / 2;
    left.push(`${(point.x + nx * half).toFixed(1)} ${(point.y + ny * half).toFixed(1)}`);
    right.push(`${(point.x - nx * half).toFixed(1)} ${(point.y - ny * half).toFixed(1)}`);
  }
  return `M ${left.join(' L ')} L ${right.reverse().join(' L ')} Z`;
}

function flowCurve(from: BranchPoint, to: BranchPoint): TreeCurve {
  const reach = Math.max(20, Math.abs(to.x - from.x));
  const sign = to.x >= from.x ? 1 : -1;
  return {
    p0: from,
    p1: { x: from.x + sign * reach * 0.46, y: from.y },
    p2: { x: to.x - sign * reach * 0.46, y: to.y },
    p3: to,
  };
}

function verticalCurve(from: BranchPoint, to: BranchPoint): TreeCurve {
  const dy = to.y - from.y;
  return {
    p0: from,
    p1: { x: from.x, y: from.y + dy * 0.46 },
    p2: { x: to.x, y: to.y - dy * 0.46 },
    p3: to,
  };
}

/** Spread the branches along the trunk edge instead of pinning them to one network hub. */
function edgeY(box: TreeBox, index: number, count: number): number {
  if (count <= 1) return box.y;
  const pad = Math.min(26, (box.bottom - box.top) * 0.14);
  return box.top + pad + ((box.bottom - box.top - pad * 2) * index) / (count - 1);
}

function phaseFor(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return ((hash % 360) * Math.PI) / 180;
}

function statusTag(status: string): string {
  if (status === 'residual' || status === 'unmapped') return 'unmapped';
  if (status === 'rule') return 'provisional';
  return 'verified';
}

/**
 * The branch bundles of the tree. Sector and ministry branches carry the counts left by the
 * upstream choices; ministry -> status branches exist only for exact triples that really occur.
 */
function buildTreeBranches(
  flow: OwnershipFlow,
  triples: FlowTriple[],
  selection: FlowSelection,
  measure: Measure,
  geometry: TreeGeometry,
  hasSelection: boolean,
): TreeBranch[] {
  const specs: BranchSpec[] = [];
  const weighted = (codes: number, exports: number) => (measure === 'codes' ? codes : exports);

  flow.sectors.forEach((node, index) => {
    const box = geometry.nodes[`sector_id:${node.id}`];
    const total = nodeTotal(triples, selection, 'sector_id', node.id);
    if (!box || total.codes === 0) return;
    const selected = selection.sector_id === node.id;
    specs.push({
      key: `sector:${node.id}`,
      curve: flowCurve(
        { x: box.right, y: box.y },
        { x: geometry.register.left, y: edgeY(geometry.register, index, flow.sectors.length) },
      ),
      kind: 'sector',
      weight: weighted(total.codes, total.exports),
      fill: 'var(--atlas-bark-dark)',
      selected,
      related: !selection.sector_id || selected,
      tag: selected ? 'sector' : undefined,
    });
  });

  flow.ministries.forEach((node, index) => {
    const box = geometry.nodes[`ministry_id:${node.id}`];
    const total = nodeTotal(triples, selection, 'ministry_id', node.id);
    if (!box || total.codes === 0) return;
    const selected = selection.ministry_id === node.id;
    specs.push({
      key: `ministry:${node.id}`,
      curve: flowCurve(
        { x: geometry.register.right, y: edgeY(geometry.register, index, flow.ministries.length) },
        { x: box.left, y: box.y },
      ),
      kind: 'ministry',
      weight: weighted(total.codes, total.exports),
      fill: 'var(--atlas-bark)',
      selected,
      related: !selection.ministry_id || selected,
      tag: selected ? 'owner' : undefined,
    });
  });

  // Only exact owner x status combinations get a branch, so the visual never invents a link.
  const pairs = new Map<string, { ministry: string; status: string; codes: number; exports: number }>();
  for (const triple of triples) {
    if (selection.sector_id && triple.sector !== selection.sector_id) continue;
    const key = `${triple.ministry}|${triple.status}`;
    const found = pairs.get(key);
    if (found) {
      found.codes += triple.codes;
      found.exports += triple.exports;
    } else {
      pairs.set(key, {
        ministry: triple.ministry,
        status: triple.status,
        codes: triple.codes,
        exports: triple.exports,
      });
    }
  }

  for (const pair of pairs.values()) {
    const from = geometry.nodes[`ministry_id:${pair.ministry}`];
    const to = geometry.nodes[`status:${pair.status}`];
    if (!from || !to || pair.codes === 0) continue;
    const selected = Boolean(selection.ministry_id || selection.status)
      && (!selection.ministry_id || selection.ministry_id === pair.ministry)
      && (!selection.status || selection.status === pair.status);
    specs.push({
      key: `status:${pair.ministry}:${pair.status}`,
      curve: flowCurve({ x: from.right, y: from.y }, { x: to.left, y: to.y }),
      kind: 'status',
      weight: weighted(pair.codes, pair.exports),
      fill: 'var(--atlas-bark)',
      selected,
      related: (!selection.ministry_id || selection.ministry_id === pair.ministry)
        && (!selection.status || selection.status === pair.status),
      tag: selected ? statusTag(pair.status) : undefined,
    });
  }

  const maxWeight = Math.max(...specs.map((spec) => spec.weight), 1);
  return specs.map((spec) => {
    const strength = Math.sqrt(Math.max(0, spec.weight) / maxWeight);
    const leaf = 2.5 + strength * 4.5;
    const trunk = 8 + strength * 16;
    const startWidth = spec.kind === 'sector' ? leaf : spec.kind === 'ministry' ? trunk : 3.5 + strength * 6;
    const endWidth = spec.kind === 'sector' ? trunk : spec.kind === 'ministry' ? leaf : 2.2 + strength * 2.8;
    const opacity = !hasSelection
      ? 0.96
      : spec.selected
        ? 1
        : spec.related
          ? 0.66
          : 0.16;
    const curve = spec.curve;
    return {
      ...spec,
      d: curvePath(curve),
      band: bandPath(curve, startWidth, endWidth, phaseFor(spec.key)),
      mid: cubicAt(curve, 0.52),
      width: Math.max(startWidth, endWidth),
      opacity,
      fill: spec.selected ? 'var(--atlas-bark-selected)' : spec.fill,
      seeds: spec.selected ? [cubicAt(curve, 0.3), cubicAt(curve, 0.7)] : [],
    };
  });
}

function buildTreeKnots(
  flow: OwnershipFlow,
  triples: FlowTriple[],
  selection: FlowSelection,
  geometry: TreeGeometry,
): TreeKnot[] {
  const knots: TreeKnot[] = [];

  flow.sectors.forEach((node, index) => {
    const box = geometry.nodes[`sector_id:${node.id}`];
    const total = nodeTotal(triples, selection, 'sector_id', node.id);
    if (!box || total.codes === 0) return;
    knots.push({
      key: `sector:${node.id}`,
      x: geometry.register.left,
      y: edgeY(geometry.register, index, flow.sectors.length),
      color: nodeColor(flow, 'sector_id', node.id),
      hot: selection.sector_id === node.id,
    });
  });

  flow.ministries.forEach((node, index) => {
    const box = geometry.nodes[`ministry_id:${node.id}`];
    const total = nodeTotal(triples, selection, 'ministry_id', node.id);
    if (!box || total.codes === 0) return;
    knots.push({
      key: `ministry:${node.id}`,
      x: geometry.register.right,
      y: edgeY(geometry.register, index, flow.ministries.length),
      color: nodeColor(flow, 'ministry_id', node.id),
      hot: selection.ministry_id === node.id,
    });
  });

  flow.statuses.forEach((node) => {
    const box = geometry.nodes[`status:${node.id}`];
    const total = nodeTotal(triples, selection, 'status', node.id);
    if (!box || total.codes === 0) return;
    knots.push({
      key: `status:${node.id}`,
      x: box.left,
      y: box.y,
      color: STATUS_COLOR[node.id] ?? 'var(--color-info)',
      hot: selection.status === node.id,
    });
  });

  return knots;
}

function buildTreeTrunk(geometry: TreeGeometry): TreeTrunk {
  const register = geometry.register;
  const centerX = (register.left + register.right) / 2;
  const leaderTop = register.top - 34;

  const leaderCurve = verticalCurve({ x: centerX, y: register.top + 8 }, { x: centerX, y: leaderTop });
  const leader = bandPath(leaderCurve, 30, 2.6, phaseFor('leader'));
  const twigs = [
    bandPath(flowCurve({ x: centerX, y: register.top - 19 }, { x: centerX - 30, y: register.top - 45 }), 6, 1.1, phaseFor('twig:left')),
    bandPath(flowCurve({ x: centerX, y: register.top - 15 }, { x: centerX + 28, y: register.top - 40 }), 5, 1, phaseFor('twig:right')),
  ];

  const rootTop = geometry.root ? geometry.root.top + 10 : geometry.height - 90;
  const trunkBottom = geometry.root ? rootTop : geometry.height - 30;
  const trunkCurve = verticalCurve({ x: centerX, y: register.bottom - 8 }, { x: centerX, y: trunkBottom });
  const trunk = bandPath(trunkCurve, 30, 48, phaseFor('trunk'));

  const groundCx = geometry.root ? (geometry.root.left + geometry.root.right) / 2 : centerX;
  const groundCy = geometry.root ? Math.min(geometry.root.bottom + 11, geometry.height - 6) : geometry.height - 16;
  const groundRx = Math.min(300, Math.max(190, geometry.width * 0.24));
  const roots = geometry.root
    ? ([-58, -112, 58, 112] as const).map((dx) =>
        bandPath(
          flowCurve(
            { x: groundCx, y: geometry.root!.bottom - 8 },
            { x: groundCx + dx, y: groundCy + (Math.abs(dx) > 90 ? 1 : 4) },
          ),
          7,
          1.1,
          phaseFor(`root:${dx}`),
        ),
      )
    : [];

  return {
    leader,
    twigs,
    trunk,
    roots,
    ground: { cx: groundCx, cy: groundCy, rx: groundRx, ry: 15 },
    groundLine: { x1: groundCx - groundRx * 0.58, x2: groundCx + groundRx * 0.58, y: groundCy - 1 },
    leaves: [
      { cx: centerX - 14, cy: register.top - 47, rx: 11, ry: 4.2, rotate: -24 },
      { cx: centerX + 15, cy: register.top - 42, rx: 9, ry: 3.6, rotate: 22 },
      { cx: centerX - 2, cy: register.top - 57, rx: 8, ry: 3.2, rotate: -4 },
    ],
  };
}

function TreeOverlay({
  geometry,
  branches,
  knots,
  trunk,
}: {
  geometry: TreeGeometry | null;
  branches: TreeBranch[];
  knots: TreeKnot[];
  trunk: TreeTrunk | null;
}) {
  if (!geometry || !trunk) return null;
  const selected = branches.filter((branch) => branch.selected);
  return (
    <svg
      className="pointer-events-none absolute inset-0 z-10 hidden h-full w-full xl:block"
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      aria-hidden="true"
      focusable="false"
    >
      <g>
        <ellipse cx={trunk.ground.cx} cy={trunk.ground.cy} rx={trunk.ground.rx} ry={trunk.ground.ry} fill="var(--atlas-ground)" />
        <line
          x1={trunk.groundLine.x1}
          x2={trunk.groundLine.x2}
          y1={trunk.groundLine.y}
          y2={trunk.groundLine.y}
          stroke="var(--atlas-bark)"
          strokeWidth={1}
          strokeDasharray="2 9"
          opacity={0.5}
        />
      </g>

      <g fill="var(--atlas-bark-dark)" opacity={0.92}>
        {trunk.roots.map((root, index) => <path key={`root:${index}`} d={root} />)}
      </g>

      <g className="atlas-tree-halo" fill="none" strokeLinecap="round">
        {selected.map((branch) => (
          <path key={`halo:${branch.key}`} d={branch.d} stroke="var(--atlas-seed)" strokeWidth={branch.width + 16} opacity={0.22} />
        ))}
      </g>

      <g fill="var(--atlas-bark-dark)">
        <path d={trunk.leader} />
        {trunk.twigs.map((twig, index) => <path key={`twig:${index}`} d={twig} />)}
        <path d={trunk.trunk} />
      </g>
      <g fill="var(--atlas-seed)" opacity={0.58}>
        {trunk.leaves.map((leaf, index) => (
          <ellipse key={`leaf:${index}`} cx={leaf.cx} cy={leaf.cy} rx={leaf.rx} ry={leaf.ry}
            transform={`rotate(${leaf.rotate} ${leaf.cx} ${leaf.cy})`} />
        ))}
      </g>

      <g>
        {branches.map((branch) => (
          <g key={branch.key} opacity={branch.opacity} className="atlas-tree-branch">
            <path d={branch.band} fill={branch.fill} stroke="var(--atlas-bark-dark)" strokeWidth={0.9} strokeOpacity={0.28} />
            {branch.width > 8 ? (
              <path d={branch.d} fill="none" stroke="var(--atlas-bark-light)" strokeWidth={1.1} opacity={0.35} strokeLinecap="round" />
            ) : null}
          </g>
        ))}
      </g>

      <g>
        {knots.map((knot) => (
          <g key={knot.key}>
            {knot.hot ? <circle cx={knot.x} cy={knot.y} r={8} fill="none" stroke="var(--atlas-seed)" strokeWidth={1} opacity={0.6} /> : null}
            <circle cx={knot.x} cy={knot.y} r={knot.hot ? 5.2 : 3.6} fill="var(--atlas-bark-dark)" />
            <circle cx={knot.x} cy={knot.y} r={1.9} fill={knot.color} opacity={knot.hot ? 1 : 0.8} />
          </g>
        ))}
      </g>

      <g>
        {selected.flatMap((branch) =>
          branch.seeds.map((seed, index) => (
            <circle key={`seed:${branch.key}:${index}`} cx={seed.x} cy={seed.y} r={2.1}
              fill="var(--atlas-seed)" stroke="var(--atlas-seed-ink)" strokeWidth={0.6} />
          )),
        )}
      </g>

      <g className="atlas-tree-motes">
        {selected.map((branch, index) => (
          <circle key={`mote:${branch.key}`} r={2.4} fill="var(--atlas-seed)" stroke="var(--atlas-seed-ink)" strokeWidth={0.5}>
            <animateMotion dur={`${3.6 + index * 0.7}s`} begin={`${index * 0.6}s`} repeatCount="indefinite" path={branch.d} />
          </circle>
        ))}
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------- small pieces

function Column({ step, title, meta, children }: { step: number; title: string; meta: string; children: ReactNode }) {
  return (
    <section className="relative z-20 min-w-0" aria-label={`${step}. ${title}`}>
      <header className="mb-3 flex items-baseline justify-between gap-2 border-b border-dashed border-line/70 px-1 pb-2">
        <h3 className="text-[10.5px] font-bold tracking-[0.14em] text-muted uppercase">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-grid size-[17px] place-items-center rounded-full bg-brand-soft text-[9px] font-bold text-brand-ink ring-1 ring-brand/25" aria-hidden>{step}</span>
            {title}
          </span>
        </h3>
        <span className="max-w-[55%] shrink-0 truncate text-[10px] text-muted tabular-nums" title={meta}>{meta}</span>
      </header>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

interface TreeRowProps {
  dim: Dim;
  nodeId: string;
  label: string;
  fullName?: string;
  color: string;
  measure: Measure;
  codes: number;
  exports: number;
  share: number;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}

function TreeRow({ dim, nodeId, label, fullName, color, measure, codes, exports, share, selected, disabled, onClick }: TreeRowProps) {
  const primary = measure === 'codes' ? fmtNum(codes) : fmtUSD(exports);
  const secondary = measure === 'codes'
    ? `${fmtPct(share, { digits: 0 })} · ${fmtUSD(exports)}`
    : `${fmtPct(share, { digits: 0 })} · ${fmtNum(codes)} lines`;
  return (
    <button
      type="button"
      data-flow-dim={dim}
      data-flow-id={nodeId}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      title={`${fullName ?? label}: ${fmtNum(codes)} current HSN lines, ${fmtUSD(exports)} exports${disabled ? ' (no lines with the current selection)' : ''}`}
      className={clsx(
        'atlas-tree-node group flex w-full items-center gap-2.5 rounded-[13px] border px-3 py-2.5 text-left transition',
        'focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:outline-none',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      <span className="relative grid size-4 shrink-0 place-items-center" aria-hidden>
        <span className="size-3.5 rounded-full opacity-20" style={{ backgroundColor: color }} />
        <span className="absolute size-2 rounded-full" style={{ backgroundColor: color }} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={clsx('block truncate text-[12.5px] font-semibold', selected ? 'text-[#6b441f] dark:text-[#f1dcc0]' : 'text-ink')}>{label}</span>
        <span className="block truncate text-[10.5px] text-muted">{secondary}</span>
      </span>
      <span className="shrink-0 text-right">
        <span className={clsx('block text-[13px] font-bold tabular-nums', selected ? 'text-[#6b441f] dark:text-[#f1dcc0]' : 'text-ink')}>{primary}</span>
        {selected ? <Check className="mt-0.5 ml-auto size-3 text-[#7d9b58] dark:text-[#b9d98d]" aria-hidden /> : null}
      </span>
    </button>
  );
}

function BreakdownGroup({
  title,
  dim,
  rows,
  detail,
  selection,
  flow,
  onSelect,
}: {
  title: string;
  dim: Dim;
  rows: FlowDetailBreakdown[];
  detail: FlowDetail;
  selection: FlowSelection;
  flow: OwnershipFlow;
  onSelect: (dim: Dim, id: string) => void;
}) {
  const treeNodes = new Set(nodesFor(flow, dim).map((n) => n.id));
  const shown = rows.reduce((sum, row) => sum + row.codes, 0);
  const rest = Math.max(0, detail.total_codes - shown);
  const total = detail.total_codes || 1;

  const content = (row: FlowDetailBreakdown, label: string, selectable: boolean, active: boolean) => {
    const color = dim === 'status' ? STATUS_COLOR[row.id] ?? 'var(--color-info)' : row.color ?? 'var(--color-brand)';
    const share = row.codes / total;
    return (
      <>
        <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className={clsx('block truncate text-[11.5px]', active ? 'font-semibold text-brand-ink' : 'font-medium text-ink-2')}>{label}</span>
          <span className="mt-1 block h-1 overflow-hidden rounded-full bg-surface-3" aria-hidden>
            <span className="block h-full rounded-full" style={{ width: `${Math.max(2, share * 100)}%`, backgroundColor: color }} />
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-[11.5px] font-bold text-ink tabular-nums">{fmtNum(row.codes)}</span>
          <span className="block text-[10px] text-muted">{fmtPct(share, { digits: 0 })}</span>
        </span>
        {selectable ? (
          active ? <Check className="size-3 shrink-0 text-brand" aria-hidden /> : null
        ) : (
          <ArrowUpRight className="size-3 shrink-0 text-muted transition group-hover:text-brand-ink" aria-hidden />
        )}
      </>
    );
  };

  return (
    <div className="min-w-0">
      <h4 className="mb-1.5 flex items-baseline justify-between gap-2 text-[10px] font-bold tracking-[0.12em] text-muted uppercase">
        <span>By {title}</span>
        <span className="font-normal tracking-normal normal-case">{fmtNum(detail.total_codes)} lines</span>
      </h4>
      <div className="space-y-1">
        {rows.map((row) => {
          const selectable = treeNodes.has(row.id);
          const active = selection[dim] === row.id;
          const label = dim === 'ministry_id' ? row.short_name ?? row.name ?? row.id : row.name ?? row.id;
          const className = clsx(
            'group flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition',
            'focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:outline-none',
            active ? 'border-brand/40 bg-brand-soft/60' : 'border-line/70 bg-surface hover:border-line-strong hover:bg-surface-2',
          );
          if (selectable) {
            return (
              <button key={row.id} type="button" aria-pressed={active} className={className}
                onClick={() => onSelect(dim, row.id)} title={`${label} - select this branch`}>
                {content(row, label, true, active)}
              </button>
            );
          }
          return (
            <Link key={row.id} to={exploreHref(selection, { dim, id: row.id })} className={className}
              title={`${label} is outside the tree's top nodes - open its exact lines in the Explorer`}>
              {content(row, label, false, false)}
            </Link>
          );
        })}
        {!rows.length ? <p className="px-2 py-1 text-[11px] text-muted">No lines in this group.</p> : null}
        {rest > 0 ? (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-line px-2 py-1.5 text-[10.5px] text-muted">
            <span>{fmtNum(rest)} more lines in smaller groups</span>
            <span className="shrink-0">not shown separately</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- card

export function OwnershipFlowCard() {
  const q = useOwnershipFlow();
  const [measure, setMeasure] = useState<Measure>('codes');
  const [selection, setSelection] = useState<FlowSelection>({});

  const flow = q.data;
  const triples = flow?.sector_ministry_status ?? [];
  const detailQuery = useFlowDetail(selection);
  const hasSelection = DIMS.some((d) => Boolean(selection[d]));
  const expressible = selection.sector_id !== 'other' && selection.ministry_id !== 'other';

  const summary = useMemo(() => totalFor(triples, selection), [triples, selection]);
  const share = flow?.total_codes ? summary.codes / flow.total_codes : 0;
  const detail = detailQuery.data && sameSelection(detailQuery.data.filters, selection) ? detailQuery.data : null;

  // The connectors are measured from the live DOM, so they follow wrapped labels, theme changes and
  // the responsive grid without duplicating any layout values here.
  const treeRef = useRef<HTMLDivElement>(null);
  const treeRevision = flow
    ? `${flow.total_codes}|${measure}|${selection.sector_id ?? ''}|${selection.ministry_id ?? ''}|${selection.status ?? ''}`
    : 'empty';
  const geometry = useTreeGeometry(treeRef, treeRevision);
  const branches = useMemo(
    () => (flow && geometry ? buildTreeBranches(flow, triples, selection, measure, geometry, hasSelection) : []),
    [flow, triples, selection, measure, geometry, hasSelection],
  );
  const knots = useMemo(
    () => (flow && geometry ? buildTreeKnots(flow, triples, selection, geometry) : []),
    [flow, triples, selection, geometry],
  );
  const trunk = useMemo(() => (geometry ? buildTreeTrunk(geometry) : null), [geometry]);

  const clear = () => setSelection({});
  const removeFrom = (dim: Dim) => {
    const rank = DIMS.indexOf(dim);
    setSelection((prev) => {
      const next: FlowSelection = { ...prev };
      for (const d of DIMS.slice(rank)) next[d] = null;
      return next;
    });
  };

  const toggle = (dim: Dim, id: string) => {
    setSelection((prev) => {
      const next: FlowSelection = { ...prev, [dim]: prev[dim] === id ? null : id };
      const rank = DIMS.indexOf(dim);
      // A new upstream choice can invalidate a deeper one; drop only the impossible levels.
      if (next[dim]) {
        for (const lower of DIMS.slice(rank + 1)) {
          if (!next[lower]) continue;
          const probe: FlowSelection = {};
          for (const d of DIMS.slice(0, DIMS.indexOf(lower) + 1)) probe[d] = next[d];
          if (totalFor(triples, probe).codes === 0) next[lower] = null;
        }
      }
      return next;
    });
  };

  const footer = flow ? (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-muted">
      <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-ok" /> Verified (DPIIT Guidebook, upload or manual review)</span>
      <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-info" /> Provisional rule</span>
      <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-bad" /> Residual / not listed</span>
      <span className="ml-auto"><ProvenanceBadge provenance={measure === 'codes' ? flow.provenance.mapping : flow.provenance.trade} size="xs" /></span>
    </div>
  ) : undefined;

  return (
    <Card
      title="How India's product register branches"
      subtitle="Follow the tree from the register trunk: clicking a sector, ministry or status keeps the exact HSN lines they share. Each column counts the lines left after the choices to its left; the register and panel below resolve the intersection."
      actions={
        <SegmentedControl<Measure> size="sm" value={measure} onChange={setMeasure} ariaLabel="Size branches by"
          options={[{ value: 'codes', label: 'Lines' }, { value: 'exports', label: 'Exports' }]} />
      }
      footer={footer}
    >
      {q.isPending ? (
        <LoadingBlock height={460} label="Tracing the ownership branches…" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />
      ) : !flow || !flow.total_codes ? (
        <EmptyState icon={Workflow} title="No mapped lines yet" />
      ) : (
        <div onKeyDown={(event) => { if (event.key === 'Escape' && hasSelection) clear(); }}>
          {/* breadcrumb / drill-up */}
          <nav aria-label="Selected mapping path" className="mb-2.5 flex flex-wrap items-center gap-1.5 text-[11.5px]">
            <button type="button" onClick={clear} aria-current={!hasSelection ? 'page' : undefined}
              className={clsx('rounded-md px-1.5 py-0.5 font-semibold transition focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:outline-none',
                hasSelection ? 'text-muted hover:bg-surface-2 hover:text-ink' : 'bg-brand-soft text-brand-ink')}>
              All lines
            </button>
            {DIMS.filter((d) => selection[d]).map((dim) => (
              <span key={dim} className="inline-flex items-center gap-1.5">
                <ChevronRight className="size-3 text-muted" aria-hidden />
                <button type="button" onClick={() => removeFrom(dim)} title={`Remove ${DIM_LABEL[dim].toLowerCase()} and deeper choices`}
                  className="inline-flex max-w-[260px] items-center gap-1 rounded-md bg-brand-soft px-1.5 py-0.5 font-semibold text-brand-ink transition hover:bg-brand/15 focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:outline-none">
                  <span className="text-[10px] font-normal tracking-wide text-muted uppercase">{DIM_LABEL[dim]}</span>
                  <span className="truncate">{nodeLabel(flow, dim, selection[dim])}</span>
                  <X className="size-3 shrink-0" aria-hidden />
                </button>
              </span>
            ))}
            {hasSelection ? (
              <button type="button" onClick={clear}
                className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold text-muted transition hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:outline-none">
                <RotateCcw className="size-3" aria-hidden /> Reset
              </button>
            ) : (
              <span className="ml-auto hidden text-[10.5px] text-muted sm:inline">Tab to a node · Enter to select · Esc to reset</span>
            )}
          </nav>

          {/* the four-column tree */}
          <div ref={treeRef} className="relative grid gap-x-3 gap-y-6 md:grid-cols-2 xl:grid-cols-[1.1fr_0.82fr_1.06fr_1fr] xl:gap-x-14 xl:pb-40 2xl:gap-x-24 2xl:pb-44">
            <div aria-hidden className="pointer-events-none absolute inset-0 z-0 hidden overflow-hidden xl:block">
              <div className="atlas-tree-canopy atlas-tree-canopy-a -top-24 left-[0%] h-64 w-[34%]" />
              <div className="atlas-tree-canopy atlas-tree-canopy-b -top-16 left-[30%] h-52 w-[28%]" />
              <div className="atlas-tree-canopy atlas-tree-canopy-c -top-28 right-[-5%] h-72 w-[40%]" />
              <div className="atlas-tree-canopy atlas-tree-canopy-b bottom-[10%] left-[39%] h-40 w-[22%] opacity-50" />
            </div>

            <Column step={1} title="Sector" meta={`${fmtNum(flow.total_codes)} lines`}>
              {flow.sectors.map((node) => {
                const total = nodeTotal(triples, selection, 'sector_id', node.id);
                const up = upstreamTotal(triples, selection, 'sector_id');
                const selected = selection.sector_id === node.id;
                return (
                  <TreeRow key={node.id} dim="sector_id" nodeId={node.id} label={node.name} fullName={node.name} color={node.color ?? 'var(--color-brand)'}
                    measure={measure} codes={total.codes} exports={total.exports}
                    share={measure === 'codes' ? total.codes / (up.codes || 1) : total.exports / (up.exports || 1)}
                    selected={selected} disabled={!selected && total.codes === 0} onClick={() => toggle('sector_id', node.id)} />
                );
              })}
            </Column>

            {/* 2 · register: the trunk of the tree */}
            <section data-flow-register aria-label="2. HSN register" aria-live="polite"
              className="atlas-tree-register relative z-20 flex min-w-0 flex-col justify-center rounded-2xl border p-3.5 xl:min-h-[340px] xl:self-center">
              <h3 className="text-[10.5px] font-bold tracking-[0.14em] text-muted uppercase">
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-grid size-[17px] place-items-center rounded-full bg-brand-soft text-[9px] font-bold text-brand-ink ring-1 ring-brand/25" aria-hidden>2</span>
                  HSN register
                </span>
              </h3>
              <div className="mt-3">
                <div className="text-[10.5px] font-semibold tracking-wide text-muted uppercase">
                  {hasSelection ? 'Selected lines' : 'All mapped lines'}
                </div>
                <div className="mt-0.5 text-[28px] leading-none font-extrabold tracking-tight text-[#6b441f] tabular-nums dark:text-[#f1dcc0]">
                  {measure === 'codes' ? fmtNum(summary.codes) : fmtUSD(summary.exports)}
                </div>
                <div className="mt-1 text-[11.5px] text-muted">
                  {measure === 'codes'
                    ? `${fmtUSD(summary.exports)} exports (${flow.latest_year})`
                    : `${fmtNum(summary.codes)} current HSN lines`}
                </div>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.min(100, share * 100)}%`, backgroundColor: 'var(--atlas-bark)' }} />
              </div>
              <div className="mt-1 text-[11px] text-muted">
                {fmtPct(share, { digits: 1 })} of {fmtNum(flow.total_codes)} lines
              </div>
              <div className="mt-3 space-y-1 text-[11px]">
                {DIMS.filter((d) => selection[d]).map((dim) => (
                  <div key={dim} className="flex items-baseline justify-between gap-2">
                    <span className="shrink-0 text-[10px] tracking-wide text-muted uppercase">{DIM_LABEL[dim]}</span>
                    <span className="truncate text-right font-semibold text-ink-2">{nodeLabel(flow, dim, selection[dim])}</span>
                  </div>
                ))}
                {!hasSelection ? <p className="text-muted">Pick a branch to narrow the register.</p> : null}
              </div>
              {hasSelection ? (
                <button type="button" onClick={clear}
                  className="mt-3 inline-flex items-center gap-1 self-start rounded-md text-[11.5px] font-semibold text-brand-ink hover:underline focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:outline-none">
                  <RotateCcw className="size-3" aria-hidden /> Reset to all lines
                </button>
              ) : null}
            </section>

            <Column step={3} title="Owning ministry"
              meta={selection.sector_id ? `in ${nodeLabel(flow, 'sector_id', selection.sector_id)}` : 'all sectors'}>
              {flow.ministries.map((node) => {
                const total = nodeTotal(triples, selection, 'ministry_id', node.id);
                const up = upstreamTotal(triples, selection, 'ministry_id');
                const selected = selection.ministry_id === node.id;
                const label = node.short_name ?? node.name;
                return (
                  <TreeRow key={node.id} dim="ministry_id" nodeId={node.id} label={label} fullName={node.name} color={node.id === 'residual' ? 'var(--color-bad)' : node.color ?? 'var(--color-brand)'}
                    measure={measure} codes={total.codes} exports={total.exports}
                    share={measure === 'codes' ? total.codes / (up.codes || 1) : total.exports / (up.exports || 1)}
                    selected={selected} disabled={!selected && total.codes === 0} onClick={() => toggle('ministry_id', node.id)} />
                );
              })}
            </Column>

            <Column step={4} title="Mapping status"
              meta={selection.ministry_id ? `for ${nodeLabel(flow, 'ministry_id', selection.ministry_id)}` : selection.sector_id ? `in ${nodeLabel(flow, 'sector_id', selection.sector_id)}` : 'all lines'}>
              {flow.statuses.map((node) => {
                const total = nodeTotal(triples, selection, 'status', node.id);
                const up = upstreamTotal(triples, selection, 'status');
                const selected = selection.status === node.id;
                return (
                  <TreeRow key={node.id} dim="status" nodeId={node.id} label={node.name} fullName={node.name} color={STATUS_COLOR[node.id] ?? 'var(--color-info)'}
                    measure={measure} codes={total.codes} exports={total.exports}
                    share={measure === 'codes' ? total.codes / (up.codes || 1) : total.exports / (up.exports || 1)}
                    selected={selected} disabled={!selected && total.codes === 0} onClick={() => toggle('status', node.id)} />
                );
              })}
              <div className="mt-2 rounded-lg border border-dashed border-line px-2.5 py-2 text-[10.5px] leading-relaxed text-muted">
                <span className="font-semibold text-ink-2">Reading the status:</span> DPIIT Guidebook is listed and verified.
                Provisional rule is inferred by the mapping rules. Residual has no owner in the register.
              </div>
            </Column>

            <TreeOverlay geometry={geometry} branches={branches} knots={knots} trunk={trunk} />

            {/* the root card sits on the ground, below the trunk */}
            <div
              data-flow-root
              className={clsx(
                'absolute bottom-16 z-20 hidden -translate-x-1/2 xl:block',
                !geometry && 'opacity-0',
              )}
              style={{ left: geometry ? geometry.register.left + (geometry.register.right - geometry.register.left) / 2 : 0 }}
            >
              <div className="atlas-tree-root w-[280px] rounded-2xl border px-4 py-3 text-center 2xl:w-[300px]">
                <div className="text-[9.5px] font-bold tracking-[0.16em] text-muted uppercase">All guidebook lines</div>
                <div className="mt-0.5 text-[25px] leading-none font-extrabold tracking-tight text-[#6b441f] tabular-nums dark:text-[#f1dcc0]">{fmtNum(flow.total_codes)}</div>
                <div className="mt-1 text-[10.5px] text-muted">{fmtUSD(flow.total_exports)} exports ({flow.latest_year}) · 100% of register</div>
              </div>
            </div>

            {/* branch tags ride on the selected paths, like the yes/no markers on a decision tree */}
            <div aria-hidden className="pointer-events-none absolute inset-0 z-30 hidden xl:block">
              {branches.filter((branch) => branch.tag).map((branch) => (
                <span key={`tag:${branch.key}`} className="atlas-tree-tag" style={{ left: branch.mid.x, top: branch.mid.y }}>
                  {branch.tag}
                </span>
              ))}
            </div>
          </div>

          <p className="mt-2 text-center text-[11px] text-muted xl:hidden">Pick nodes in any order; each column counts the lines left by the choices to its left.</p>

          {/* exact intersection */}
          <section aria-label="Selected combination detail" className="mt-3 overflow-hidden rounded-xl border border-line bg-surface-2/30">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-3 py-3">
              <div className="min-w-0" aria-live="polite">
                <div className="flex items-baseline gap-2">
                  <span className="text-[24px] leading-none font-extrabold tracking-tight text-ink tabular-nums">{fmtNum(summary.codes)}</span>
                  <span className="text-[12px] text-muted">
                    lines · {fmtPct(share, { digits: 1 })} of the register · {fmtUSD(summary.exports)} exports ({flow.latest_year})
                    {detail ? ` · ${fmtUSD(detail.imports)} imports` : null}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {hasSelection ? DIMS.filter((d) => selection[d]).map((dim) => (
                    <Badge key={dim} tone={dim === 'status' ? STATUS_TONE[selection.status ?? ''] ?? 'neutral' : 'brand'}
                      dot={nodeColor(flow, dim, selection[dim])}>
                      <span className="mr-1 font-normal text-muted">{DIM_LABEL[dim]}:</span>
                      {nodeLabel(flow, dim, selection[dim])}
                    </Badge>
                  )) : <Badge tone="neutral">All sectors · all ministries · all statuses</Badge>}
                </div>
              </div>
              <div className="flex max-w-[260px] shrink-0 items-center gap-2">
                {detailQuery.isFetching ? <LoaderCircle className="size-3.5 animate-spin text-brand" aria-label="Updating detail" /> : null}
                {expressible ? (
                  <Button to={exploreHref(selection)} size="xs" variant="secondary" icon={Search}>Explore these lines</Button>
                ) : (
                  <span className="text-[10.5px] leading-snug text-muted">“Other” folds many groups; use a row below for its exact lines.</span>
                )}
              </div>
            </div>

            {detailQuery.isPending ? (
              <LoadingBlock height={190} label="Resolving the selected lines…" />
            ) : detailQuery.isError ? (
              <div className="p-3"><ErrorState error={detailQuery.error} onRetry={() => void detailQuery.refetch()} compact /></div>
            ) : detail ? (
              <>
                <div className="grid gap-3 p-3 md:grid-cols-3">
                  <BreakdownGroup title="sector" dim="sector_id" rows={detail.breakdown.sectors} detail={detail}
                    selection={selection} flow={flow} onSelect={toggle} />
                  <BreakdownGroup title="ministry" dim="ministry_id" rows={detail.breakdown.ministries} detail={detail}
                    selection={selection} flow={flow} onSelect={toggle} />
                  <BreakdownGroup title="status" dim="status" rows={detail.breakdown.statuses} detail={detail}
                    selection={selection} flow={flow} onSelect={toggle} />
                </div>
                <div className="border-t border-line p-3">
                  <div className="mb-1.5 flex items-baseline justify-between gap-2">
                    <h4 className="text-[10px] font-bold tracking-[0.12em] text-muted uppercase">Largest 8-digit lines by allocated exports</h4>
                    <span className="text-[10.5px] text-muted">{detail.top_lines.length} of {fmtNum(detail.total_codes)}</span>
                  </div>
                  {detail.top_lines.length ? (
                    <div data-no-swipe className="-mx-1 overflow-x-auto px-1">
                      <table className="w-full min-w-[520px] text-[11.5px]">
                        <thead>
                          <tr className="text-left text-[10px] font-semibold tracking-wide text-muted uppercase">
                            <th className="pb-1 pr-3 font-semibold">HSN line</th>
                            <th className="pb-1 pr-3 font-semibold">Description</th>
                            <th className="hidden pb-1 pr-3 font-semibold md:table-cell">Sector</th>
                            <th className="hidden pb-1 pr-3 font-semibold lg:table-cell">Ministry</th>
                            <th className="pb-1 text-right font-semibold" title="Each HS6 export total split equally across its 8-digit lines">Exports *</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.top_lines.map((line) => (
                            <tr key={line.hsn8} className="border-t border-line/70">
                              <td className="py-1.5 pr-3">
                                <Link to={routes.product(line.hsn8)} className="font-mono font-semibold text-brand-ink hover:underline">{line.hsn8}</Link>
                              </td>
                              <td className="max-w-[320px] truncate py-1.5 pr-3 text-ink-2" title={line.description}>{line.description}</td>
                              <td className="hidden py-1.5 pr-3 text-muted md:table-cell">{line.sector_name}</td>
                              <td className="hidden py-1.5 pr-3 text-muted lg:table-cell" title={line.ministry_name}>{line.ministry_short}</td>
                              <td className="py-1.5 text-right font-semibold text-ink tabular-nums">{fmtUSD(line.exports)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-[11.5px] text-muted">No 8-digit lines match this combination.</p>
                  )}
                  <p className="mt-1.5 text-[10.5px] text-muted">* Each HS6 export total is split equally across its 8-digit lines, the Atlas allocation convention.</p>
                </div>
              </>
            ) : null}
          </section>
        </div>
      )}
    </Card>
  );
}
