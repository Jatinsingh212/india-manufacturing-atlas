"""ETL step 11 - policy knowledge base and Guidebook info cards.

Loads ``data/curated/policy.json`` and ``data/curated/info.json`` (owner: B2) into

* ``schemes`` + ``scheme_products``   - the 14 PLI schemes and indicative BIS Quality Control Orders,
* ``trade_agreements``                - India's FTAs / CEPAs / PTAs (partners = ``countries.id``),
* ``skill_councils``                  - Sector Skill Councils mapped to sector and value-chain ids,
* ``info_pages``                      - the four left-panel cards of the Guidebook dashboard,
* ``roadmap_items``                   - the programme's Phase 0 / I / II plan x the 8 workstreams,
* ``risks``                           - the programme risk register with the platform control for each.

Contract (docs/SPEC.md sections 3 and 7)
---------------------------------------
``run(conn) -> dict`` is called by ``scripts/build_db.py`` after products, ministries, sectors, trade
(``countries``) and value chains are loaded.

Validation (raises ``ValueError`` listing every problem, so a bad curated file aborts the build):

* every ``ministry_id`` of a scheme must exist in ``ministries`` (``null`` is allowed - e.g. a QCO
  issued by a ministry outside the Atlas's 31 product owners);
* every agreement partner must exist in ``countries``;
* every skill-council ``sector_id`` must exist in ``sectors``;
* ids are unique, HS prefixes are 2-8 digits, enumerated fields use the schema's values.

Skill-council ``chain_ids`` that are not (yet) in ``value_chains`` are only reported in the returned
stats (``unknown_chain_ids``), because value chains are curated by another owner and may be loaded
in a different order in tests.

Idempotency: curated reference tables (schemes, scheme_products, trade_agreements, skill_councils,
info_pages) are fully replaced from the JSON; roadmap_items and risks are upserted by id, so running
the step twice yields the same rows. Note that an upsert resets any status edited by an admin through
``PATCH /api/roadmap`` or ``PATCH /api/risks`` - the step is meant for (re)builds, not live databases.
"""
from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parents[2]
CURATED_DIR = BACKEND_DIR / "data" / "curated"
POLICY_PATH = CURATED_DIR / "policy.json"
INFO_PATH = CURATED_DIR / "info.json"

SCHEME_KINDS = ("PLI", "QCO")
AGREEMENT_STATUSES = ("in_force", "signed", "negotiating")
PHASES = ("Phase 0", "Phase I", "Phase II")
ROADMAP_STATUSES = ("done", "in_progress", "planned")
RISK_STATUSES = ("open", "mitigating", "closed")
INFO_IDS = ("about_hsn", "guidebook", "how_to_use", "cbic_tariff")
_PREFIX_RE = re.compile(r"^\d{2,8}$")


# --------------------------------------------------------------------------- helpers

def _load_json(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _ids(conn: sqlite3.Connection, table: str) -> set[str]:
    """All ``id`` values of a reference table (empty set if the table has no rows)."""
    return {str(r[0]) for r in conn.execute(f"SELECT id FROM {table}")}  # noqa: S608 - fixed table names


def _check_unique(items: list[dict], what: str, errors: list[str]) -> None:
    seen: set[Any] = set()
    for it in items:
        key = it.get("id")
        if key is None or key == "":
            errors.append(f"{what}: entry without id: {it.get('name') or it.get('title')!r}")
        elif key in seen:
            errors.append(f"{what}: duplicate id {key!r}")
        seen.add(key)


def _check_in(value: Any, allowed: tuple, what: str, errors: list[str]) -> None:
    if value not in allowed:
        errors.append(f"{what}: {value!r} not in {allowed}")


def _check_score(value: Any, what: str, errors: list[str]) -> None:
    if value is not None and not (isinstance(value, int) and 1 <= value <= 5):
        errors.append(f"{what}: must be an integer 1..5 or null, got {value!r}")


# --------------------------------------------------------------------------- validation

def validate(policy: dict, info: dict, ministry_ids: set[str], country_ids: set[str],
             sector_ids: set[str]) -> list[str]:
    """Return a list of human-readable problems (empty when the curated data are consistent)."""
    errors: list[str] = []

    schemes = policy.get("schemes", [])
    _check_unique(schemes, "schemes", errors)
    for s in schemes:
        sid = s.get("id")
        _check_in(s.get("kind"), SCHEME_KINDS, f"scheme {sid} kind", errors)
        if not s.get("name"):
            errors.append(f"scheme {sid}: missing name")
        mid = s.get("ministry_id")
        if mid is not None and mid not in ministry_ids:
            errors.append(f"scheme {sid}: unknown ministry_id {mid!r}")
        outlay = s.get("outlay_crore")
        if outlay is not None and not (isinstance(outlay, (int, float)) and outlay > 0):
            errors.append(f"scheme {sid}: outlay_crore must be a positive number or null")
        prefixes = s.get("hs_prefixes") or []
        if not prefixes:
            errors.append(f"scheme {sid}: no hs_prefixes")
        seen_p: set[str] = set()
        for p in prefixes:
            code = str(p.get("prefix", ""))
            if not _PREFIX_RE.match(code):
                errors.append(f"scheme {sid}: prefix {code!r} must be 2-8 digits")
            if code in seen_p:
                errors.append(f"scheme {sid}: duplicate prefix {code!r}")
            seen_p.add(code)

    agreements = policy.get("agreements", [])
    _check_unique(agreements, "agreements", errors)
    for a in agreements:
        aid = a.get("id")
        _check_in(a.get("status"), AGREEMENT_STATUSES, f"agreement {aid} status", errors)
        partners = a.get("partners") or []
        if not partners:
            errors.append(f"agreement {aid}: no partners")
        for c in partners:
            if c not in country_ids:
                errors.append(f"agreement {aid}: unknown country id {c!r}")

    councils = policy.get("skill_councils", [])
    _check_unique(councils, "skill_councils", errors)
    for sc in councils:
        for sec in sc.get("sector_ids") or []:
            if sec not in sector_ids:
                errors.append(f"skill council {sc.get('id')}: unknown sector id {sec!r}")

    roadmap = policy.get("roadmap", [])
    _check_unique(roadmap, "roadmap", errors)
    for r in roadmap:
        rid = r.get("id")
        _check_in(r.get("phase"), PHASES, f"roadmap {rid} phase", errors)
        _check_in(r.get("status"), ROADMAP_STATUSES, f"roadmap {rid} status", errors)
        if not r.get("title"):
            errors.append(f"roadmap {rid}: missing title")
        sm, em = r.get("start_month"), r.get("end_month")
        if sm is not None and em is not None and sm > em:
            errors.append(f"roadmap {rid}: start_month > end_month")

    risks = policy.get("risks", [])
    _check_unique(risks, "risks", errors)
    for k in risks:
        kid = k.get("id")
        if not isinstance(kid, int):
            errors.append(f"risk {kid!r}: id must be an integer")
        for field in ("area", "risk", "mitigation"):
            if not k.get(field):
                errors.append(f"risk {kid}: missing {field}")
        _check_in(k.get("status"), RISK_STATUSES, f"risk {kid} status", errors)
        _check_score(k.get("likelihood"), f"risk {kid} likelihood", errors)
        _check_score(k.get("impact"), f"risk {kid} impact", errors)

    pages = info.get("pages", [])
    _check_unique(pages, "info pages", errors)
    for p in pages:
        _check_in(p.get("id"), INFO_IDS, "info page id", errors)
        if not p.get("title") or not p.get("body_md"):
            errors.append(f"info page {p.get('id')}: title and body_md are required")
    return errors


# --------------------------------------------------------------------------- loading

def _load_schemes(conn: sqlite3.Connection, schemes: list[dict]) -> int:
    conn.execute("DELETE FROM scheme_products")
    conn.execute("DELETE FROM schemes")
    n_prefixes = 0
    for s in schemes:
        conn.execute(
            "INSERT INTO schemes (id, name, kind, ministry_id, outlay_crore, launched, description, url, source) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (s["id"], s["name"], s["kind"], s.get("ministry_id"), s.get("outlay_crore"),
             None if s.get("launched") is None else str(s["launched"]),
             s.get("description"), s.get("url"), s.get("source")),
        )
        for p in s.get("hs_prefixes") or []:
            conn.execute("INSERT INTO scheme_products (scheme_id, hs_prefix, note) VALUES (?, ?, ?)",
                         (s["id"], str(p["prefix"]), p.get("note")))
            n_prefixes += 1
    return n_prefixes


def _load_agreements(conn: sqlite3.Connection, agreements: list[dict]) -> None:
    conn.execute("DELETE FROM trade_agreements")
    for a in agreements:
        conn.execute(
            "INSERT INTO trade_agreements (id, name, short_name, partners_json, status, year, url, notes) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (a["id"], a["name"], a.get("short_name"), json.dumps(list(a["partners"])), a["status"],
             a.get("year"), a.get("url"), a.get("notes")),
        )


def _load_skill_councils(conn: sqlite3.Connection, councils: list[dict]) -> None:
    conn.execute("DELETE FROM skill_councils")
    for sc in councils:
        conn.execute(
            "INSERT INTO skill_councils (id, name, sector_ids_json, chain_ids_json, url) VALUES (?, ?, ?, ?, ?)",
            (sc["id"], sc["name"], json.dumps(list(sc.get("sector_ids") or [])),
             json.dumps(list(sc.get("chain_ids") or [])), sc.get("url")),
        )


def _load_info(conn: sqlite3.Connection, pages: list[dict]) -> None:
    conn.execute("DELETE FROM info_pages")
    for i, p in enumerate(pages, start=1):
        conn.execute(
            "INSERT INTO info_pages (id, title, icon, body_md, links_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
            (p["id"], p["title"], p.get("icon"), p["body_md"], json.dumps(list(p.get("links") or [])),
             p.get("sort_order", i)),
        )


def _upsert_roadmap(conn: sqlite3.Connection, items: list[dict]) -> None:
    for i, r in enumerate(items, start=1):
        conn.execute(
            "INSERT INTO roadmap_items (id, phase, workstream, title, description, start_month, end_month, "
            "status, owner, platform_route, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET phase=excluded.phase, workstream=excluded.workstream, "
            "title=excluded.title, description=excluded.description, start_month=excluded.start_month, "
            "end_month=excluded.end_month, status=excluded.status, owner=excluded.owner, "
            "platform_route=excluded.platform_route, sort_order=excluded.sort_order",
            (r["id"], r["phase"], r.get("workstream"), r["title"], r.get("description"), r.get("start_month"),
             r.get("end_month"), r["status"], r.get("owner"), r.get("platform_route"), r.get("sort_order", i)),
        )


def _upsert_risks(conn: sqlite3.Connection, risks: list[dict]) -> None:
    for k in risks:
        conn.execute(
            "INSERT INTO risks (id, area, risk, mitigation, likelihood, impact, status, owner, platform_control) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET area=excluded.area, risk=excluded.risk, mitigation=excluded.mitigation, "
            "likelihood=excluded.likelihood, impact=excluded.impact, status=excluded.status, owner=excluded.owner, "
            "platform_control=excluded.platform_control",
            (k["id"], k["area"], k["risk"], k["mitigation"], k.get("likelihood"), k.get("impact"), k["status"],
             k.get("owner"), k.get("platform_control")),
        )


def run(conn: sqlite3.Connection, policy_path: Path | str | None = None,
        info_path: Path | str | None = None) -> dict:
    """Validate and load the curated policy knowledge base; returns load statistics.

    ``policy_path`` / ``info_path`` default to the curated files and exist only so tests can load
    variants. Raises ``ValueError`` when ministry, country or sector ids (or enumerated fields) are invalid.
    """
    policy = _load_json(Path(policy_path) if policy_path else POLICY_PATH)
    info = _load_json(Path(info_path) if info_path else INFO_PATH)

    ministry_ids = _ids(conn, "ministries")
    country_ids = _ids(conn, "countries")
    sector_ids = _ids(conn, "sectors")
    errors = validate(policy, info, ministry_ids, country_ids, sector_ids)
    if errors:
        hint = ""
        if not country_ids:
            hint = " (the countries table is empty - run the trade step first)"
        raise ValueError(f"load_policy: {len(errors)} problem(s) in curated policy/info data{hint}:\n  - "
                         + "\n  - ".join(errors))

    chain_ids = _ids(conn, "value_chains")
    unknown_chains = sorted({c for sc in policy.get("skill_councils", []) for c in sc.get("chain_ids") or []
                             if chain_ids and c not in chain_ids})

    with conn:  # one transaction: either the whole knowledge base is replaced or nothing is
        n_prefixes = _load_schemes(conn, policy.get("schemes", []))
        _load_agreements(conn, policy.get("agreements", []))
        _load_skill_councils(conn, policy.get("skill_councils", []))
        _load_info(conn, info.get("pages", []))
        _upsert_roadmap(conn, policy.get("roadmap", []))
        _upsert_risks(conn, policy.get("risks", []))

    schemes = policy.get("schemes", [])
    roadmap = policy.get("roadmap", [])
    stats = {
        "schemes_pli": sum(1 for s in schemes if s["kind"] == "PLI"),
        "schemes_qco": sum(1 for s in schemes if s["kind"] == "QCO"),
        "scheme_prefixes": n_prefixes,
        "trade_agreements": len(policy.get("agreements", [])),
        "skill_councils": len(policy.get("skill_councils", [])),
        "info_pages": len(info.get("pages", [])),
        "roadmap_items": len(roadmap),
        "roadmap_done": sum(1 for r in roadmap if r["status"] == "done"),
        "risks": len(policy.get("risks", [])),
    }
    if unknown_chains:
        stats["unknown_chain_ids"] = unknown_chains
    return stats


if __name__ == "__main__":  # manual run against an existing database: python -m scripts.etl.load_policy [db]
    import os
    import sys

    db = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("ATLAS_DB", str(BACKEND_DIR / "data" / "atlas.db"))
    c = sqlite3.connect(db)
    try:
        print(run(c))
    finally:
        c.close()
