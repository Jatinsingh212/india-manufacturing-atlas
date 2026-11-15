"""Tests for the supplier-tier knowledge base (backend/data/curated/supply_tiers.json).

* validates the curated document (structure, chain ids, ministry ids vs. ministry texts, HS-code
  existence in the raw GST master / HS2022 nomenclature, tier levels, examples);
* runs ``scripts.etl.load_supply_tiers`` against a temporary SQLite database and checks the tables it
  writes, including the Atlas's re-derived ministry ownership;
* exercises the API endpoint ``GET /api/valuechains/{id}/tiers`` against the real database.

Does not need ``data/atlas.db`` except for the API test, which is skipped when it is not built.
Run from ``backend/``:  ``python -m pytest -q tests/test_supply_tiers_data.py``
"""
from __future__ import annotations

import csv
import json
import sqlite3
from pathlib import Path

import openpyxl
import pytest

from scripts.etl import CURATED_DIR, RAW_DIR, SCHEMA_PATH
from scripts.etl import load_supply_tiers as lst
from scripts.etl import load_value_chains as lvc

REQUIRED_TIERS = {"sports_goods"}


# --------------------------------------------------------------------------- fixtures (module scope)

@pytest.fixture(scope="module")
def doc() -> dict:
    return json.loads((CURATED_DIR / "supply_tiers.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def chains(doc) -> dict[str, dict]:
    return {c["chain_id"]: c for c in doc["chains"]}


@pytest.fixture(scope="module")
def ministries() -> list[dict]:
    return lvc.load_ministries()


@pytest.fixture(scope="module")
def nomenclature() -> dict[str, dict]:
    out = {}
    with open(RAW_DIR / "hs_nomenclature.csv", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            if r["section"] != "TOTAL" and r["level"] in ("2", "4", "6"):
                out[r["hscode"]] = r
    return out


@pytest.fixture(scope="module")
def gst_master() -> dict[str, str]:
    wb = openpyxl.load_workbook(RAW_DIR / "gst_hsn_master.xlsx", read_only=True)
    try:
        out = {}
        for code, text, *_ in wb["HSN_MSTR"].iter_rows(min_row=2, values_only=True):
            code = str(code or "").strip()
            if len(code) == 8 and code.isdigit():
                out[code] = str(text or "")
        return out
    finally:
        wb.close()


# --------------------------------------------------------------------------- curated document

def test_structure_and_chain_ids(chains):
    assert chains, "supply_tiers.json has no chains"
    assert REQUIRED_TIERS <= set(chains)
    for cid, c in chains.items():
        assert c.get("source"), f"{cid}: 'source' is required"
        assert c.get("source_label"), f"{cid}: 'source_label' is required"
        levels = [t["level"] for t in c["tiers"]]
        assert levels == sorted(levels), f"{cid}: tiers are not ordered by level"
        assert len(set(levels)) == len(levels), f"{cid}: duplicate tier level"
        assert levels and levels[0] == 1, f"{cid}: the first tier must be level 1"
        for t in c["tiers"]:
            assert t.get("name"), (cid, t)
            assert t.get("description"), (cid, t)
            assert t["examples"], f"{cid} tier {t['level']}: 'examples' is required"
            assert all(isinstance(e, str) and e.strip() for e in t["examples"]), (cid, t)
            assert t["items"], f"{cid} tier {t['level']}: no items"
            for i in t["items"]:
                assert i.get("item") and i.get("description"), (cid, i)
                assert i.get("hs_code"), (cid, i)


def test_curated_ministry_suggestions_are_known_and_match_their_texts(chains, ministries):
    """A curated ministry hint is optional, but when present it must name a known ministry."""
    known = {m["id"] for m in ministries}
    index = lvc.build_alias_index(ministries)
    for cid, c in chains.items():
        for t in c["tiers"]:
            for i in t["items"]:
                ids = i.get("ministry_ids")
                if ids is None:
                    ids = lvc.resolve_ministry_text(i.get("ministry_text"), index)
                assert set(ids) <= known, (cid, i)
                if i.get("ministry_ids") is not None:
                    assert lvc.resolve_ministry_text(i.get("ministry_text"), index) == list(ids), (cid, i)


def test_codes_exist_in_raw_sources(chains, nomenclature, gst_master):
    for cid, c in chains.items():
        for t in c["tiers"]:
            for i in t["items"]:
                code = i["hs_code"]
                assert code.isdigit() and len(code) in (2, 4, 6, 8), (cid, code)
                if len(code) == 8:
                    assert code in gst_master, f"{cid}: {code} not in GST master"
                    assert code[:6] in nomenclature, f"{cid}: {code} is not a current HS2022 line"
                else:
                    assert code in nomenclature, f"{cid}: {code} not in hs_nomenclature.csv"


def test_sports_goods_tiers_match_the_study_structure(chains):
    """The sports-goods tiers are the study's three levels, with the study's example supplier types."""
    sg = chains["sports_goods"]
    assert [t["level"] for t in sg["tiers"]] == [1, 2, 3]
    assert [t["name"] for t in sg["tiers"]] == ["Tier 1 suppliers", "Tier 2 suppliers", "Tier 3 suppliers"]
    t1, t2, t3 = sg["tiers"]
    assert "Direct suppliers" in t1["description"]
    assert "Tier 1 suppliers" in t2["description"]
    assert "Tier 2 suppliers" in t3["description"]
    # the study's example supplier types are carried through verbatim
    assert "Bat manufacturers" in t1["examples"]
    assert "Ball manufacturers" in t1["examples"]
    assert "Leather apparel manufacturers" in t1["examples"]
    assert "Synthetic turf manufacturers" in t1["examples"]
    assert "Industrial adhesive manufacturers" in t1["examples"]
    assert "Raw base polymer producers" in t2["examples"]
    assert "Rubber compound manufacturers" in t2["examples"]
    assert "Textile manufacturers" in t2["examples"]
    assert "Sewing machine manufacturers" in t2["examples"]
    assert "Button makers" in t2["examples"]
    assert "Marker and thread manufacturers" in t2["examples"]
    assert any("Petrochemical" in e for e in t3["examples"])
    assert "Bolt and nut manufacturers" in t3["examples"]
    assert "Chemical producers" in t3["examples"]
    assert "Steel mills" in t3["examples"]
    assert "Timber suppliers" in t3["examples"]
    # the tiers deepen: Tier 1 holds the finished-goods specialists, Tier 3 the basic materials
    assert {"95069920", "95066920", "95066210"} <= {i["hs_code"] for i in t1["items"]}
    assert {"39081011", "73181500", "72161000"} <= {i["hs_code"] for i in t3["items"]}
    # the base polymers and rubber compounds sit in Tier 2, one step above the petrochemicals of Tier 3
    assert {"39021000", "39011010", "39095000", "40012200", "40021990"} <= {i["hs_code"] for i in t2["items"]}


# --------------------------------------------------------------------------- loader against a temp DB

@pytest.fixture
def db(tmp_path, ministries, nomenclature, gst_master):
    """Temporary atlas DB: schema + ministries + hs_nodes (HS2022) + products for the tier codes."""
    path = tmp_path / "tiers_test.db"
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    conn.executemany(
        "INSERT INTO ministries (id, short_name, name, parent_ministry, kind, website, color) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [(m["id"], m["short_name"], m["name"], m["parent_ministry"], m["kind"], m["website"], m["color"])
         for m in ministries],
    )
    conn.executemany(
        "INSERT OR IGNORE INTO hs_nodes (code, level, parent, section_id, description) VALUES (?, ?, ?, ?, ?)",
        [(code, int(r["level"]), None if r["level"] == "2" else r["parent"], r["section"], r["description"])
         for code, r in nomenclature.items()],
    )
    codes = {i["hs_code"] for c in json.loads((CURATED_DIR / "supply_tiers.json").read_text(encoding="utf-8"))["chains"]
             for t in c["tiers"] for i in t["items"] if len(i["hs_code"]) == 8}
    conn.executemany(
        "INSERT INTO products (hsn8, hs6, hs4, hs2, description, ministry_id, mapping_status, mapping_source) "
        "VALUES (?, ?, ?, ?, ?, 'residual', 'residual', 'rule')",
        [(c, c[:6], c[:4], c[:2], gst_master[c] or c) for c in sorted(codes)],
    )
    conn.execute("INSERT INTO value_chains (id, name, title, anchor_hs, lead_ministry_id, description, phase, "
                 "source, manufacturers_json, skill_council_json, sort_order) "
                 "VALUES ('sports_goods', 'Sports Goods', 'Sports Goods (HS Code 9506)', '9506', 'sports', 'x', "
                 "'Sector deep-dive', 'curated', '[]', NULL, 1)")
    conn.commit()
    try:
        yield conn
    finally:
        conn.close()


def test_loader_writes_the_tier_tables(db, doc):
    stats = lst.load_tiers(db, doc)
    n_tiers = sum(len(c["tiers"]) for c in doc["chains"])
    n_items = sum(len(t["items"]) for c in doc["chains"] for t in c["tiers"])
    assert stats["tiers"] == n_tiers
    assert stats["items"] == n_items
    assert db.execute("SELECT COUNT(*) FROM vc_tiers").fetchone()[0] == n_tiers
    assert db.execute("SELECT COUNT(*) FROM vc_tier_items").fetchone()[0] == n_items
    assert stats["items_8digit_not_in_products"] == []

    row = db.execute("SELECT name, description, examples_json FROM vc_tiers WHERE chain_id = 'sports_goods' "
                     "AND tier_level = 1").fetchone()
    assert row[0] == "Tier 1 suppliers"
    assert "Direct suppliers" in row[1]
    assert "Bat manufacturers" in json.loads(row[2])


def test_loader_replaces_ministry_ids_with_the_atlas_mapping(db, doc):
    """The curated ids are only a suggestion: the loader replaces them with the Atlas's own mapping."""
    stats = lst.load_tiers(db, doc)
    # every item carries the Atlas owner of its 8-digit line (the test DB maps them all to 'residual')
    ids = {tuple(json.loads(r[0])) for r in db.execute("SELECT ministry_ids_json FROM vc_tier_items")}
    assert ids == {("residual",)}
    # the items whose curated suggestion differed from the Atlas mapping are reported, not silently dropped
    changed = {c["hs_code"] for c in stats["curated_ministries_rederived"]}
    assert changed, "the curated suggestions should differ from the Atlas mapping in the test DB"
    assert changed == {i["hs_code"] for c in doc["chains"] for t in c["tiers"] for i in t["items"]}


def test_loader_is_idempotent(db, doc):
    lst.load_tiers(db, doc)
    before = db.execute("SELECT COUNT(*) FROM vc_tier_items").fetchone()[0]
    lst.load_tiers(db, doc)
    assert db.execute("SELECT COUNT(*) FROM vc_tier_items").fetchone()[0] == before


def test_unknown_chain_is_rejected(db, doc):
    bad = json.loads(json.dumps(doc))
    bad["chains"][0]["chain_id"] = "no_such_chain"
    with pytest.raises(lst.SupplyTierError):
        lst.load_tiers(db, bad)


def test_malformed_codes_and_unknown_ministries_are_rejected(db, doc):
    bad = json.loads(json.dumps(doc))
    bad["chains"][0]["tiers"][0]["items"][0]["hs_code"] = "12ab"
    with pytest.raises(lst.SupplyTierError):
        lst.load_tiers(db, bad)

    bad = json.loads(json.dumps(doc))
    bad["chains"][0]["tiers"][0]["items"][0]["ministry_ids"] = ["not_a_ministry"]
    with pytest.raises(lst.SupplyTierError):
        lst.load_tiers(db, bad)


# --------------------------------------------------------------------------- API

def test_tiers_endpoint_returns_the_three_levels(client):
    body = client.get("/api/valuechains/sports_goods/tiers").json()
    assert body["chain_id"] == "sports_goods"
    assert [t["tier_level"] for t in body["tiers"]] == [1, 2, 3]
    for t in body["tiers"]:
        assert t["name"] and t["description"] and t["examples"]
        assert t["items"]
        for i in t["items"]:
            assert {"item_name", "hs_code", "ministries", "exports", "imports", "linked"} <= set(i)
            assert i["linked"], f"{i['item_name']}: the tier item has no trade data"
            assert i["exports"] is not None or i["imports"] is not None


def test_tiers_endpoint_404s_for_an_unknown_chain(client):
    assert client.get("/api/valuechains/no_such_chain/tiers").status_code == 404


def test_tiers_carry_a_not_verified_curated_provenance(client):
    """Curated tier rows are published as Not verified until a ministry validates them."""
    body = client.get("/api/valuechains/sports_goods/tiers").json()
    mapping = body["provenance"]["mapping"]
    assert mapping["status"] == "not_verified"
    assert mapping["counts"] == {"curated": 40}
    assert body["provenance"]["trade"]["status"] == "verified"
    for t in body["tiers"]:
        assert t["provenance"]["status"] == "not_verified"
        assert t["provenance"]["counts"] == {"curated": len(t["items"])}
        for i in t["items"]:
            assert i["provenance"]["status"] == "not_verified"
            assert i["provenance"]["source"] == "study"


def test_chain_detail_flags_whether_it_has_tiers(client):
    sports = client.get("/api/valuechains/sports_goods").json()
    assert sports["has_tiers"] is True
    tyre = client.get("/api/valuechains/tyre").json()
    assert tyre["has_tiers"] is False
    assert client.get("/api/valuechains/tyre/tiers").json()["tiers"] == []
