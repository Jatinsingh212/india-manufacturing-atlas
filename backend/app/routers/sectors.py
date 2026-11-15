"""Sector dashboards (docs/SPEC.md section 6.4). Public.

* ``GET /api/sectors``                - same list as ``/api/meta/sectors`` (convenience).
* ``GET /api/sectors/{id}``           - same shape as the ministry dashboard, with ``sector`` instead of
  ``ministry`` and ``ministry_mix`` instead of ``sector_mix`` (built by
  ``app.routers.ministries.build_entity_dashboard``; definitions are documented there).
* ``GET /api/sectors/{id}/products``  - paginated ``ProductSummary`` of the sector's lines, with the search
  facets (``q``, ``ministry_id``, ``chapter``, ``mapping_status``, ``mapping_source``, ``sort``, ``order``).

Sector-specific KPI meanings: ``secondary_codes`` = lines of the sector with at least one secondary owner;
``sectors_covered`` = 1 (the sector itself) and ``ministries_covered`` = owning ministries (residual excluded);
``open_tickets`` / ``pending_claims`` = unresolved tickets / pending claims about the sector's lines;
``schemes`` = schemes whose HS prefixes cover at least one line of the sector.
"""
from __future__ import annotations

import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from app.db import get_db, row
from app.routers.meta import sector_list
from app.routers.ministries import build_entity_dashboard, entity_products

router = APIRouter(prefix="/api/sectors", tags=["sectors"])

SortParam = Literal["relevance", "exports", "imports", "rca", "code", "world_trade"]
OrderParam = Literal["asc", "desc"]


@router.get("", summary="All sectors (same as /api/meta/sectors)")
def list_sectors(conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
    return sector_list(conn)


@router.get("/{sector_id}", summary="Sector dashboard")
def sector_dashboard(sector_id: str, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    data = build_entity_dashboard(conn, "sector", sector_id)
    if data is None:
        raise HTTPException(status_code=404, detail=f"Unknown sector '{sector_id}'")
    return data


@router.get("/{sector_id}/products", summary="Products of a sector (paginated)")
def sector_products(
    sector_id: str,
    q: str | None = Query(None, max_length=200),
    ministry_id: str | None = None,
    chapter: str | None = None,
    mapping_status: Literal["accepted", "residual"] | None = None,
    mapping_source: Literal["dpiit_guidebook", "official_upload", "manual", "rule", "unmapped"] | None = None,
    sort: SortParam = "relevance",
    order: OrderParam | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    if not row(conn, "SELECT 1 AS x FROM sectors WHERE id = ?", (sector_id,)):
        raise HTTPException(status_code=404, detail=f"Unknown sector '{sector_id}'")
    return entity_products(conn, "sector", sector_id, q=q, ministry_id=ministry_id, chapter=chapter,
                           mapping_status=mapping_status, mapping_source=mapping_source, sort=sort, order=order,
                           page=page, page_size=page_size)
