/**
 * Data hooks for the Value-chain Network page (SPEC section 6.5, public endpoints).
 *
 * `useNetworkView` turns the page filters into `/api/network` calls:
 * - centre set     -> one call with center + depth (+ chain_id when exactly one chain is chosen);
 *                     with several chains the result is narrowed client-side to those chains;
 * - no centre      -> one call per chosen chain (merged, de-duplicated), or a single call for all
 *                     curated chains when none is chosen.
 * `include_parts` adds the HS-text-derived "parts of" links. While a new selection loads, the last
 * graph stays on screen (dimmed by the page) instead of flashing a skeleton.
 *
 * The API links a heading to the longer codes under it with synthetic `hs_hierarchy` edges (so that,
 * e.g., 4011 in the natural-rubber chain and 40111010 in the tyre chain read as connected). It adds
 * them per response, so when several per-chain responses are merged the cross-chain family links are
 * recomputed here with the same rule (nearest displayed ancestor of at least 4 digits).
 *
 * `useTrace` calls `/api/network/trace/{code}` for upstream / downstream path highlighting.
 */
import { useMemo, useRef } from 'react';
import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { NetworkEdge, NetworkNode, NetworkParams, NetworkResponse, TraceDirection } from '@/api/types';
import { HIERARCHY_RELATION } from './graphStyle';

export interface NetworkFilters {
  chains: string[];
  center: string;
  depth: number;
  includeParts: boolean;
}

/** Merge several network responses: nodes by id (chain ids unioned), edges by id. */
export function mergeNetworks(parts: ReadonlyArray<NetworkResponse>): NetworkResponse {
  const nodes = new Map<string, NetworkNode>();
  const edges = new Map<string, NetworkEdge>();
  const chains = new Set<string>();
  for (const p of parts) {
    for (const n of p.nodes) {
      const prev = nodes.get(n.id);
      nodes.set(
        n.id,
        prev
          ? { ...prev, chain_ids: [...new Set([...(prev.chain_ids ?? []), ...(n.chain_ids ?? [])])], is_center: prev.is_center || n.is_center }
          : n,
      );
    }
    for (const e of p.edges) if (!edges.has(e.id)) edges.set(e.id, e);
    for (const c of p.stats?.chains ?? []) chains.add(c);
  }
  const nodeList = [...nodes.values()];
  const edgeList = parts.length > 1 ? withHierarchyEdges(nodeList, [...edges.values()]) : [...edges.values()];
  return { nodes: nodeList, edges: edgeList, stats: { n_nodes: nodeList.length, n_edges: edgeList.length, chains: [...chains] } };
}

/**
 * Add the API's "same HS family" links (relation `hs_hierarchy`) that are missing between displayed
 * nodes: every code is tied to its nearest displayed ancestor of at least 4 digits, unless the two
 * are already linked in either direction.
 */
export function withHierarchyEdges(nodes: ReadonlyArray<NetworkNode>, edges: NetworkEdge[]): NetworkEdge[] {
  const linked = new Set<string>();
  for (const e of edges) {
    linked.add(`${e.source}|${e.target}`);
    linked.add(`${e.target}|${e.source}`);
  }
  const byCode = new Map(nodes.map((n) => [n.code, n.id]));
  const codes = [...byCode.keys()].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const extra: NetworkEdge[] = [];
  for (const c of codes) {
    let parent: string | null = null;
    for (const p of codes) {
      if (p.length >= 4 && p.length < c.length && c.startsWith(p) && (!parent || p.length > parent.length)) parent = p;
    }
    if (!parent) continue;
    const src = byCode.get(parent) as string;
    const dst = byCode.get(c) as string;
    if (linked.has(`${src}|${dst}`)) continue;
    linked.add(`${src}|${dst}`);
    linked.add(`${dst}|${src}`);
    extra.push({ id: `${src}->${dst}:${HIERARCHY_RELATION}`, source: src, target: dst, relation: HIERARCHY_RELATION, chain_id: null, source_kind: 'hs_nomenclature' });
  }
  return extra.length ? [...edges, ...extra] : edges;
}

/**
 * Keep only the edges of the chosen chains and their endpoints (plus the centre), then the chain-less
 * links that belong with them: "parts of" links touching a kept node (with their other end) and
 * "same HS family" links between kept nodes.
 */
function narrowToChains(net: NetworkResponse, chains: readonly string[]): NetworkResponse {
  const keep = new Set(chains);
  const chainEdges = net.edges.filter((e) => e.chain_id !== null && keep.has(e.chain_id));
  const ids = new Set<string>(net.nodes.filter((n) => n.is_center || (n.chain_ids ?? []).some((c) => keep.has(c))).map((n) => n.id));
  chainEdges.forEach((e) => {
    ids.add(e.source);
    ids.add(e.target);
  });
  const partEdges = net.edges.filter((e) => !e.chain_id && e.relation === 'parts_of' && (ids.has(e.source) || ids.has(e.target)));
  partEdges.forEach((e) => {
    ids.add(e.source);
    ids.add(e.target);
  });
  const familyEdges = net.edges.filter((e) => !e.chain_id && e.relation === HIERARCHY_RELATION && ids.has(e.source) && ids.has(e.target));
  const nodes = net.nodes.filter((n) => ids.has(n.id));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const finalEdges = [...chainEdges, ...partEdges, ...familyEdges].filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  return { nodes, edges: finalEdges, stats: { n_nodes: nodes.length, n_edges: finalEdges.length, chains: [...keep] } };
}

export interface NetworkView {
  data: NetworkResponse | null;
  isPending: boolean;
  isFetching: boolean;
  error: unknown;
  refetch: () => void;
}

export function useNetworkView(f: NetworkFilters): NetworkView {
  const requests = useMemo<NetworkParams[]>(() => {
    const parts = f.includeParts ? { include_parts: true } : {};
    if (f.center) {
      return [{ center: f.center, depth: f.depth, ...(f.chains.length === 1 ? { chain_id: f.chains[0] } : {}), ...parts }];
    }
    if (!f.chains.length) return [{ ...parts }];
    return f.chains.map((c) => ({ chain_id: c, ...parts }));
  }, [f.center, f.depth, f.chains, f.includeParts]);

  const results = useQueries({
    queries: requests.map((p) => ({
      queryKey: ['network', 'graph', p],
      queryFn: ({ signal }: { signal: AbortSignal }) => api.network(p, { signal }),
      placeholderData: keepPreviousData,
    })),
  });

  // Memoise the merge on the identities of the response objects (and the narrowing inputs), not on
  // fetch status: a background refetch that returns structurally shared data must not hand the graph
  // new arrays, because that would re-run the dagre layout.
  const datas = results.map((r) => r.data);
  const memo = useRef<{ key: unknown[]; value: NetworkResponse | null }>({ key: [], value: null });
  const key: unknown[] = [...datas, f.center, f.chains];
  if (key.length !== memo.current.key.length || key.some((k, i) => k !== memo.current.key[i])) {
    const allData = datas.every((d) => d !== undefined);
    let value: NetworkResponse | null = null;
    if (allData) {
      const net = datas.length === 1 ? (datas[0] as NetworkResponse) : mergeNetworks(datas as NetworkResponse[]);
      value = f.center && f.chains.length > 1 ? narrowToChains(net, f.chains) : net;
    }
    memo.current = { key, value };
  }
  const merged = memo.current.value;

  const last = useRef<NetworkResponse | null>(null);
  if (merged) last.current = merged;
  const error = results.find((r) => r.error)?.error ?? null;

  return {
    data: merged ?? last.current,
    isPending: !merged && !last.current && !error,
    isFetching: results.some((r) => r.isFetching),
    error,
    refetch: () => results.forEach((r) => void r.refetch()),
  };
}

export interface TraceRequest {
  code: string;
  direction: TraceDirection;
  depth: number;
}

/** GET /api/network/trace/{code}?direction=&depth= */
export function useTrace(req: TraceRequest | null) {
  return useQuery({
    queryKey: ['network', 'trace', req?.code, req?.direction, req?.depth],
    queryFn: ({ signal }) => api.trace((req as TraceRequest).code, { direction: (req as TraceRequest).direction, depth: (req as TraceRequest).depth }, { signal }),
    enabled: Boolean(req),
  });
}
