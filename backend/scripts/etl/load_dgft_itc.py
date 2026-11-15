"""Load the public DGFT ITC-HS import / export policy dataset into ``dgft_itc_policy``.

Input is the deterministic dataset written by :mod:`scripts.etl.fetch_dgft_itc`
(``data/raw/dgft_itc/dgft_itc_policy.jsonl.gz``). Every portal record is kept, including
duplicates, so the database can reproduce the public source. Exactly one record per
``itc_code + direction`` is marked ``is_current = 1``: the last record in portal (API) order.

The loader does not invent a policy for codes the portal does not list. A code with no row is
reported as *not listed* by the API/UI; a listed code whose policy is empty is *not specified*.

Usage (from ``backend/``)::

    python -m scripts.etl.load_dgft_itc             # build step
    python -m scripts.etl.load_dgft_itc path.jsonl.gz
"""
from __future__ import annotations

import gzip
import json
import sqlite3
from pathlib import Path

from scripts.etl import BACKEND_DIR

DATA_DIR = BACKEND_DIR / "data" / "raw" / "dgft_itc"
DATA_FILE = DATA_DIR / "dgft_itc_policy.jsonl.gz"
MANIFEST_FILE = DATA_DIR / "manifest.json"
DIRECTIONS = ("import", "export")
REQUIRED = ("itc_code", "direction", "chapter", "policy", "policy_condition", "itc_code_type",
            "notification_no", "notification_date", "notification_date_iso", "record_index",
            "is_current", "source", "source_url", "fetched_at")


def _read(path: Path) -> tuple[list[dict], dict]:
    manifest = {}
    if MANIFEST_FILE.exists():
        manifest = json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
    records: list[dict] = []
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as handle:  # type: ignore[operator]
        for line_no, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path.name}:{line_no}: malformed JSON ({exc})") from exc
            missing = [key for key in REQUIRED if key not in record]
            if missing:
                raise ValueError(f"{path.name}:{line_no}: missing {', '.join(missing)}")
            code = str(record["itc_code"])
            if len(code) != 8 or not code.isdigit():
                raise ValueError(f"{path.name}:{line_no}: invalid 8-digit ITC code {code!r}")
            if record["direction"] not in DIRECTIONS:
                raise ValueError(f"{path.name}:{line_no}: invalid direction {record['direction']!r}")
            records.append(record)
    return records, manifest


def _validate(records: list[dict]) -> dict:
    if not records:
        raise ValueError("the DGFT dataset is empty")
    keys: set[tuple[str, str, int]] = set()
    current: dict[tuple[str, str], list[dict]] = {}
    for record in records:
        key = (str(record["itc_code"]), str(record["direction"]), int(record["record_index"]))
        if key in keys:
            raise ValueError(f"duplicate DGFT record key {key}")
        keys.add(key)
        current.setdefault((key[0], key[1]), []).append(record)
    out = {"rows": len(records), "codes": len({r["itc_code"] for r in records})}
    for direction in DIRECTIONS:
        rows = [r for r in records if r["direction"] == direction]
        groups = [g for (code, d), g in current.items() if d == direction]
        for group in groups:
            marked = [r for r in group if int(r["is_current"]) == 1]
            if len(marked) != 1:
                code = group[0]["itc_code"]
                raise ValueError(f"{code} / {direction}: expected one current record, found {len(marked)}")
            if int(marked[0]["record_index"]) != max(int(r["record_index"]) for r in group):
                raise ValueError(f"{group[0]['itc_code']} / {direction}: current record is not the last one")
        out[direction] = {
            "records": len(rows),
            "codes": len(groups),
            "codes_with_policy": len({r["itc_code"] for r in rows
                                      if int(r["is_current"]) == 1 and r["policy"]}),
            "duplicate_records": len(rows) - len(groups),
            "fetched_at": max((r["fetched_at"] for r in rows), default=None),
        }
    return out


def run(conn: sqlite3.Connection, path: Path | str | None = None) -> dict:
    """Replace ``dgft_itc_policy`` from the checked-in public dataset; return coverage stats."""
    source = Path(path) if path else DATA_FILE
    if not source.exists():
        return {"skipped": f"{source} not found - run python -m scripts.etl.fetch_dgft_itc"}
    records, manifest = _read(source)
    stats = _validate(records)
    stats["file"] = source.name
    stats["fetched_at"] = stats.get("fetched_at") or manifest.get("fetched_at")

    conn.execute("DELETE FROM dgft_itc_policy")
    conn.executemany(
        """INSERT INTO dgft_itc_policy (
               itc_code, direction, record_index, chapter, description, policy, policy_condition,
               itc_code_type, notification_no, notification_date, notification_date_iso,
               is_current, source, source_url, fetched_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            (r["itc_code"], r["direction"], int(r["record_index"]), r["chapter"], r["description"],
             r["policy"], r["policy_condition"], r["itc_code_type"], r["notification_no"],
             r["notification_date"], r["notification_date_iso"], int(r["is_current"]),
             r["source"] or "dgft_itc_hs", r["source_url"], r["fetched_at"])
            for r in records
        ],
    )
    return stats


if __name__ == "__main__":  # manual run against an existing database
    import os
    import sys

    db = os.environ.get("ATLAS_DB", str(BACKEND_DIR / "data" / "atlas.db"))
    conn = sqlite3.connect(db)
    try:
        print(run(conn, sys.argv[1] if len(sys.argv) > 1 else None))
        conn.commit()
    finally:
        conn.close()
