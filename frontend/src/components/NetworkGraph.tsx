/**
 * NetworkGraph - cytoscape.js graph for `NetworkResponse` / `TraceResponse` data (one HSN -> many
 * inputs and outputs). Left-to-right dagre layout by default, nodes coloured by
 * ministry, sized by log trade, centre node ringed in magenta, `parts_of` edges dashed.
 *
 *   const q = useQuery({ queryKey: ['network', chain], queryFn: ({ signal }) => api.network({ chain_id: chain }, { signal }) });
 *   <NetworkGraph nodes={q.data.nodes} edges={q.data.edges} selectedId={sel}
 *                 onNodeClick={(n) => setSel(n.id)} highlightIds={criticalIds} height={560} />
 *
 * For full control use `onReady(cy)` (the cytoscape Core) or import cytoscape directly in your page;
 * the dagre extension is registered by this component. cytoscape is code-split (loads on first render).
 */
import { lazy, Suspense } from 'react';
import type { Core, LayoutOptions } from 'cytoscape';
import type { NetworkEdge, NetworkNode } from '@/api/types';
import { Skeleton } from './Loading';

export interface NetworkGraphProps {
  nodes: ReadonlyArray<NetworkNode>;
  edges: ReadonlyArray<NetworkEdge>;
  /** px or CSS length (default 520). */
  height?: number | string;
  /** Preset or a full cytoscape layout object (default 'dagre-lr'). */
  layout?: 'dagre-lr' | 'dagre-tb' | 'cose' | 'concentric' | LayoutOptions;
  /** Node size metric (log scale); null = uniform. Default 'world_trade'. */
  sizeBy?: 'exports' | 'imports' | 'world_trade' | null;
  /** Selected node id: ringed in brand blue; with `dimOthers`, non-neighbours fade. */
  selectedId?: string | null;
  /** Node ids to flag in red (e.g. critical inputs from a trace). */
  highlightIds?: ReadonlyArray<string>;
  dimOthers?: boolean;
  /** Mouse-wheel zoom (default false so page scrolling is never hijacked; +/- controls are shown). */
  wheelZoom?: boolean;
  /** Zoom in / out / fit buttons (default true). */
  showControls?: boolean;
  onNodeClick?: (node: NetworkNode) => void;
  onEdgeClick?: (edge: NetworkEdge) => void;
  onBackgroundClick?: () => void;
  onReady?: (cy: Core) => void;
  className?: string;
}

const NetworkGraphCore = lazy(() => import('./impl/NetworkGraphCore'));

export function NetworkGraph(props: NetworkGraphProps) {
  const height = props.height ?? 520;
  return (
    <Suspense
      fallback={
        <div style={{ height }} className="w-full">
          <Skeleton className="h-full w-full rounded-lg" />
        </div>
      }
    >
      <NetworkGraphCore {...props} height={height} />
    </Suspense>
  );
}
