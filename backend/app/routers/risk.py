"""Supply-chain risk and early warning (docs/SPEC.md section 6.8): early identification of supply-chain
vulnerabilities and import-dependence hotspots. Owner: C2. Government roles only (analyst / ministry / admin; anonymous 401, industry 403).

Endpoints
---------
* ``GET /api/risk/overview``  KPIs, the most vulnerable products, risk by sector and by source country, latest
  alerts. Accepts the analytics common filters (``ministry_id``, ``sector_id``, ``chapter``, ``chain_id``,
  ``limit`` (top_vulnerable size, default 50), ``min_world_trade``, ``min_imports``).
* ``GET /api/risk/alerts?severity=&kind=&limit=``  the automated alerts written by ``compute_scores``
  (``[{id, kind, hs6, description, severity, title, detail, value, created_at}]``, high severity first);
  also accepts ``ministry_id`` / ``sector_id`` / ``chapter`` / ``chain_id``.

Definitions (thresholds below; plain-language version in docs/METHODOLOGY.md)
--------------------------------------------------------------------------
* **High-risk product**: vulnerability score >= 65 and India's imports >= US$ 1 mn. (65 needs more than plain
  import dependence at scale - e.g. full dependence and top-decile imports already give ~55-60 - so it also
  requires concentrated sourcing and / or a large China share.)
* ``imports_at_risk_usd`` = India's imports of the high-risk products.
* ``china_dependent_imports_usd`` = imports *from China* (``M_p x china_import_share``) in products where China
  supplies >= 60 % of India's imports (the ``china_dependence`` alert threshold, without its value floor).
* ``concentrated_products`` = products with India's import HHI >= 0.6 and imports >= US$ 1 mn.
* ``by_sector``: ``avg_vulnerability`` is the import-weighted mean vulnerability of the sector's HS6 codes with
  imports; ``imports_at_risk`` sums its high-risk products (an HS6 belongs to the most common sector of its lines).
* ``by_source_country``: India's imports of the high-risk products by source country (``india_partners``) and
  the number of high-risk products each country supplies; top 15.
* ``top_vulnerable``: HS6 items with imports >= US$ 1 mn ranked by vulnerability score.
"""
from __future__ import annotations

import sqlite3
from collections import defaultdict
from typing import Literal

from fastapi import APIRouter, Depends, Query

from app.common import latest_year, provenance
from app.db import get_db
from app.routers.analytics import (alerts_list, common_filters, filter_rows, item_base, pick,
                                   source_country_breakdown)
from app.security import require_gov
from app.services.scoring import analytics_frame

router = APIRouter(prefix="/api/risk", tags=["risk"], dependencies=[Depends(require_gov)])

HIGH_RISK_VULNERABILITY = 65.0
MIN_IMPORTS = 1e6
CHINA_DEPENDENT_SHARE = 0.6
CONCENTRATED_HHI = 0.6
OVERVIEW_ALERTS = 20
SOURCE_COUNTRIES = 15
MAX_ALERTS = 2000

Severity = Literal["high", "medium", "low"]
AlertKind = Literal["import_surge", "export_drop", "concentration", "china_dependence"]


def is_high_risk(r: dict) -> bool:
    """High-risk rule of the module docstring."""
    return ((r.get("vulnerability_score") or 0) >= HIGH_RISK_VULNERABILITY
            and (r.get("india_imports") or 0) >= MIN_IMPORTS)


@router.get("/overview", summary="Supply-chain vulnerability overview")
def overview(f: dict = Depends(common_filters), conn: sqlite3.Connection = Depends(get_db)) -> dict:
    frame = analytics_frame(conn)
    data = filter_rows(conn, frame, f)
    importing = [r for r in data if (r.get("india_imports") or 0) > 0]
    high = [r for r in importing if is_high_risk(r)]
    china_dep = [r for r in importing if (r.get("china_import_share") or 0) >= CHINA_DEPENDENT_SHARE]
    concentrated = [r for r in importing if (r.get("india_import_hhi") or 0) >= CONCENTRATED_HHI
                    and r["india_imports"] >= MIN_IMPORTS]

    fields = ("vulnerability_score", "top_import_source", "top_import_source_name", "top_import_source_share",
              "china_import_share", "india_imports", "india_exports", "dependency_ratio", "india_import_hhi",
              "n_import_sources", "import_dependency_score", "archetype")
    ranked = sorted((r for r in importing if r["india_imports"] >= MIN_IMPORTS
                     and r.get("vulnerability_score") is not None),
                    key=lambda r: (-r["vulnerability_score"], -r["india_imports"], r["hs6"]))
    top = [{**item_base(r), **pick(r, *fields), "high_risk": is_high_risk(r)} for r in ranked[: f["limit"]]]

    sectors: dict[str, dict] = defaultdict(lambda: {"weighted": 0.0, "weight": 0.0, "imports": 0.0,
                                                    "at_risk": 0.0, "n_products": 0, "n_high_risk": 0})
    names: dict[str, str] = {}
    for r in importing:
        sid = r.get("sector_id") or "unassigned"
        names[sid] = r.get("sector_name") or "Unassigned"
        s = sectors[sid]
        m = r["india_imports"]
        s["imports"] += m
        s["n_products"] += 1
        if r.get("vulnerability_score") is not None:
            s["weighted"] += r["vulnerability_score"] * m
            s["weight"] += m
        if is_high_risk(r):
            s["at_risk"] += m
            s["n_high_risk"] += 1
    by_sector = [{"sector_id": sid, "name": names[sid],
                  "avg_vulnerability": (s["weighted"] / s["weight"]) if s["weight"] else None,
                  "imports_at_risk": s["at_risk"], "imports": s["imports"], "n_products": s["n_products"],
                  "n_high_risk": s["n_high_risk"]} for sid, s in sectors.items()]
    by_sector.sort(key=lambda s: (-(s["imports_at_risk"] or 0), -(s["avg_vulnerability"] or 0), s["sector_id"]))

    by_country = [{"country_id": c["country_id"], "country": c["country"], "imports_at_risk": c["imports"],
                   "n_products": c["n_products"]}
                  for c in source_country_breakdown(conn, [r["hs6"] for r in high], limit=SOURCE_COUNTRIES)]

    hs6_set = {r["hs6"] for r in data} if any(f.get(k) is not None for k in
                                              ("ministry_id", "sector_id", "chapter", "chain_id",
                                               "min_world_trade", "min_imports")) else None
    total_imports = sum(r["india_imports"] for r in importing)
    at_risk = sum(r["india_imports"] for r in high)
    year = latest_year(conn)
    return {
        "kpis": {"high_risk_products": len(high), "imports_at_risk_usd": at_risk,
                 "china_dependent_imports_usd": sum(r["india_imports"] * r["china_import_share"] for r in china_dep),
                 "concentrated_products": len(concentrated),
                 "china_dependent_products": len(china_dep), "total_imports_usd": total_imports,
                 "imports_at_risk_share": (at_risk / total_imports) if total_imports else None,
                 "n_products": len(importing)},
        "top_vulnerable": top,
        "by_sector": by_sector,
        "by_source_country": by_country,
        "alerts": alerts_list(conn, limit=OVERVIEW_ALERTS, hs6_set=hs6_set),
        "thresholds": {"high_risk_vulnerability": HIGH_RISK_VULNERABILITY, "min_imports_usd": MIN_IMPORTS,
                       "china_dependent_share": CHINA_DEPENDENT_SHARE, "concentrated_hhi": CONCENTRATED_HHI},
        "scored": frame.scored,
        "provenance": {"trade": provenance("tradestat", year=year),
                       "scores": provenance("model", "not_verified", "Model estimate - Atlas analytical model (derived from official DGFT/DGCIS & UN trade data)")},
    }


@router.get("/alerts", summary="Automated alerts (import surges, export drops, concentration, China dependence)")
def alerts(severity: Severity | None = Query(None), kind: AlertKind | None = Query(None),
           limit: int = Query(100, ge=1, le=MAX_ALERTS),
           ministry_id: str | None = Query(None), sector_id: str | None = Query(None),
           chapter: str | None = Query(None), chain_id: str | None = Query(None),
           conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
    hs6_set = None
    f = {"ministry_id": ministry_id or None, "sector_id": sector_id or None, "chapter": chapter or None,
         "chain_id": chain_id or None}
    if any(f.values()):
        hs6_set = {r["hs6"] for r in filter_rows(conn, analytics_frame(conn), f)}
    return alerts_list(conn, severity=severity, kind=kind, limit=limit, hs6_set=hs6_set)
