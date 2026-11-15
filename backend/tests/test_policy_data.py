"""Tests for B2's curated data (policy.json, info.json, ops_seed.json) and its two ETL steps
(scripts/etl/load_policy.py, scripts/etl/seed_ops.py).

The JSON checks validate ids against the real reference data (ministries.json, sectors.json, the OEC
country list in raw/oec_country_exp_totals_hs22.csv.gz, HS 2022 codes in raw/hs_nomenclature.csv and
8-digit lines in raw/gst_hsn_master.xlsx). The loader checks build a throw-away SQLite database from
scripts/etl/schema.sql with minimal reference rows - they never touch data/atlas.db.

Run from backend/:  python -m pytest -q tests/test_policy_data.py
"""
from __future__ import annotations

import csv
import gzip
import hashlib
import json
import re
import sqlite3
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from scripts.etl import load_policy, seed_ops  # noqa: E402

CURATED = BACKEND / "data" / "curated"
RAW = BACKEND / "data" / "raw"
SCHEMA = BACKEND / "scripts" / "etl" / "schema.sql"

PILOT_CHAINS = {"tyre", "natural_rubber", "cotton_apparel", "auto_components", "pharma_api", "mobile_electronics",
                "solar_pv", "steel", "ev_battery", "leather_footwear", "toys"}
WORKSTREAMS = {
    "Convert Static Guidebook → Digital Platform", "Integrate Multi-Source Data at HSN Level",
    "Build Analytics Layer", "Develop Ministry-Specific Dashboards", "Build HSN Code - Value Chain Interlinkages",
    "Launch in Phases", "Enable Policy Use Cases", "Develop Real-Time Updating Mechanism",
}
PROGRAMME_RISKS = [
    ("Data Integration", "Multiple data sources (CBIC, GSTN, DGFT, Ministries) leading to inconsistencies and delays",
     "Establish HSN-first data standard, build API-based pipelines, start with priority datasets"),
    ("Data Quality & Reliability", "Incomplete/incorrect production, GST, and cluster data",
     "Use AI-based data validation, cross-check datasets, introduce data confidence scores, start with "
     "high-confidence trade data"),
    ("Technology & Scalability", "Handling large database (12,000+ HSN codes) and real-time analytics",
     "Deploy cloud-based scalable architecture (Google Cloud), use modular design, perform load testing, follow "
     "phased rollout"),
    ("Data Security & Privacy", "Risk of sensitive data exposure or misuse",
     "Implement role-based access control (RBAC), ensure encryption, follow government security standards, define "
     "clear access protocols"),
    ("Value Chain Mapping Complexity", "Difficulty in mapping input-output relationships across HSN codes",
     "Start with pilot sectors, use AI/graph analytics, validate with industry experts, refine iteratively"),
    ("Scope Creep / Over-Ambition", "Trying to cover all sectors and features at once",
     "Adopt phased implementation strategy"),
]
PLI_NODAL = {  # the 14 PLI schemes and their nodal ministries
    "pli_mobile": "meity", "pli_ksm_api": "dop", "pli_medical_devices": "dop", "pli_auto": "mhi",
    "pli_pharma": "dop", "pli_specialty_steel": "mos", "pli_telecom": "dot", "pli_it_hardware": "meity",
    "pli_white_goods": "dpiit", "pli_food": "mofpi", "pli_textiles": "mot", "pli_solar": "mnre",
    "pli_acc": "mhi", "pli_drones": "moca",
}
TICKET_CODES_IN_TEST_DB = ("59021010", "61091000", "85414300", "95030090")  # 85076000 left out on purpose


def _json(name: str) -> dict:
    with open(CURATED / name, encoding="utf-8") as f:
        return json.load(f)


# --------------------------------------------------------------------------- reference data fixtures

@pytest.fixture(scope="module")
def policy() -> dict:
    return _json("policy.json")


@pytest.fixture(scope="module")
def info() -> dict:
    return _json("info.json")


@pytest.fixture(scope="module")
def ops() -> dict:
    return _json("ops_seed.json")


@pytest.fixture(scope="module")
def ministries() -> list[dict]:
    return _json("ministries.json")["ministries"]


@pytest.fixture(scope="module")
def sectors() -> list[dict]:
    return _json("sectors.json")["sectors"]


@pytest.fixture(scope="module")
def oec_countries() -> dict[str, str]:
    with gzip.open(RAW / "oec_country_exp_totals_hs22.csv.gz", "rt", encoding="utf-8") as f:
        return {r["country_id"]: r["country"] for r in csv.DictReader(f)}


@pytest.fixture(scope="module")
def hs_codes() -> set[str]:
    with open(RAW / "hs_nomenclature.csv", encoding="utf-8-sig") as f:
        return {r["hscode"] for r in csv.DictReader(f)}


@pytest.fixture(scope="module")
def gst_codes() -> set[str]:
    openpyxl = pytest.importorskip("openpyxl")
    wb = openpyxl.load_workbook(RAW / "gst_hsn_master.xlsx", read_only=True)
    try:
        return {str(r[0]).strip() for r in wb["HSN_MSTR"].iter_rows(min_row=2, values_only=True) if r[0] is not None}
    finally:
        wb.close()


# --------------------------------------------------------------------------- policy.json

def test_policy_has_note_and_sections(policy):
    assert policy.get("_note")
    for key in ("schemes", "agreements", "skill_councils", "roadmap", "risks"):
        assert isinstance(policy[key], list) and policy[key], key


def test_the_14_pli_schemes(policy, ministries):
    pli = {s["id"]: s for s in policy["schemes"] if s["kind"] == "PLI"}
    assert set(pli) == set(PLI_NODAL)
    ids = {m["id"] for m in ministries}
    for sid, s in pli.items():
        assert s["ministry_id"] == PLI_NODAL[sid] and s["ministry_id"] in ids
        assert isinstance(s["outlay_crore"], (int, float)) and s["outlay_crore"] > 0, sid
        assert re.fullmatch(r"20\d\d", str(s["launched"])), sid
        assert s["description"] and s["source"] and s["url"].startswith("https://"), sid
    total = sum(s["outlay_crore"] for s in pli.values())
    assert 180_000 < total < 210_000  # "about Rs 1.97 lakh crore" across the 14 schemes


def test_qcos_and_scheme_fields(policy, ministries):
    qco = [s for s in policy["schemes"] if s["kind"] == "QCO"]
    assert 10 <= len(qco) <= 20
    ids = {m["id"] for m in ministries}
    seen = set()
    for s in policy["schemes"]:
        assert s["id"] not in seen
        seen.add(s["id"])
        assert s["kind"] in ("PLI", "QCO")
        assert s["ministry_id"] is None or s["ministry_id"] in ids, s["id"]
        assert "verify" in s["source"].lower()
        if s["kind"] == "QCO":
            assert s["outlay_crore"] is None
    toys = next(s for s in qco if s["id"] == "qco_toys")
    assert [p["prefix"] for p in toys["hs_prefixes"]] == ["9503"]
    tyres = next(s for s in qco if s["id"] == "qco_tyres")
    assert {p["prefix"] for p in tyres["hs_prefixes"]} == {"4011", "4013"}


def test_scheme_prefixes_are_real_codes(policy, hs_codes, gst_codes):
    for s in policy["schemes"]:
        prefixes = [p["prefix"] for p in s["hs_prefixes"]]
        assert prefixes and len(prefixes) == len(set(prefixes)), s["id"]
        for p in s["hs_prefixes"]:
            code = p["prefix"]
            assert re.fullmatch(r"\d{2,8}", code) and len(code) % 2 == 0, (s["id"], code)
            assert p.get("note"), (s["id"], code)
            if len(code) <= 6:
                assert code in hs_codes, f"{s['id']}: {code} not in HS 2022 nomenclature"
            else:
                assert code in gst_codes, f"{s['id']}: {code} not in GST HSN master"


def test_agreements(policy, oec_countries):
    ids = [a["id"] for a in policy["agreements"]]
    assert len(ids) == len(set(ids))
    for a in policy["agreements"]:
        assert a["status"] in ("in_force", "signed", "negotiating"), a["id"]
        assert a["partners"] and len(a["partners"]) == len(set(a["partners"])), a["id"]
        for c in a["partners"]:
            assert c in oec_countries, f"{a['id']}: {c} is not an OEC country id"
        assert a["year"] is None or 1970 <= a["year"] <= 2026
        assert a["notes"]
    by_id = {a["id"]: a for a in policy["agreements"]}
    assert by_id["ind_uae_cepa"]["partners"] == ["asare"] and by_id["ind_uae_cepa"]["status"] == "in_force"
    assert by_id["ind_aus_ecta"]["partners"] == ["ocaus"]
    assert by_id["ind_mus_cecpa"]["partners"] == ["afmus"]
    assert by_id["ind_gbr_ceta"]["partners"] == ["eugbr"]
    assert set(by_id["ind_efta_tepa"]["partners"]) == {"euche", "euisl", "eunor"}
    assert len(by_id["aitiga"]["partners"]) == 10 and "assgp" in by_id["aitiga"]["partners"]
    assert len(by_id["safta"]["partners"]) == 7
    assert len(by_id["ind_eu_fta"]["partners"]) == 27 and by_id["ind_eu_fta"]["status"] == "negotiating"
    for required in ("ind_jpn_cepa", "ind_kor_cepa", "ind_sgp_ceca", "ind_mys_ceca"):
        assert by_id[required]["status"] == "in_force"


def test_skill_councils(policy, sectors):
    sector_ids = {s["id"] for s in sectors}
    ids = [c["id"] for c in policy["skill_councils"]]
    assert len(ids) == len(set(ids)) and len(ids) >= 12
    covered_chains = set()
    for c in policy["skill_councils"]:
        assert c["name"]
        assert set(c["sector_ids"]) <= sector_ids, c["id"]
        assert set(c["chain_ids"]) <= PILOT_CHAINS, c["id"]
        assert c["url"] is None or c["url"].startswith("https://")
        covered_chains |= set(c["chain_ids"])
    assert covered_chains == PILOT_CHAINS  # every pilot value chain has at least one skill council


def test_roadmap(policy):
    items = policy["roadmap"]
    ids = [r["id"] for r in items]
    assert len(ids) == len(set(ids))
    assert {r["phase"] for r in items} == {"Phase 0", "Phase I", "Phase II"}
    assert {r["workstream"] for r in items} == WORKSTREAMS
    windows = {"Phase 0": (0, 3), "Phase I": (3, 6), "Phase II": (6, 12)}
    for r in items:
        lo, hi = windows[r["phase"]]
        assert lo <= r["start_month"] <= r["end_month"] <= hi, r["id"]
        assert r["status"] in ("done", "in_progress", "planned")
        if r["status"] == "done":
            assert r["platform_route"] and r["platform_route"].startswith("/"), r["id"]
    statuses = {r["status"] for r in items}
    assert statuses == {"done", "in_progress", "planned"}
    planned = " ".join(r["title"] for r in items if r["status"] == "planned")
    for api in ("CBIC", "GSTN", "DGFT"):  # live government APIs need credentials -> planned
        assert api in planned


def test_programme_risks(policy):
    risks = policy["risks"]
    assert [(r["area"], r["risk"], r["mitigation"]) for r in risks] == PROGRAMME_RISKS
    assert [r["id"] for r in risks] == [1, 2, 3, 4, 5, 6]
    for r in risks:
        assert 1 <= r["likelihood"] <= 5 and 1 <= r["impact"] <= 5
        assert r["status"] in ("open", "mitigating", "closed")
        assert r["owner"] and len(r["platform_control"]) > 40


# --------------------------------------------------------------------------- info.json

def test_info_cards(info):
    pages = info["pages"]
    assert [p["id"] for p in pages] == ["about_hsn", "guidebook", "how_to_use", "cbic_tariff"]
    assert [p["icon"] for p in pages] == ["Info", "BookOpen", "Compass", "FileText"]
    for p in pages:
        assert p["title"] and len(p["body_md"]) > 200
        for link in p["links"]:
            assert link["label"] and link["url"].startswith("https://")
    text = {p["id"]: p["body_md"] for p in pages}
    assert "DPIIT" in text["guidebook"] and "Residual" in text["guidebook"]
    assert "official Guidebook mapping is not public" in text["guidebook"]
    assert all("PLAYBOOK" not in body and "deck" not in body.lower() for body in text.values())
    assert "WCO" in text["about_hsn"] or "World Customs Organization" in text["about_hsn"]
    assert "WITS" in text["cbic_tariff"] and "2022" in text["cbic_tariff"]
    urls = {link["url"] for link in pages[3]["links"]}
    assert urls == {"https://www.cbic.gov.in", "https://www.icegate.gov.in",
                    "https://www.icegate.gov.in/Webappl/Trade-Guide-on-Imports", "https://www.dgft.gov.in"}


# --------------------------------------------------------------------------- ops_seed.json

def test_ops_seed_users(ops, ministries):
    users = ops["users"]
    assert ops["demo_password"]
    emails = [u["email"] for u in users]
    assert len(emails) == len(set(emails))
    assert {u["role"] for u in users} == {"admin", "ministry", "analyst", "industry"}
    assert {u["ministry_id"] for u in users if u["role"] == "ministry"} == {"mot", "dpiit"}
    assert all(u["is_demo"] == 1 for u in users)
    ids = {m["id"] for m in ministries}
    assert all(u["ministry_id"] is None or u["ministry_id"] in ids for u in users)
    industry = next(u for u in users if u["role"] == "industry")
    assert industry["email"] == "industry@example.com"
    assert industry["organisation"] == "Example Manufacturing Pvt Ltd"


def test_ops_seed_sources_and_tickets(ops, gst_codes):
    sources = {s["id"]: s for s in ops["data_sources"]}
    assert set(sources) == {"oec_baci", "wits_trains", "gst_hsn", "hs_nomenclature", "un_comtrade",
                            "cbic", "gstn", "dgft", "dgft_itc_hs", "unido_indstat",
                            "rubber_board", "atma", "icai_patna", "icegate_trade_guide",
                            "cluster_observatory", "wits_markets", "iilb"}
    for sid in ("cbic", "gstn", "dgft"):
        assert sources[sid]["status"] == "not_configured"
        assert "ATLAS_" in sources[sid]["description"]  # says which credential / env var is needed
    assert sources["dgft_itc_hs"]["status"] == "connected"
    assert sources["dgft_itc_hs"]["manifest_keys"] == ["dgft_itc_hs"]
    assert sources["dgft_itc_hs"]["records_table"] == "dgft_itc_policy"
    assert "captcha" in sources["dgft_itc_hs"]["description"].lower()
    assert {k for k, s in sources.items() if s["status"] == "connected"} == {
        "oec_baci", "wits_trains", "gst_hsn", "hs_nomenclature", "unido_indstat",
        "rubber_board", "atma", "dgft_itc_hs", "cluster_observatory", "wits_markets", "iilb"
    }
    # a live connector that has never run is seeded as not_refreshed, never as 'connected' (Data Hub badge)
    assert sources["un_comtrade"]["status"] == "not_refreshed"

    tickets = ops["tickets"]
    assert 4 <= len(tickets) <= 6
    assert len({t["status"] for t in tickets}) >= 2
    for t in tickets:
        assert t["hsn8"] in gst_codes, t["hsn8"]
        assert t["category"] in seed_ops.TICKET_CATEGORIES and t["status"] in seed_ops.TICKET_STATUSES
        assert 1 <= len(t["messages"]) <= 2
    assert "production" not in ops                       # real figures live in production.json
    production = json.loads((CURATED / "production.json").read_text(encoding="utf-8"))["rows"]
    assert {p["key"] for p in production} == {"tyre", "natural_rubber", "cotton_apparel", "auto_components",
                                              "pharma_api", "mobile_electronics", "solar_pv", "steel", "ev_battery",
                                              "leather_footwear", "toys"}
    assert any(p["value"] == 857000 and p["unit"] == "tonnes" for p in production)
    assert all(p["source"] in {"unido_indstat", "rubber_board", "atma"} for p in production)


# --------------------------------------------------------------------------- loaders on a temp database

def _insert_product(conn, hsn8, ministry_id, status="accepted", description="Other", source="rule"):
    conn.execute(
        "INSERT INTO products (hsn8, hs6, hs4, hs2, description, ministry_id, mapping_status, mapping_source) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (hsn8, hsn8[:6], hsn8[:4], hsn8[:2], description, ministry_id, status, source))


@pytest.fixture()
def db(tmp_path, ministries, sectors, oec_countries):
    """Temp DB from schema.sql with ministries, sectors, countries, a few products and value chains."""
    path = tmp_path / "atlas_test.db"
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA.read_text(encoding="utf-8"))
    conn.executemany("INSERT INTO ministries (id, short_name, name, parent_ministry, kind, website, color) "
                     "VALUES (?, ?, ?, ?, ?, ?, ?)",
                     [(m["id"], m["short_name"], m["name"], m["parent_ministry"], m["kind"], m["website"], m["color"])
                      for m in ministries])
    conn.executemany("INSERT INTO sectors (id, name, description, color, icon, chapters) VALUES (?, ?, ?, ?, ?, ?)",
                     [(s["id"], s["name"], s["description"], s["color"], s["icon"], json.dumps(s["chapters"]))
                      for s in sectors])
    conn.executemany("INSERT INTO countries (id, iso3, name, continent) VALUES (?, ?, ?, 'Other')",
                     [(cid, cid[-3:].upper(), name) for cid, name in oec_countries.items()])
    # ticket codes (85076000 deliberately missing -> that ticket must be skipped)
    _insert_product(conn, "59021010", "mot", description="Tyre cord fabric of nylon - impregnated with rubber")
    _insert_product(conn, "61091000", "mot", description="T-shirts, singlets and other vests of cotton")
    _insert_product(conn, "85414300", "mnre", description="Photovoltaic cells assembled in modules")
    _insert_product(conn, "95030090", "residual", status="residual", description="Toys - other")
    # residual candidates: heading 6307 owned by MoT, 3926 by DPIIT, 3824 by DCPC, chapter 98 excluded
    for code in ("63071010", "63071020", "63072000"):
        _insert_product(conn, code, "mot")
    _insert_product(conn, "63079090", "residual", status="residual", description="Other made up articles - other")
    for code in ("39261011", "39262011", "39263010"):
        _insert_product(conn, code, "dpiit")
    _insert_product(conn, "39269099", "residual", status="residual", description="Other articles of plastics")
    for code in ("38241000", "38244010"):
        _insert_product(conn, code, "dcpc")
    _insert_product(conn, "38249900", "residual", status="residual", description="Other chemical products")
    _insert_product(conn, "98010011", "residual", status="residual", description="Project imports")
    conn.execute("INSERT INTO hs_nodes (code, level, parent, section_id, description) VALUES "
                 "('6307', 4, '63', 'XI', 'Made up articles n.e.c.'), ('3926', 4, '39', 'VII', 'Other articles of plastics')")
    for cid in ("tyre", "natural_rubber", "cotton_apparel"):
        conn.execute("INSERT INTO value_chains (id, name, anchor_hs) VALUES (?, ?, '4011')", (cid, cid))
    # a figure already stored (same scope/key/value, different label wording)
    conn.execute("INSERT INTO production (scope, key, label, year, value, unit, source, status) "
                 "VALUES ('chain', 'natural_rubber', 'Rubber output', 2024, 857000, 'tonnes', 'rubber_board', "
                 "'verified')")
    conn.commit()
    yield conn
    conn.close()


def _counts(conn, tables):
    return {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in tables}


POLICY_TABLES = ("schemes", "scheme_products", "trade_agreements", "skill_councils", "info_pages", "roadmap_items",
                 "risks")
OPS_TABLES = ("users", "data_sources", "tickets", "ticket_messages", "residual_claims", "production")


def test_load_policy_loads_and_is_idempotent(db, policy, info):
    stats = load_policy.run(db)
    assert stats["schemes_pli"] == 14 and stats["info_pages"] == 4 and stats["risks"] == 6
    first = _counts(db, POLICY_TABLES)
    assert first["schemes"] == len(policy["schemes"])
    assert first["scheme_products"] == sum(len(s["hs_prefixes"]) for s in policy["schemes"])
    assert first["trade_agreements"] == len(policy["agreements"])
    assert first["roadmap_items"] == len(policy["roadmap"]) and first["info_pages"] == len(info["pages"])
    assert set(stats.get("unknown_chain_ids", [])) <= PILOT_CHAINS - {"tyre", "natural_rubber", "cotton_apparel"}

    load_policy.run(db)
    assert _counts(db, POLICY_TABLES) == first

    partners = json.loads(db.execute("SELECT partners_json FROM trade_agreements WHERE id='ind_uae_cepa'").fetchone()[0])
    assert partners == ["asare"]
    links = json.loads(db.execute("SELECT links_json FROM info_pages WHERE id='cbic_tariff'").fetchone()[0])
    assert {link["url"] for link in links} >= {"https://www.cbic.gov.in"}
    assert db.execute("SELECT ministry_id, outlay_crore FROM schemes WHERE id='pli_textiles'").fetchone() == ("mot", 10683)
    assert db.execute("SELECT COUNT(*) FROM scheme_products WHERE scheme_id='qco_toys' AND hs_prefix='9503'"
                      ).fetchone()[0] == 1


def test_load_policy_rejects_unknown_ids(db, policy, tmp_path):
    bad = json.loads(json.dumps(policy))
    bad["schemes"][0]["ministry_id"] = "ministry_of_nowhere"
    bad["agreements"][0]["partners"] = ["xxnowhere"]
    path = tmp_path / "policy_bad.json"
    path.write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(ValueError) as exc:
        load_policy.run(db, policy_path=path)
    assert "ministry_of_nowhere" in str(exc.value) and "xxnowhere" in str(exc.value)
    assert db.execute("SELECT COUNT(*) FROM schemes").fetchone()[0] == 0  # nothing written


def test_seed_ops_seeds_and_is_idempotent(db, ops):
    stats = seed_ops.run(db)
    first = _counts(db, OPS_TABLES)
    assert first["users"] == len(ops["users"])
    assert first["data_sources"] == len(ops["data_sources"]) == 17
    assert stats["tickets_inserted"] == len(TICKET_CODES_IN_TEST_DB)
    assert stats["tickets_skipped_missing_code"] == 1
    assert first["ticket_messages"] == sum(len(t["messages"]) for t in ops["tickets"] if t["hsn8"] != "85076000")
    assert stats["production_inserted"] == 11 and stats["production_skipped_existing"] == 1

    seed_ops.run(db)
    assert _counts(db, OPS_TABLES) == first


def test_seed_ops_password_hashes(db, ops):
    seed_ops.run(db)
    rows = db.execute("SELECT email, password_hash, is_demo FROM users").fetchall()
    salts = set()
    for email, stored, is_demo in rows:
        assert is_demo == 1
        m = re.fullmatch(r"pbkdf2_sha256\$200000\$([0-9a-f]{32})\$([0-9a-f]{64})", stored)
        assert m, email
        salt_hex, hash_hex = m.groups()
        expected = hashlib.pbkdf2_hmac("sha256", ops["demo_password"].encode(), bytes.fromhex(salt_hex), 200000).hex()
        assert hash_hex == expected
        assert seed_ops.verify_password(ops["demo_password"], stored)
        assert not seed_ops.verify_password("wrong-password", stored)
        salts.add(salt_hex)
    assert len(salts) == len(rows)  # a fresh random salt per user


def test_seed_ops_ticket_routing_and_messages(db):
    seed_ops.run(db)
    routed = dict(db.execute("SELECT hsn8, routed_ministry_id FROM tickets").fetchall())
    assert routed == {"59021010": "mot", "61091000": "mot", "85414300": "mnre", "95030090": "dpiit"}  # residual->dpiit
    industry_id = db.execute("SELECT id FROM users WHERE email='industry@example.com'").fetchone()[0]
    assert db.execute("SELECT submitted_by FROM tickets WHERE hsn8='59021010'").fetchone()[0] == industry_id
    assert db.execute("SELECT submitted_by FROM tickets WHERE hsn8='61091000'").fetchone()[0] is None
    # MoT ticket answered by the MoT demo user; the residual toys line is routed to and answered by DPIIT
    reply = db.execute("SELECT u.email, m.author_role, m.body FROM ticket_messages m JOIN tickets t ON t.id = m.ticket_id "
                       "JOIN users u ON u.id = m.author_id WHERE t.hsn8 = '59021010' AND m.author_role = 'ministry'"
                       ).fetchone()
    assert reply[0] == "textiles@atlas.gov.in" and "Ministry of Textiles" in reply[2] and "{" not in reply[2]
    toys = db.execute("SELECT u.email FROM ticket_messages m JOIN tickets t ON t.id = m.ticket_id "
                      "JOIN users u ON u.id = m.author_id WHERE t.hsn8 = '95030090'").fetchone()
    assert toys[0] == "dpiit@atlas.gov.in"
    assert {s for (s,) in db.execute("SELECT DISTINCT status FROM tickets")} >= {"resolved", "in_progress"}


def test_seed_ops_residual_claims(db):
    stats = seed_ops.run(db)
    claims = db.execute("SELECT c.hsn8, c.ministry_id, c.status, u.email, c.justification, p.mapping_status "
                        "FROM residual_claims c JOIN products p ON p.hsn8 = c.hsn8 "
                        "LEFT JOIN users u ON u.id = c.claimed_by ORDER BY c.id").fetchall()
    assert 2 <= len(claims) <= 3 and stats["residual_claims_inserted"] == len(claims)
    by_code = {c[0]: c for c in claims}
    assert by_code["63079090"][1] == "mot" and by_code["63079090"][3] == "textiles@atlas.gov.in"
    assert by_code["39269099"][1] == "dpiit" and by_code["39269099"][3] == "dpiit@atlas.gov.in"
    assert by_code["38249900"][1] == "dcpc" and by_code["38249900"][3] == "admin@atlas.gov.in"  # no DCPC demo user
    assert "98010011" not in by_code  # chapter 98 excluded
    for hsn8, mid, status, _email, justification, mapping_status in claims:
        assert status == "pending" and mapping_status == "residual"
        assert justification and "{" not in justification


def test_seed_ops_data_sources_from_manifest(db):
    seed_ops.run(db)
    rows = {r[0]: r for r in db.execute("SELECT id, status, last_refreshed, records FROM data_sources")}
    manifest = json.loads((RAW / "manifest.json").read_text(encoding="utf-8"))
    oec = [v for k, v in manifest.items() if k.startswith("oec_")]
    assert rows["oec_baci"][2] == max(v["fetched_at"] for v in oec)
    assert rows["oec_baci"][3] == sum(v["rows"] for v in oec)
    assert rows["wits_trains"][3] == manifest["wits_india_mfn_2022"]["rows"]
    assert rows["gst_hsn"][2] is not None  # falls back to the file's modification time
    for sid in ("cbic", "gstn", "dgft"):
        assert rows[sid][1] == "not_configured" and rows[sid][2] is None and rows[sid][3] is None


def test_seed_ops_rejects_unknown_ministry_user(db, ops, tmp_path):
    bad = json.loads(json.dumps(ops))
    bad["users"][1]["ministry_id"] = "ministry_of_nowhere"
    path = tmp_path / "ops_bad.json"
    path.write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(ValueError):
        seed_ops.run(db, seed_path=path)
