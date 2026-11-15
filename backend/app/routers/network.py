"""Value-chain network graph (docs/SPEC.md section 6.5): multiple inputs and outputs per HSN code, the manufacturing
ecosystem graph and upstream-downstream relationships. Owner: C2. Public.

Endpoints
---------
* ``GET /api/network?chain_id=&center=&depth=2&include_parts=false``
    No parameters -> every curated chain edge (relations ``input_to`` / ``component_of``). ``chain_id`` restricts
    to one chain; ``center`` runs a breadth-first search in both directions up to ``depth`` hops (0-6) from the
    centre code's family (the code and the curated codes under / above it); ``include_parts`` adds the HS-text
    ``parts_of`` links (``source_kind = "hs_text"``).
* ``GET /api/network/trace/{code}?direction=upstream|downstream|both&depth=3&include_parts=false``
    The same network shape for a directed trace plus ``critical_inputs`` (upstream nodes with imports >= US$
    1 mn that are vulnerable, import-dependent or China-dependent; see ``app.services.graph``).

Node statistics (exports, imports, world trade, RCA, vulnerability) are latest-year HS6 values; 4/2-digit nodes
aggregate the distinct HS6 codes under them. Synthetic ``hs_hierarchy`` edges link a node to its nearest
displayed ancestor code so chains that meet at different code levels appear connected. A centre / trace code
that is a valid HS code but not part of any value chain returns just that node (no edges); an unknown code -> 404.
"""
from __future__ import annotations

import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from app.common import latest_year, provenance
from app.db import get_db, scalar
from app.services import graph
from app.services.scoring import cached

router = APIRouter(prefix="/api/network", tags=["network"])

Direction = Literal["upstream", "downstream", "both"]


def _known_code(conn: sqlite3.Connection, code: str) -> bool:
    """True when ``code`` is an 8-digit line, an HS node, or a code used in the value-chain graph."""
    if not code or len(code) not in (2, 4, 6, 8):
        return False
    if len(code) == 8:
        found = scalar(conn, "SELECT COUNT(*) FROM products WHERE hsn8 = ?", (code,), 0)
    else:
        found = scalar(conn, "SELECT COUNT(*) FROM hs_nodes WHERE code = ?", (code,), 0)
    if found:
        return True
    return bool(scalar(conn, "SELECT COUNT(*) FROM vc_edges WHERE src = ? OR dst = ?", (code, code), 0))


def _check_chain(conn: sqlite3.Connection, chain_id: str | None) -> None:
    if chain_id and chain_id not in graph.graph_data(conn).chains:
        raise HTTPException(status_code=404, detail=f"Unknown value chain '{chain_id}'")


def _with_provenance(conn: sqlite3.Connection, body: dict) -> dict:
    body = dict(body)
    body["provenance"] = {
        "links": provenance("manual", "verified",
                            "Value-chain links: Atlas-curated chains; 'parts of' links derived from HS 2022 "
                            "heading texts"),
        "trade": provenance("tradestat", year=latest_year(conn)),
        "scores": provenance("model", "not_verified", "Model estimate · Atlas analytical model (derived from official DGFT/DGCIS & UN trade data)"),
    }
    return body


def _network_body(conn: sqlite3.Connection, chain_id: str | None, center: str | None, depth: int,
                  include_parts: bool) -> dict:
    return _with_provenance(conn, graph.network(conn, chain_id=chain_id, center=center, depth=depth,
                                          include_parts=include_parts))


@router.get("", summary="Value-chain network graph (nodes + edges)")
def network(chain_id: str | None = Query(None, description="Restrict to one value chain"),
            center: str | None = Query(None, max_length=12, description="Centre the graph on an HS code"),
            depth: int = Query(2, ge=0, le=graph.MAX_DEPTH, description="Hops from the centre (0-6)"),
            include_parts: bool = Query(False, description="Add HS-text 'parts of' links"),
            conn: sqlite3.Connection = Depends(get_db)) -> dict:
    chain_id = chain_id or None
    _check_chain(conn, chain_id)
    code = graph.digits(center) or None
    if center and not _known_code(conn, code or ""):
        raise HTTPException(status_code=404, detail=f"Unknown HS code '{center}'")
    return cached(conn, "network", _network_body, chain_id, code, depth, include_parts)


def _trace_body(conn: sqlite3.Connection, code: str, direction: str, depth: int, include_parts: bool) -> dict:
    body = graph.trace(conn, code, direction=direction, depth=depth, include_parts=include_parts)
    return _with_provenance(conn, body)


@router.get("/trace/{code}", summary="Upstream / downstream trace of a code with its critical inputs")
def trace(code: str,
          direction: Direction = Query("both"),
          depth: int = Query(3, ge=1, le=graph.MAX_DEPTH),
          include_parts: bool = Query(False, description="Also follow HS-text 'parts of' links"),
          conn: sqlite3.Connection = Depends(get_db)) -> dict:
    digits = graph.digits(code)
    if not _known_code(conn, digits):
        raise HTTPException(status_code=404, detail=f"Unknown HS code '{code}'")
    return cached(conn, "trace", _trace_body, digits, direction, depth, include_parts)
