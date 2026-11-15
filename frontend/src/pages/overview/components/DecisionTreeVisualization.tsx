import { useMemo, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '@/components';
import { fmtNum, fmtPct } from '@/lib/format';

export interface TreeNode {
  id: string;
  label: string;
  value: number;
  pct: number;
  splitQuestion?: string;
  branchLabel?: 'Yes' | 'No';
  children?: TreeNode[];
  color?: string;
}

interface LayoutNode extends TreeNode {
  x: number;
  y: number;
  depth: number;
}

const TRUNK_COLOR = '#a67c52';
const BRANCH_COLOR = '#b0895e';
const NODE_COLOR = '#c9a87e';
const TEXT_MUTED = '#6b5b47';
const LEVEL_HEIGHT = 260;
const NODE_RADIUS = 26;
const SIBLING_GAP = 120;

function leafCount(n: TreeNode): number {
  if (!n.children || n.children.length === 0) return 1;
  return n.children.reduce((sum, c) => sum + leafCount(c), 0);
}

function layoutTree(root: TreeNode, nodeWidth: number, levelHeight: number): LayoutNode[] {
  const laid: LayoutNode[] = [];
  let nextX = 0;
  function assign(node: TreeNode, depth: number) {
    const leaves = leafCount(node);
    const x = nextX;
    nextX += leaves * (nodeWidth + SIBLING_GAP);
    const y = depth * levelHeight;
    laid.push({ ...node, x, y, depth });
    if (node.children) for (const child of node.children) assign(child, depth + 1);
  }
  assign(root, 0);
  const rootX = laid[0].x + (leafCount(root) - 0.5) * (nodeWidth + SIBLING_GAP);
  const shift = rootX - laid[0].x;
  for (const n of laid) n.x += shift;
  return laid;
}

function branchPath(x1: number, y1: number, x2: number, y2: number, depth: number): string {
  const dy = y2 - y1;
  const cx = (x1 + x2) / 2;
  const cy = y1 + dy * 0.5;
  const bend = depth === 0 ? 0 : (x2 > x1 ? -60 : 60);
  return `M ${x1} ${y1} Q ${cx + bend} ${cy} ${x2} ${y2}`;
}

export function DecisionTreeVisualization({
  root,
  nodeWidth = 200,
  levelHeight = LEVEL_HEIGHT,
  onNodeClick,
}: { root: TreeNode; nodeWidth?: number; levelHeight?: number; onNodeClick?: (id: string) => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set([root.id]));
  const nodes = useMemo(() => layoutTree(root, nodeWidth, levelHeight), [root, nodeWidth, levelHeight]);
  const nodeMap = new Map<string, LayoutNode>();
  for (const n of nodes) nodeMap.set(n.id, n);
  const isExpanded = (id: string) => expanded.has(id);
  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  let minX = Infinity, maxX = -Infinity, maxY = 0;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - nodeWidth / 2 - 60);
    maxX = Math.max(maxX, n.x + nodeWidth / 2 + 60);
    maxY = Math.max(maxY, n.y + 140);
  }
  const width = Math.max(900, maxX - minX);
  const height = Math.max(500, maxY + 60);
  const offsetX = -minX + 40;

  return (
    <section className="relative rounded-3xl border border-line bg-surface shadow-card overflow-hidden">
      <div className="absolute inset-0 z-0 bg-[#f3efe5]" />
      <div className="absolute inset-0 z-0 opacity-30" style={{ backgroundImage: 'radial-gradient(circle at 20% 30%, #d9c3a3 0%, transparent 40%), radial-gradient(circle at 80% 70%, #e8dcc8 0%, transparent 40%)' }} />
      <div className="absolute -top-6 left-1/4 z-10 hidden md:block pointer-events-none">
        <div className="flex gap-1">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-4 w-1 bg-[#8a7352] rounded-full rotate-[-20deg]" />
          ))}
        </div>
      </div>
      <div className="absolute -top-6 left-2/5 z-10 hidden md:block pointer-events-none">
        <div className="flex gap-1">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-3 w-1 bg-[#8a7352] rounded-full rotate-[20deg]" />
          ))}
        </div>
      </div>

      <svg
        className="absolute inset-0 z-20 w-full h-full"
        width={width}
        height={height}
        style={{ transform: `translateX(${offsetX}px)` }}
      >
        {nodes.map((n) => {
          if (!n.children || n.children.length === 0) return null;
          const color = n.color ?? (n.depth === 0 ? TRUNK_COLOR : BRANCH_COLOR);
          return (
            <g key={n.id}>
              {n.children.map((child) => {
                const c = nodeMap.get(child.id);
                if (!c) return null;
                const parentY = n.y + NODE_RADIUS;
                const childY = c.y - NODE_RADIUS;
                const p1 = branchPath(n.x, parentY, c.x, childY, n.depth);
                const p2 = branchPath(n.x + NODE_RADIUS * 0.4, parentY, c.x - NODE_RADIUS * 0.4, childY, n.depth);
                return (
                  <g key={child.id}>
                    <path d={p1} fill="none" stroke={color} strokeWidth={n.depth === 0 ? 3 : 2.5} strokeLinecap="round" />
                    <path d={p2} fill="none" stroke={color} strokeWidth={n.depth === 0 ? 3 : 2.5} strokeLinecap="round" />
                    <text
                      x={(n.x + c.x) / 2}
                      y={(parentY + childY) / 2 - 10}
                      textAnchor="middle"
                      fill={TEXT_MUTED}
                      fontSize={11}
                      fontWeight={600}
                      letterSpacing={0.4}
                      className="drop-shadow-[0_1px_0_rgba(255,255,255,0.7)]"
                    >
                      {child.branchLabel ?? ''}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}

        {nodes.map((n) => {
          const color = n.color ?? NODE_COLOR;
          const isLeaf = !n.children || n.children.length === 0;
          const shown = n.depth === 0 || isExpanded(n.id);
          if (!shown) return null;
          return (
            <g
              key={n.id}
              transform={`translate(${n.x - NODE_RADIUS}, ${n.y - NODE_RADIUS})`}
              onClick={(e) => {
                e.stopPropagation();
                if (!isLeaf && n.children && n.children.length > 0) toggle(n.id);
                onNodeClick?.(n.id);
              }}
              className="cursor-pointer"
            >
              <circle
                cx={NODE_RADIUS}
                cy={NODE_RADIUS}
                r={NODE_RADIUS}
                fill={color}
                stroke="#fff"
                strokeWidth={2}
              />
              {!isLeaf && (
                <circle
                  cx={NODE_RADIUS}
                  cy={NODE_RADIUS * 2}
                  r={6}
                  fill={color}
                  stroke="#fff"
                  strokeWidth={1.5}
                />
              )}
            </g>
          );
        })}
      </svg>


      <div className="relative z-30" style={{ width, height }}>
        {nodes.map((n) => {
          const shown = n.depth === 0 || isExpanded(n.id);
          if (!shown) return null;
          const isLeaf = !n.children || n.children.length === 0;
          const left = n.x + NODE_RADIUS + 18;
          const top = n.y - 52;
          return (
            <div
              key={n.id}
              className="absolute pointer-events-auto"
              style={{ left, top }}
            >
              <div className="min-w-[210px] max-w-[260px] rounded-xl border border-[#e8dcc8]/90 bg-white/95 shadow-[0_10px_30px_rgba(60,48,34,0.12)] p-3 text-left backdrop-blur-sm">
                <div className="flex items-baseline gap-2 mb-0.5">
                  <span className="text-[16px] font-extrabold tracking-tight text-[#6b441f] tabular-nums">
                    {fmtNum(n.value)}
                  </span>
                  <span className="text-[12px] font-semibold text-muted">{fmtPct(n.pct)}</span>
                </div>
                <div className="text-[12px] font-semibold tracking-tight text-ink mb-1">{n.label}</div>
                {n.splitQuestion && (
                  <div className="text-[10.5px] leading-none text-muted italic">
                    Splits on: {n.splitQuestion}
                  </div>
                )}
                {n.children && n.children.length > 0 && !isLeaf && (
                  <div className="mt-2 flex items-center gap-1.5">
                    <Button size="sm" variant="ghost" className="px-2 py-1 text-[10px] text-muted border border-line/60 hover:bg-[#f3efe5]" onClick={(e) => { e.stopPropagation(); toggle(n.id); }}>
                      {isExpanded(n.id) ? 'Collapse' : 'Expand'}
                      <MoreHorizontal className="size-3.5 ml-1" />
                    </Button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}