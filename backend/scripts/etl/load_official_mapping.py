"""Apply the official DPIIT Guidebook on HSN Code Mapping to the Atlas.

The Guidebook (revised 16.12.2025) is the authoritative source for which Ministry/Department
accepted each 8-digit HS code. ``scripts/etl/parse_dpiit_guidebook.py`` turns the published PDF
into ``data/curated/ministry_mapping.json``; this step applies it after the rule-based sector
assignment and before value chains are loaded.

Rules
-----
* An accepted code gets the Guidebook's first-listed ministry as primary owner and every other
  accepting ministry as a secondary owner. The ownership set is official; the first-listed order
  is the transparent tie-break for the one primary-owner field in ``products``.
* A code listed in the Guidebook's residual annexure stays ``residual`` (no ministry accepted it).
* A product line absent from both Guidebook tables stays ``residual`` with
  ``mapping_source='unmapped'``. The rule table is never used as a fallback: an indicative owner
  is not an official owner.
* All accepted rows get ``mapping_source='dpiit_guidebook'`` and confidence 1.0.

The full published tables are also stored in ``guidebook_mapping`` (including the 17 accepted
codes absent from the GST product master, so coverage can be audited). ``products_fts`` is
rebuilt because it embeds the ministry name.
"""
from __future__ import annotations

import json
import sqlite3
from collections import Counter
from pathlib import Path

from scripts.etl import CURATED_DIR
from scripts.etl.nomenclature import rebuild_fts

MAPPING_JSON = CURATED_DIR / "ministry_mapping.json"
RESIDUAL = "residual"

GUIDEBOOK_SOURCE = "dpiit_guidebook"
UNLISTED_SOURCE = "unmapped"
CONFIDENCE = 1.0

_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS guidebook_mapping (
  hsn8 TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  primary_ministry_id TEXT,
  ministries_json TEXT NOT NULL DEFAULT '[]',
  probable_ministry TEXT,
  description TEXT,
  page INTEGER,
  source TEXT NOT NULL DEFAULT 'dpiit_guidebook'
);
CREATE INDEX IF NOT EXISTS ix_guidebook_status ON guidebook_mapping(status);
"""


def load_document(path: Path | str = MAPPING_JSON) -> dict:
    """Read and validate the parser output."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    accepted = data.get("accepted")
    residual = data.get("residual")
    source = data.get("_source") or {}
    if not isinstance(accepted, list) or not accepted:
        raise ValueError("ministry_mapping.json has no accepted codes")
    if not isinstance(residual, list):
        raise ValueError("ministry_mapping.json has no residual list")
    if not source.get("url") or not source.get("sha256"):
        raise ValueError("ministry_mapping.json has no source URL / SHA-256")
    codes = [r.get("hsn8") for r in accepted] + [r.get("hsn8") for r in residual]
    if any(not code or len(str(code)) != 8 or not str(code).isdigit() for code in codes):
        raise ValueError("ministry_mapping.json contains a malformed HS code")
    overlap = {r["hsn8"] for r in accepted} & {r["hsn8"] for r in residual}
    if overlap:
        raise ValueError(f"codes listed as both accepted and residual: {sorted(overlap)[:5]}")
    return data


def _known_ministries(conn: sqlite3.Connection) -> set[str]:
    return {r[0] for r in conn.execute("SELECT id FROM ministries")}


def _validate_owners(accepted: list[dict], known: set[str]) -> None:
    unknown: set[str] = set()
    for row in accepted:
        owners = row.get("ministries") or []
        if not owners:
            raise ValueError(f"accepted code {row.get('hsn8')} has no owner")
        unknown.update(mid for mid in owners if mid not in known)
    if unknown:
        raise ValueError(f"Guidebook names ministry ids not present in ministries.json: {sorted(unknown)}")


def run(conn: sqlite3.Connection, path: Path | str | None = None) -> dict:
    """Apply the official mapping; return coverage statistics."""
    data = load_document(path or MAPPING_JSON)
    source = data["_source"]
    accepted_rows: list[dict] = data["accepted"]
    residual_rows: list[dict] = data["residual"]
    accepted = {r["hsn8"]: r for r in accepted_rows}
    residual = {r["hsn8"]: r for r in residual_rows}
    acceptances = int(data.get("counts", {}).get("acceptances")
                      or sum(len(r.get("ministries") or []) for r in accepted_rows))

    conn.executescript(_TABLE_SQL)
    _validate_owners(accepted_rows, _known_ministries(conn))

    # The audit table stores the complete published mapping, not only the rows present in products.
    conn.execute("DELETE FROM guidebook_mapping")
    audit_rows = []
    for row in accepted_rows:
        audit_rows.append((row["hsn8"], "accepted", row["ministries"][0],
                           json.dumps(row["ministries"], ensure_ascii=False), None,
                           row.get("description"), row.get("page")))
    for row in residual_rows:
        audit_rows.append((row["hsn8"], "residual", None, "[]", row.get("probable_ministry"),
                           row.get("description"), row.get("page")))
    conn.executemany(
        "INSERT INTO guidebook_mapping(hsn8, status, primary_ministry_id, ministries_json, "
        "probable_ministry, description, page) VALUES (?,?,?,?,?,?,?)", audit_rows)

    products = conn.execute("SELECT hsn8, ministry_id, mapping_source, mapping_status FROM products").fetchall()
    updates: list[tuple] = []
    primary_rows: list[tuple[str, str, str]] = []
    counts: Counter = Counter()
    changed_primary = 0
    multi_owner = 0
    secondary_rows = 0

    for hsn8, old_ministry, _old_source, _old_status in products:
        row = accepted.get(hsn8)
        if row is not None:
            owners = list(dict.fromkeys(row["ministries"]))
            primary = owners[0]
            page = row.get("page")
            rule = f"dpiit:accepted:p{page}" if page else "dpiit:accepted"
            updates.append((primary, "accepted", GUIDEBOOK_SOURCE, CONFIDENCE, rule, hsn8))
            primary_rows.append((hsn8, primary, "primary"))
            for mid in owners[1:]:
                primary_rows.append((hsn8, mid, "secondary"))
                secondary_rows += 1
            if len(owners) > 1:
                multi_owner += 1
            if old_ministry != primary:
                changed_primary += 1
            counts["official"] += 1
        elif hsn8 in residual:
            row = residual[hsn8]
            page = row.get("page")
            rule = f"dpiit:residual:p{page}" if page else "dpiit:residual"
            updates.append((RESIDUAL, "residual", GUIDEBOOK_SOURCE, None, rule, hsn8))
            counts["guidebook_residual"] += 1
        else:
            updates.append((RESIDUAL, "residual", UNLISTED_SOURCE, None, "not-in-dpiit-guidebook", hsn8))
            counts["not_listed"] += 1

    conn.executemany(
        "UPDATE products SET ministry_id=?, mapping_status=?, mapping_source=?, mapping_confidence=?, "
        "mapping_rule=? WHERE hsn8=?", updates)
    conn.execute("DELETE FROM product_ministries")
    conn.executemany("INSERT INTO product_ministries(hsn8, ministry_id, role) VALUES (?,?,?)", primary_rows)

    conn.execute("DELETE FROM meta WHERE key LIKE 'guidebook_%'")
    meta = {
        "guidebook_revision": source.get("edition") or "",
        "guidebook_source_url": source.get("url") or "",
        "guidebook_source_sha256": source.get("sha256") or "",
        "guidebook_accepted_codes": str(len(accepted)),
        "guidebook_acceptances": str(acceptances),
        "guidebook_residual_codes": str(len(residual)),
        "guidebook_matched_products": str(counts["official"]),
        "guidebook_residual_products": str(counts["guidebook_residual"]),
        "guidebook_not_listed_products": str(counts["not_listed"]),
    }
    conn.executemany("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", list(meta.items()))
    n_fts = rebuild_fts(conn)

    product_codes = {r[0] for r in products}
    return {
        "guidebook_accepted_codes": len(accepted),
        "guidebook_residual_codes": len(residual),
        "guidebook_acceptances": acceptances,
        "matched_official": counts["official"],
        "matched_guidebook_residual": counts["guidebook_residual"],
        "not_listed": counts["not_listed"],
        "official_codes_absent_from_products": len([c for c in accepted if c not in product_codes]),
        "multi_owner_products": multi_owner,
        "secondary_owner_rows": secondary_rows,
        "primary_owner_changed": changed_primary,
        "products_fts": n_fts,
        "source_sha256": source.get("sha256"),
    }
