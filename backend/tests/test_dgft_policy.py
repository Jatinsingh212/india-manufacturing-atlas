"""Regression checks for the public DGFT ITC-HS import / export policy feed.

The dataset is the public DGFT "Discover" ITC-HS table (Schedule I import and Schedule II export),
fetched with the page's own CSRF token. These tests lock the published counts, the duplicate-record
rule (last record in portal order is current), the plain-text conditions and the three API states:
``specified``, ``not_specified`` and ``not_listed``. No rule or parent fallback is allowed.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
DGFT_DIR = BACKEND_DIR / "data" / "raw" / "dgft_itc"
DATASET = DGFT_DIR / "dgft_itc_policy.jsonl.gz"
MANIFEST = DGFT_DIR / "manifest.json"
HTML_TAG_RE = re.compile(r"</?[a-zA-Z][^>]*>")


def _manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def _records() -> list[dict]:
    with gzip.open(DATASET, "rt", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def _require_policy_table(db_conn) -> None:
    if not db_conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dgft_itc_policy'").fetchone():
        pytest.skip("dgft_itc_policy is missing - rebuild with 'python -m scripts.build_db'")


# =========================================================================== dataset

def test_manifest_and_file_hashes_match() -> None:
    manifest = _manifest()
    assert manifest["source_id"] == "dgft_itc_hs"
    assert manifest["source_url"].endswith("opt=itchs-import-export")
    assert manifest["method"].startswith("GET public home page for _csrf")
    # The public page needs no account, OTP or CAPTCHA and no access-control bypass.
    assert manifest["authentication"].lower().startswith("none")
    assert "captcha" in manifest["authentication"].lower()
    assert manifest["file"] == DATASET.name
    assert hashlib.sha256(DATASET.read_bytes()).hexdigest() == manifest["file_sha256"]
    with gzip.open(DATASET, "rb") as handle:
        assert hashlib.sha256(handle.read()).hexdigest() == manifest["content_sha256"]


def test_published_totals() -> None:
    totals = _manifest()["totals"]
    assert totals["records"] == 25_187
    assert totals["codes"] == 12_571
    assert totals["chapters"] == 98
    assert totals["current_records"] == 25_142
    assert totals["duplicate_records"] == 45
    for direction, records, codes, with_policy, without_policy, duplicates in (
            ("import", 12_587, 12_571, 12_512, 59, 16),
            ("export", 12_600, 12_571, 12_510, 61, 29)):
        block = totals[direction]
        assert block["records"] == records
        assert block["codes"] == codes
        assert block["codes_with_policy"] == with_policy
        assert block["current_without_policy"] == without_policy
        assert block["duplicate_records"] == duplicates


def test_one_current_record_per_code_and_direction() -> None:
    records = _records()
    assert len(records) == 25_187
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for record in records:
        code = str(record["itc_code"])
        assert len(code) == 8 and code.isdigit(), record
        assert record["direction"] in ("import", "export"), record
        groups[(code, record["direction"])].append(record)

    assert len(groups) == 25_142
    duplicates = 0
    for (code, direction), group in groups.items():
        group.sort(key=lambda r: r["record_index"])
        assert [r["record_index"] for r in group] == list(range(len(group))), (code, direction)
        current = [r for r in group if int(r["is_current"]) == 1]
        assert len(current) == 1, (code, direction)
        assert current[0] is group[-1], (code, direction)
        if len(group) > 1:
            duplicates += len(group) - 1
            # The portal appends newer notifications last: the current record never has an older
            # notification date than an earlier record of the same code and direction.
            dates = [r["notification_date_iso"] for r in group if r["notification_date_iso"]]
            if len(dates) == len(group):
                assert dates == sorted(dates), (code, direction, dates)
    assert duplicates == 45


def test_duplicate_code_10011900_export_uses_latest_record() -> None:
    rows = [r for r in _records() if r["itc_code"] == "10011900" and r["direction"] == "export"]
    rows.sort(key=lambda r: r["record_index"])
    assert [r["policy"] for r in rows] == ["Prohibited", "Free"]
    assert [r["notification_no"] for r in rows] == ["06/2015-20", "35/2026-27"]
    assert [int(r["is_current"]) for r in rows] == [0, 1]
    assert rows[-1]["notification_date_iso"] == "2026-08-24"


def test_conditions_are_plain_text() -> None:
    records = _records()
    assert not any(HTML_TAG_RE.search(r["description"] or "") for r in records)
    assert not any(HTML_TAG_RE.search(r["policy_condition"] or "") for r in records)
    # A mathematical "<" is content, not markup.
    mica = [r for r in records if r["itc_code"] == "25111010" and r["direction"] == "export"]
    assert mica and "Specific Gravity < 4.0" in (mica[0]["policy_condition"] or "")


# =========================================================================== database + API

def test_database_counts_and_current_flags(db_conn) -> None:
    _require_policy_table(db_conn)
    counts = db_conn.execute("""
        SELECT direction, COUNT(*) AS records, COUNT(DISTINCT itc_code) AS codes,
               SUM(is_current) AS current_records
        FROM dgft_itc_policy GROUP BY direction""").fetchall()
    assert {r["direction"]: (r["records"], r["codes"], r["current_records"]) for r in counts} == {
        "import": (12_587, 12_571, 12_571),
        "export": (12_600, 12_571, 12_571),
    }
    bad = db_conn.execute("""
        SELECT itc_code, direction, SUM(is_current) AS n, MAX(record_index) AS last_index,
               MAX(CASE WHEN is_current = 1 THEN record_index END) AS current_index
        FROM dgft_itc_policy GROUP BY itc_code, direction
        HAVING n <> 1 OR current_index <> last_index LIMIT 5""").fetchall()
    assert not bad, bad


def test_trade_policy_states_on_product_detail(client, db_conn) -> None:
    _require_policy_table(db_conn)

    free = client.get("/api/hsn/product/87042219").json()["trade_policy"]
    assert free["source"] == "dgft_itc_hs"
    assert free["source_url"].endswith("opt=itchs-import-export")
    assert free["fetched_at"] == _manifest()["fetched_at"]
    assert free["import"]["status"] == "specified" and free["import"]["policy"] == "Free"
    assert free["import"]["provenance"]["status"] == "verified"
    # A published code may still have no export policy value: not_specified, never a fallback.
    assert free["export"]["status"] == "not_specified" and free["export"]["policy"] is None
    assert free["export"]["provenance"]["status"] == "not_available"

    basmati = client.get("/api/hsn/product/10063020").json()["trade_policy"]
    assert basmati["import"]["status"] == "not_specified"
    export = basmati["export"]
    assert export["status"] == "specified" and export["policy"] == "Free"
    assert export["notification_no"] == "62/2024-25"
    assert export["notification_date_iso"] == "2025-03-10"
    assert export["condition"] and "EU Member States" in export["condition"]
    assert not HTML_TAG_RE.search(export["condition"])

    tyre = client.get("/api/hsn/product/40111090").json()["trade_policy"]
    assert tyre["import"]["policy"] == "Restricted"
    assert tyre["import"]["notification_no"] == "12/2015-2020"
    assert tyre["import"]["notification_date_iso"] == "2020-06-12"


def test_duplicate_record_resolution_through_api(client, db_conn) -> None:
    _require_policy_table(db_conn)
    export = client.get("/api/hsn/product/10011900").json()["trade_policy"]["export"]
    assert export["status"] == "specified" and export["policy"] == "Free"
    assert export["notification_no"] == "35/2026-27"
    assert export["notification_date_iso"] == "2026-08-24"
    assert export["n_records"] == 2
    assert export["description"]


def test_code_absent_from_dgft_is_not_listed(client, db_conn) -> None:
    _require_policy_table(db_conn)
    for direction in ("import", "export"):
        missing = db_conn.execute("""
            SELECT p.hsn8 FROM products p
            WHERE NOT EXISTS (SELECT 1 FROM dgft_itc_policy d
                              WHERE d.itc_code = p.hsn8 AND d.direction = ?)
            ORDER BY p.hsn8 LIMIT 1""", (direction,)).fetchone()
        if not missing:
            pytest.skip(f"every GST product has a DGFT {direction} row")
        policy = client.get(f"/api/hsn/product/{missing['hsn8']}").json()["trade_policy"]
        block = policy[direction]
        assert block["status"] == "not_listed"
        assert block["policy"] is None and block["condition"] is None and block["itc_type"] is None
        assert block["n_records"] == 0
        assert block["provenance"]["status"] == "not_available"
        # No rule, parent policy or ministry hint is substituted for the absent value.
        assert "not listed" in (block["provenance"]["label"] or "").lower()


def test_public_feed_is_a_separate_connected_source(db_conn) -> None:
    _require_policy_table(db_conn)
    source = db_conn.execute("SELECT * FROM data_sources WHERE id = 'dgft_itc_hs'").fetchone()
    assert source is not None
    assert source["status"] == "connected" and source["kind"] == "api"
    assert source["url"].endswith("opt=itchs-import-export")
    assert source["records"] == 25_187
    assert source["last_refreshed"] == _manifest()["fetched_at"]
    assert "captcha" in source["description"].lower()

    credentialed = db_conn.execute("SELECT status FROM data_sources WHERE id = 'dgft'").fetchone()
    assert credentialed is not None and credentialed["status"] == "not_configured"


# =========================================================================== fetch behaviour

def test_partial_chapter_fetch_is_a_read_only_probe(tmp_path, monkeypatch) -> None:
    """A connectivity probe must not overwrite the complete dataset or manifests."""
    from scripts.etl import fetch_dgft_itc

    payload = {"itcCodeClassifications": [{
        "itcCode": "01012100",
        "itcDescription": "Horses; live, pure-bred breeding animals",
        "impPolicy": "Free",
        "impCondition": None,
        "impItcCodeType": "ITC-HS",
        "notificationNo": "01/2023",
        "notificationDate": "01/04/2023",
    }]}

    def fake_fetch_chapter(session, chapter, exp_type):
        assert chapter == "01" and exp_type in (1, 2)
        return payload, json.dumps(payload), "token"

    monkeypatch.setattr(fetch_dgft_itc, "_new_session", lambda: object())
    monkeypatch.setattr(fetch_dgft_itc, "fetch_chapter", fake_fetch_chapter)

    out_dir = tmp_path / "dgft"
    central = tmp_path / "manifest.json"
    report = fetch_dgft_itc.fetch_all(chapters=("01",), out_dir=out_dir, central_manifest=central, sleep=0)

    assert report["probe"] is True
    assert report["chapters"] == ["01"]
    assert report["totals"]["records"] == 2
    assert report["totals"]["codes"] == 1
    assert not (out_dir / fetch_dgft_itc.OUT_FILE.name).exists()
    assert not (out_dir / fetch_dgft_itc.OUT_MANIFEST.name).exists()
    assert not central.exists()
