"""Tests for the value-chain knowledge base (owner B1).

* validates ``data/curated/value_chains.json`` (structure, ids, ministry ids vs. ministry texts, HS-code existence in
  the raw GST master / HS2022 nomenclature, edges, clusters) and checks the tyre and natural-rubber chains;
* runs ``scripts.etl.load_value_chains`` and ``scripts.etl.derive_part_links`` against a temporary SQLite database
  created from ``scripts/etl/schema.sql`` with minimal ``ministries`` / ``products`` / ``hs_nodes`` rows.

Does not need ``data/atlas.db``. Run from ``backend/``:  ``python -m pytest -q tests/test_value_chains_data.py``
"""
from __future__ import annotations

import copy
import csv
import json
import sqlite3
from pathlib import Path

import openpyxl
import pytest

from scripts.etl import CURATED_DIR, RAW_DIR, SCHEMA_PATH
from scripts.etl import derive_part_links as dpl
from scripts.etl import load_value_chains as lvc

REQUIRED_CHAINS = {"tyre", "natural_rubber", "cotton_apparel", "auto_components", "pharma_api",
                   "mobile_electronics", "solar_pv", "steel", "ev_battery", "leather_footwear"}


# --------------------------------------------------------------------------- fixtures (module scope)

@pytest.fixture(scope="module")
def doc() -> dict:
    return json.loads((CURATED_DIR / "value_chains.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def chains(doc) -> dict[str, dict]:
    return {c["id"]: c for c in doc["chains"]}


@pytest.fixture(scope="module")
def ministries() -> list[dict]:
    return lvc.load_ministries()


@pytest.fixture(scope="module")
def nomenclature() -> dict[str, dict]:
    """HS2022 nodes of raw/hs_nomenclature.csv (the synthetic TOTAL / chapter-99 rows excluded)."""
    out = {}
    with open(RAW_DIR / "hs_nomenclature.csv", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            if r["section"] != "TOTAL" and r["level"] in ("2", "4", "6"):
                out[r["hscode"]] = r
    return out


@pytest.fixture(scope="module")
def gst_master() -> dict[str, str]:
    """8-digit code -> line text of raw/gst_hsn_master.xlsx, sheet HSN_MSTR."""
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


def _items(chain: dict):
    for stage in chain["stages"]:
        for item in stage["items"]:
            yield stage, item


def _all_item_codes(chains: dict) -> set[str]:
    return {i["hs_code"] for c in chains.values() for _, i in _items(c) if i["hs_code"]}


# --------------------------------------------------------------------------- JSON: structure and ids

def test_structure_and_unique_ids(doc, chains):
    assert len(doc["chains"]) >= 10
    assert len(chains) == len(doc["chains"]), "duplicate chain ids"
    assert REQUIRED_CHAINS <= set(chains)
    orders = [c["sort_order"] for c in doc["chains"]]
    assert len(set(orders)) == len(orders)
    required = {"id", "name", "title", "anchor_hs", "lead_ministry_id", "description", "phase", "source",
                "sort_order", "stages", "edges", "manufacturers", "clusters", "skill_council"}
    for cid, c in chains.items():
        assert required <= set(c), f"{cid}: missing {required - set(c)}"
        assert c["source"] == "curated"
        assert c["phase"] == "Sector deep-dive"
        assert not ({"kpi_overrides", "playbook_reference", "_notes"} & set(c)), cid
        stage_ids = [s["id"] for s in c["stages"]]
        assert len(set(stage_ids)) == len(stage_ids), cid
        assert [s["order"] for s in c["stages"]] == list(range(1, len(c["stages"]) + 1)), cid
        for _, item in _items(c):
            assert item["item"] and item["description"], (cid, item)
            assert item["source"] == "curated"
            assert not ({"deck_hs_code", "deck_description", "deck_slide", "note"} & set(item)), (cid, item)


def test_ministry_ids_are_known_and_match_texts(chains, ministries):
    known = {m["id"] for m in ministries}
    index = lvc.build_alias_index(ministries)
    for cid, c in chains.items():
        assert c["lead_ministry_id"] in known, cid
        for stage in c["stages"]:
            assert stage["ministry_ids"] and set(stage["ministry_ids"]) <= known, (cid, stage["id"])
            assert lvc.resolve_ministry_text(stage["ministry_text"], index) == stage["ministry_ids"], (cid, stage["id"])
        for stage, item in _items(c):
            assert set(item["ministry_ids"]) <= known, (cid, item)
            assert lvc.resolve_ministry_text(item["ministry_text"], index) == item["ministry_ids"], (cid, item)


def test_codes_exist_in_raw_sources(chains, nomenclature, gst_master):
    for cid, c in chains.items():
        assert c["anchor_hs"] in nomenclature, (cid, c["anchor_hs"])
        for _, item in _items(c):
            code = item["hs_code"]
            if code is None:
                continue
            assert code.isdigit() and len(code) in (2, 4, 6, 8), (cid, code)
            if len(code) == 8:
                assert code in gst_master, f"{cid}: {code} not in GST master"
                assert code[:6] in nomenclature, f"{cid}: {code} is not a current HS2022 line"
            else:
                assert code in nomenclature, f"{cid}: {code} not in hs_nomenclature.csv"


def test_curated_chain_shape(chains):
    for cid, c in chains.items():
        assert 3 <= len(c["stages"]) <= 4, cid
        for stage in c["stages"]:
            assert 1 <= len(stage["items"]) <= 19, (cid, stage["id"])
        assert sum(1 for _, i in _items(c) if i["hs_code"]) >= 8, cid
        assert sum(len(s["items"]) >= 3 for s in c["stages"]) >= 2, cid
        assert len(c["description"]) > 150 and c["description"].count(". ") >= 1, cid
        assert len(c["manufacturers"]) >= 2 or c.get("coverage_note"), cid   # a note explains thin sources
        assert c["skill_council"] is None or c["skill_council"]["name"], cid


def test_manufacturers_clusters_and_skill_councils(chains):
    seen: dict[str, dict] = {}
    for cid, c in chains.items():
        for m in c["manufacturers"]:
            assert m["name"]
            assert m["url"] is None or m["url"].startswith("https://"), (cid, m)
        sc = c["skill_council"]
        if sc is not None:
            assert sc["url"] is None or sc["url"].startswith("https://"), (cid, sc)
        assert len(c["clusters"]) >= (1 if c.get("coverage_note") else 2), cid
        for cl in c["clusters"]:
            assert {"id", "name", "state", "district", "products", "lat", "lon"} <= set(cl), (cid, cl)
            assert 6.0 <= cl["lat"] <= 37.5 and 68.0 <= cl["lon"] <= 97.5, (cid, cl["id"])  # inside India
            if cl["id"] in seen:
                assert seen[cl["id"]] == cl, f"cluster {cl['id']} differs between chains"
            seen[cl["id"]] = cl


def test_edges_are_valid_and_connect_the_ecosystem(chains):
    item_codes = _all_item_codes(chains)
    keys = set()
    used = set()
    for cid, c in chains.items():
        for e in c["edges"]:
            assert e["relation"] in lvc.RELATIONS, (cid, e)
            assert e.get("source", c["source"]) in lvc.OWNED_SOURCES, (cid, e)
            assert e["src"] in item_codes and e["dst"] in item_codes, (cid, e)
            assert e["src"] != e["dst"], (cid, e)
            key = (e["src"], e["dst"], e["relation"])
            assert key not in keys, f"duplicate edge {key}"
            keys.add(key)
            used.update((e["src"], e["dst"]))
    assert item_codes <= used, f"items without any edge: {sorted(item_codes - used)}"

    def chain_edges(cid):
        return [(e["src"], e["dst"]) for e in chains[cid]["edges"]]

    # cross-chain links carried by the curated chains
    assert any(s.startswith("7209") and d.startswith("8708") for s, d in chain_edges("steel")), \
        "steel -> auto components"
    assert any(s == "72139190" and d == "73262010" for s, d in chain_edges("steel")), "steel -> bead wire"
    assert any(s == "52091250" and d == "64041110" for s, d in chain_edges("cotton_apparel")), \
        "cotton fabric -> footwear"
    assert any(s == "76012010" and d == "76071190" for s, d in chain_edges("ev_battery")), \
        "aluminium -> foil (shared with solar)"
    assert any(s == "85076000" and d.startswith("870380") for s, d in chain_edges("ev_battery")), "Li-ion -> EVs"
    assert any(s[:4] in ("5208", "5209", "6006") and d[:2] in ("61", "62")
               for s, d in chain_edges("cotton_apparel")), "cotton fabric -> apparel"
    assert any(s.startswith("4001") and d.startswith("4011") for s, d in chain_edges("natural_rubber"))
    nr_codes = {i["hs_code"] for _, i in _items(chains["natural_rubber"])}
    tyre_codes = {i["hs_code"] for _, i in _items(chains["tyre"])}
    assert {"40012100", "40012200"} <= nr_codes & tyre_codes, "natural rubber forms shared with the tyre chain"
    # EV cars appear in both auto_components and ev_battery, Li-ion cells in ev_battery and mobile_electronics
    assert "87038030" in {i["hs_code"] for _, i in _items(chains["auto_components"])}
    assert "85076000" in {i["hs_code"] for _, i in _items(chains["mobile_electronics"])}


# --------------------------------------------------------------------------- JSON: the two sector pages

TYRE_RAW = [
    ("Natural Rubber", "40012100"), ("Natural Rubber", "40012200"), ("Natural Rubber", "40012910"),
    ("Natural Rubber", "40012920"), ("Natural Rubber", "40012930"),
    ("Synthetic Rubber", "40021910"), ("Synthetic Rubber", "40021920"), ("Synthetic Rubber", "40021930"),
    ("Synthetic Rubber", "40021990"), ("Synthetic Rubber", "40022000"), ("Synthetic Rubber", "40029920"),
    ("Carbon Black", "28030010"), ("Silica", "28112200"), ("Oils and Plasticizers", "27101990"),
    ("Oils and Plasticizers", "38122010"), ("Oils and Plasticizers", "38122090"),
    ("Vulcanizing Agents", "38123930"), ("Vulcanizing Agents", "29342000"), ("Adhesives", "35069190"),
]
TYRE_COMPONENTS = [
    ("Bead Assembly", "40169990"), ("Tyre Cord Fabric", "5902"), ("Bead Wire", "73262010"),
]
TYRE_FINISHED = [
    ("Passenger Car Tyres", "40111010"), ("Passenger Car Tyres", "40111090"),
    ("Truck and Bus Tyres", "40112010"), ("Truck and Bus Tyres", "40112090"),
    ("Aircraft Tyres", "40113000"), ("Motorcycle Tyres", "40114010"),
    ("Motorcycle Tyres", "40114020"), ("Motorcycle Tyres", "40114090"),
]
TYRE_MANUFACTURERS = [
    ("MRF", "https://www.mrftyres.com/"), ("Apollo Tyres", "https://www.apollotyres.com/en-in/"),
    ("JK Tyre & Industries", "https://www.jktyre.com/"), ("CEAT", "https://www.ceat.com/"),
    ("Birla Tyres", "https://birlatyre.com/"), ("TVS Srichakra", "https://tvsmobility.in/manufacturing/"),
    ("Goodyear India", "https://www.goodyear.co.in/"), ("Bridgestone India", "https://www.bridgestone.co.in/"),
]


def test_tyre_chain_is_curated(chains):
    t = chains["tyre"]
    assert (t["title"], t["anchor_hs"], t["lead_ministry_id"]) == ("Tyre Sector (HS Code 4011)", "4011", "dpiit")
    stages = {s["id"]: s for s in t["stages"]}
    assert [s["name"] for s in t["stages"]] == ["Raw Materials", "Components", "Finished Goods"]
    assert [len(s["items"]) for s in t["stages"]] == [19, 3, 8]
    assert stages["raw"]["ministry_text"] == "D/o Commerce, DCPC, M/o Mines, M/o Petroleum & Natural Gas, DPIIT"
    assert stages["components"]["ministry_text"] == "DPIIT, M/o Textiles, M/o Steel"
    assert stages["finished"]["ministry_text"] == "DPIIT"
    assert [(i["item"], i["hs_code"]) for i in stages["raw"]["items"]] == TYRE_RAW
    assert [(i["item"], i["hs_code"]) for i in stages["components"]["items"]] == TYRE_COMPONENTS
    assert [(i["item"], i["hs_code"]) for i in stages["finished"]["items"]] == TYRE_FINISHED
    assert all(i["source"] == "curated" for _, i in _items(t))
    assert all("deck_hs_code" not in i and "deck_description" not in i and "deck_slide" not in i
               for _, i in _items(t))
    by_code = {i["hs_code"]: i for i in stages["raw"]["items"]}
    assert by_code["28112200"]["ministry_ids"] == ["mom", "dcpc"]
    assert by_code["27101990"]["ministry_ids"] == ["mopng"]
    assert by_code["35069190"]["ministry_ids"] == ["dpiit"]
    assert by_code["40021930"]["description"] == "Styrene Butadiene Styrene Oil Bound Copolymer"
    assert {i["hs_code"]: i["ministry_ids"] for i in stages["components"]["items"]}["5902"] == ["mot"]
    assert {i["hs_code"]: i["ministry_ids"] for i in stages["components"]["items"]}["73262010"] == ["mos"]
    assert [(m["name"], m["url"]) for m in t["manufacturers"]] == TYRE_MANUFACTURERS
    assert not ({"kpi_overrides", "playbook_reference", "_notes"} & set(t))


def test_natural_rubber_chain_is_curated(chains):
    nr = chains["natural_rubber"]
    assert (nr["title"], nr["anchor_hs"], nr["lead_ministry_id"]) == \
        ("Natural Rubber Sector (HS Code 4001)", "4001", "doc")
    stages = {s["id"]: s for s in nr["stages"]}
    assert [s["name"] for s in nr["stages"]] == ["Raw Materials", "Processing", "Finished Goods"]
    raw = stages["raw"]["items"]
    assert [(i["item"], i["hs_code"], i["ministry_ids"]) for i in raw] == [("Rubber Tree", "06029090", ["dafw"])]
    assert stages["raw"]["ministry_ids"] == ["dafw"]
    proc_codes = {i["hs_code"] for i in stages["processing"]["items"]}
    assert {"40011010", "40011020", "40012100", "40012200"} <= proc_codes
    assert all(c.startswith("4001") for c in proc_codes)
    assert stages["processing"]["ministry_ids"] == ["doc"]
    fin = stages["finished"]
    assert fin["ministry_text"] == "DPIIT, Ministry of Textiles" and fin["ministry_ids"] == ["dpiit", "mot"]
    names = [i["item"] for i in fin["items"]]
    for item in ("Tyre", "Conveyor belts", "Hoses", "Seals", "Gloves", "Footwear"):
        assert item in names
    assert "Gaskets" not in names
    codes = {i["item"]: set() for i in fin["items"]}
    for i in fin["items"]:
        codes[i["item"]].add(i["hs_code"])
    assert codes["Tyre"] == {"4011"} and codes["Conveyor belts"] == {"4010"} and codes["Hoses"] == {"4009"}
    assert codes["Seals"] == {"401693"} and codes["Gloves"] == {"4015"}
    assert codes["Footwear"] == {"6401", "6402"}
    assert all(i["source"] == "curated" for _, i in _items(nr))
    assert [(m["name"], m["url"]) for m in nr["manufacturers"]] == [
        ("Thomson Rubbers (India) Pvt. Ltd.", None), ("Harrisons Malayalam Ltd.", None),
        ("Arasu Rubber Corporation Ltd.", None)]
    assert not ({"kpi_overrides", "playbook_reference", "_notes"} & set(nr))


# --------------------------------------------------------------------------- loaders against a temp DB

@pytest.fixture
def db(tmp_path, chains, ministries, nomenclature, gst_master):
    """Temporary atlas DB: schema + ministries + hs_nodes (HS2022) + products for the codes the chains use.

    One chain code (40012930) is deliberately left out of ``products`` to exercise the unlinked path.
    """
    path = tmp_path / "vc_test.db"
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
    codes = {c for c in _all_item_codes(chains) if len(c) == 8} - {"40012930"}
    conn.executemany(
        "INSERT INTO products (hsn8, hs6, hs4, hs2, description, ministry_id, mapping_status, mapping_source) "
        "VALUES (?, ?, ?, ?, ?, 'residual', 'residual', 'rule')",
        [(c, c[:6], c[:4], c[:2], gst_master[c] or c) for c in sorted(codes)],
    )
    conn.commit()
    try:
        yield conn
    finally:
        conn.close()


def test_load_value_chains_populates_tables(db, chains):
    # rows owned by other steps / uploads must survive the reload
    db.execute("INSERT INTO vc_edges (src, dst, relation, chain_id, source) VALUES ('8708', '8703', 'parts_of', NULL, 'hs_text')")
    db.execute("INSERT INTO vc_edges (src, dst, relation, chain_id, source) VALUES ('1001', '1101', 'input_to', NULL, 'official_upload')")
    db.execute("INSERT INTO production (scope, key, label, value, unit, source, status) VALUES ('hs4', '4011', 'x', 1, 'units', 'manual', 'verified')")
    db.commit()

    stats = lvc.run(db)
    n_items = sum(len(s["items"]) for c in chains.values() for s in c["stages"])
    n_edges = sum(len(c["edges"]) for c in chains.values())
    assert stats["chains"] == len(chains)
    assert stats["items"] == n_items == db.execute("SELECT COUNT(*) FROM vc_items").fetchone()[0]
    assert stats["stages"] == db.execute("SELECT COUNT(*) FROM vc_stages").fetchone()[0]
    assert stats["edges_inserted"] == n_edges and stats["edges_duplicate_skipped"] == 0
    assert stats["edges_default"] == 0 and stats["cross_chain_edges"] == 7
    assert stats["unknown_codes"] == ["40012930"] and stats["items_8digit_not_in_products"] == ["40012930"]
    assert "items_deck_code_differs" not in stats
    assert db.execute("SELECT COUNT(*) FROM vc_edges WHERE source = 'curated'").fetchone()[0] == n_edges
    assert db.execute("SELECT COUNT(*) FROM vc_edges WHERE source IN ('hs_text','official_upload')").fetchone()[0] == 2
    assert db.execute("SELECT COUNT(*) FROM vc_edges WHERE chain_id IS NULL AND source != 'hs_text' "
                      "AND source != 'official_upload'").fetchone()[0] == 0

    vc = db.execute("SELECT title, anchor_hs, lead_ministry_id, source, manufacturers_json, notes_json "
                    "FROM value_chains WHERE id = 'tyre'").fetchone()
    assert vc[:4] == ("Tyre Sector (HS Code 4011)", "4011", "dpiit", "curated")
    assert len(json.loads(vc[4])) == 8 and vc[5] is None
    assert [r[1] for r in db.execute("PRAGMA table_info(value_chains)")].count("kpi_overrides_json") == 0
    assert [r[1] for r in db.execute("PRAGMA table_info(vc_items)")].count("deck_hs_code") == 0

    # mapping-table order and hsn8 linking
    rows = db.execute("SELECT item_order, item_name, hs_code, hsn8, ministry_ids_json FROM vc_items "
                      "WHERE chain_id = 'tyre' AND stage_id = 'raw' ORDER BY item_order").fetchall()
    assert [r[0] for r in rows] == list(range(1, 20))
    assert rows[0][1:4] == ("Natural Rubber", "40012100", "40012100")
    assert json.loads(rows[12][4]) == ["residual"]  # fixture maps every products line to residual
    assert db.execute("SELECT hsn8 FROM vc_items WHERE hs_code = '5902'").fetchone()[0] is None  # 4-digit code
    assert db.execute("SELECT COUNT(*) FROM vc_items WHERE hs_code = '40012930' AND hsn8 IS NULL").fetchone()[0] == 2
    assert db.execute("SELECT COUNT(*) FROM vc_items WHERE hs_code IS NULL").fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM vc_items WHERE source != 'curated'").fetchone()[0] == 0
    assert stats["curated_ministries_rederived"] and all(
        r["atlas"] == ["residual"] for r in stats["curated_ministries_rederived"] if len(r["hs_code"]) == 8)

    # production: chain figures are loaded from real sources by seed_ops, never by the chain loader
    assert db.execute("SELECT COUNT(*) FROM production WHERE scope = 'chain'").fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM production WHERE scope = 'hs4'").fetchone()[0] == 1

    # clusters: one row per id, chain ids merged, sectors from the anchors
    n_clusters = len({cl["id"] for c in chains.values() for cl in c["clusters"]})
    assert stats["clusters"] == n_clusters == db.execute("SELECT COUNT(*) FROM clusters").fetchone()[0]
    chain_ids, sector_ids = db.execute(
        "SELECT chain_ids_json, sector_ids_json FROM clusters WHERE id = 'chennai_auto'").fetchone()
    assert set(json.loads(chain_ids)) == {"tyre", "auto_components", "ev_battery"}
    assert {"rubber_tyre", "automotive", "electronics"} == set(json.loads(sector_ids))
    assert "cluster_conflicts" not in stats

    # idempotent
    again = lvc.run(db)
    assert again["edges_inserted"] == stats["edges_inserted"] and again["items"] == stats["items"]
    assert db.execute("SELECT COUNT(*) FROM production WHERE scope = 'chain'").fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM vc_edges").fetchone()[0] == n_edges + 2


def test_loader_rejects_unknown_ministry(db, doc):
    bad = copy.deepcopy(doc)
    bad["chains"][2]["stages"][0]["items"][0]["ministry_ids"] = ["ministry_of_magic"]
    with pytest.raises(lvc.ValueChainError, match="ministry_of_magic"):
        lvc.load_chains(db, bad)
    bad = copy.deepcopy(doc)
    bad["chains"][0]["lead_ministry_id"] = "nope"
    with pytest.raises(lvc.ValueChainError, match="nope"):
        lvc.load_chains(db, bad)
    assert db.execute("SELECT COUNT(*) FROM value_chains").fetchone()[0] == 0  # nothing half-loaded


def test_loader_default_edges_and_text_resolution(db):
    data = {"chains": [{
        "id": "demo", "name": "Demo", "anchor_hs": "4011", "lead_ministry_id": "dpiit", "source": "curated",
        "stages": [
            {"id": "a", "name": "A", "order": 1, "ministry_text": "D/o Chemicals and Petrochemicals",
             "items": [{"item": "x", "hs_code": "4002", "ministry_text": "DCPC"},
                       {"item": "y", "hs_code": "40.01", "ministry_text": "D/o Commerce"}]},
            {"id": "b", "name": "B", "order": 2, "ministry_text": "DPIIT",
             "items": [{"item": "z", "hs_code": "4011​", "ministry_text": "DPIIT"},
                       {"item": "no code", "hs_code": None}]},
        ]}]}
    stats = lvc.load_chains(db, data)
    assert stats["edges_default"] == 2 and stats["edges_inserted"] == 2
    assert sorted(db.execute("SELECT src, dst, relation, chain_id, source FROM vc_edges").fetchall()) == [
        ("4001", "4011", "input_to", "demo", "curated"), ("4002", "4011", "input_to", "demo", "curated")]
    ids = dict(db.execute("SELECT item_name, ministry_ids_json FROM vc_items").fetchall())
    assert json.loads(ids["x"]) == ["dcpc"] and json.loads(ids["y"]) == ["doc"] and json.loads(ids["no code"]) == []
    assert json.loads(db.execute("SELECT ministry_ids_json FROM vc_stages WHERE stage_id = 'a'").fetchone()[0]) == ["dcpc"]


def test_derive_part_links(db):
    lvc.run(db)
    curated_before = db.execute("SELECT COUNT(*) FROM vc_edges WHERE source != 'hs_text'").fetchone()[0]
    stats = dpl.run(db)
    assert stats["parts_of_edges"] > 50 and stats["unknown_codes"] == []

    def targets(src):
        return {r[0] for r in db.execute(
            "SELECT dst FROM vc_edges WHERE src = ? AND relation = 'parts_of' AND source = 'hs_text'", (src,))}

    assert targets("8708") == {"8701", "8702", "8703", "8704", "8705"}
    assert targets("8409") == {"8407", "8408"}
    assert targets("8473") == {"8470", "8471", "8472"}
    assert targets("8503") == {"8501", "8502"}
    assert targets("8714") == {"8711", "8712", "8713"}
    assert targets("8466") == {f"84{n}" for n in range(56, 66)}
    assert targets("847321") == {"847010", "847021", "847029"}         # item-level references
    assert targets("847329") == {"847030", "847050", "847090"}         # '8470.30. 8470.50' typo in the source
    for src in ("840390", "9401", "6217", "8443", "848690", "870810", "841290"):
        assert targets(src) == set(), src                               # negated, self, redundant or no parts phrase
    assert db.execute("SELECT COUNT(*) FROM vc_edges WHERE source = 'hs_text' AND "
                      "(chain_id IS NOT NULL OR relation != 'parts_of' OR src = dst OR substr(src, 1, 4) = dst)"
                      ).fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM vc_edges WHERE source != 'hs_text'").fetchone()[0] == curated_before
    again = dpl.run(db)
    assert again["parts_of_edges"] == stats["parts_of_edges"]
    assert db.execute("SELECT COUNT(*) FROM vc_edges WHERE source = 'hs_text'").fetchone()[0] == stats["parts_of_edges"]


def test_part_link_parser_rules():
    nodes = [("8401", 4, "Reactors"), ("8402", 4, "Boilers"), ("8403", 4, "Heating boilers"),
             ("8404", 4, "Auxiliary plant"), ("840490", 6, "Boilers; parts of auxiliary plant, for use with boilers "
                                                           "of heading no. 8402 and 8403"),
             ("840390", 6, "Boilers; parts of central heating boilers (excluding those of heading no. 8402)"),
             ("8470", 4, "Calculators"), ("8471", 4, "Computers"), ("8472", 4, "Office machines"),
             ("8473", 4, "Machinery; parts and accessories (other than covers, carrying cases and the like) suitable "
                         "for use solely or principally with machines of headings 84.70 to 84.72"),
             ("847330", 6, "Machinery; parts and accessories of the machines of heading no. 8471"),
             ("847350", 6, "Machines; parts and accessories equally suitable for use with machines of two or more of "
                           "the headings 8470 to 8472"),
             ("8486", 4, "Machines and apparatus of heading 8486; parts and accessories")]
    pairs, info = dpl.derive_links(nodes)
    assert set(pairs) == {("840490", "8402"), ("840490", "8403"), ("8473", "8470"), ("8473", "8471"),
                          ("8473", "8472"), ("847330", "8471")}
    assert info["references_negated"] >= 1 and info["subheadings_redundant_with_heading"] == 1
