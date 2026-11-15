"""Value-chain network graph (docs/SPEC.md section 6.5): one HSN can have multiple inputs and outputs,
forming a network of upstream-downstream manufacturing relationships. Owner: C2.

The graph is ``vc_edges`` (input -> output): curated chain edges (relation ``input_to`` / ``component_of``,
``source`` ``curated``) plus the HS-text ``parts_of`` links (``source = 'hs_text'``, no chain).
Node codes are 8-digit lines, 6-digit subheadings or 4-digit headings exactly as curated.

Decisions
---------
* **Code families.** A 4/6-digit code and the longer codes under it describe the same goods at different
  levels (``4011`` tyres in the natural-rubber chain, ``40111090`` car tyres in the tyre chain). Traversal and
  centring treat such *family* codes (one a prefix of the other, the shorter at least 4 digits) as touching,
  and the response links each displayed node to its nearest displayed ancestor with a synthetic edge
  ``relation = "hs_hierarchy"`` (``source_kind = "hs_nomenclature"``) so linked chains appear connected.
* **Default view** (no parameters) = every curated chain edge; ``include_parts=true`` adds the ``parts_of``
  edges that touch a displayed node (all of them when no chain / centre restricts the view).
* **Chain view** (``chain_id``) = that chain's edges plus the chain's anchor heading (``4011``) as a node when
  it has >= 4 digits, linked to its lines by ``hs_hierarchy`` edges, so the chain-level production figure
  (``production`` scope ``chain``) always has a node to sit on even when no curated edge names the anchor.
* **Centre / trace** = breadth-first search from the centre's family over the selected edge set, both
  directions for ``/api/network`` and ``direction`` for the trace, up to ``depth`` hops (max 6).
* **Node statistics** use the cached HS6 analytics frame (``app.services.scoring.analytics_frame``): an 8 or
  6-digit node shows its HS6 values; a 4/2-digit node sums the distinct HS6 codes under it, with the aggregate
  Balassa RCA and the import-weighted mean vulnerability score. A line whose HS6 is reported by the source only
  as a heading aggregate (petroleum oils, ``271000``) shows that aggregate (``trade_level = "hs4_aggregate"``).
* **Critical inputs** (trace) = upstream nodes with imports >= US$ 1 mn and vulnerability >= 50, dependency
  ratio >= 0.5 or China share >= 0.5, ranked by vulnerability score.
"""
from __future__ import annotations

import json
import sqlite3
from collections import defaultdict
from collections.abc import Iterable

from app.common import choose_production
from app.services.scoring import Frame, aggregate, analytics_frame, cached

MAX_DEPTH = 6
HIERARCHY_RELATION = "hs_hierarchy"
CURATED_RELATIONS = ("input_to", "component_of")
CRITICAL_MIN_IMPORTS = 1e6
CRITICAL_MIN_VULNERABILITY = 50.0
CRITICAL_MIN_SHARE = 0.5


def digits(code: str | None) -> str:
    """Digits of a typed code (``"4011.10.90"`` -> ``"40111090"``)."""
    return "".join(ch for ch in str(code or "") if ch.isdigit())


def family(a: str, b: str) -> bool:
    """True when ``a`` and ``b`` are the same code or one is a >= 4-digit prefix of the other."""
    if a == b:
        return True
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    return len(short) >= 4 and long_.startswith(short)


# --------------------------------------------------------------------------- cached graph data

class GraphData:
    """Edges + curated items, indexed for traversal (read-only, cached per data fingerprint)."""

    def __init__(self, edges: list[dict], items: list[dict], chains: dict[str, dict], production: list[dict]):
        self.edges = edges
        self.items = items
        self.chains = chains
        self.items_by_code: dict[str, list[dict]] = defaultdict(list)
        for it in items:
            if it["hs_code"]:
                self.items_by_code[it["hs_code"]].append(it)
        self.code_chains: dict[str, set] = defaultdict(set)
        for e in edges:
            if e["chain_id"]:
                self.code_chains[e["src"]].add(e["chain_id"])
                self.code_chains[e["dst"]].add(e["chain_id"])
        for it in items:
            if it["hs_code"]:
                self.code_chains[it["hs_code"]].add(it["chain_id"])
        for cid, ch in chains.items():
            anchor = digits(ch.get("anchor_hs"))
            if len(anchor) >= 4:
                self.code_chains[anchor].add(cid)  # a chain's anchor heading belongs to that chain's view
        # One row per code / chain through the shared chooser (verified first, then latest year, then newest),
        # so the network node shows the same production figure as the chain KPI and the demand-supply table.
        by_code: dict[str, list[dict]] = defaultdict(list)
        by_chain: dict[str, list[dict]] = defaultdict(list)
        for p in production:
            if p["scope"] in ("hsn8", "hs6", "hs4"):
                by_code[p["key"]].append(p)
            elif p["scope"] == "chain" and p.get("label") == "india_production":
                by_chain[p["key"]].append(p)
        self.production_by_code: dict[str, dict] = {k: v for k, v in ((k, choose_production(v))
                                                                      for k, v in by_code.items()) if v}
        self.chain_production: dict[str, dict] = {k: v for k, v in ((k, choose_production(v))
                                                                    for k, v in by_chain.items()) if v}

    def select(self, chain_id: str | None = None, include_parts: bool = False) -> list[dict]:
        """Curated edges (of one chain when ``chain_id``) plus, optionally, every ``parts_of`` edge."""
        out = [e for e in self.edges if e["relation"] != "parts_of" and (chain_id is None or e["chain_id"] == chain_id)]
        if include_parts:
            out += [e for e in self.edges if e["relation"] == "parts_of"]
        return out


def _rows(conn: sqlite3.Connection, sql: str, params=()) -> list[dict]:
    cur = conn.execute(sql, params)
    cols = [c[0] for c in cur.description]
    return [r if isinstance(r, dict) else dict(zip(cols, r)) for r in cur.fetchall()]


def _build_graph(conn: sqlite3.Connection) -> GraphData:
    edges = _rows(conn, "SELECT src, dst, relation, chain_id, weight, source FROM vc_edges ORDER BY src, dst, relation")
    items = _rows(conn, """SELECT i.id, i.chain_id, i.stage_id, i.item_order, i.item_name, i.hs_code, i.hsn8,
                                  i.description, i.ministry_ids_json, s.stage_order
                           FROM vc_items i LEFT JOIN vc_stages s ON s.chain_id = i.chain_id AND s.stage_id = i.stage_id
                           ORDER BY i.chain_id, s.stage_order, i.item_order, i.id""")
    chains = {c["id"]: c for c in _rows(conn, "SELECT * FROM value_chains ORDER BY sort_order, id")}
    production = _rows(conn, "SELECT id, scope, key, label, year, value, unit, source, status FROM production "
                             "ORDER BY id")
    return GraphData(edges, items, chains, production)


def graph_data(conn: sqlite3.Connection) -> GraphData:
    """Cached :class:`GraphData` for the database behind ``conn``."""
    return cached(conn, "graph_data", _build_graph)


# --------------------------------------------------------------------------- traversal

def _edges_touching(edges: list[dict], code: str, *, as_dst: bool) -> list[dict]:
    """Edges whose dst (``as_dst``) or src is in the family of ``code``."""
    key = "dst" if as_dst else "src"
    return [e for e in edges if family(e[key], code)]


def bfs(edges: list[dict], start: Iterable[str], depth: int, direction: str = "both") -> tuple[dict[str, int], list[dict]]:
    """Breadth-first search over ``edges`` from the ``start`` codes.

    ``direction``: ``downstream`` follows src -> dst, ``upstream`` dst -> src, ``both`` either way.
    Returns ``({code: hops}, [edges used])``; codes in the start set have 0 hops.
    """
    depth = max(0, min(MAX_DEPTH, int(depth)))
    seen: dict[str, int] = {c: 0 for c in start}
    used: dict[tuple, dict] = {}
    frontier = list(seen)
    for hop in range(1, depth + 1):
        nxt: list[str] = []
        for code in frontier:
            if direction in ("downstream", "both"):
                for e in _edges_touching(edges, code, as_dst=False):
                    used[(e["src"], e["dst"], e["relation"])] = e
                    if e["dst"] not in seen:
                        seen[e["dst"]] = hop
                        nxt.append(e["dst"])
            if direction in ("upstream", "both"):
                for e in _edges_touching(edges, code, as_dst=True):
                    used[(e["src"], e["dst"], e["relation"])] = e
                    if e["src"] not in seen:
                        seen[e["src"]] = hop
                        nxt.append(e["src"])
        frontier = nxt
        if not frontier:
            break
    return seen, list(used.values())


def start_codes(edges: list[dict], center: str) -> list[str]:
    """Edge endpoints in the family of ``center`` (the centre itself first).

    When nothing in ``edges`` is in the family of an 8-digit centre (e.g. ``40111010`` while the tyre chain curates
    its sibling ``40111090``), fall back to the endpoints under the centre's HS6, then HS4 (SPEC 6.3: links match
    "hsn8, hs6 or hs4"). The subheading / heading is returned as well so the centre and its siblings hang off a
    common ``hs_hierarchy`` bridge node instead of the centre floating alone.
    """
    codes = {center}
    for e in edges:
        for c in (e["src"], e["dst"]):
            if family(c, center):
                codes.add(c)
    if len(codes) == 1 and len(center) == 8:
        for prefix in (center[:6], center[:4]):
            hits = {c for e in edges for c in (e["src"], e["dst"]) if family(c, prefix)}
            if hits:
                codes.add(prefix)
                codes |= hits
                break
    return sorted(codes, key=lambda c: (c != center, len(c), c))


def hierarchy_edges(codes: Iterable[str]) -> list[dict]:
    """Synthetic ``hs_hierarchy`` edges from each code to its nearest displayed ancestor (>= 4 digits)."""
    pool = sorted(set(codes), key=lambda c: (len(c), c))
    out = []
    for c in pool:
        parents = [p for p in pool if len(p) >= 4 and len(p) < len(c) and c.startswith(p)]
        if parents:
            parent = max(parents, key=len)
            out.append({"src": parent, "dst": c, "relation": HIERARCHY_RELATION, "chain_id": None,
                        "source": "hs_nomenclature"})
    return out


# --------------------------------------------------------------------------- nodes

def _descriptions(conn: sqlite3.Connection, codes: list[str]) -> dict[str, dict]:
    """``{code: {description, ministry_id, sector_id}}`` for 8-digit lines and HS nodes."""
    out: dict[str, dict] = {}
    lines = [c for c in codes if len(c) == 8]
    nodes = [c for c in codes if len(c) != 8]
    if lines:
        for r in _rows(conn, "SELECT hsn8, description, ministry_id, sector_id FROM products "
                             "WHERE hsn8 IN (SELECT value FROM json_each(?))", (json.dumps(lines),)):
            out[r["hsn8"]] = {"description": r["description"], "ministry_id": r["ministry_id"],
                              "sector_id": r["sector_id"]}
    if nodes:
        for r in _rows(conn, "SELECT code, description FROM hs_nodes WHERE code IN (SELECT value FROM json_each(?))",
                       (json.dumps(nodes),)):
            out[r["code"]] = {"description": r["description"], "ministry_id": None, "sector_id": None}
    return out


def _prefix_owner(frame: Frame, hs6_list: list[str]) -> tuple[str | None, str | None]:
    """Most frequent (ministry, sector) over the HS6 rows (ties -> lowest code)."""
    mins: dict[str, int] = defaultdict(int)
    secs: dict[str, int] = defaultdict(int)
    for h in hs6_list:
        r = frame.by_hs6.get(h)
        if r is None:
            continue
        if r.get("ministry_id"):
            mins[r["ministry_id"]] += 1
        if r.get("sector_id"):
            secs[r["sector_id"]] += 1
    m = max(sorted(mins), key=lambda k: mins[k]) if mins else None
    s = max(sorted(secs), key=lambda k: secs[k]) if secs else None
    return m, s


def _sentence(text: str) -> str:
    """Upper-case the first character only (``str.capitalize`` would lower-case "China")."""
    return text[:1].upper() + text[1:]


def _short_label(text: str | None, limit: int = 42) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[: limit - 3].rstrip(" ,;") + "..."


def build_nodes(conn: sqlite3.Connection, codes: Iterable[str], *, center_codes: Iterable[str] = (),
                chain_id: str | None = None, hops: dict[str, int] | None = None) -> list[dict]:
    """Network ``nodes`` (SPEC 6.5 shape + ``trade_level``, ``hops``) for the given codes."""
    frame = analytics_frame(conn)
    g = graph_data(conn)
    codes = sorted(set(codes), key=lambda c: (len(c), c))
    center_set = set(center_codes)
    desc = _descriptions(conn, codes)
    ministries = {r["id"]: r for r in _rows(conn, "SELECT id, short_name, color FROM ministries")}
    out = []
    for code in codes:
        items = g.items_by_code.get(code, [])
        if chain_id:
            items = [i for i in items if i["chain_id"] == chain_id] or items
        item = items[0] if items else None
        info = desc.get(code, {})
        hs6s, level = frame.resolve(code)
        agg = aggregate(frame, hs6s)
        ministry_id = info.get("ministry_id")
        sector_id = info.get("sector_id")
        if item and not ministry_id:
            ids = json.loads(item.get("ministry_ids_json") or "[]")
            ministry_id = ids[0] if ids else None
        if not ministry_id or not sector_id:
            m2, s2 = _prefix_owner(frame, hs6s)
            ministry_id = ministry_id or m2
            sector_id = sector_id or s2
        mi = ministries.get(ministry_id or "", {})
        production = None
        prod = g.production_by_code.get(code)
        if prod is None:
            for cid, ch in g.chains.items():
                if ch.get("anchor_hs") == code and cid in g.chain_production:
                    prod = g.chain_production[cid]
                    break
        if prod is not None:
            production = {"value": prod["value"], "unit": prod["unit"], "label": prod.get("label"),
                          "year": prod.get("year"), "source": prod["source"], "status": prod["status"]}
        description = info.get("description") or (item or {}).get("description") or f"HS {code}"
        rec = frame.by_hs6.get(hs6s[0]) if len(hs6s) == 1 else None
        out.append({
            "id": code, "code": code,
            "label": (item or {}).get("item_name") or _short_label(description),
            "description": description,
            "level": len(code),
            "ministry_id": ministry_id, "ministry_short": mi.get("short_name"), "color": mi.get("color"),
            "sector_id": sector_id,
            "exports": agg["exports"], "imports": agg["imports"], "world_trade": agg["world_trade"],
            "rca": agg["rca"], "vulnerability_score": agg["vulnerability_score"],
            "dependency_ratio": rec.get("dependency_ratio") if rec else (
                agg["imports"] / (agg["imports"] + agg["exports"])
                if agg["imports"] is not None and (agg["imports"] + (agg["exports"] or 0)) > 0 else None),
            "china_import_share": rec.get("china_import_share") if rec else None,
            "production": production,
            "chain_ids": sorted(g.code_chains.get(code, set())),
            "stage_id": (item or {}).get("stage_id"),
            "is_center": code in center_set,
            "trade_level": level if hs6s else None,
            "hops": (hops or {}).get(code),
        })
    return out


def _edge_out(e: dict) -> dict:
    return {"id": f"{e['src']}->{e['dst']}:{e['relation']}", "source": e["src"], "target": e["dst"],
            "relation": e["relation"], "chain_id": e["chain_id"], "source_kind": e["source"]}


def _assemble(conn: sqlite3.Connection, edges: list[dict], extra_codes: Iterable[str] = (), *,
              center_codes: Iterable[str] = (), chain_id: str | None = None,
              hops: dict[str, int] | None = None) -> dict:
    codes = set(extra_codes)
    for e in edges:
        codes.add(e["src"])
        codes.add(e["dst"])
    all_edges = list(edges) + hierarchy_edges(codes)
    nodes = build_nodes(conn, codes, center_codes=center_codes, chain_id=chain_id, hops=hops)
    chains = sorted({e["chain_id"] for e in edges if e["chain_id"]})
    out_edges = [_edge_out(e) for e in sorted(all_edges, key=lambda e: (e["src"], e["dst"], e["relation"]))]
    return {"nodes": nodes, "edges": out_edges,
            "stats": {"n_nodes": len(nodes), "n_edges": len(out_edges), "chains": chains}}


def network(conn: sqlite3.Connection, chain_id: str | None = None, center: str | None = None, depth: int = 2,
            include_parts: bool = False) -> dict:
    """``GET /api/network`` body (see module docstring)."""
    g = graph_data(conn)
    pool = g.select(chain_id, include_parts=False)
    parts = [e for e in g.edges if e["relation"] == "parts_of"] if include_parts else []
    center = digits(center)
    if center:
        search = pool + parts
        start = start_codes(search, center)
        hops, used = bfs(search, start, depth, "both")
        return _assemble(conn, used, start, center_codes=[center], chain_id=chain_id, hops=hops)
    edges = list(pool)
    extra: list[str] = []
    if chain_id is not None:
        # The chain's anchor heading (4011 for tyres) is always a node of the chain view: its 8-digit lines hang off
        # it through hs_hierarchy edges and it carries the chain-level production figure.
        anchor = digits((g.chains.get(chain_id) or {}).get("anchor_hs"))
        if len(anchor) >= 4:
            extra.append(anchor)
    if include_parts:
        if chain_id is None:
            edges += parts
        else:
            codes = {e["src"] for e in pool} | {e["dst"] for e in pool}
            edges += [e for e in parts if any(family(e["src"], c) or family(e["dst"], c) for c in codes)]
    return _assemble(conn, edges, extra, chain_id=chain_id)


def critical_inputs(conn: sqlite3.Connection, nodes: list[dict], upstream_codes: Iterable[str],
                    limit: int = 20) -> list[dict]:
    """Upstream nodes that are import-dependent / concentrated (see module docstring), most vulnerable first."""
    from app.common import country_values

    frame = analytics_frame(conn)
    wanted = set(upstream_codes)
    out = []
    for n in nodes:
        if n["code"] not in wanted or n["is_center"]:
            continue
        imports = n.get("imports") or 0.0
        vuln = n.get("vulnerability_score")
        dep = n.get("dependency_ratio")
        hs6s, _level = frame.resolve(n["code"])
        china = n.get("china_import_share")
        top_name, top_id, top_share = None, None, None
        if hs6s and imports > 0:
            if len(hs6s) == 1:
                r = frame.by_hs6[hs6s[0]]
                top_name, top_id, top_share = (r.get("top_import_source_name"), r.get("top_import_source"),
                                               r.get("top_import_source_share"))
            else:
                top = country_values(conn, "india_partners", hs6s, flow="M", limit=5)
                if top:
                    top_name, top_id, top_share = top[0]["country"], top[0]["country_id"], top[0]["share"]
                    china = next((t["share"] for t in top if t["country_id"] == "aschn"), china)
        flags = []
        if vuln is not None and vuln >= CRITICAL_MIN_VULNERABILITY:
            flags.append(f"vulnerability score {vuln:.0f}/100")
        if dep is not None and dep >= CRITICAL_MIN_SHARE:
            flags.append(f"import-dependent (imports are {dep:.0%} of trade)")
        if china is not None and china >= CRITICAL_MIN_SHARE:
            flags.append(f"{china:.0%} of imports from China")
        if imports < CRITICAL_MIN_IMPORTS or not flags:
            continue
        if top_name and top_share is not None and (china is None or top_id != "aschn" or china < CRITICAL_MIN_SHARE):
            flags.append(f"top source {top_name} ({top_share:.0%})")
        out.append({"code": n["code"], "description": n["description"], "label": n["label"],
                    "vulnerability_score": vuln, "imports": imports, "top_import_source": top_name,
                    "top_import_source_id": top_id, "top_import_source_share": top_share,
                    "china_import_share": china, "dependency_ratio": dep,
                    "reason": _sentence("; ".join(flags))})
    out.sort(key=lambda c: (-(c["vulnerability_score"] or 0), -(c["imports"] or 0), c["code"]))
    return out[:limit]


def trace(conn: sqlite3.Connection, code: str, direction: str = "both", depth: int = 3,
          include_parts: bool = False) -> dict | None:
    """``GET /api/network/trace/{code}`` body; None when the code is not part of the graph and unknown."""
    g = graph_data(conn)
    center = digits(code)
    if not center:
        return None
    edges = g.select(None, include_parts=include_parts)
    start = start_codes(edges, center)
    hops, used = bfs(edges, start, depth, direction)
    body = _assemble(conn, used, start, center_codes=[center], hops=hops)
    up_codes: set[str] = set()
    if direction in ("upstream", "both"):
        up_hops, _ = bfs(edges, start, depth, "upstream")
        up_codes = {c for c, h in up_hops.items() if h > 0 and not family(c, center)}
    body["critical_inputs"] = critical_inputs(conn, body["nodes"], up_codes)
    body["direction"] = direction
    body["depth"] = max(0, min(MAX_DEPTH, int(depth)))
    return body


def chain_codes(conn: sqlite3.Connection, chain_id: str) -> list[str] | None:
    """Every code of a chain (anchor, items, chain edges) or None for an unknown chain."""
    g = graph_data(conn)
    chain = g.chains.get(chain_id)
    if chain is None:
        return None
    codes = {chain["anchor_hs"]} if chain.get("anchor_hs") else set()
    codes |= {i["hs_code"] for i in g.items if i["chain_id"] == chain_id and i["hs_code"]}
    for e in g.edges:
        if e["chain_id"] == chain_id:
            codes.update((e["src"], e["dst"]))
    return sorted(codes)


def chain_hs6(conn: sqlite3.Connection, chain_id: str) -> list[str] | None:
    """Distinct HS6 codes (with trade) covered by a chain's codes, or None for an unknown chain."""
    codes = chain_codes(conn, chain_id)
    if codes is None:
        return None
    frame = analytics_frame(conn)
    out: dict[str, None] = {}
    for c in codes:
        for h in frame.resolve(c)[0]:
            out[h] = None
    return sorted(out)


def downstream_paths(conn: sqlite3.Connection, code: str, depth: int = 3,
                     include_parts: bool = True) -> list[dict]:
    """Products reachable downstream from ``code`` (family-matched) with the shortest path and hop count.

    Returns ``[{code, hops, path: [codes from the start code]}]`` sorted by hops, code (start family excluded).
    """
    g = graph_data(conn)
    center = digits(code)
    if not center:
        return []
    edges = g.select(None, include_parts=include_parts)
    start = start_codes(edges, center)
    depth = max(1, min(MAX_DEPTH, int(depth)))
    parent: dict[str, str | None] = {c: None for c in start}
    hops: dict[str, int] = {c: 0 for c in start}
    frontier = list(start)
    for hop in range(1, depth + 1):
        nxt = []
        for c in frontier:
            for e in _edges_touching(edges, c, as_dst=False):
                if e["dst"] not in hops:
                    hops[e["dst"]] = hop
                    parent[e["dst"]] = c
                    nxt.append(e["dst"])
        frontier = nxt
    out = []
    for c, h in hops.items():
        if h == 0 or family(c, center):
            continue
        path = [c]
        while parent.get(path[-1]) is not None:
            path.append(parent[path[-1]])
        out.append({"code": c, "hops": h, "path": list(reversed(path))})
    out.sort(key=lambda d: (d["hops"], d["code"]))
    return out
