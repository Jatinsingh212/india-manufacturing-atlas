/**
 * NetworkGraphCore - the real cytoscape + dagre renderer (lazy-loaded by components/NetworkGraph.tsx).
 * Do not import this file directly.
 */
import { useEffect, useMemo, useRef } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';
import cytoscape, { type Core, type ElementDefinition, type LayoutOptions, type StylesheetJson } from 'cytoscape';
import dagre from 'cytoscape-dagre';
import { CHART_TOKENS, INDIA_COLOR, ministryColor } from '@/lib/theme';
import { useTheme } from '@/theme/ThemeContext';
import type { NetworkGraphProps } from '../NetworkGraph';

let dagreRegistered = false;
function ensureDagre(): void {
  if (dagreRegistered) return;
  cytoscape.use(dagre);
  dagreRegistered = true;
}

function layoutFor(layout: NetworkGraphProps['layout']): LayoutOptions {
  if (layout && typeof layout === 'object') return layout;
  switch (layout) {
    case 'dagre-tb':
      return { name: 'dagre', rankDir: 'TB', nodeSep: 28, rankSep: 70, edgeSep: 10, padding: 48, animate: false } as LayoutOptions;
    case 'concentric':
      return { name: 'concentric', padding: 48, minNodeSpacing: 24, animate: false } as LayoutOptions;
    case 'cose':
      return { name: 'cose', padding: 48, animate: false } as LayoutOptions;
    case 'dagre-lr':
    default:
      return { name: 'dagre', rankDir: 'LR', nodeSep: 22, rankSep: 110, edgeSep: 10, padding: 48, animate: false } as LayoutOptions;
  }
}

export default function NetworkGraphCore({
  nodes,
  edges,
  height = 520,
  layout = 'dagre-lr',
  sizeBy = 'world_trade',
  selectedId,
  highlightIds,
  dimOthers = true,
  wheelZoom = false,
  showControls = true,
  onNodeClick,
  onEdgeClick,
  onBackgroundClick,
  onReady,
  className,
}: NetworkGraphProps) {
  const { mode } = useTheme();
  const elRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const handlers = useRef({ onNodeClick, onEdgeClick, onBackgroundClick });
  handlers.current = { onNodeClick, onEdgeClick, onBackgroundClick };
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const dataRef = useRef({ nodes, edges });
  dataRef.current = { nodes, edges };
  const layoutKey = typeof layout === 'object' ? JSON.stringify(layout) : layout;

  const elements = useMemo<ElementDefinition[]>(() => {
    const vals = nodes.map((n) => (sizeBy ? (n[sizeBy] ?? 0) : 0)).filter((v) => v > 0);
    const maxLog = vals.length ? Math.log10(Math.max(...vals) + 1) : 1;
    const ids = new Set(nodes.map((n) => n.id));
    return [
      ...nodes.map((n) => {
        const v = sizeBy ? (n[sizeBy] ?? 0) : 0;
        const size = sizeBy ? 22 + (v > 0 ? (Math.log10(v + 1) / (maxLog || 1)) * 30 : 0) : 30;
        const short = n.label.length > 34 ? `${n.label.slice(0, 33)}…` : n.label;
        return {
          group: 'nodes' as const,
          data: {
            id: n.id,
            label: `${n.code}\n${short}`,
            color: ministryColor(n.ministry_id, n.color),
            size: n.is_center ? Math.max(size, 44) : size,
            center: n.is_center ? 1 : 0,
          },
        };
      }),
      ...edges
        .filter((e) => ids.has(e.source) && ids.has(e.target))
        .map((e) => ({
          group: 'edges' as const,
          data: { id: e.id, source: e.source, target: e.target, relation: e.relation },
        })),
    ];
  }, [nodes, edges, sizeBy]);

  const style = useMemo<StylesheetJson>(() => {
    const t = CHART_TOKENS[mode];
    return [
      {
        selector: 'node',
        style: {
          'background-color': 'data(color)',
          width: 'data(size)',
          height: 'data(size)',
          label: 'data(label)',
          'font-size': 10,
          'font-family': 'Inter, ui-sans-serif, system-ui, Segoe UI, sans-serif',
          color: t.ink,
          'text-wrap': 'wrap',
          'text-max-width': '150px',
          'text-valign': 'bottom',
          'text-margin-y': 5,
          'text-background-color': t.surface,
          'text-background-opacity': 0.85,
          'text-background-padding': '2px',
          'border-width': 2,
          'border-color': t.surface,
        },
      },
      { selector: 'node[center = 1]', style: { 'border-width': 4, 'border-color': INDIA_COLOR[mode], 'font-weight': 'bold' } },
      {
        selector: 'edge',
        style: {
          width: 1.5,
          'line-color': t.axis,
          'target-arrow-color': t.axis,
          'target-arrow-shape': 'triangle',
          'arrow-scale': 0.9,
          'curve-style': 'bezier',
          opacity: 0.9,
        },
      },
      { selector: 'edge[relation = "component_of"]', style: { width: 2 } },
      { selector: 'edge[relation = "parts_of"]', style: { 'line-style': 'dashed', 'line-dash-pattern': [5, 4] } },
      { selector: '.atlas-dim', style: { opacity: 0.18 } },
      { selector: 'node.atlas-hl', style: { 'border-width': 4, 'border-color': '#d03b3b' } },
      { selector: 'edge.atlas-hl', style: { 'line-color': '#d03b3b', 'target-arrow-color': '#d03b3b', width: 2.5 } },
      { selector: 'node.atlas-selected', style: { 'border-width': 4, 'border-color': mode === 'dark' ? '#93b2ff' : '#0033a0' } },
    ];
  }, [mode]);

  // Create / rebuild the graph when the data, theme or layout changes.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    ensureDagre();
    const cy = cytoscape({
      container: el,
      elements,
      style,
      layout: layoutFor(layout),
      minZoom: 0.15,
      maxZoom: 3,
      userZoomingEnabled: wheelZoom,
      boxSelectionEnabled: false,
    });
    cyRef.current = cy;
    cy.on('tap', 'node', (evt) => {
      const id = evt.target.id();
      const node = dataRef.current.nodes.find((n) => n.id === id);
      if (node) handlers.current.onNodeClick?.(node);
    });
    cy.on('tap', 'edge', (evt) => {
      const id = evt.target.id();
      const edge = dataRef.current.edges.find((e) => e.id === id);
      if (edge) handlers.current.onEdgeClick?.(edge);
    });
    cy.on('tap', (evt) => {
      if (evt.target === cy) handlers.current.onBackgroundClick?.();
    });
    onReadyRef.current?.(cy);
    const ro = new ResizeObserver(() => cy.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      cy.destroy();
      cyRef.current = null;
    };
    // `layout` objects are compared through layoutKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elements, style, layoutKey, wheelZoom]);

  // Selection and highlight classes (no relayout).
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.elements().removeClass('atlas-dim atlas-hl atlas-selected');
      const hl = new Set(highlightIds ?? []);
      if (hl.size) {
        cy.nodes().forEach((n) => {
          if (hl.has(n.id())) n.addClass('atlas-hl');
        });
        cy.edges().forEach((e) => {
          if (hl.has(e.source().id()) && hl.has(e.target().id())) e.addClass('atlas-hl');
        });
      }
      if (selectedId) {
        const sel = cy.getElementById(selectedId);
        if (sel.nonempty()) {
          sel.addClass('atlas-selected');
          if (dimOthers) {
            const keep = sel.closedNeighborhood();
            cy.elements().difference(keep).addClass('atlas-dim');
          }
        }
      }
    });
  }, [selectedId, highlightIds, dimOthers, elements, style]);

  const zoomBy = (factor: number) => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.zoom({ level: cy.zoom() * factor, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  };
  const ctrl =
    'inline-flex size-8 items-center justify-center rounded-md border border-line bg-surface text-ink-2 shadow-sm hover:bg-surface-3 hover:text-ink';

  return (
    <div className={className} style={{ position: 'relative', height, width: '100%' }}>
      <div ref={elRef} style={{ height: '100%', width: '100%' }} role="img" aria-label="Value-chain network graph" />
      {showControls ? (
        <div className="absolute top-2 right-2 flex flex-col gap-1">
          <button type="button" className={ctrl} onClick={() => zoomBy(1.25)} aria-label="Zoom in" title="Zoom in">
            <Plus className="size-4" aria-hidden />
          </button>
          <button type="button" className={ctrl} onClick={() => zoomBy(0.8)} aria-label="Zoom out" title="Zoom out">
            <Minus className="size-4" aria-hidden />
          </button>
          <button type="button" className={ctrl} onClick={() => cyRef.current?.fit(undefined, 48)} aria-label="Fit graph" title="Fit graph">
            <Maximize className="size-4" aria-hidden />
          </button>
        </div>
      ) : null}
    </div>
  );
}
