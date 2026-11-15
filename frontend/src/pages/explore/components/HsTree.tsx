/**
 * HsTree - lazily expanding HS nomenclature tree for the Explorer:
 *   21 sections -> chapters -> headings -> subheadings -> 8-digit national lines
 * (GET /api/hsn/tree?code=, one request per expanded node, cached).
 *
 * Each row shows the code, its description, the number of national lines and India's exports. Chapter,
 * heading and subheading rows show the leading Guidebook owner and line coverage aggregated from the
 * accepted 8-digit lines under them; national lines show their direct owner. Selecting any node -
 * section, chapter, heading, subheading or line - filters the search table (the page decides how) and expands it; clicking the selected node
 * again collapses it, and the chevron only expands / collapses. The path to the selected code (from the
 * URL, e.g. /explore?q=4011) is expanded automatically. Implements the WAI-ARIA tree pattern (role
 * tree / treeitem / group).
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import clsx from 'clsx';
import { ArrowUpRight, ChevronRight, RefreshCw } from 'lucide-react';
import { useSections } from '@/api/hooks';
import type { TreeNode } from '@/api/types';
import { Skeleton } from '@/components';
import { fmtCode, fmtNum, fmtPct, fmtUSD } from '@/lib/format';
import { routes } from '@/lib/routes';
import { useHsTree } from '../api';

interface TreeCtx {
  expanded: Set<string>;
  toggle: (code: string) => void;
  selected: string;
  onSelect: (node: TreeNode) => void;
}

const Ctx = createContext<TreeCtx | null>(null);

function useTree(): TreeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('HsTree context missing');
  return v;
}

const LEVEL_PAD: Record<number, number> = { 0: 0, 2: 1, 4: 2, 6: 3, 8: 4 };

/** Tree rows for 8-digit lines also carry the owner and mapping status (beyond SPEC 6.3). */
type TreeRowNode = TreeNode & { ministry_short?: string | null; mapping_status?: string | null };

function nodeTitle(n: TreeNode): string {
  return n.level === 0 ? `Section ${n.code}` : fmtCode(n.code);
}

/**
 * Scrolls the nearest scrollable ancestor (the tree panel) so that `el` is visible, without moving the
 * page itself (Element.scrollIntoView would also scroll the window).
 */
function revealInPanel(el: HTMLElement) {
  let box: HTMLElement | null = el.parentElement;
  while (box && box !== document.body) {
    const oy = getComputedStyle(box).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && box.scrollHeight > box.clientHeight) break;
    box = box.parentElement;
  }
  if (!box || box === document.body) return;
  const r = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  if (r.top < b.top + 8 || r.bottom > b.bottom - 8) box.scrollTop += r.top - b.top - b.height / 3;
}

function TreeRow({ node, depth }: { node: TreeRowNode; depth: number }) {
  const { expanded, toggle, selected, onSelect } = useTree();
  const open = expanded.has(node.code);
  const isSelected = selected === node.code;
  const isSection = node.level === 0;
  const pad = 6 + (LEVEL_PAD[node.level] ?? depth) * 14;
  const summary = node.level === 8 ? null : node.ownership;
  const owner = node.level === 8 ? node.ministry_short : summary?.owners?.[0]?.short_name ?? null;
  const residual = node.level === 8 ? node.mapping_status === 'residual' : (summary?.mapped_lines ?? 0) === 0;
  const rowRef = useRef<HTMLDivElement>(null);

  // Bring the selected node into view in the panel (deep links such as /explore?code=6109).
  useEffect(() => {
    if (isSelected && rowRef.current) revealInPanel(rowRef.current);
  }, [isSelected]);

  return (
    <li role="treeitem" aria-expanded={node.has_children ? open : undefined} aria-selected={isSelected} aria-level={depth + 1} className="min-w-0">
      <div
        ref={rowRef}
        className={clsx(
          'group flex min-w-0 items-start gap-1 rounded-md pr-1.5',
          isSelected ? 'bg-brand-soft ring-1 ring-brand/30' : 'hover:bg-surface-3',
        )}
        style={{ paddingLeft: pad }}
      >
        {node.has_children ? (
          <button
            type="button"
            onClick={() => toggle(node.code)}
            className="mt-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted hover:bg-surface hover:text-ink"
            aria-label={`${open ? 'Collapse' : 'Expand'} ${nodeTitle(node)}`}
          >
            <ChevronRight className={clsx('size-3.5 transition-transform', open && 'rotate-90')} aria-hidden />
          </button>
        ) : (
          <span className="mt-1 inline-block size-5 shrink-0" aria-hidden />
        )}
        <button
          type="button"
          onClick={() => (isSelected && node.has_children ? toggle(node.code) : onSelect(node))}
          title={node.description}
          aria-current={isSelected ? 'true' : undefined}
          className="min-w-0 flex-1 py-1 text-left"
        >
          <span className="flex items-baseline gap-2">
            <span className={clsx('shrink-0 text-[12px] font-semibold atlas-num', isSection ? 'text-ink' : 'font-mono text-brand-ink')}>{nodeTitle(node)}</span>
            <span className="ml-auto shrink-0 text-[10.5px] text-muted atlas-num">
              {fmtNum(node.n_products)} {node.n_products === 1 ? 'line' : 'lines'}
            </span>
          </span>
          <span className={clsx('line-clamp-2 text-[12px] leading-snug', isSelected ? 'text-ink' : 'text-ink-2')}>{node.description}</span>
          {(typeof node.exports === 'number' && node.exports > 0) || owner ? (
            <span className="flex flex-wrap gap-x-2 text-[10.5px] text-muted">
              {typeof node.exports === 'number' && node.exports > 0 ? (
                <span title={node.trade_level === 'hs4_aggregate' ? `Heading aggregate ${node.metric_hs6 ?? ''}` : undefined}>
                  Exports {fmtUSD(node.exports)}
                  {node.trade_level === 'hs4_aggregate' ? ' (heading)' : ''}
                </span>
              ) : null}
              {owner ? (
                <span title={summary ? summary.owners.map((o) => `${o.short_name} (${o.n_lines})`).join(', ') : undefined}>
                  {owner}
                  {residual ? ' · residual' : summary ? ` · ${fmtPct(summary.coverage, { digits: 0 })} mapped` : ''}
                  {summary && summary.n_owners > 1 ? ` · +${summary.n_owners - 1}` : ''}
                </span>
              ) : summary ? (
                <span>No accepted owner</span>
              ) : null}
            </span>
          ) : null}
        </button>
        {node.level === 8 ? (
          <Link
            to={routes.product(node.code)}
            className="mt-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted opacity-0 group-hover:opacity-100 hover:text-brand-ink focus:opacity-100"
            aria-label={`Open product page for ${fmtCode(node.code)}`}
            title="Open product page"
          >
            <ArrowUpRight className="size-3.5" aria-hidden />
          </Link>
        ) : null}
      </div>
      {open && node.has_children ? <TreeBranch code={node.code} depth={depth + 1} /> : null}
    </li>
  );
}

function TreeBranch({ code, depth }: { code: string | null; depth: number }) {
  const q = useHsTree(code);
  if (q.isPending) {
    return (
      <div className="space-y-1.5 py-1.5" style={{ paddingLeft: 26 + depth * 14 }} aria-busy>
        {Array.from({ length: code ? 3 : 8 }, (_, i) => (
          <Skeleton key={i} className="h-7 w-[90%]" />
        ))}
      </div>
    );
  }
  if (q.isError && !q.data) {
    return (
      <div className="flex items-center gap-2 py-1.5 text-xs text-bad-ink" style={{ paddingLeft: 26 + depth * 14 }} role="alert">
        Could not load this level.
        <button type="button" onClick={() => void q.refetch()} className="inline-flex items-center gap-1 text-brand-ink hover:underline">
          <RefreshCw className="size-3" aria-hidden /> Retry
        </button>
      </div>
    );
  }
  const nodes = q.data ?? [];
  if (!nodes.length) {
    return (
      <div className="py-1.5 text-xs text-muted" style={{ paddingLeft: 26 + depth * 14 }}>
        No entries at this level.
      </div>
    );
  }
  return (
    <ul role={depth === 0 ? 'tree' : 'group'} aria-label={depth === 0 ? 'HS nomenclature tree' : undefined} className="space-y-px">
      {nodes.map((n) => (
        <TreeRow key={n.code} node={n} depth={depth} />
      ))}
    </ul>
  );
}

export interface HsTreeProps {
  /** Selected node code (section roman numeral or 2-8 digits); its ancestors are expanded. */
  selected: string;
  onSelect: (node: TreeNode) => void;
  className?: string;
}

/** Codes to expand so that `code` is visible (and opened, when it has children). */
function pathFor(code: string, sectionOfChapter: Map<string, string>): string[] {
  if (!code) return [];
  if (!/^\d+$/.test(code)) return [code]; // a section id
  const out: string[] = [];
  const chapter = code.slice(0, 2);
  const section = sectionOfChapter.get(chapter);
  if (section) out.push(section);
  out.push(chapter);
  if (code.length >= 4) out.push(code.slice(0, 4));
  if (code.length >= 6) out.push(code.slice(0, 6));
  return out;
}

export function HsTree({ selected, onSelect, className }: HsTreeProps) {
  const sections = useSections();
  const sectionOfChapter = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sections.data ?? []) for (const c of s.chapters) m.set(c.code, s.id);
    return m;
  }, [sections.data]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // Reveal the selected code whenever it (or the chapter -> section map) changes.
  useEffect(() => {
    const path = pathFor(selected, sectionOfChapter);
    if (!path.length) return;
    setExpanded((prev) => {
      if (path.every((p) => prev.has(p))) return prev;
      const next = new Set(prev);
      path.forEach((p) => next.add(p));
      return next;
    });
  }, [selected, sectionOfChapter]);

  const ctx = useMemo<TreeCtx>(
    () => ({
      expanded,
      selected,
      onSelect,
      toggle: (code: string) =>
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(code)) next.delete(code);
          else next.add(code);
          return next;
        }),
    }),
    [expanded, selected, onSelect],
  );

  return (
    <Ctx.Provider value={ctx}>
      <div className={className}>
        <TreeBranch code={null} depth={0} />
      </div>
      {expanded.size ? (
        <button type="button" onClick={() => setExpanded(new Set())} className="mt-2 px-1.5 text-xs text-brand-ink hover:underline">
          Collapse all
        </button>
      ) : null}
    </Ctx.Provider>
  );
}
