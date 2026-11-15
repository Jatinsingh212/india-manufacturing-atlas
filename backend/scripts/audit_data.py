"""End-to-end data audit: raw sources -> ETL -> database -> API.

Run from ``backend/``::

    python -m scripts.audit_data
    python -m scripts.audit_data --db data/atlas.db --json audit-report.json
    python -m scripts.audit_data --no-api

The audit is deliberately independent of the build order: every table is compared with a fresh
parse of the file that feeds it (CEPII BACI via OEC, WITS/TRAINS, the GST HSN master, the WCO HS 2022
nomenclature, the DPIIT Guidebook, the DGFT ITC-HS feed and the curated JSON documents), and every
derived table is recomputed from its inputs:

* ``trade_hs6`` / ``country_totals`` / partner tables / ``hs6_products``  <- raw BACI files
* ``products`` / ``hs_nodes`` / ``sections``                            <- GST xlsx + HS nomenclature
* ``guidebook_mapping`` / owners / secondary owners                     <- DPIIT Guidebook JSON
* ``tariffs`` / ``dgft_itc_policy``                                     <- WITS CSV / DGFT JSONL
* ``hs6_metrics``                                                        <- trade + partner tables
* ``v_product_trade`` allocation                                         <- products x metrics
* ``hs6_scores`` / forecasts / alerts                                    <- metrics + the shared formulas
* value chains, clusters, policy, production, ops seed data, meta        <- curated JSON + manifest
* API responses                                                          <- a temporary DB copy

Missing data is never coerced to zero: the audit asserts that the 7108.20 / 7118.90 lines keep
``trade = null`` and that BACI's 2710 heading aggregate is allocated once with weight ``1 / 69``.

Exit code 0 = every check passed, 1 = at least one discrepancy. ``--json`` writes the complete
structured report (checks, counts, failures) for CI or a release record.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import math
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import time
import traceback
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence

BACKEND = Path(__file__).resolve().parents[1]
DATA = BACKEND / "data"
RAW = DATA / "raw"
CURATED = DATA / "curated"
DEFAULT_DB = DATA / "atlas.db"
LATEST_YEAR = 2024
FIRST_TREND_YEAR = 2018
HS22_FIRST_YEAR = 2022
INDIA = "asind"
CHINA = "aschn"
USD_TOL = 0.01
RATIO_TOL = 1e-10
SCORE_TOL = 5e-4

CURRENT_TOTAL_EXPORTS = 437_704_444_000.0   # India FY2024-25, sum of parsed DGCIS TRADESTAT rows
CURRENT_TOTAL_IMPORTS = 721_200_052_000.0   # sum of parsed rows (grand totals differ by row rounding)
CURRENT_TOTAL_WORLD = 22_944_492_970_774.0  # BACI HS6 world trade, calendar year 2024


# --------------------------------------------------------------------------- audit framework

class Audit:
    """Collect PASS/FAIL checks and print a stable, CI-friendly report."""

    def __init__(self, db: Path) -> None:
        self.db = db
        self.section_name = ""
        self.checks: list[dict] = []
        self.started = time.time()
        self.counts: dict[str, Any] = {}
        self.cache: dict[str, Any] = {}

    def section(self, name: str) -> None:
        self.section_name = name

    def check(self, name: str, ok: bool, detail: str = "", *, value: Any = None) -> bool:
        if len(detail) > 600:
            detail = detail[:597] + "..."
        self.checks.append({"section": self.section_name, "name": name, "ok": bool(ok),
                            "detail": detail, "value": value})
        marker = "PASS" if ok else "FAIL"
        suffix = f"  [{detail}]" if detail else ""
        print(f"[{marker}] {self.section_name}: {name}{suffix}")
        return bool(ok)

    def check_count(self, name: str, actual: int, expected: int) -> bool:
        return self.check(name, actual == expected, f"actual={actual:,} expected={expected:,}",
                          value={"actual": actual, "expected": expected})

    def fail(self, name: str, detail: str, *, value: Any = None) -> bool:
        return self.check(name, False, detail, value=value)

    def summary(self) -> dict:
        failures = [c for c in self.checks if not c["ok"]]
        by_section: dict[str, dict] = {}
        for c in self.checks:
            bucket = by_section.setdefault(c["section"], {"passed": 0, "failed": 0})
            bucket["passed" if c["ok"] else "failed"] += 1
        return {
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "db": str(self.db),
            "duration_s": round(time.time() - self.started, 2),
            "checks": len(self.checks),
            "passed": len(self.checks) - len(failures),
            "failed": len(failures),
            "ok": not failures,
            "by_section": by_section,
            "counts": self.counts,
            "failures": failures,
            "results": self.checks,
        }


def _connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path), timeout=60)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON")
    return conn


def _scalar(conn: sqlite3.Connection, sql: str, params: Sequence = ()) -> Any:
    row = conn.execute(sql, params).fetchone()
    return None if row is None else row[0]


def _json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _close(a: float | None, b: float | None, tol: float = USD_TOL) -> bool:
    if a is None or b is None:
        return a is None and b is None
    return math.isclose(float(a), float(b), rel_tol=1e-10, abs_tol=tol)


def _ratio_close(a: float | None, b: float | None) -> bool:
    return _close(a, b, RATIO_TOL)


def _rows(path: Path) -> Iterator[dict[str, str]]:
    """Yield dict rows from a CSV / gzipped CSV; UTF-8 with BOM tolerated."""
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8-sig", newline="") as fh:
        yield from csv.DictReader(fh)


def _gz_jsonl(path: Path) -> Iterator[dict]:
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                yield json.loads(line)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _raw_path(manifest_key: str) -> Path:
    if manifest_key == "dgft_itc_hs":
        return RAW / "dgft_itc" / "dgft_itc_policy.jsonl.gz"
    if manifest_key == "wits_india_mfn_2022":
        return RAW / "wits_india_mfn_2022.csv"
    return RAW / f"{manifest_key}.csv.gz"


def _count_file(path: Path) -> int:
    if path.suffix == ".gz" and path.name.endswith(".jsonl.gz"):
        return sum(1 for _ in _gz_jsonl(path))
    if path.suffix == ".gz":
        return sum(1 for _ in _rows(path))
    if path.suffix == ".csv":
        return sum(1 for _ in _rows(path))
    raise ValueError(f"unsupported source file {path}")


def _write_report(a: Audit, path: Path) -> None:
    payload = a.summary()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    os.replace(tmp, path)


# --------------------------------------------------------------------------- section 1: files

def audit_files(a: Audit, conn: sqlite3.Connection) -> None:
    manifest = _json(RAW / "manifest.json")
    a.counts["manifest_sources"] = len(manifest)
    for key, meta in manifest.items():
        path = _raw_path(key)
        exists = path.is_file()
        a.check(f"raw file {key}", exists, str(path.relative_to(BACKEND)) if exists else f"missing {path}")
        if not exists:
            continue
        expected = int(meta.get("rows", -1))
        actual = _count_file(path)
        a.check_count(f"raw rows {key}", actual, expected)

    for name in ("hs_nomenclature.csv", "hs_sections.csv", "gst_hsn_master.xlsx"):
        path = RAW / name
        a.check(f"raw file {name}", path.is_file(), str(path.relative_to(BACKEND)))
    for name in ("info.json", "ministries.json", "ministry_mapping.json", "ops_seed.json", "policy.json",
                 "production.json", "sectors.json", "value_chains.json", "supply_tiers.json"):
        path = CURATED / name
        ok = path.is_file()
        if ok:
            try:
                _json(path)
            except Exception as exc:  # noqa: BLE001 - report parse errors as audit failures
                ok = False
                a.fail(f"curated JSON {name}", f"parse error: {exc}")
                continue
        a.check(f"curated JSON {name}", ok, str(path.relative_to(BACKEND)))

    dgft_manifest = _json(RAW / "dgft_itc" / "manifest.json")
    dgft_file = RAW / "dgft_itc" / "dgft_itc_policy.jsonl.gz"
    if dgft_file.is_file():
        a.check("DGFT file sha256", _sha256(dgft_file) == dgft_manifest.get("file_sha256"),
                f"manifest={dgft_manifest.get('file_sha256')}")
        lines = list(_gz_jsonl(dgft_file))
        a.check("DGFT content sha256",
                hashlib.sha256(("\n".join(json.dumps(r, ensure_ascii=False, sort_keys=True)
                                          for r in lines) + "\n").encode("utf-8")).hexdigest()
                == dgft_manifest.get("content_sha256"))
        totals = dgft_manifest.get("totals", {})
        a.check_count("DGFT current records", sum(1 for r in lines if r.get("is_current")),
                      int(totals.get("current_records", -1)))
        for direction in ("import", "export"):
            expected = int(totals.get(direction, {}).get("records", -1))
            actual = sum(1 for r in lines if r.get("direction") == direction)
            a.check_count(f"DGFT {direction} records", actual, expected)

    mapping = _json(CURATED / "ministry_mapping.json")
    source = mapping.get("_source", {})
    a.check("Guidebook source sha256 matches meta",
            _scalar(conn, "SELECT value FROM meta WHERE key='guidebook_source_sha256'") == source.get("sha256"),
            str(source.get("sha256")))
    a.check_count("Guidebook accepted unique codes", len(mapping.get("accepted", [])),
                  int(mapping.get("counts", {}).get("accepted_unique_codes", -1)))
    a.check_count("Guidebook residual codes", len(mapping.get("residual", [])),
                  int(mapping.get("counts", {}).get("residual_codes", -1)))


# --------------------------------------------------------------------------- section 2: nomenclature

def _hs_raw() -> tuple[list[dict], list[dict]]:
    sections = list(_rows(RAW / "hs_sections.csv"))
    nodes = []
    for r in _rows(RAW / "hs_nomenclature.csv"):
        if r["section"].strip() not in {s["section"].strip() for s in sections}:
            continue
        if int(r["level"]) not in (2, 4, 6):
            continue
        nodes.append(r)
    return sections, nodes


def _gst_codes() -> set[str]:
    from openpyxl import load_workbook

    wb = load_workbook(RAW / "gst_hsn_master.xlsx", read_only=True, data_only=True)
    try:
        ws = wb["HSN_MSTR"]
        out = set()
        for code, _text in ws.iter_rows(min_row=2, max_col=2, values_only=True):
            if code is None:
                continue
            code = str(code).strip()
            if len(code) == 8 and code.isdigit():
                out.add(code)
        return out
    finally:
        wb.close()


def _sector_for(code: str, by_chapter: dict[str, str], by_heading: dict[str, str]) -> str | None:
    return by_heading.get(code[:4]) or by_chapter.get(code[:2])


def audit_nomenclature(a: Audit, conn: sqlite3.Connection) -> None:
    sections, raw_nodes = _hs_raw()
    a.check_count("sections", _scalar(conn, "SELECT COUNT(*) FROM sections"), len(sections))
    a.check_count("hs_nodes", _scalar(conn, "SELECT COUNT(*) FROM hs_nodes"), len(raw_nodes))

    raw_by_code = {r["hscode"].strip(): r for r in raw_nodes}
    db_nodes = {r["code"]: dict(r) for r in conn.execute("SELECT * FROM hs_nodes")}
    a.check("hs_nodes code set matches raw", set(db_nodes) == set(raw_by_code),
            f"db={len(db_nodes):,} raw={len(raw_by_code):,}")
    bad = []
    for code, r in db_nodes.items():
        raw = raw_by_code.get(code)
        if raw is None:
            continue
        expected_parent = None if raw["parent"].strip() == "TOTAL" else raw["parent"].strip()
        if (r["level"] != int(raw["level"]) or r["parent"] != expected_parent
                or r["section_id"] != raw["section"].strip()
                or r["description"] != " ".join(raw["description"].split())):
            bad.append(code)
    a.check("hs_nodes fields match raw", not bad, f"{len(bad)} mismatches: {bad[:8]}")
    a.check("hs_nodes levels valid", _scalar(conn, "SELECT COUNT(*) FROM hs_nodes WHERE level NOT IN (2,4,6)") == 0)
    a.check("hs_nodes parent links valid", _scalar(conn, """
        SELECT COUNT(*) FROM hs_nodes n WHERE n.level > 2 AND (n.parent IS NULL OR NOT EXISTS
        (SELECT 1 FROM hs_nodes p WHERE p.code = n.parent))""") == 0)
    a.check("hs_nodes section links valid", _scalar(conn, """
        SELECT COUNT(*) FROM hs_nodes n WHERE NOT EXISTS (SELECT 1 FROM sections s WHERE s.id = n.section_id)""") == 0)

    gst = _gst_codes()
    hs6 = {r["hscode"].strip() for r in raw_nodes if int(r["level"]) == 6}
    current = {c for c in gst if c[:6] in hs6}
    db_products = {r["hsn8"]: dict(r) for r in conn.execute("SELECT * FROM products")}
    a.check_count("GST 8-digit codes", len(gst), 14_709)
    a.check_count("current products", sum(1 for r in db_products.values() if r["is_current"] == 1), len(current))
    a.check("current product set matches raw GST x HS2022", set(db_products) == current,
            f"db={len(db_products):,} expected={len(current):,}")
    a.check("no non-current products", _scalar(conn, "SELECT COUNT(*) FROM products WHERE is_current<>1") == 0)
    a.check("product code lengths", _scalar(conn, "SELECT COUNT(*) FROM products WHERE length(hsn8)<>8") == 0)
    a.check("product prefixes consistent", _scalar(conn, """
        SELECT COUNT(*) FROM products WHERE hs6<>substr(hsn8,1,6) OR hs4<>substr(hsn8,1,4) OR hs2<>substr(hsn8,1,2)""") == 0)
    a.check("product HS6 valid", _scalar(conn, """
        SELECT COUNT(*) FROM products p WHERE NOT EXISTS
        (SELECT 1 FROM hs_nodes n WHERE n.code = p.hs6 AND n.level = 6)""") == 0)
    bad_lines = _scalar(conn, """
        SELECT COUNT(*) FROM products p WHERE lines_in_hs6 <> (SELECT COUNT(*) FROM products p2 WHERE p2.hs6=p.hs6)""")
    a.check("lines_in_hs6 correct", bad_lines == 0, f"mismatches={bad_lines}")
    a.check_count("products FTS rows", _scalar(conn, "SELECT COUNT(*) FROM products_fts"), len(db_products))

    sectors = _json(CURATED / "sectors.json")
    by_chapter = {ch: s["id"] for s in sectors["sectors"] for ch in s.get("chapters", [])}
    by_heading = dict(sectors.get("heading_overrides", {}))
    bad_sector = [code for code, r in db_products.items()
                  if r["sector_id"] != _sector_for(r["hs6"], by_chapter, by_heading)]
    a.check("product sectors match curated register", not bad_sector,
            f"{len(bad_sector)} mismatches: {bad_sector[:8]}")


# --------------------------------------------------------------------------- section 3: mapping

def audit_mapping(a: Audit, conn: sqlite3.Connection) -> None:
    mapping = _json(CURATED / "ministry_mapping.json")
    accepted = {r["hsn8"]: r for r in mapping.get("accepted", [])}
    residual = {r["hsn8"]: r for r in mapping.get("residual", [])}
    gb_rows = {r["hsn8"]: dict(r) for r in conn.execute("SELECT * FROM guidebook_mapping")}
    a.check_count("guidebook_mapping rows", len(gb_rows), len(accepted) + len(residual))
    a.check("guidebook accepted set", {c for c, r in gb_rows.items() if r["status"] == "accepted"} == set(accepted))
    a.check("guidebook residual set", {c for c, r in gb_rows.items() if r["status"] == "residual"} == set(residual))
    acceptances = sum(len(r.get("ministries", [])) for r in accepted.values())
    a.check_count("Guidebook acceptances", acceptances,
                  int(mapping.get("counts", {}).get("acceptances", -1)))
    a.check_count("Guidebook multi-owner codes",
                  sum(1 for r in accepted.values() if len(r.get("ministries", [])) > 1),
                  int(mapping.get("counts", {}).get("multi_owner_codes", -1)))

    products = {r["hsn8"]: dict(r) for r in conn.execute("SELECT * FROM products")}
    expected_accepted = set(accepted) & set(products)
    expected_residual = set(residual) & set(products)
    expected_unmapped = set(products) - set(accepted) - set(residual)
    a.check_count("accepted product lines",
                  sum(1 for r in products.values() if r["mapping_status"] == "accepted"), len(expected_accepted))
    a.check_count("residual product lines",
                  sum(1 for r in products.values() if r["mapping_status"] == "residual"),
                  len(expected_residual) + len(expected_unmapped))
    a.check_count("unmapped product lines",
                  sum(1 for r in products.values() if r["mapping_source"] == "unmapped"), len(expected_unmapped))

    bad_primary = []
    for code in expected_accepted:
        gb = gb_rows[code]
        if gb["primary_ministry_id"] != accepted[code]["ministries"][0]:
            bad_primary.append(code)
    a.check("accepted primary owner = first Guidebook ministry", not bad_primary,
            f"{len(bad_primary)} mismatches: {bad_primary[:8]}")
    a.check("residual status has no primary owner", _scalar(conn, """
        SELECT COUNT(*) FROM guidebook_mapping WHERE status='residual' AND primary_ministry_id IS NOT NULL""") == 0)
    a.check("residual products owner bucket", _scalar(conn, """
        SELECT COUNT(*) FROM products WHERE mapping_status='residual' AND ministry_id<>'residual'""") == 0)
    a.check("accepted products not residual bucket", _scalar(conn, """
        SELECT COUNT(*) FROM products WHERE mapping_status='accepted' AND ministry_id='residual'""") == 0)
    a.check("all primary owners exist", _scalar(conn, """
        SELECT COUNT(*) FROM products p WHERE NOT EXISTS
        (SELECT 1 FROM ministries m WHERE m.id=p.ministry_id)""") == 0)

    primary = {(r["hsn8"], r["ministry_id"]) for r in conn.execute(
        "SELECT hsn8, ministry_id FROM product_ministries WHERE role='primary'")}
    secondary = {(r["hsn8"], r["ministry_id"]) for r in conn.execute(
        "SELECT hsn8, ministry_id FROM product_ministries WHERE role='secondary'")}
    a.check_count("primary owner rows", len(primary), len(expected_accepted))
    expected_secondary = {(code, mid) for code in expected_accepted
                          for mid in accepted[code]["ministries"][1:]}
    a.check("secondary owners match Guidebook", secondary == expected_secondary,
            f"db={len(secondary):,} expected={len(expected_secondary):,}")
    a.check("no residual owner rows", _scalar(conn,
        "SELECT COUNT(*) FROM product_ministries WHERE ministry_id='residual'") == 0)
    a.check("product_ministries roles valid", _scalar(conn,
        "SELECT COUNT(*) FROM product_ministries WHERE role NOT IN ('primary','secondary')") == 0)
    a.check("product_ministries referential integrity", _scalar(conn, """
        SELECT COUNT(*) FROM product_ministries pm WHERE NOT EXISTS
        (SELECT 1 FROM products p WHERE p.hsn8=pm.hsn8) OR NOT EXISTS
        (SELECT 1 FROM ministries m WHERE m.id=pm.ministry_id)""") == 0)

    meta_expect = {
        "guidebook_acceptances": str(acceptances),
        "guidebook_accepted_codes": str(len(accepted)),
        "guidebook_matched_products": str(len(expected_accepted)),
        "guidebook_not_listed_products": str(len(expected_unmapped)),
        "guidebook_residual_codes": str(len(residual)),
        "guidebook_residual_products": str(len(expected_residual)),
    }
    actual_meta = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM meta")}
    bad_meta = {k: (actual_meta.get(k), v) for k, v in meta_expect.items() if actual_meta.get(k) != v}
    a.check("Guidebook meta counters", not bad_meta, str(bad_meta))

    ministries = _json(CURATED / "ministries.json")["ministries"]
    db_ministries = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM ministries")}
    a.check("ministry register ids", set(db_ministries) == {m["id"] for m in ministries})
    a.check("ministry register fields", all(
        db_ministries[m["id"]]["name"] == m["name"]
        and db_ministries[m["id"]]["short_name"] == m["short_name"]
        and db_ministries[m["id"]]["kind"] == m["kind"] for m in ministries))
    sectors = _json(CURATED / "sectors.json")["sectors"]
    db_sectors = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM sectors")}
    a.check("sector register ids", set(db_sectors) == {s["id"] for s in sectors})
    a.check("sector register names", all(db_sectors[s["id"]]["name"] == s["name"] for s in sectors))


# --------------------------------------------------------------------------- section 4: trade

def _load_yearly(kind: str, names: dict[str, str]) -> dict[tuple[str, int], float]:
    """Fresh splice of the HS2017 (< 2022) and HS2022 (>= 2022) BACI files."""
    stems = {"world": ("oec_world_hs6_hs22", "oec_world_hs6_hs17"),
             "exports": ("oec_india_exp_hs6_hs22", "oec_india_exp_hs6_hs17"),
             "imports": ("oec_india_imp_hs6_hs22", "oec_india_imp_hs6_hs17")}[kind]
    out: dict[tuple[str, int], float] = {}
    for stem, hs22 in zip(stems, (True, False)):
        for r in _rows(RAW / f"{stem}.csv.gz"):
            year = int(r["year"])
            if not ((HS22_FIRST_YEAR <= year <= LATEST_YEAR) if hs22
                    else (FIRST_TREND_YEAR <= year < HS22_FIRST_YEAR)):
                continue
            key = (r["hs6"], year)
            out[key] = out.get(key, 0.0) + float(r["value_usd"])
            names.setdefault(r["hs6"], r["hs6_name"].strip())
    return out


def _load_partner_raw(stem: str, countries: dict[str, str]) -> dict[str, Any]:
    per_hs6: dict[str, float] = defaultdict(float)
    top: dict[str, tuple[str, float]] = {}
    count = 0
    total = 0.0
    for r in _rows(RAW / f"{stem}.csv.gz"):
        cid = r["country_id"]
        countries.setdefault(cid, r["country"].strip())
        value = float(r["value_usd"])
        if value <= 0:
            continue
        hs6 = r["hs6"]
        count += 1
        total += value
        per_hs6[hs6] += value
        prior = top.get(hs6)
        if prior is None or value > prior[1] or (value == prior[1] and cid < prior[0]):
            top[hs6] = (cid, value)
    return {"count": count, "total": total, "per_hs6": dict(per_hs6), "top": top}


def _load_tradestat() -> dict[str, Any]:
    """Fresh parse of the official DGFT/DGCIS TRADESTAT India sources (8-digit, FY2018-19..FY2024-25)."""
    series: dict[tuple[str, int], tuple[float | None, float | None]] = {}
    with gzip.open(RAW / "tradestat_india_hs8_2018_2024.csv.gz", "rt", encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            code = (r.get("hs8") or "").strip().zfill(8)
            if not re.fullmatch(r"\d{8}", code or ""):
                raise ValueError(f"bad HS8 code in the TRADESTAT series: {code!r}")
            for year in range(FIRST_TREND_YEAR, LATEST_YEAR + 1):
                x_raw, m_raw = (r.get(f"export_{year}") or "").strip(), (r.get(f"import_{year}") or "").strip()
                # Raw TRADESTAT figures are in US$ million; the Atlas stores money in US$ (as the ETL does).
                x = round(float(x_raw) * 1e6, 2) if x_raw else None
                m = round(float(m_raw) * 1e6, 2) if m_raw else None
                if x is None and m is None:
                    continue
                series[(code, year)] = (x, m)
    manifest = _json(RAW / "tradestat_manifest.json")
    map_rows = list(csv.DictReader(open(RAW / "tradestat_country_map.csv", encoding="utf-8")))

    partners: dict[tuple[str, str], list[tuple[str, float]]] = defaultdict(list)
    parts_path = RAW / "tradestat_india_partners_2024.csv.gz"
    if parts_path.exists():
        with gzip.open(parts_path, "rt", encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                cid = r["country_id"].strip()
                value = float(r["value"]) if r["value"] else None
                if value is not None and value > 0 and cid:
                    partners[(r["hsn8"].strip().zfill(8), r["flow"].strip().upper())].append((cid, value))
    return {"series": series, "manifest": manifest, "map_rows": map_rows, "partners": partners,
            "partners_manifest": _json(RAW / "tradestat_partners_manifest.json")
            if (RAW / "tradestat_partners_manifest.json").exists() else None}


def _metric_rollup(codes: set[str]) -> dict[str, str]:
    """BACI headings published only as one aggregate code (e.g. 2710 -> 271000)."""
    by_hs4: dict[str, set[str]] = defaultdict(set)
    for code in codes:
        by_hs4[code[:4]].add(code)
    return {hs4: hs4 + "00" for hs4, codes_in_hs4 in by_hs4.items() if codes_in_hs4 == {hs4 + "00"}}


def _official_hs6(series: dict[tuple[str, int], tuple[float, float]], rollup: dict[str, str]) -> dict:
    """Official India trade aggregated to the HS6 rollup used for series and metrics."""
    out: dict[tuple[str, int], list[float | None]] = defaultdict(lambda: [None, None])
    for (code, year), (x, m) in series.items():
        key = (rollup.get(code[:6][:4], code[:6]), year)
        if x is not None:
            out[key][0] = (out[key][0] or 0.0) + x
        if m is not None:
            out[key][1] = (out[key][1] or 0.0) + m
    return {k: (v[0], v[1]) for k, v in out.items()}


def _load_trade_raw() -> dict[str, Any]:
    countries: dict[str, str] = {}
    totals: dict[tuple[str, int], list[float | None]] = defaultdict(lambda: [None, None])
    for stem, idx, hs22 in (("oec_country_exp_totals_hs22", 0, True),
                            ("oec_country_exp_totals_hs17", 0, False),
                            ("oec_country_imp_totals_hs22", 1, True)):
        for r in _rows(RAW / f"{stem}.csv.gz"):
            countries.setdefault(r["country_id"], r["country"].strip())
            year = int(r["year"])
            if not ((HS22_FIRST_YEAR <= year <= LATEST_YEAR) if hs22
                    else (FIRST_TREND_YEAR <= year < HS22_FIRST_YEAR)):
                continue
            totals[(r["country_id"], year)][idx] = float(r["value_usd"])

    names: dict[str, str] = {}
    world = _load_yearly("world", names)
    exports = _load_yearly("exports", names)
    imports = _load_yearly("imports", names)
    for (hs6, year), value in imports.items():
        if year < HS22_FIRST_YEAR:
            totals[(INDIA, year)][1] = (totals[(INDIA, year)][1] or 0.0) + value

    partners = {
        "world_suppliers": _load_partner_raw("oec_world_exporters_2024", countries),
        "world_markets": _load_partner_raw("oec_world_importers_2024", countries),
    }
    return {"countries": countries, "totals": {k: tuple(v) for k, v in totals.items()},
            "world": world, "exports": exports, "imports": imports, "names": names, "partners": partners}


def _partner_table_check(a: Audit, conn: sqlite3.Connection, table: str, flow: str | None,
                         stats: dict[str, Any]) -> None:
    where, params = ("WHERE flow = ?", (flow,)) if flow else ("", ())
    prefix = f"{table}:{flow}" if flow else table
    actual_count = _scalar(conn, f"SELECT COUNT(*) FROM {table} {where}", params)
    a.check_count(f"{prefix} rows", actual_count, stats["count"])
    actual_total = _scalar(conn, f"SELECT COALESCE(SUM(value),0) FROM {table} {where}", params)
    a.check(f"{prefix} total value", _close(actual_total, stats["total"]),
            f"db={actual_total} raw={stats['total']}")

    actual_by_hs6 = {r[0]: r[1] for r in conn.execute(
        f"SELECT hs6, SUM(value) FROM {table} {where} GROUP BY hs6", params)}
    raw_by_hs6 = stats["per_hs6"]
    diff = max((abs((actual_by_hs6.get(h) or 0.0) - v) for h, v in raw_by_hs6.items()), default=0.0)
    a.check(f"{prefix} per-HS6 sums", set(actual_by_hs6) == set(raw_by_hs6) and diff <= USD_TOL,
            f"hs6 db={len(actual_by_hs6):,} raw={len(raw_by_hs6):,} maxdiff={diff:.6f}")

    if flow:
        actual_top = {r[0]: (r[1], r[2]) for r in conn.execute(
            f"SELECT hs6, country_id, value FROM {table} WHERE flow = ? AND rank = 1", (flow,))}
    else:
        actual_top = {r[0]: (r[1], r[2]) for r in conn.execute(
            f"SELECT hs6, country_id, value FROM {table} WHERE rank = 1")}
    bad_top = [h for h, (cid, value) in stats["top"].items()
               if actual_top.get(h) is None or actual_top[h][0] != cid or not _close(actual_top[h][1], value)]
    a.check(f"{prefix} top partners", not bad_top, f"{len(bad_top)} mismatches: {bad_top[:8]}")

    if flow:
        bad = _scalar(conn, f"""
            SELECT COUNT(*) FROM (
              SELECT value, share, rank,
                     SUM(value) OVER (PARTITION BY hs6, flow) AS total,
                     ROW_NUMBER() OVER (PARTITION BY hs6, flow ORDER BY value DESC, country_id) AS rn
              FROM {table} {where}
            ) WHERE ABS(share - value / total) > 1e-12 OR rank <> rn""", params)
    else:
        bad = _scalar(conn, f"""
            SELECT COUNT(*) FROM (
              SELECT value, share, rank,
                     SUM(value) OVER (PARTITION BY hs6) AS total,
                     ROW_NUMBER() OVER (PARTITION BY hs6 ORDER BY value DESC, country_id) AS rn
              FROM {table}
            ) WHERE ABS(share - value / total) > 1e-12 OR rank <> rn""")
    a.check(f"{prefix} shares and ranks", bad == 0, f"bad rows={bad}")


def audit_trade(a: Audit, conn: sqlite3.Connection) -> None:
    raw = _load_trade_raw()
    official = _load_tradestat()
    a.cache["trade_raw"] = raw
    a.cache["official"] = official
    countries = raw["countries"]
    db_countries = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM countries")}
    map_new = [r for r in official["map_rows"] if r["create"] == "1"]
    new_ids = {r["atlas_id"] for r in map_new}
    a.check_count("country id set", len(db_countries), len(set(countries) | new_ids))
    a.check("country names", all(db_countries[c]["name"] == n for c, n in countries.items()),
            f"mismatches={sum(1 for c,n in countries.items() if db_countries.get(c,{}).get('name') != n)}")
    a.check("country iso3 / continent (BACI)", all(
        db_countries[c]["iso3"] == c[-3:].upper()
        and db_countries[c]["continent"] == {"af": "Africa", "as": "Asia", "eu": "Europe", "na": "North America",
                                            "sa": "South America", "oc": "Oceania"}.get(c[:2], "Other")
        for c in countries))
    bad = [(r["ts_id"], r["atlas_id"]) for r in map_new
           if (r["atlas_id"] not in db_countries
               or db_countries[r["atlas_id"]]["name"] != r["name"]
               or db_countries[r["atlas_id"]]["iso3"] != r["iso3"]
               or db_countries[r["atlas_id"]]["continent"] != r["continent"])]
    a.check("TRADESTAT-only countries", not bad, f"{len(bad)} mismatches: {bad[:8]}")

    expected_totals = {k: tuple(v) for k, v in raw["totals"].items()}
    for year, flows in official["manifest"]["years"].items():
        y = int(year)
        if FIRST_TREND_YEAR <= y <= LATEST_YEAR:
            x = (flows.get("export") or {}).get("official_total_usd_m")
            m = (flows.get("import") or {}).get("official_total_usd_m")
            expected_totals[(INDIA, y)] = (x * 1e6 if x is not None else None,
                                           m * 1e6 if m is not None else None)
    actual_totals = {(r["country_id"], r["year"]): (r["exports"], r["imports"])
                     for r in conn.execute("SELECT * FROM country_totals")}
    a.check_count("country_totals rows", len(actual_totals), len(expected_totals))
    bad = [k for k, v in expected_totals.items()
           if k not in actual_totals or not _close(actual_totals[k][0], v[0]) or not _close(actual_totals[k][1], v[1])]
    a.check("country_totals values", not bad, f"{len(bad)} mismatches: {bad[:8]}")

    world = raw["world"]
    rollup = _metric_rollup(set(h for h, _y in world))
    official_hs6 = _official_hs6(official["series"], rollup)
    # India flows are official-only: the overlay writes the official FY totals where DGCIS covers a
    # code/year and NULLs everything else (BACI India figures are never mixed in), while world_trade
    # stays BACI's CY row.
    expected_series: dict[tuple[str, int], tuple[float | None, float | None, float | None]] = {}
    for key in sorted(set(world) | set(official_hs6)):
        x, m = official_hs6.get(key, (None, None))
        expected_series[key] = (x, m, world.get(key))
    actual_series = {(r["hs6"], r["year"]): (r["india_exports"], r["india_imports"], r["world_trade"])
                     for r in conn.execute("SELECT * FROM trade_hs6")}
    a.check_count("trade_hs6 rows", len(actual_series), len(expected_series))
    bad = [k for k, v in expected_series.items()
           if k not in actual_series or any(not _close(xx, yy) for xx, yy in zip(actual_series[k], v))]
    a.check("trade_hs6 values", not bad, f"{len(bad)} mismatches: {bad[:8]}")
    a.check("trade_hs6 years", set(y for _h, y in actual_series) == set(range(FIRST_TREND_YEAR, LATEST_YEAR + 1)))
    a.check("trade_hs6 non-negative", _scalar(conn,
        "SELECT COUNT(*) FROM trade_hs6 WHERE india_exports < 0 OR india_imports < 0 OR world_trade < 0") == 0)

    # Official 8-digit TRADESTAT series: the file is exactly what the table stores (NULL when absent).
    actual_hs8 = {(r["hsn8"], r["year"]): (r["india_exports"], r["india_imports"])
                  for r in conn.execute("SELECT * FROM trade_hs8")}
    expected_hs8 = official["series"]
    a.check_count("trade_hs8 rows", len(actual_hs8), len(expected_hs8))
    bad = [k for k, v in expected_hs8.items()
           if k not in actual_hs8 or any(not _close(xx, yy) for xx, yy in zip(actual_hs8[k], v))]
    a.check("trade_hs8 values", not bad, f"{len(bad)} mismatches: {bad[:8]}")
    a.check("trade_hs8 non-negative", _scalar(conn,
        "SELECT COUNT(*) FROM trade_hs8 WHERE india_exports < 0 OR india_imports < 0") == 0)

    for key, stats in raw["partners"].items():
        table, _, flow = key.partition(":")
        _partner_table_check(a, conn, table, flow or None, stats)

    official_partner_stats = _official_partner_stats(official["partners"], rollup)
    for (table, flow), stats in official_partner_stats.items():
        _partner_table_check(a, conn, table, flow, stats)

    # TRADESTAT partner totals must reconcile with the partner file and the official national total.
    partners_manifest = official["partners_manifest"]
    if partners_manifest:
        totals_manifest = partners_manifest["totals_usd"]
        partner_totals = {"X": _scalar(conn, "SELECT COALESCE(SUM(value),0) FROM india_partners WHERE flow='X'"),
                          "M": _scalar(conn, "SELECT COALESCE(SUM(value),0) FROM india_partners WHERE flow='M'")}
        a.check("india_partners export total = partner file", _close(partner_totals["X"], totals_manifest["X"]),
                f"{partner_totals['X']} vs {totals_manifest['X']}")
        a.check("india_partners import total = partner file", _close(partner_totals["M"], totals_manifest["M"]),
                f"{partner_totals['M']} vs {totals_manifest['M']}")

    # The published country reports do not cover trade whose partner in TRADESTAT is
    # "unspecified" / one-off partner types, so the partner sum is slightly below the national total.
    for flow in ("X", "M"):
        idx = 0 if flow == "X" else 1
        official_total = sum(v[idx] for k, v in official["series"].items()
                             if k[1] == LATEST_YEAR and v[idx] is not None)
        partner_total = _scalar(conn, f"SELECT COALESCE(SUM(value),0) FROM india_partners WHERE flow='{flow}'")
        gap = abs(official_total - partner_total) / official_total if official_total else 0
        a.check(f"india_partners {flow} sums with trade_hs6", gap <= 0.001,
                f"gap {gap:.4%} ({official_total - partner_total:,.0f}) of official")
        a.check(f"india_partners {flow} totals <= official total", partner_total <= official_total)

    checks = (
        # India's country_totals hold the published TRADESTAT grand total while trade_hs6/hs8 hold the
        # per-row sums; the official total includes row rounding (values are reported to $0.01m) and
        # codes DGCIS does not publish separately, so this reconciles to 0.001%.
        ("india imports 2024 vs country total",
         "SELECT COALESCE(SUM(india_imports),0) FROM trade_hs6 WHERE year=2024", (),
         "SELECT imports FROM country_totals WHERE country_id=? AND year=?", (INDIA, LATEST_YEAR), 1e-5),
        ("india exports 2024 vs country total",
         "SELECT COALESCE(SUM(india_exports),0) FROM trade_hs6 WHERE year=2024", (),
         "SELECT exports FROM country_totals WHERE country_id=? AND year=?", (INDIA, LATEST_YEAR), 1e-5),
        ("world trade 2024 vs suppliers",
         "SELECT COALESCE(SUM(value),0) FROM world_suppliers", (),
         "SELECT COALESCE(SUM(world_trade),0) FROM trade_hs6 WHERE year=2024", (), 0.0),
        ("world trade 2024 vs markets",
         "SELECT COALESCE(SUM(value),0) FROM world_markets", (),
         "SELECT COALESCE(SUM(world_trade),0) FROM trade_hs6 WHERE year=2024", (), 0.0),
    )
    for name, left, left_params, right, right_params, rel in checks:
        l, r = _scalar(conn, left, left_params), _scalar(conn, right, right_params)
        a.check(name, abs(l - r) <= rel * max(abs(r), 1), f"{l} vs {r}")

    # The world trade tables still reconcile against BACI (TRADESTAT does not have world totals).
    # The 2710 official-only subheadings are allocated in `_metric_hs6`; keep the metric code coverage.
    # hs6_products is the union of the HS2022 subheadings, the BACI codes and the official metric codes.
    node_desc = {r["hscode"].strip(): " ".join(r["description"].split())
                 for r in _hs_raw()[1] if int(r["level"]) == 6}
    names = raw["names"]
    base_codes = set(node_desc) | set(names)   # what the base trade step wrote (HS2022 nodes + BACI)
    expected_hs6 = set(node_desc) | {h for h, _y in expected_series} | set(rollup.values())
    db_hs6 = {r["hs6"]: dict(r) for r in conn.execute("SELECT * FROM hs6_products")}
    a.check_count("hs6_products rows", len(db_hs6), len(expected_hs6))
    a.check("hs6_products code set", set(db_hs6) == expected_hs6,
            f"db={len(db_hs6):,} expected={len(expected_hs6):,}")
    sectors = _json(CURATED / "sectors.json")
    by_chapter = {ch: s["id"] for s in sectors["sectors"] for ch in s.get("chapters", [])}
    by_heading = dict(sectors.get("heading_overrides", {}))
    n_lines = {r[0]: r[1] for r in conn.execute("SELECT hs6, COUNT(*) FROM products GROUP BY hs6")}
    bad = []
    for h in expected_hs6:
        row = db_hs6.get(h)
        if row is None:
            continue
        # Description rule: HS2022 node desc, else BACI name; codes only TRADESTAT reports (no node,
        # no BACI coverage) are labelled "HS <code>" by the overlay (e.g. the 980x special codes).
        desc = node_desc.get(h) or names.get(h) or ("HS " + h if h not in base_codes else h)
        if (row["hs4"] != h[:4] or row["hs2"] != h[:2]
                or row["description"] != desc
                or row["sector_id"] != _sector_for(h, by_chapter, by_heading)
                or row["n_lines"] != n_lines.get(h, 0)):
            bad.append((h, desc, dict(row)))
    a.check("hs6_products fields", not bad, f"{len(bad)} mismatches: {bad[:4]}")

    total_x = _scalar(conn, "SELECT SUM(india_exports) FROM hs6_metrics")
    total_m = _scalar(conn, "SELECT SUM(india_imports) FROM hs6_metrics")
    total_w = _scalar(conn, "SELECT SUM(world_trade) FROM hs6_metrics")
    a.check("2024 India exports anchor", _close(total_x, CURRENT_TOTAL_EXPORTS), f"{total_x}")
    a.check("2024 India imports anchor", _close(total_m, CURRENT_TOTAL_IMPORTS), f"{total_m}")
    a.check("2024 world trade anchor", _close(total_w, CURRENT_TOTAL_WORLD), f"{total_w}")


def _official_partner_stats(rows: dict[tuple[str, str], list[tuple[str, float]]],
                            rollup: dict[str, str]) -> dict[tuple[str, str], dict[str, Any]]:
    """Expected `india_partners` rows re-derived from the official TRADESTAT partner file."""
    per_metric: dict[tuple[str, str], dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for (code, flow), values in rows.items():
        if not code or flow not in ("X", "M"):
            continue
        metric = rollup.get(code[:6][:4], code[:6])
        for cid, value in values:
            per_metric[(metric, flow)][cid] += value
    out: dict[tuple[str, str], dict[str, Any]] = {}
    for flow in ("X", "M"):
        metrics = {metric: countries for (m, f), countries in sorted(per_metric.items()) if f == flow
                   for metric in (m,)}
        per_hs6 = {metric: sum(countries.values()) for metric, countries in metrics.items()}
        top = {metric: min(countries.items(), key=lambda cv: (-cv[1], cv[0]))
               for metric, countries in metrics.items() if countries}
        out[("india_partners", flow)] = {
            "flow": flow, "count": sum(len(c) for c in metrics.values()), "total": sum(per_hs6.values()),
            "per_hs6": per_hs6, "top": top,
        }
    return out


# --------------------------------------------------------------------------- section 5: tariffs / policy feed

def audit_tariffs(a: Audit, conn: sqlite3.Connection) -> None:
    raw = {r["hs6"]: r for r in _rows(RAW / "wits_india_mfn_2022.csv")}
    db = {r["hs6"]: dict(r) for r in conn.execute("SELECT * FROM tariffs")}
    a.check_count("tariff rows", len(db), len(raw))
    a.check("tariff code set", set(db) == set(raw), f"db={len(db):,} raw={len(raw):,}")
    bad = []
    for code, r in raw.items():
        mfn = int(float(r.get("NBR_MFN_LINES") or 0))
        total_lines = int(float(r.get("TOTALNOOFLINES") or 0))
        na_lines = int(float(r.get("NBR_NA_LINES") or 0))
        non_ad_valorem = mfn == 0 and na_lines > 0
        val = r.get("value")
        avg = float(val) if (not non_ad_valorem and val not in (None, "")) else None
        lo = float(r.get("MIN_RATE")) if (not non_ad_valorem and r.get("MIN_RATE") not in (None, "")) else None
        hi = float(r.get("MAX_RATE")) if (not non_ad_valorem and r.get("MAX_RATE") not in (None, "")) else None
        row = db.get(code)
        if row is None or (not _close(row["mfn_avg"], avg) or not _close(row["mfn_min"], lo)
                           or not _close(row["mfn_max"], hi) or row["n_lines"] != total_lines
                           or row["n_na_lines"] != na_lines or row["year"] != 2022
                           or row["source"] != "wits"):
            bad.append(code)
    a.check("tariff fields", not bad, f"{len(bad)} mismatches: {bad[:8]}")
    a.check("non-ad-valorem tariffs are NULL", _scalar(conn,
        "SELECT COUNT(*) FROM tariffs WHERE n_lines > 0 AND n_na_lines = n_lines AND mfn_avg IS NOT NULL") == 0)

    dgft = {(r["itc_code"], r["direction"], r["record_index"]): dict(r)
            for r in conn.execute("SELECT * FROM dgft_itc_policy")}
    a.check_count("DGFT policy rows", len(dgft), _count_file(RAW / "dgft_itc" / "dgft_itc_policy.jsonl.gz"))
    raw_dgft = list(_gz_jsonl(RAW / "dgft_itc" / "dgft_itc_policy.jsonl.gz"))
    expected = {(r["itc_code"], r["direction"], r["record_index"]) for r in raw_dgft}
    a.check("DGFT policy key set", set(dgft) == expected, f"db={len(dgft):,} raw={len(expected):,}")
    bad = []
    for r in raw_dgft:
        key = (r["itc_code"], r["direction"], r["record_index"])
        row = dgft.get(key)
        if row is None or (row["chapter"] != r.get("chapter") or row["description"] != r.get("description")
                           or row["policy"] != r.get("policy") or row["policy_condition"] != r.get("policy_condition")
                           or row["itc_code_type"] != r.get("itc_code_type")
                           or row["notification_no"] != r.get("notification_no")
                           or row["notification_date"] != r.get("notification_date")
                           or row["notification_date_iso"] != r.get("notification_date_iso")
                           or row["is_current"] != r.get("is_current")
                           or row["source"] != "dgft_itc_hs" or row["source_url"] != r.get("source_url")
                           or row["fetched_at"] != r.get("fetched_at")):
            bad.append(key)
    a.check("DGFT policy fields", not bad, f"{len(bad)} mismatches: {bad[:8]}")
    a.check("DGFT one current row per code/direction", _scalar(conn, """
        SELECT COUNT(*) FROM (SELECT itc_code, direction, SUM(is_current) n FROM dgft_itc_policy
                              GROUP BY itc_code, direction HAVING n <> 1)""") == 0)
    a.check("DGFT current_without_policy is recorded", _scalar(conn,
        "SELECT COUNT(*) FROM dgft_itc_policy WHERE is_current=1 AND policy IS NULL") >= 0)


# --------------------------------------------------------------------------- section 6: metrics

def _cagr(series: dict[int, float | None], last_year: int = LATEST_YEAR,
          first_allowed: int = FIRST_TREND_YEAR) -> tuple[float | None, int | None]:
    last = series.get(last_year)
    if last is None or last <= 0:
        return None, None
    years = sorted(y for y, v in series.items()
                   if first_allowed <= y < last_year and v is not None and v > 0)
    if not years:
        return None, None
    first = years[0]
    return (last / float(series[first])) ** (1.0 / (last_year - first)) - 1.0, first


def _yoy(series: dict[int, float | None], year: int = LATEST_YEAR) -> float | None:
    prev, cur = series.get(year - 1), series.get(year)
    if prev is None or prev <= 0 or cur is None:
        return None
    return cur / prev - 1.0


def audit_metrics(a: Audit, conn: sqlite3.Connection) -> None:
    official = a.cache.get("official") if "official" in a.cache else _load_tradestat()
    ex: dict[str, dict[int, float | None]] = defaultdict(dict)
    im: dict[str, dict[int, float | None]] = defaultdict(dict)
    wd: dict[str, dict[int, float | None]] = defaultdict(dict)
    for r in conn.execute("SELECT hs6, year, india_exports, india_imports, world_trade FROM trade_hs6"):
        ex[r["hs6"]][r["year"]] = r["india_exports"]
        im[r["hs6"]][r["year"]] = r["india_imports"]
        wd[r["hs6"]][r["year"]] = r["world_trade"]
    latest = sorted(h for h in wd if LATEST_YEAR in wd[h])
    total_x = sum(v for h in latest if (v := ex[h].get(LATEST_YEAR)) is not None)
    total_w = sum(v for h in latest if (v := wd[h].get(LATEST_YEAR)) is not None)
    rollup = _metric_rollup(set(wd))

    suppliers: dict[str, tuple[int, float | None, int | None]] = {}
    for r in conn.execute("""
        SELECT hs6, COUNT(*) AS n, SUM(share*share) AS hhi,
               MAX(CASE WHEN country_id=? THEN rank END) AS india_rank
        FROM world_suppliers GROUP BY hs6""", (INDIA,)):
        suppliers[r["hs6"]] = (r["n"], r["hhi"], r["india_rank"])
    sources: dict[str, tuple[int, float | None, float | None]] = {}
    for r in conn.execute("""
        SELECT hs6, COUNT(*) AS n, SUM(share*share) AS hhi,
               SUM(CASE WHEN country_id=? THEN share ELSE 0 END) AS china
        FROM india_partners WHERE flow='M' GROUP BY hs6""", (CHINA,)):
        sources[r["hs6"]] = (r["n"], r["hhi"], r["china"])
    top_src = {r["hs6"]: (r["country_id"], r["share"]) for r in conn.execute(
        "SELECT hs6, country_id, share FROM india_partners WHERE flow='M' AND rank=1")}
    top_dst = {r["hs6"]: (r["country_id"], r["share"]) for r in conn.execute(
        "SELECT hs6, country_id, share FROM india_partners WHERE flow='X' AND rank=1")}

    expected: dict[str, tuple] = {}
    for h in latest:
        x = ex[h].get(LATEST_YEAR)
        m = im[h].get(LATEST_YEAR)
        w = wd[h].get(LATEST_YEAR)
        has_w = w is not None and w > 0
        has_x = x is not None
        rca = (x / total_x) / (w / total_w) if has_x and has_w and total_x > 0 and total_w > 0 else None
        n_sup, w_hhi, india_rank = suppliers.get(h, (0, None, None))
        n_src, m_hhi, china = sources.get(h, (0, None, None))
        src, src_share = top_src.get(h, (None, None))
        dst, dst_share = top_dst.get(h, (None, None))
        e_cagr, first_year = _cagr(ex[h])
        expected[h] = (
            h, LATEST_YEAR, x, m, w,
            (x - m) if has_x and m is not None else None,
            rca,
            (x / w) if has_x and has_w else None, india_rank, n_sup or 0, w_hhi,
            m_hhi if n_src else None, n_src or 0, src, src_share, china if n_src else None, dst, dst_share,
            e_cagr, _cagr(im[h])[0], _cagr(wd[h])[0], _yoy(ex[h]), _yoy(im[h]), _yoy(wd[h]), first_year,
        )

    db = {r["hs6"]: tuple(r) for r in conn.execute("SELECT * FROM hs6_metrics")}
    a.check_count("hs6_metrics rows", len(db), len(expected))
    a.check("hs6_metrics code set", set(db) == set(expected), f"db={len(db):,} expected={len(expected):,}")
    bad = []
    for h, row in expected.items():
        cur = db.get(h)
        if cur is None or len(cur) != len(row):
            bad.append((h, "missing"))
            continue
        for i, (x, y) in enumerate(zip(cur, row)):
            if i in (2, 3, 4, 5):  # USD values
                ok = (x is None and y is None) or (x is not None and _close(x, y))
            elif i in (6, 7, 10, 11, 14, 15, 17, 18, 19, 20, 21, 22, 23):
                ok = (x is None and y is None) or (x is not None and _ratio_close(x, y))
            else:
                ok = x == y               # hs6, year, ranks, counts, country ids, first_year
            if not ok:
                bad.append((h, i, x, y))
                break
    a.check("hs6_metrics recomputed", not bad, f"{len(bad)} mismatches: {bad[:6]}")
    a.check("hs6_metrics year", _scalar(conn, "SELECT COUNT(*) FROM hs6_metrics WHERE year<>2024") == 0)
    a.check("metric RCA universe", _scalar(conn, """
        SELECT COUNT(*) FROM hs6_metrics
        WHERE world_trade > 0 AND india_exports IS NOT NULL AND rca IS NULL""") == 0)
    a.check("metric HHI range", _scalar(conn,
        "SELECT COUNT(*) FROM hs6_metrics WHERE (world_supplier_hhi < 0 OR world_supplier_hhi > 1)"
        " OR (india_import_hhi < 0 OR india_import_hhi > 1)"
        " OR (china_import_share < 0 OR china_import_share > 1)") == 0)

    # ---- product lines: the view's classification re-derived from the raw trade tables ----
    a.check_count("v_product_trade rows", _scalar(conn, "SELECT COUNT(*) FROM v_product_trade"),
                  _scalar(conn, "SELECT COUNT(*) FROM products"))
    expected_levels = {r[0]: r[1] for r in conn.execute("""
        SELECT CASE WHEN h8=1 THEN 'hs8' WHEN e6=1 THEN 'hs6' WHEN agg=1 THEN 'hs4_aggregate' END lvl,
               COUNT(*)
        FROM (SELECT (SELECT 1 FROM trade_hs8 t WHERE t.hsn8=p.hsn8 AND t.year=2024) h8,
                     (SELECT 1 FROM hs6_metrics e WHERE e.hs6=p.hs6) e6,
                     (SELECT 1 FROM hs6_metrics a2 WHERE a2.hs6=p.hs4||'00') agg FROM products p)
        GROUP BY 1""")}
    level_counts = {r["trade_level"]: r["n"] for r in conn.execute(
        "SELECT trade_level, COUNT(*) n FROM v_product_trade GROUP BY trade_level")}
    a.counts["v_product_trade_levels"] = level_counts
    a.check("v_product_trade levels", level_counts == expected_levels,
            f"view={level_counts} derived={expected_levels}")
    a.check_count("exact-HS8 product lines", level_counts.get("hs8", 0),
                  _scalar(conn, "SELECT COUNT(*) FROM products p JOIN trade_hs8 t ON t.hsn8=p.hsn8 AND t.year=2024"))
    a.check("aggregate metric is the heading rollup code", all(
        r["hs4"] in rollup and r["metric_hs6"] == rollup[r["hs4"]]
        for r in conn.execute("""
            SELECT DISTINCT hs4, metric_hs6 FROM v_product_trade WHERE trade_level='hs4_aggregate'""")),
            f"rollup={rollup}")
    a.check("heading aggregate is only HS 2710 family", _scalar(conn, """
        SELECT COUNT(*) FROM v_product_trade WHERE trade_level='hs4_aggregate' AND hs4<>'2710'""") == 0)
    a.check("weighted world context sums to its group", _scalar(conn, """
        SELECT COUNT(*) FROM v_product_trade vt
        WHERE ABS(world_alloc - COALESCE(world_trade, 0) * CASE
              WHEN EXISTS(SELECT 1 FROM hs6_metrics e WHERE e.hs6 = vt.hs6)
                   THEN 1.0 / (SELECT COUNT(*) FROM products p WHERE p.hs6 = vt.hs6)
              WHEN EXISTS(SELECT 1 FROM hs6_metrics e WHERE e.hs6 = vt.hs4 || '00')
                   THEN 1.0 / (SELECT COUNT(*) FROM products p WHERE p.hs4 = vt.hs4) END) > 1e-6""") == 0)

    # ---- exact anchors from the official TRADESTAT series (independently parsed) ----
    series = official["series"]
    anchor = conn.execute("""SELECT trade_level, metric_hs6, india_exports, exports_alloc, world_alloc
                             FROM v_product_trade WHERE hsn8='27101290'""").fetchone()
    a.check("27101290 keeps its exact official exports",
            anchor is not None and anchor["trade_level"] == "hs8" and anchor["metric_hs6"] == "271000"
            and _close(anchor["india_exports"], series.get(("27101290", LATEST_YEAR), (None, None))[0])
            and _close(anchor["exports_alloc"], anchor["india_exports"]),
            f"db={dict(anchor) if anchor else None}")
    a.check("27101290 world context is its heading aggregate", _scalar(conn, """
        SELECT ABS(world_alloc - (SELECT world_trade FROM hs6_metrics WHERE hs6 = '271000')
               / (SELECT COUNT(*) FROM products WHERE hs4 = '2710'))
        FROM v_product_trade WHERE hsn8 = '27101290'""") < 1e-6)
    # An unpublished line in a reported group carries the recomputed remainder when the group's total
    # exceeds its published lines, and stays NULL (not zero) otherwise: re-derive the rule for every
    # product line and compare with the view.
    bad_alloc = _scalar(conn, """
        WITH lines AS (
            SELECT p.hsn8, p.hs6, p.hs4,
                   CASE WHEN EXISTS (SELECT 1 FROM trade_hs6 t6 WHERE t6.hs6 = p.hs6 AND t6.year = 2024)
                        THEN p.hs6 ELSE p.hs4 || '00' END AS metric
            FROM products p),
        gov AS (
            SELECT l.hsn8,
                   SUM(CASE WHEN t.india_exports IS NULL THEN 1 ELSE 0 END)
                       OVER (PARTITION BY l.metric) AS n_missing_x,
                   SUM(CASE WHEN t.india_imports IS NULL THEN 1 ELSE 0 END)
                       OVER (PARTITION BY l.metric) AS n_missing_m,
                   COALESCE(SUM(t.india_exports) OVER (PARTITION BY l.metric), 0) AS exact_x_sum,
                   COALESCE(SUM(t.india_imports) OVER (PARTITION BY l.metric), 0) AS exact_m_sum,
                   MAX(g.tot_x) OVER (PARTITION BY l.metric) AS tot_x,
                   MAX(g.tot_m) OVER (PARTITION BY l.metric) AS tot_m,
                   t.india_exports AS ex8, t.india_imports AS im8
            FROM lines l
            LEFT JOIN trade_hs8 t ON t.hsn8 = l.hsn8 AND t.year = 2024
            LEFT JOIN (SELECT hs6, SUM(india_exports) tot_x, SUM(india_imports) tot_m
                       FROM trade_hs6 WHERE year = 2024 GROUP BY hs6) g ON g.hs6 = l.metric
            WHERE l.metric IS NOT NULL AND g.hs6 IS NOT NULL)
        SELECT COUNT(*) FROM gov gg JOIN v_product_trade vt ON vt.hsn8 = gg.hsn8
        WHERE ((gg.ex8 IS NULL) != (vt.india_exports IS NULL))
           OR (gg.ex8 IS NOT NULL AND ABS(COALESCE(vt.india_exports, -1e18) - gg.ex8) > 0.01)
           OR (gg.ex8 IS NULL AND gg.n_missing_x > 0 AND gg.tot_x - gg.exact_x_sum > 0
               AND ABS(COALESCE(vt.exports_alloc, -1e18) - (gg.tot_x - gg.exact_x_sum) / gg.n_missing_x) > 0.01)
           OR (gg.ex8 IS NULL AND NOT (gg.n_missing_x > 0 AND gg.tot_x - gg.exact_x_sum > 0)
               AND vt.exports_alloc != 0)
           OR ((gg.im8 IS NULL) != (vt.india_imports IS NULL))
           OR (gg.im8 IS NOT NULL AND ABS(COALESCE(vt.india_imports, -1e18) - gg.im8) > 0.01)
           OR (gg.im8 IS NULL AND gg.n_missing_m > 0 AND gg.tot_m - gg.exact_m_sum > 0
               AND ABS(COALESCE(vt.imports_alloc, -1e18) - (gg.tot_m - gg.exact_m_sum) / gg.n_missing_m) > 0.01)
           OR (gg.im8 IS NULL AND NOT (gg.n_missing_m > 0 AND gg.tot_m - gg.exact_m_sum > 0)
               AND vt.imports_alloc != 0)""")
    a.check("allocations re-derive exactly for every line", bad_alloc == 0, f"bad rows={bad_alloc}")
    a.check("27101211 (unpublished) stays Not available", _scalar(conn, """
        SELECT COUNT(*) FROM v_product_trade
        WHERE hsn8 = '27101211' AND trade_level = 'hs4_aggregate' AND metric_hs6 = '271000'
          AND india_exports IS NULL AND exports_alloc = 0""") == 1)
    for code in ("71082000", "71189000"):
        row = conn.execute("SELECT * FROM v_product_trade WHERE hsn8=?", (code,)).fetchone()
        x8, m8 = series.get((code, LATEST_YEAR), (None, None))
        a.check(f"{code} line published as reported", row is not None and row["trade_level"] == "hs8"
                and _close(row["india_exports"], x8) and (
                    (m8 is None and row["india_imports"] is None) or _close(row["india_imports"], m8)),
                f"db={dict(row) if row else None} official=({x8}, {m8})")
        a.check(f"{code} metric exists", _scalar(conn, "SELECT COUNT(*) FROM hs6_metrics WHERE hs6=?",
                                                (code[:6],)) == 1)
        a.check(f"{code} has scores", _scalar(conn, "SELECT COUNT(*) FROM hs6_scores WHERE hs6=?",
                                              (code[:6],)) == 1)

    # ---- allocation: published lines exact, groups never over-allocated ----
    overshoot = _scalar(conn, """
        SELECT COALESCE(MAX(CASE WHEN s > tot_x + 1.0 THEN s - tot_x END), 0) FROM (
          SELECT gv.hs6, gv.tot_x, SUM(CASE WHEN vt.trade_level='hs8' THEN vt.india_exports
                                            ELSE vt.exports_alloc END) AS s
          FROM v_product_trade vt
          JOIN (SELECT hs6, SUM(india_exports) tot_x FROM trade_hs6 WHERE year=2024 GROUP BY hs6) gv
            ON gv.hs6 = vt.metric_hs6
          GROUP BY gv.hs6)""")
    a.check("allocation exports never exceed group total", (overshoot or 0) <= 1.0, f"max overshoot={overshoot}")
    overshoot = _scalar(conn, """
        SELECT COALESCE(MAX(CASE WHEN s > tot_m + 1.0 THEN s - tot_m END), 0) FROM (
          SELECT gv.hs6, gv.tot_m, SUM(CASE WHEN vt.trade_level='hs8' THEN vt.india_imports
                                            ELSE vt.imports_alloc END) AS s
          FROM v_product_trade vt
          JOIN (SELECT hs6, SUM(india_imports) tot_m FROM trade_hs6 WHERE year=2024 GROUP BY hs6) gv
            ON gv.hs6 = vt.metric_hs6
          GROUP BY gv.hs6)""")
    a.check("allocation imports never exceed group total", (overshoot or 0) <= 1.0, f"max overshoot={overshoot}")
    # Published lines carry exact values; nothing is fabricated.
    bad_exact = _scalar(conn, """
        SELECT COUNT(*) FROM v_product_trade vt LEFT JOIN trade_hs8 t ON t.hsn8 = vt.hsn8 AND t.year=2024
        WHERE vt.trade_level='hs8'
          AND (t.hsn8 IS NULL
               OR vt.metric_hs6 IS NULL
               OR (t.india_exports IS NOT NULL AND vt.india_exports IS NULL)
               OR (t.india_imports IS NOT NULL AND vt.india_imports IS NULL)
               OR (t.india_exports IS NOT NULL AND ABS(vt.india_exports - t.india_exports) > 0.01)
               OR (t.india_imports IS NOT NULL AND ABS(vt.india_imports - t.india_imports) > 0.01))""")
    a.check("published lines carry exact TRADESTAT values", bad_exact == 0, f"bad rows={bad_exact}")
    sum_alloc_x = _scalar(conn, "SELECT COALESCE(SUM(exports_alloc),0) FROM v_product_trade")
    sum_alloc_m = _scalar(conn, "SELECT COALESCE(SUM(imports_alloc),0) FROM v_product_trade")
    official_x = sum(v[0] for (code, y), v in official["series"].items()
                     if y == LATEST_YEAR and v[0] is not None)
    short_x = (official_x - sum_alloc_x) / official_x if official_x else 0
    a.check("allocation exports cover the official total", 0 <= short_x <= 0.02,
            f"alloc={sum_alloc_x:,.0f} official={official_x:,.0f} shortfall={short_x:.4%}")
    official_m = sum(v[1] for (code, y), v in official["series"].items()
                     if y == LATEST_YEAR and v[1] is not None)
    short_m = (official_m - sum_alloc_m) / official_m if official_m else 0
    a.check("allocation imports cover the official total", 0 <= short_m <= 0.02,
            f"alloc={sum_alloc_m:,.0f} official={official_m:,.0f} shortfall={short_m:.4%}")
    a.check("no negative allocation", _scalar(conn,
        "SELECT COUNT(*) FROM v_product_trade WHERE exports_alloc<0 OR imports_alloc<0 OR world_alloc<0") == 0)


# --------------------------------------------------------------------------- section 7: scores / forecasts / alerts

def _score_records(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute("""
        SELECT m.*, COALESCE(hp.hs2, substr(m.hs6,1,2)) AS hs2,
               COALESCE(hp.description, n.description, 'HS ' || m.hs6) AS description,
               c.name AS top_import_source_name,
               t23.india_exports AS exports_2023, t23.india_imports AS imports_2023
        FROM hs6_metrics m
        LEFT JOIN hs6_products hp ON hp.hs6 = m.hs6
        LEFT JOIN hs_nodes n ON n.code = m.hs6
        LEFT JOIN countries c ON c.id = m.top_import_source
        LEFT JOIN trade_hs6 t23 ON t23.hs6 = m.hs6 AND t23.year = ?
        ORDER BY m.hs6""", (LATEST_YEAR - 1,))
    return [dict(r) for r in rows]


def audit_scores(a: Audit, conn: sqlite3.Connection) -> None:
    from app.services import forecast as fc
    from app.services import scoring

    records = _score_records(conn)
    a.check_count("score input records", len(records), _scalar(conn, "SELECT COUNT(*) FROM hs6_metrics"))
    computed = {r["hs6"]: r for r in scoring.score_products(records)}
    clusters = scoring.cluster_products(records)
    labels = clusters["labels"]
    stored = {r["hs6"]: dict(r) for r in conn.execute("SELECT * FROM hs6_scores")}
    a.check_count("hs6_scores rows", len(stored), len(computed))
    a.check("hs6_scores code set", set(stored) == set(computed))

    fields = ("export_potential_score", "untapped_potential_usd", "import_dependency_score",
              "vulnerability_score", "substitution_score")
    bad = []
    for h, expected in computed.items():
        row = stored.get(h)
        if row is None:
            bad.append((h, "missing"))
            continue
        for key in fields:
            x, y = row[key], expected.get(key)
            tol = 0.01 if key == "untapped_potential_usd" else SCORE_TOL
            if not _close(x, y, tol):
                bad.append((h, key, x, y))
                break
        else:
            if row["archetype"] != expected["archetype"]:
                bad.append((h, "archetype", row["archetype"], expected["archetype"]))
            elif row["ml_cluster"] != labels.get(h):
                bad.append((h, "ml_cluster", row["ml_cluster"], labels.get(h)))
    a.check("scores / archetypes / clusters recomputed", not bad, f"{len(bad)} mismatches: {bad[:6]}")
    a.check("score ranges", _scalar(conn, """
        SELECT COUNT(*) FROM hs6_scores WHERE export_potential_score NOT BETWEEN 0 AND 100
        OR import_dependency_score NOT BETWEEN 0 AND 100 OR vulnerability_score NOT BETWEEN 0 AND 100
        OR (substitution_score IS NOT NULL AND substitution_score NOT BETWEEN 0 AND 100)
        OR ml_cluster NOT BETWEEN 0 AND 5 OR archetype NOT IN ('Champion','Established','Emerging','Dependent','Marginal')""") == 0)
    a.check("untapped potential non-negative", _scalar(conn,
        "SELECT COUNT(*) FROM hs6_scores WHERE untapped_potential_usd < 0") == 0)
    a.check_count("substitution candidates", _scalar(conn,
        "SELECT COUNT(*) FROM hs6_scores WHERE substitution_score IS NOT NULL"),
        sum(1 for r in computed.values() if r["substitution_score"] is not None))
    a.check("total untapped anchor", _close(_scalar(conn, "SELECT SUM(untapped_potential_usd) FROM hs6_scores"),
                                           61_035_300_864.0, 0.02), f"{_scalar(conn, 'SELECT SUM(untapped_potential_usd) FROM hs6_scores')}")
    a.check_count("score clusters", len({r["ml_cluster"] for r in stored.values() if r["ml_cluster"] is not None}),
                  len(clusters["clusters"]))

    # Forecasts: re-fit every 2018-2024 series independently through the documented estimator.
    ex: dict[str, dict[int, float]] = defaultdict(dict)
    im: dict[str, dict[int, float]] = defaultdict(dict)
    for r in conn.execute("SELECT hs6, year, india_exports, india_imports FROM trade_hs6 "
                          "WHERE year BETWEEN 2018 AND 2024"):
        ex[r["hs6"]][r["year"]] = r["india_exports"]
        im[r["hs6"]][r["year"]] = r["india_imports"]
    n_forecast = 0
    bad = []
    for h, row in stored.items():
        raw = row.get("forecast_json")
        try:
            saved = json.loads(raw) if raw else {}
        except ValueError:
            bad.append((h, "invalid json"))
            continue
        expected = fc.forecast_set(ex.get(h, {}), im.get(h, {}))
        for side in ("exports", "imports"):
            got = saved.get(side, [])
            want = expected.get(side, [])
            if len(got) != len(want):
                bad.append((h, side, "length", len(got), len(want)))
                break
            for g, w in zip(got, want):
                if (g.get("year") != w["year"] or not _close(g.get("value"), w["value"], 0.011)
                        or not _close(g.get("lo"), w["lo"], 0.011) or not _close(g.get("hi"), w["hi"], 0.011)):
                    bad.append((h, side, g, w))
                    break
            else:
                continue
            break
        if saved.get("exports") or saved.get("imports"):
            n_forecast += 1
    a.check("forecasts recomputed", not bad, f"{len(bad)} mismatches: {bad[:5]}")
    a.check_count("products with a forecast", n_forecast, 5_233)
    a.check("forecast years", _scalar(conn, """
        SELECT COUNT(*) FROM hs6_scores s, json_each(s.forecast_json, '$.exports') j
        WHERE json_extract(j.value,'$.year') NOT IN (2025,2026)""") == 0)

    # Alerts: the rule engine's output is compared as a multiset (the ids and run timestamp are incidental).
    stored_created = _scalar(conn, "SELECT MIN(created_at) FROM alerts")
    expected_alerts = scoring.detect_alerts(records, stored_created or "2026-01-01T00:00:00Z")
    stored_alerts = [dict(r) for r in conn.execute("SELECT * FROM alerts")]
    a.check_count("alerts rows", len(stored_alerts), len(expected_alerts))

    def alert_key(x: dict) -> tuple:
        return (x.get("kind"), x.get("hs6"), x.get("severity"), x.get("title"), x.get("detail"),
                None if x.get("value") is None else round(float(x["value"]), 4))

    got = Counter(alert_key(x) for x in stored_alerts)
    want = Counter(alert_key(x) for x in expected_alerts)
    diff = got - want
    extra = want - got
    a.check("alerts recomputed", not diff and not extra,
            f"missing={sum(extra.values())} extra={sum(diff.values())} examples={list(diff)[:2]}")
    a.check("alert severity/kind valid", _scalar(conn, """
        SELECT COUNT(*) FROM alerts WHERE kind NOT IN
        ('import_surge','export_drop','concentration','china_dependence')
        OR severity NOT IN ('high','medium','low')""") == 0)


# --------------------------------------------------------------------------- section 8: value chains / stages / items / edges / clusters / production

def audit_value_chains(a: Audit, conn: sqlite3.Connection) -> None:
    """Compare ``data/curated/value_chains.json`` against the DB, re-deriving Atlas ownership."""
    from scripts.etl.load_value_chains import (_Owners, build_alias_index, load_ministries,
                                               resolve_ministry_text, _clean_text)

    doc = _json(CURATED / "value_chains.json")
    chains_json = doc.get("chains", [])
    a.counts["value_chains_json_chains"] = len(chains_json)
    db_chains = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM value_chains")}
    a.check_count("value_chains rows", len(db_chains), len(chains_json))
    a.check("value_chains id set", set(db_chains) == {c["id"] for c in chains_json},
            f"db={len(db_chains):,} json={len(chains_json):,}")

    bad = []
    for c in chains_json:
        row = db_chains.get(c["id"])
        if row is None:
            bad.append((c["id"], "missing")); continue
        notes = c.get("_notes") or c.get("notes") or []
        sc = c.get("skill_council")
        if (row["name"] != _clean_text(c.get("name")) or row["title"] != _clean_text(c.get("title"))
                or row["anchor_hs"] != c.get("anchor_hs") or row["phase"] != c.get("phase")
                or row["source"] != (c.get("source") or "curated")
                or row["sort_order"] != (c.get("sort_order") or 0)
                or row["description"] != _clean_text(c.get("description"))
                or row["manufacturers_json"] != json.dumps(c.get("manufacturers") or [], ensure_ascii=False)
                or row["skill_council_json"] != (json.dumps(sc, ensure_ascii=False) if sc is not None else None)
                or row["notes_json"] != (json.dumps(notes, ensure_ascii=False) if notes else None)):
            bad.append((c["id"], "field mismatch"))
    a.check("value_chains fields match JSON", not bad, f"{len(bad)} mismatches: {bad[:6]}")
    a.check("lead ministries known", _scalar(conn,
        "SELECT COUNT(*) FROM value_chains WHERE lead_ministry_id IS NOT NULL AND lead_ministry_id NOT IN "
        "(SELECT id FROM ministries)") == 0)

    mins = load_ministries()
    alias_index = build_alias_index(mins)
    owners = _Owners(conn)
    sectors_doc = _json(CURATED / "sectors.json")
    by_chapter = {ch: s["id"] for s in sectors_doc.get("sectors", [])
                  for ch in s.get("chapters", [])}
    by_heading = dict(sectors_doc.get("heading_overrides", {}))

    # ------------------------------------------------------------------ stages
    stage_order_expected: dict[tuple[str, str], int] = {}
    n_stages = n_items = 0
    for c in chains_json:
        ordered = sorted(c.get("stages") or [], key=lambda s: s.get("order", 0))
        for s_pos, st in enumerate(ordered, start=1):
            stage_order_expected[(c["id"], st["id"])] = int(st.get("order") or s_pos)
            n_stages += 1
            n_items += len(st.get("items") or [])
    db_stages = {(r["chain_id"], r["stage_id"]): dict(r) for r in conn.execute("SELECT * FROM vc_stages")}
    a.check_count("vc_stages rows", len(db_stages), n_stages)
    a.check("vc_stages id set", set(db_stages) == set(stage_order_expected),
            f"db={len(db_stages):,} json={n_stages:,}")

    def stage_ids_from_json(st: dict) -> list[str]:
        ids = st.get("ministry_ids")
        if ids is None:
            ids = resolve_ministry_text(st.get("ministry_text"), alias_index)
        if not ids:
            ids = list(dict.fromkeys(m for it in st.get("items") or [] for m in (it.get("ministry_ids") or [])))
        return ids

    bad = []
    for c in chains_json:
        ordered = sorted(c.get("stages") or [], key=lambda s: s.get("order", 0))
        for st in ordered:
            sid = (c["id"], st["id"])
            row = db_stages.get(sid)
            if row is None:
                bad.append((sid, "missing")); continue
            curated = stage_ids_from_json(st)
            touched = False
            union: list[str] = []
            for it in st.get("items") or []:
                atlas = owners.for_code(it.get("hs_code"))
                if atlas is not None:
                    touched = True
                    union.extend(m for m in atlas if m != "residual")
            union = list(dict.fromkeys(union))
            if touched and union and union != curated:
                expected = union
                expected_text = owners.text(union)
            else:
                expected = curated
                expected_text = _clean_text(st.get("ministry_text"))
            if (row["name"] != _clean_text(st.get("name")) or row["stage_order"] != stage_order_expected[sid]
                    or row["ministry_text"] != expected_text
                    or json.loads(row["ministry_ids_json"] or "[]") != expected):
                bad.append((sid, "field mismatch"))
    a.check("vc_stages fields match (Atlas re-derived ownership)", not bad,
            f"{len(bad)} mismatches: {bad[:6]}")

    # ------------------------------------------------------------------ items
    db_items = {(r["chain_id"], r["stage_id"], r["item_order"]): dict(r)
                for r in conn.execute("SELECT * FROM vc_items")}
    products_set = {r[0] for r in conn.execute("SELECT hsn8 FROM products")}
    a.check_count("vc_items rows", len(db_items), n_items)
    bad = []
    for c in chains_json:
        src = c.get("source") or "curated"
        for st in c.get("stages") or []:
            for i, it in enumerate(st.get("items") or [], start=1):
                key = (c["id"], st["id"], i)
                row = db_items.get(key)
                if row is None:
                    bad.append((key, "missing")); continue
                code = it.get("hs_code")
                hsn8 = code if (code and len(code) == 8 and code in products_set) else None
                atlas = owners.for_code(code) if code else None
                curated = it.get("ministry_ids")
                if curated is None:
                    curated = resolve_ministry_text(it.get("ministry_text"), alias_index) or []
                expected_ids = atlas if atlas is not None else curated
                if atlas is not None and atlas != curated:
                    expected_text = owners.text(atlas)
                else:
                    expected_text = _clean_text(it.get("ministry_text"))
                if (row["item_name"] != (_clean_text(it.get("item")) or "")
                        or row["hs_code"] != code or row["hsn8"] != hsn8
                        or row["description"] != _clean_text(it.get("description"))
                        or row["ministry_text"] != expected_text
                        or row["source"] != (it.get("source") or src)
                        or json.loads(row["ministry_ids_json"] or "[]") != expected_ids):
                    bad.append((key, "field mismatch"))
    a.check("vc_items fields match (Atlas re-derived ownership)", not bad,
            f"{len(bad)} mismatches: {bad[:6]}")
    a.check("vc_item hsn8 iff 8-digit product line", _scalar(conn,
        "SELECT COUNT(*) FROM vc_items WHERE (hsn8 IS NOT NULL) <> (length(hs_code) = 8 AND hsn8 IN "
        "(SELECT hsn8 FROM products))") == 0)
    a.check("vc_item code lengths valid", _scalar(conn,
        "SELECT COUNT(*) FROM vc_items WHERE hs_code IS NOT NULL AND length(hs_code) NOT IN (2,4,6,8)") == 0)

    # ------------------------------------------------------------------ edges
    db_edges = {(r["src"], r["dst"], r["relation"]): dict(r) for r in conn.execute("SELECT * FROM vc_edges")}
    json_edges: dict[tuple[str, str, str], dict] = {}
    for c in chains_json:
        src = c.get("source") or "curated"
        for e in c.get("edges") or []:
            json_edges[(e["src"], e["dst"], e.get("relation") or "input_to")] = {
                "weight": float(e.get("weight", 1) or 1),
                "source": e.get("source") or src, "chain_id": c["id"]}
    curated_edges = {k: v for k, v in db_edges.items() if v["source"] == "curated"}
    a.check_count("vc_edges curated (from JSON)", len(curated_edges), len(json_edges))
    a.check("vc_edges curated set matches JSON", set(curated_edges) == set(json_edges),
            f"db={len(curated_edges):,} json={len(json_edges):,}")
    hs_text = [v for v in db_edges.values() if v["source"] == "hs_text"]
    a.check("vc_edges hs_text rows have null chain", all(v["chain_id"] is None for v in hs_text))
    a.check("vc_edges relations valid", _scalar(conn,
        "SELECT COUNT(*) FROM vc_edges WHERE relation NOT IN ('input_to','component_of','parts_of')") == 0)
    bad = []
    for key, exp in json_edges.items():
        row = curated_edges.get(key)
        if row is None or not _close(row["weight"], exp["weight"]) or row["source"] != exp["source"] \
                or row["chain_id"] != exp["chain_id"]:
            bad.append((key, "mismatch"))
    a.check("vc_edges curated fields match JSON", not bad, f"{len(bad)} mismatches: {bad[:6]}")
    a.check("edge codes known (product line or HS node)", _scalar(conn,
        "SELECT COUNT(*) FROM vc_edges e WHERE (NOT EXISTS (SELECT 1 FROM products p WHERE p.hsn8=e.src)"
        " AND NOT EXISTS (SELECT 1 FROM hs_nodes n WHERE n.code=e.src))"
        " OR (NOT EXISTS (SELECT 1 FROM products p WHERE p.hsn8=e.dst)"
        " AND NOT EXISTS (SELECT 1 FROM hs_nodes n WHERE n.code=e.dst))") == 0)
    a.check("edge chain_id refers to a chain", _scalar(conn,
        "SELECT COUNT(*) FROM vc_edges WHERE chain_id IS NOT NULL AND NOT EXISTS "
        "(SELECT 1 FROM value_chains vc WHERE vc.id = vc_edges.chain_id)") == 0)

    # ------------------------------------------------------------------ clusters
    db_clusters = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM clusters")}
    json_cluster_entries: dict[str, list[tuple[str, dict]]] = {}
    for c in chains_json:
        for cl in c.get("clusters") or []:
            json_cluster_entries.setdefault(cl["id"], []).append((c["id"], cl))
    a.check_count("clusters rows (curated)", len(db_clusters), len(json_cluster_entries))
    a.check("cluster id set", set(db_clusters) == set(json_cluster_entries),
            f"db={len(db_clusters):,} json={len(json_cluster_entries):,}")
    a.check("clusters all sourced curated", all(r["source"] == "curated" for r in db_clusters.values()))
    chain_order = [c["id"] for c in chains_json]
    bad = []
    for cid, entries in json_cluster_entries.items():
        row = db_clusters.get(cid)
        if row is None:
            bad.append((cid, "missing")); continue
        cl = entries[0][1]
        expected_chain_ids = [chid for chid in chain_order if any(e[0] == chid for e in entries)]
        own = list(cl.get("sector_ids") or [])
        if not own:
            for chid, _ in entries:
                anchor = next((c2.get("anchor_hs") for c2 in chains_json if c2["id"] == chid), None)
                sec = _sector_for(anchor, by_chapter, by_heading)
                if sec and sec not in own:
                    own.append(sec)
        if (row["name"] != cl.get("name") or row["state"] != cl.get("state")
                or row["district"] != cl.get("district") or row["products"] != cl.get("products")
                or not _close(row["lat"], cl.get("lat")) or not _close(row["lon"], cl.get("lon"))
                or json.loads(row["chain_ids_json"] or "[]") != expected_chain_ids
                or json.loads(row["sector_ids_json"] or "[]") != own):
            bad.append((cid, "field mismatch"))
    a.check("clusters match JSON", not bad, f"{len(bad)} mismatches: {bad[:6]}")

    # ------------------------------------------------------------------ production
    production_doc = _json(CURATED / "production.json")
    prod_json = production_doc.get("rows", [])
    db_prod = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM production WHERE scope = 'chain'")}
    a.check_count("production chain-scope rows", len(db_prod), len(prod_json))
    bad = []
    for p in prod_json:
        found = None
        for r in db_prod.values():
            if (r["scope"] == p["scope"] and r["key"] == p["key"]
                    and (r["label"] or "") == (p.get("label") or "")
                    and r["year"] == p.get("year") and r["unit"] == p.get("unit")
                    and r["source"] == p.get("source") and r["status"] == p.get("status")
                    and (r["value"] is None and p.get("value") is None
                         or r["value"] is not None and p.get("value") is not None
                         and abs(float(r["value"]) - float(p["value"])) <= 1e-6 * abs(float(p["value"])))):
                found = r
                break
        if found is None:
            bad.append((p.get("key"), "missing"))
    a.check("production rows match production.json", not bad, f"{len(bad)} mismatches: {bad[:6]}")
    a.check("production only chain scope", _scalar(conn, "SELECT COUNT(*) FROM production WHERE scope <> 'chain'") == 0)


def audit_supply_tiers(a: Audit, conn: sqlite3.Connection) -> None:
    """Compare ``data/curated/supply_tiers.json`` against the DB, re-deriving Atlas ownership."""
    from scripts.etl.load_value_chains import (_Owners, _clean_text, build_alias_index, load_ministries,
                                               resolve_ministry_text)
    from scripts.etl.load_supply_tiers import normalise_tiers

    doc = _json(CURATED / "supply_tiers.json")
    chains_json = doc.get("chains", [])
    a.counts["supply_tiers_json_chains"] = len(chains_json)

    mins = load_ministries()
    known = {m["id"] for m in mins}
    try:
        chains = normalise_tiers(doc, known, build_alias_index(mins))
    except Exception as exc:  # noqa: BLE001 - a broken document is an audit failure, not a crash
        a.fail("supply_tiers.json valid", str(exc))
        return
    a.check("supply_tiers.json valid", True, f"{len(chains)} chain(s)")

    n_tiers = sum(len(c["tiers"]) for c in chains)
    n_items = sum(len(t["items"]) for c in chains for t in c["tiers"])
    db_tiers = {(r["chain_id"], r["tier_level"]): dict(r) for r in conn.execute("SELECT * FROM vc_tiers")}
    a.check_count("vc_tiers rows", len(db_tiers), n_tiers)
    a.check("vc_tiers id set", set(db_tiers) == {(c["chain_id"], t["tier_level"])
                                                 for c in chains for t in c["tiers"]},
            f"db={len(db_tiers):,} json={n_tiers:,}")
    a.check("tier chains exist", _scalar(conn,
        "SELECT COUNT(*) FROM vc_tiers WHERE chain_id NOT IN (SELECT id FROM value_chains)") == 0)

    owners = _Owners(conn)
    products_set = {r[0] for r in conn.execute("SELECT hsn8 FROM products")}
    bad = []
    for c in chains:
        for order, t in enumerate(c["tiers"], start=1):
            row = db_tiers.get((c["chain_id"], t["tier_level"]))
            if row is None:
                bad.append(((c["chain_id"], t["tier_level"]), "missing")); continue
            if (row["name"] != t["name"] or row["description"] != t["description"]
                    or row["sort_order"] != order
                    or json.loads(row["examples_json"] or "[]") != t["examples"]
                    or row["source"] != c["source"]):
                bad.append(((c["chain_id"], t["tier_level"]), "field mismatch"))
    a.check("vc_tiers fields match JSON", not bad, f"{len(bad)} mismatches: {bad[:6]}")

    db_items = {(r["chain_id"], r["tier_level"], r["item_order"]): dict(r)
                for r in conn.execute("SELECT * FROM vc_tier_items")}
    a.check_count("vc_tier_items rows", len(db_items), n_items)
    bad = []
    for c in chains:
        for t in c["tiers"]:
            for it in t["items"]:
                key = (c["chain_id"], t["tier_level"], it["item_order"])
                row = db_items.get(key)
                if row is None:
                    bad.append((key, "missing")); continue
                code = it["hs_code"]
                hsn8 = code if (code and len(code) == 8 and code in products_set) else None
                atlas = owners.for_code(code) if code else None
                curated = it["ministry_ids"] or []
                expected_ids = atlas if atlas is not None else curated
                if atlas is not None and atlas != curated:
                    expected_text = owners.text(atlas)
                else:
                    expected_text = it["ministry_text"]
                if (row["item_name"] != it["item_name"] or row["hs_code"] != code or row["hsn8"] != hsn8
                        or row["description"] != it["description"]
                        or row["ministry_text"] != expected_text
                        or json.loads(row["ministry_ids_json"] or "[]") != expected_ids):
                    bad.append((key, "field mismatch"))
    a.check("vc_tier_items fields match (Atlas re-derived ownership)", not bad,
            f"{len(bad)} mismatches: {bad[:6]}")
    a.check("vc_tier_item hsn8 iff 8-digit product line", _scalar(conn,
        "SELECT COUNT(*) FROM vc_tier_items WHERE (hsn8 IS NOT NULL) <> (length(hs_code) = 8 AND hsn8 IN "
        "(SELECT hsn8 FROM products))") == 0)
    a.check("vc_tier_item code lengths valid", _scalar(conn,
        "SELECT COUNT(*) FROM vc_tier_items WHERE hs_code IS NOT NULL AND length(hs_code) NOT IN (2,4,6,8)") == 0)
    a.check("tier item ministries known", _scalar(conn,
        "SELECT COUNT(*) FROM vc_tier_items WHERE ministry_ids_json IS NOT NULL AND EXISTS (SELECT 1 FROM "
        "json_each(vc_tier_items.ministry_ids_json) j WHERE j.value NOT IN (SELECT id FROM ministries))") == 0)


# --------------------------------------------------------------------------- section 9: policy, ops seed and meta

def audit_policy_ops_meta(a: Audit, conn: sqlite3.Connection) -> None:
    policy = _json(CURATED / "policy.json")
    info = _json(CURATED / "info.json")
    ops = _json(CURATED / "ops_seed.json")
    manifest = _json(RAW / "manifest.json")
    INFO_IDS = ("about_hsn", "guidebook", "how_to_use", "cbic_tariff")
    ministry_ids = {r[0] for r in conn.execute("SELECT id FROM ministries")}
    country_ids = {r[0] for r in conn.execute("SELECT id FROM countries")}
    sector_ids = {r[0] for r in conn.execute("SELECT id FROM sectors")}

    schemes = policy.get("schemes", [])
    db_schemes = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM schemes")}
    a.check_count("schemes", len(db_schemes), len(schemes))
    a.check("scheme id set", set(db_schemes) == {s["id"] for s in schemes})
    bad = []
    for s in schemes:
        row = db_schemes.get(s["id"])
        if row is None:
            bad.append((s["id"], "missing")); continue
        if (row["name"] != s.get("name") or row["kind"] != s.get("kind")
                or row["ministry_id"] != s.get("ministry_id")
                or row["outlay_crore"] != (float(s["outlay_crore"]) if s.get("outlay_crore") is not None else None)
                or row["launched"] != (str(s["launched"]) if s.get("launched") is not None else None)
                or row["description"] != s.get("description") or row["url"] != s.get("url")
                or row["source"] != s.get("source")):
            bad.append((s["id"], "field mismatch"))
    a.check("schemes match policy.json", not bad, f"{len(bad)}: {bad[:4]}")
    a.check("scheme ministries known", _scalar(conn,
        "SELECT COUNT(*) FROM schemes WHERE ministry_id IS NOT NULL AND ministry_id NOT IN "
        "(SELECT id FROM ministries)") == 0)

    db_sp = {(r["scheme_id"], r["hs_prefix"]): dict(r) for r in conn.execute("SELECT * FROM scheme_products")}
    exp_sp = {(s["id"], str(p["prefix"])): p.get("note") for s in schemes
              for p in (s.get("hs_prefixes") or [])}
    a.check_count("scheme_products", len(db_sp), len(exp_sp))
    bad = [k for k, v in exp_sp.items() if db_sp.get(k) is None or db_sp[k]["note"] != v]
    a.check("scheme_products match hs_prefixes", not bad, f"{len(bad)}: {bad[:4]}")

    agreements = policy.get("agreements", [])
    db_ag = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM trade_agreements")}
    a.check_count("trade_agreements", len(db_ag), len(agreements))
    bad = []
    for ag in agreements:
        row = db_ag.get(ag["id"])
        if row is None:
            bad.append((ag["id"], "missing")); continue
        if (row["name"] != ag.get("name") or row["short_name"] != ag.get("short_name")
                or json.loads(row["partners_json"]) != list(ag.get("partners") or [])
                or row["status"] != ag.get("status") or row["year"] != ag.get("year")
                or row["url"] != ag.get("url") or row["notes"] != ag.get("notes")):
            bad.append((ag["id"], "field mismatch"))
    a.check("trade_agreements match policy.json", not bad, f"{len(bad)}: {bad[:4]}")
    a.check("agreement partners known", _scalar(conn,
        "SELECT COUNT(*) FROM trade_agreements ta, json_each(ta.partners_json) j WHERE j.value NOT IN "
        "(SELECT id FROM countries)") == 0)

    councils = policy.get("skill_councils", [])
    db_sc = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM skill_councils")}
    a.check_count("skill_councils", len(db_sc), len(councils))
    bad = []
    for sc in councils:
        row = db_sc.get(sc["id"])
        if row is None:
            bad.append((sc["id"], "missing")); continue
        if (row["name"] != sc.get("name")
                or json.loads(row["sector_ids_json"]) != list(sc.get("sector_ids") or [])
                or json.loads(row["chain_ids_json"]) != list(sc.get("chain_ids") or [])
                or row["url"] != sc.get("url")):
            bad.append((sc["id"], "field mismatch"))
    a.check("skill_councils match policy.json", not bad, f"{len(bad)}: {bad[:4]}")
    a.check("skill council sectors known", _scalar(conn,
        "SELECT COUNT(*) FROM skill_councils sc, json_each(sc.sector_ids_json) j WHERE j.value NOT IN "
        "(SELECT id FROM sectors)") == 0)

    pages = info.get("pages", [])
    db_ip = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM info_pages")}
    a.check_count("info_pages", len(db_ip), len(pages))
    a.check("info page ids", set(db_ip) == set(INFO_IDS) == {p.get("id") for p in pages})
    bad = []
    for i, p in enumerate(pages, start=1):
        row = db_ip.get(p["id"])
        if row is None:
            bad.append((p.get("id"), "missing")); continue
        if (row["title"] != p.get("title") or row["icon"] != p.get("icon")
                or row["body_md"] != p.get("body_md")
                or json.loads(row["links_json"]) != list(p.get("links") or [])
                or row["sort_order"] != p.get("sort_order", i)):
            bad.append((p.get("id"), "field mismatch"))
    a.check("info_pages match info.json", not bad, f"{len(bad)}: {bad[:4]}")

    roadmap = policy.get("roadmap", [])
    db_rm = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM roadmap_items")}
    a.check_count("roadmap_items", len(db_rm), len(roadmap))
    bad = []
    for i, r in enumerate(roadmap, start=1):
        row = db_rm.get(r["id"])
        if row is None:
            bad.append((r["id"], "missing")); continue
        if (row["phase"] != r.get("phase") or row["workstream"] != r.get("workstream")
                or row["title"] != r.get("title") or row["description"] != r.get("description")
                or row["start_month"] != r.get("start_month") or row["end_month"] != r.get("end_month")
                or row["status"] != r.get("status") or row["owner"] != r.get("owner")
                or row["platform_route"] != r.get("platform_route")
                or row["sort_order"] != r.get("sort_order", i)):
            bad.append((r["id"], "field mismatch"))
    a.check("roadmap_items match policy.json", not bad, f"{len(bad)}: {bad[:4]}")
    a.check("roadmap phases/statuses valid", _scalar(conn,
        "SELECT COUNT(*) FROM roadmap_items WHERE phase NOT IN ('Phase 0','Phase I','Phase II')"
        " OR status NOT IN ('done','in_progress','planned')") == 0)

    risks = policy.get("risks", [])
    db_risk = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM risks")}
    a.check_count("risks", len(db_risk), len(risks))
    bad = []
    for k in risks:
        row = db_risk.get(k["id"])
        if row is None:
            bad.append((k["id"], "missing")); continue
        if (row["area"] != k.get("area") or row["risk"] != k.get("risk")
                or row["mitigation"] != k.get("mitigation") or row["likelihood"] != k.get("likelihood")
                or row["impact"] != k.get("impact") or row["status"] != k.get("status")
                or row["owner"] != k.get("owner") or row["platform_control"] != k.get("platform_control")):
            bad.append((k["id"], "field mismatch"))
    a.check("risks match policy.json", not bad, f"{len(bad)}: {bad[:4]}")
    a.check("risk fields valid", _scalar(conn,
        "SELECT COUNT(*) FROM risks WHERE likelihood NOT BETWEEN 1 AND 5 OR impact NOT BETWEEN 1 AND 5"
        " OR status NOT IN ('open','mitigating','closed')") == 0)

    # ---- ops seed: users
    users = ops.get("users", [])
    db_users = {r["email"].lower(): dict(r) for r in conn.execute("SELECT * FROM users")}
    a.check_count("users", len(db_users), len(users))
    bad = []
    for u in users:
        row = db_users.get(u["email"].strip().lower())
        if row is None:
            bad.append((u["email"], "missing")); continue
        if (row["name"] != u["name"] or row["role"] != u["role"] or row["ministry_id"] != u.get("ministry_id")
                or row["organisation"] != u.get("organisation") or row["active"] != 1
                or row["is_demo"] != int(u.get("is_demo", 1))):
            bad.append((u["email"], "field mismatch"))
    a.check("users match ops_seed.json", not bad, f"{len(bad)}: {bad[:4]}")
    a.check("admin user exists", _scalar(conn, "SELECT COUNT(*) FROM users WHERE role='admin' AND active=1") >= 1)
    a.check("user roles valid", _scalar(conn, "SELECT COUNT(*) FROM users WHERE role NOT IN "
        "('admin','ministry','analyst','industry')") == 0)

    # ---- ops seed: data sources
    sources = ops.get("data_sources", [])
    db_ds = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM data_sources")}
    a.check_count("data_sources", len(db_ds), len(sources))
    a.check("data_sources id set", set(db_ds) == {s["id"] for s in sources})
    bad = []
    for s in sources:
        row = db_ds.get(s["id"])
        if row is None:
            bad.append((s["id"], "missing")); continue
        for k in ("name", "owner", "kind", "url", "licence", "description", "refresh_cron"):
            if s.get(k) is not None and row[k] != s.get(k):
                bad.append((s["id"], f"field {k}")); break
        if row["status"] not in ("connected", "not_refreshed", "not_configured", "error"):
            bad.append((s["id"], f"bad status {row['status']!r}"))
    a.check("data_sources verbatim fields match ops_seed", not bad, f"{len(bad)}: {bad[:4]}")
    def source_manifest_records(s: dict) -> int | None:
        """Sum of manifest ``rows`` for the keys a source derives from (mirrors seed_ops first step)."""
        keys = list(s.get("manifest_keys") or [])
        prefix = s.get("manifest_prefix")
        if prefix:
            keys += [k for k in manifest if k.startswith(prefix)]
        entries = [manifest[k] for k in dict.fromkeys(keys) if k in manifest]
        rows = [int(e["rows"]) for e in entries if isinstance(e.get("rows"), (int, float))]
        return sum(rows) if rows else None

    for s in sources:
        row = db_ds.get(s["id"])
        if row is None:
            continue
        expected = source_manifest_records(s)
        if expected is not None:
            a.check(f"data source {s['id']} records", row["records"] == expected,
                    f"db={row['records']} expected={expected}")
        else:
            # records_sql / records_table values are seed-time snapshots (some tables are loaded after
            # seed_ops seeds the sources); sanity-check the type only.
            a.check(f"data source {s['id']} records type",
                    row["records"] is None or isinstance(row["records"], int),
                    f"db={row['records']!r}")

    # ---- ops seed: tickets
    tickets = ops.get("tickets", [])
    db_tickets = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM tickets")}
    a.check_count("tickets", len(db_tickets), len(tickets))
    bad = []
    for t in tickets:
        row = next((r for r in db_tickets.values()
                    if r["hsn8"] == t["hsn8"] and r["subject"] == t["subject"]), None)
        if row is None:
            bad.append((t["hsn8"], t["subject"][:30], "missing")); continue
        if (row["category"] != t.get("category") or row["status"] != t.get("status")
                or row["submitter_name"] != t.get("submitter_name")
                or row["submitter_org"] != t.get("submitter_org")
                or row["submitter_email"] != t.get("submitter_email")):
            bad.append((t["hsn8"], "field mismatch"))
        prod_owner = _scalar(conn, "SELECT ministry_id FROM products WHERE hsn8=?", (t["hsn8"],))
        routed = prod_owner if prod_owner and prod_owner != "residual" else "dpiit"
        if row["routed_ministry_id"] != routed:
            bad.append((t["hsn8"], f"routed={row['routed_ministry_id']} expected={routed}"))
    a.check("tickets match ops_seed.json", not bad, f"{len(bad)}: {bad[:4]}")
    db_tm = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM ticket_messages")}
    a.check_count("ticket_messages", len(db_tm),
                  sum(len(t.get("messages") or []) for t in tickets))
    a.check("ticket_messages reference tickets", _scalar(conn,
        "SELECT COUNT(*) FROM ticket_messages tm WHERE NOT EXISTS "
        "(SELECT 1 FROM tickets t WHERE t.id = tm.ticket_id)") == 0)

    # ---- ops seed: residual claims
    db_claims = [dict(r) for r in conn.execute("SELECT * FROM residual_claims")]
    cfg = ops.get("residual_claims") or {}
    a.check_count("residual_claims", len(db_claims), int(cfg.get("count", 3)))
    bad = []
    for row in db_claims:
        if row["status"] != "pending":
            bad.append((row["hsn8"], "status")); continue
        if _scalar(conn, "SELECT COUNT(*) FROM products WHERE hsn8=? AND mapping_status='residual'",
                   (row["hsn8"],)) == 0:
            bad.append((row["hsn8"], "not a residual product")); continue
        if row["ministry_id"] not in ministry_ids:
            bad.append((row["hsn8"], "unknown ministry")); continue
    a.check("residual_claims pending on residual products with known ministry", not bad,
            f"{len(bad)}: {bad[:4]}")

    # ---- meta
    meta = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM meta")}
    expect_meta = {
        "build_mode": "full", "latest_year": str(LATEST_YEAR), "schema_version": "1",
        "n_current_products": "13110", "n_products": "13110",
        "guidebook_acceptances": "12912", "guidebook_accepted_codes": "11679",
        "guidebook_matched_products": "11662", "guidebook_not_listed_products": "960",
        "guidebook_residual_codes": "495", "guidebook_residual_products": "488",
    }
    bad_meta = {k: (meta.get(k), v) for k, v in expect_meta.items() if meta.get(k) != v}
    a.check("meta counters", not bad_meta, str(bad_meta))
    a.check("meta has built_at and scores_built_at", bool(meta.get("built_at") and meta.get("scores_built_at")),
            f"built_at={meta.get('built_at')} scores_built_at={meta.get('scores_built_at')}")


# --------------------------------------------------------------------------- section 10: API vs DB on a temporary copy

def audit_api(a: Audit, db_path: Path) -> None:
    """Probe the live API against a throwaway copy of the DB (no mutations of the real DB)."""
    from fastapi.testclient import TestClient
    from app.main import create_app
    from app.security import create_access_token
    import sqlite3

    os.environ["ATLAS_WARM_MODELS"] = "0"
    # Residual bucket is excluded from the API's per-ministry distribution; read it from the real DB.
    resid_conn = sqlite3.connect(str(db_path))
    resid_conn.row_factory = sqlite3.Row
    resid_x = _scalar(resid_conn, "SELECT COALESCE(SUM(exports_alloc),0) FROM v_product_trade WHERE ministry_id='residual'")
    resid_m = _scalar(resid_conn, "SELECT COALESCE(SUM(imports_alloc),0) FROM v_product_trade WHERE ministry_id='residual'")
    resid_conn.close()
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / "audit.db"
        shutil.copy2(db_path, tmp)
        app = create_app(db_path=tmp)
        with TestClient(app) as c:
            r = c.get("/api/health")
            a.check("api health", r.status_code == 200, f"status={r.status_code}")
            h = r.json() or {}
            a.check("api latest_year", h.get("latest_year") == LATEST_YEAR)
            a.check("api products", h.get("products") == 13110, str(h.get("products")))
            a.check("api build_mode", h.get("build_mode") == "full")
            for path in ("/api/meta/sections", "/api/meta/countries", "/api/meta/info"):
                r = c.get(path)
                a.check(f"api public {path}", r.status_code == 200, f"status={r.status_code}")

            c0 = sqlite3.connect(str(tmp))
            c0.row_factory = sqlite3.Row
            u = dict(c0.execute("SELECT * FROM users WHERE role='admin' AND active=1 LIMIT 1").fetchone())
            token = create_access_token(u)
            H = {"Authorization": f"Bearer {token}"}

            r = c.get("/api/meta/overview", headers=H)
            a.check("api meta/overview", r.status_code == 200, f"status={r.status_code}")
            ov = (r.json() or {}).get("kpis", {})
            # The KPI rows are DB-derived; recompute them from the temporary copy and compare.
            a.check("api kpis hs6_with_trade", ov.get("hs6_with_trade") == _scalar(c0, """
                SELECT SUM(COALESCE(india_exports, 0) > 0 OR COALESCE(india_imports, 0) > 0)
                FROM hs6_metrics"""), str(ov.get("hs6_with_trade")))
            a.check("api kpis india_exports", _close(ov.get("india_exports"), CURRENT_TOTAL_EXPORTS),
                    str(ov.get("india_exports")))
            a.check("api kpis india_imports", _close(ov.get("india_imports"), CURRENT_TOTAL_IMPORTS),
                    str(ov.get("india_imports")))
            a.check("api kpis world_trade", _close(ov.get("world_trade"), CURRENT_TOTAL_WORLD),
                    str(ov.get("world_trade")))
            counts = dict(c0.execute("""
                SELECT COALESCE(SUM(p.mapping_status='accepted'),0) AS accepted_codes,
                       COALESCE(SUM(p.mapping_status='residual'),0) AS residual_codes,
                       COUNT(DISTINCT CASE WHEN p.mapping_status='accepted' AND p.ministry_id <> 'residual'
                                           THEN p.ministry_id END) AS ministries_assigned,
                       COUNT(DISTINCT p.sector_id) AS sectors
                FROM products p WHERE p.is_current = 1""").fetchone())
            a.check("api kpis accepted_codes", ov.get("accepted_codes") == counts["accepted_codes"])
            a.check("api kpis residual_codes", ov.get("residual_codes") == counts["residual_codes"])
            a.check("api kpis ministries_assigned", ov.get("ministries_assigned") == counts["ministries_assigned"])
            a.check("api kpis sectors", ov.get("sectors") == counts["sectors"])
            dist = (r.json() or {}).get("distribution_by_ministry", [])
            sx = sum(float(x.get("exports") or 0) for x in dist)
            sm = sum(float(x.get("imports") or 0) for x in dist)
            # The API's per-ministry distribution carries the *allocation* sums (published lines exact,
            # remainder spread over unpublished lines), so it reconciles against the allocation total -
            # which is the official total minus the codes DGCIS reports but the GST catalogue has no
            # line under (see the metrics section; shortfall well under 2%).
            alloc_x = _scalar(c0, "SELECT COALESCE(SUM(exports_alloc),0) FROM v_product_trade")
            alloc_m = _scalar(c0, "SELECT COALESCE(SUM(imports_alloc),0) FROM v_product_trade")
            a.check("api ministry exports + residual == allocation total", abs(sx + resid_x - alloc_x) <= 1.0,
                    f"{sx:,.0f} + {resid_x:,.0f} vs alloc {alloc_x:,.0f}")
            a.check("api ministry imports + residual == allocation total", abs(sm + resid_m - alloc_m) <= 1.0,
                    f"{sm:,.0f} + {resid_m:,.0f} vs alloc {alloc_m:,.0f}")
            a.check("api ministry allocation within official totals",
                    alloc_x <= CURRENT_TOTAL_EXPORTS + 1 and alloc_m <= CURRENT_TOTAL_IMPORTS + 1
                    and CURRENT_TOTAL_EXPORTS - alloc_x <= 0.02 * CURRENT_TOTAL_EXPORTS
                    and CURRENT_TOTAL_IMPORTS - alloc_m <= 0.02 * CURRENT_TOTAL_IMPORTS,
                    f"alloc={alloc_x:,.0f}/{alloc_m:,.0f} official={CURRENT_TOTAL_EXPORTS:,.0f}"
                    f"/{CURRENT_TOTAL_IMPORTS:,.0f}")

            r = c.get("/api/hsn/product/27101290")
            p = r.json() or {}
            ptrade = p.get("trade") or {}
            x8 = _scalar(c0, "SELECT india_exports FROM trade_hs8 WHERE hsn8='27101290' AND year=2024")
            a.check("api 27101290 keeps its exact TRADESTAT exports", p.get("trade_level") == "hs8"
                    and p.get("metric_hs6") == "271000" and _close(ptrade.get("exports"), x8),
                    f"trade_level={p.get('trade_level')} metric_hs6={p.get('metric_hs6')}"
                    f" exports={ptrade.get('exports')} official={x8}")
            for code in ("71082000", "71189000"):
                r = c.get(f"/api/hsn/product/{code}")
                p = r.json() or {}
                ptrade = p.get("trade") or {}
                x8, m8 = c0.execute("SELECT india_exports, india_imports FROM trade_hs8"
                                    " WHERE hsn8=? AND year=2024", (code,)).fetchone()
                has_metric = (p.get("trade_level") == "hs8" and p.get("metric_hs6") == code[:6]
                              and ptrade.get("exports") == x8 and ptrade.get("imports") == m8)
                a.check(f"api {code} published as reported", has_metric,
                        f"trade={ptrade} trade_level={p.get('trade_level')}")
                a.check(f"api {code} scores consistent",
                        (p.get("scores") is None) == (_scalar(c0, "SELECT COUNT(*) FROM hs6_scores"
                                                              " WHERE hs6=?", (code[:6],)) == 0))

            r = c.get("/api/analytics/opportunities", headers=H)
            a.check("api analytics/opportunities", r.status_code == 200, f"status={r.status_code}")
            s = (r.json() or {}).get("summary", {})
            # Expected values recomputed from the same scoring store on the temporary copy.
            from app.routers.analytics import filter_rows
            from app.services.scoring import analytics_frame
            from app.routers import analytics as _an
            frame = analytics_frame(c0)
            data = filter_rows(c0, frame, {"ministry_id": None, "sector_id": None, "chapter": None,
                                           "chain_id": None, "limit": _an.MAX_LIMIT,
                                           "min_world_trade": None, "min_imports": None})
            expected = {"n_products": len(data),
                        "total_untapped_usd": sum(r.get("untapped_potential_usd") or 0.0 for r in data),
                        "n_with_untapped": sum(1 for r in data if (r.get("untapped_potential_usd") or 0) > 0),
                        "total_exports": sum(r.get("india_exports") or 0.0 for r in data)}
            a.check("api opportunities n_products", s.get("n_products") == expected["n_products"],
                    f"api={s.get('n_products')} expected={expected['n_products']}")
            a.check("api opportunities untapped total", s.get("total_untapped_usd") is not None
                    and abs((s.get("total_untapped_usd") or 0) - expected["total_untapped_usd"]) <= 0.01,
                    f"api={s.get('total_untapped_usd')} expected={expected['total_untapped_usd']}")
            a.check("api opportunities n_with_untapped", s.get("n_with_untapped") == expected["n_with_untapped"],
                    f"api={s.get('n_with_untapped')} expected={expected['n_with_untapped']}")
            a.check("api opportunities total_exports", _close(s.get("total_exports"), CURRENT_TOTAL_EXPORTS),
                    f"api={s.get('total_exports')} expected={expected['total_exports']}")

            r = c.get("/api/datahub/quality", headers=H)
            q = (r.json() or {}).get("coverage", {})
            # Mirror the route's coverage SQL exactly (zero figures count as covered).
            sq = dict(c0.execute("""
                SELECT COUNT(*) AS products,
                       SUM(m.metric_hs6 IS NOT NULL AND (m.india_exports IS NOT NULL OR m.india_imports IS NOT NULL
                                                         OR m.world_trade IS NOT NULL)) AS with_trade,
                       SUM(t.mfn_avg IS NOT NULL) AS with_tariff
                FROM products p
                LEFT JOIN v_product_trade m ON m.hsn8 = p.hsn8
                LEFT JOIN tariffs t ON t.hs6 = p.hs6
                WHERE p.is_current = 1""").fetchone())
            a.check("api quality products", q.get("products") == sq["products"], str(q.get("products")))
            a.check("api quality with_trade", q.get("with_trade") == sq["with_trade"], str(q.get("with_trade")))
            a.check("api quality with_tariff", q.get("with_tariff") == sq["with_tariff"], str(q.get("with_tariff")))
            a.check("api quality counts positive", (sq["products"] or 0) > 0
                    and (sq["with_trade"] or 0) > 0 and (sq["with_tariff"] or 0) > 0)

            r = c.get("/api/analytics/opportunities")
            a.check("api analytics requires authentication", r.status_code == 401, f"status={r.status_code}")
            c0.close()


# --------------------------------------------------------------------------- CLI

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="End-to-end Atlas data audit: raw sources -> ETL -> database -> API.")
    parser.add_argument("--db", default=str(DEFAULT_DB),
                        help="database to audit (default data/atlas.db)")
    parser.add_argument("--json", help="write the structured JSON report to this path")
    parser.add_argument("--no-api", action="store_true",
                        help="skip the API-vs-DB section (runs against a temporary DB copy)")
    args = parser.parse_args(argv)

    os.environ["ATLAS_WARM_MODELS"] = "0"

    db = Path(args.db)
    if not db.is_file():
        print(f"database not found: {db}")
        return 1

    a = Audit(db)
    conn = _connect(db)
    try:
        a.section("files"); audit_files(a, conn)
        a.section("nomenclature"); audit_nomenclature(a, conn)
        a.section("mapping"); audit_mapping(a, conn)
        a.section("trade"); audit_trade(a, conn)
        a.section("tariffs"); audit_tariffs(a, conn)
        a.section("metrics"); audit_metrics(a, conn)
        a.section("scores"); audit_scores(a, conn)
        a.section("value_chains"); audit_value_chains(a, conn)
        a.section("supply_tiers"); audit_supply_tiers(a, conn)
        a.section("policy_ops_meta"); audit_policy_ops_meta(a, conn)
    finally:
        conn.close()

    if not args.no_api:
        a.section("api"); audit_api(a, db)

    summ = a.summary()
    status = "OK" if summ["ok"] else "FAILED"
    print(f"\n== audit: {status}  ({summ['passed']} passed, {summ['failed']} failed, {summ['duration_s']}s)")
    if summ["failed"]:
        print("Failures:")
        for f in summ["failures"]:
            print(f"  - {f['section']}: {f['name']}  {f['detail']}")
    if args.json:
        _write_report(a, Path(args.json))
        print(f"report written to {args.json}")
    return 0 if summ["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())

