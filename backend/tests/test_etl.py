"""Tests for the ETL core: scripts/build_db.py and scripts/etl/{nomenclature,mapping_rules,trade,tariffs,metrics}.py.

Two groups:
* pure-function tests (text helpers, rule precedence, formulas, CLI plumbing) — always run;
* database tests against the built database (``$ATLAS_DB`` or ``backend/data/atlas.db``) — skipped with a
  clear reason when it has not been built yet (``python -m scripts.build_db --core-only``).

Sanity targets (CEPII BACI 2024 via OEC, see docs/playbook/chart_data.txt) are asserted within 2 %.
"""
from __future__ import annotations

import json
import math
import os
import sqlite3
from pathlib import Path

import pytest

from scripts import build_db
from scripts.etl import CURATED_DIR, RAW_DIR, mapping_rules as mr, metrics, nomenclature as nom, tariffs

DB_PATH = Path(os.environ.get("ATLAS_DB") or Path(__file__).resolve().parents[1] / "data" / "atlas.db")
REL = 0.02


@pytest.fixture(scope="module")
def db():
    if not DB_PATH.exists():
        pytest.skip(f"{DB_PATH} has not been built - run 'python -m scripts.build_db --core-only' from backend/")
    # A normal connection with query_only (not mode=ro): read-only connections cannot remove the WAL side
    # files on close, which would leave atlas.db-wal/-shm behind after every test run.
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA query_only = ON")
    try:
        if not conn.execute("SELECT COUNT(*) FROM products").fetchone()[0]:
            pytest.skip(f"{DB_PATH} has no products - rebuild it")
        yield conn
    finally:
        conn.close()


def one(conn, sql, params=()):
    return conn.execute(sql, params).fetchone()[0]


# =========================================================================== pure functions

class TestText:
    def test_sentence_case_keeps_acronyms_and_standards(self):
        assert nom.sentence_case("TECHNICALLY SPECIFIED NATURAL RUBBER (TSNR)") == \
            "Technically specified natural rubber (TSNR)"
        assert nom.sentence_case("MOTOR GASOLINE CONFORMING TO STANDARD IS 2795") == \
            "Motor gasoline conforming to standard IS 2795"
        assert nom.sentence_case("Vulcanizing agents for rubber") == "Vulcanizing agents for rubber"

    def test_line_label_takes_last_hierarchy_segment(self):
        raw = ("PETROLEUM OILS ... OTHER THAN WASTE OILS:  - OTHER: SUPERIOR KEROSINE OIL (SKO)")
        assert nom.line_label(raw) == "SUPERIOR KEROSINE OIL (SKO)"
        assert nom.line_label("ELECTRICAL MACHINERY~Flat panel display modules~Other~Other") == "Other"
        assert nom.line_label("RADIALS") == "RADIALS"

    def test_generic_detection(self):
        for s in ("OTHER", "Others", "RADIALS", "OF COTTON", "--- LUNGI", "FOR MOTOR CYCLES", "HEVEA"):
            assert nom.is_generic(s), s
        for s in ("SILICON DIOXIDE", "MUSHROOM SPAWN", "TISSUE CULTURE PLANT"):
            assert not nom.is_generic(s), s

    def test_clean_text_handles_excel_artefacts(self):
        class ArrayFormula:  # mimics openpyxl.worksheet.formula.ArrayFormula
            text = "=--- LUNGI"
        assert nom.clean_text(ArrayFormula()) == "--- LUNGI"
        assert nom.clean_text("#NAME?") == ""
        assert nom.clean_text("A_x000D_\nB   C") == "A B C"
        assert nom.own_label("LENTILS KG.") == "LENTILS"

    def test_generic_line_is_prefixed_with_subheading(self):
        sub = "Rubber; new pneumatic tyres, of a kind used on motor cars (including station wagons and racing cars)"
        desc, line, full = nom.build_descriptions("40111010", "RADIALS", "New pneumatic tyres, of rubber", sub, False)
        assert desc == f"{sub}{nom.DASH}radials"
        assert line == "RADIALS"
        assert full.count(nom.DASH) == 2 and full.endswith("Radials")

    def test_single_line_subheading_uses_hs_text(self):
        sub = "T-shirts, singlets and other vests; of cotton, knitted or crocheted"
        desc, _line, _full = nom.build_descriptions("61091000", "OF COTTON", "T-shirts...", sub, True)
        assert desc == sub

    def test_specific_line_keeps_its_own_label(self):
        desc, _l, _f = nom.build_descriptions("28112200", "SILICON DIOXIDE", "Inorganic acids", "Silicon dioxide", False)
        assert desc == "Silicon dioxide"


class TestMappingRules:
    def test_rule_tables_reference_known_ministries(self):
        known = {m["id"] for m in json.loads((CURATED_DIR / "ministries.json").read_text(encoding="utf-8"))["ministries"]}
        tables = (mr.CHAPTER_RULES, mr.HEADING_RULES, mr.SUBHEADING_RULES, mr.LINE_RULES)
        used = {v[0] for t in tables for v in t.values()} | {r[4] for r in mr.TEXT_RULES}
        used |= {s for v in mr.SECONDARY_RULES.values() for s in v}
        assert used <= known
        assert {f"{c:02d}" for c in range(1, 98) if c != 77} <= set(mr.CHAPTER_RULES)

    @pytest.mark.parametrize("code,text,hs6_desc,ministry,source,rule_prefix", [
        ("28112200", "SILICON DIOXIDE", "", "dcpc", "rule", "ch28"),
        ("59021090", "OTHER", "", "mot", "rule", "ch59"),
        ("33074100", "AGARBATTI", "", "msme", "rule", "l33074100"),
        ("30049011", "OF AYURVEDIC SYSTEM", "", "ayush", "rule", "t:ayush"),
        ("85414300", "PANELS", "", "mnre", "rule", "s854143"),
        ("87100000", "TANKS", "", "ddp", "rule", "h8710"),
        ("84798999", "OTHER", "Machines n.e.c.", "residual", "rule", "s847989"),
        ("84135029", "OTHER", "Pumps; reciprocating, n.e.c. in heading no. 8413", "residual", "rule", "g:"),
        ("61046200", "OF COTTON", "", "mot", "rule", "ch61"),
        ("02013000", "BONELESS", "", "mofpi", "rule", "ch02"),
    ])
    def test_classify_precedence(self, code, text, hs6_desc, ministry, source, rule_prefix):
        a = mr.classify(code, text, hs6_desc)
        assert (a.ministry_id, a.source) == (ministry, source)
        assert a.rule.startswith(rule_prefix)
        assert a.status == ("residual" if ministry == "residual" else "accepted")

    def test_confidence_by_specificity(self):
        assert mr.classify("28112200").confidence == 0.6
        assert mr.classify("33074100").confidence == 0.9
        assert mr.classify("85414300").confidence == 0.85
        assert mr.classify("87100000").confidence == 0.75
        assert mr.classify("61046200").confidence == 0.6
        assert mr.classify("84798999").confidence is None  # residual: no owner

    def test_secondary_owners(self):
        assert mr.classify("28112200").secondary == ()
        assert "dop" in mr.classify("30021500").secondary          # vaccines: MoHFW + DoP
        assert mr.classify("84798999").secondary == ()             # residual has no owners

    def test_no_deck_code_promotion(self):
        assert not hasattr(mr, "playbook_codes")
        assert not hasattr(mr, "PLAYBOOK_MAPPINGS")

    def test_sector_for_heading_override(self):
        _s, by_ch, by_h = mr.load_sector_index()
        assert mr.sector_for("400122", by_ch, by_h) == "rubber_tyre"
        assert mr.sector_for("293600", by_ch, by_h) == "pharma"
        assert mr.sector_for("610910", by_ch, by_h) == "textiles"


class TestFormulas:
    def test_cagr_uses_earliest_positive_year(self):
        v, first = metrics.cagr({2018: 100.0, 2024: 200.0})
        assert first == 2018 and v == pytest.approx(2 ** (1 / 6) - 1)
        v, first = metrics.cagr({2018: 0.0, 2019: None, 2020: 50.0, 2024: 100.0})
        assert first == 2020 and v == pytest.approx(2 ** 0.25 - 1)
        assert metrics.cagr({2018: 10.0, 2024: 0.0}) == (None, None)
        assert metrics.cagr({2024: 10.0}) == (None, None)

    def test_yoy(self):
        assert metrics.yoy({2023: 100.0, 2024: 150.0}) == pytest.approx(0.5)
        assert metrics.yoy({2023: 0.0, 2024: 150.0}) is None
        assert metrics.yoy({2024: 150.0}) is None

    def test_tariff_non_ad_valorem_is_null(self):
        row = tariffs.parse_row({"hs6": "610910", "value": "0", "MIN_RATE": "0", "MAX_RATE": "0",
                                 "TOTALNOOFLINES": "1", "NBR_MFN_LINES": "0", "NBR_NA_LINES": "1"})
        assert row[0] == "610910" and row[1] is None and row[2] is None and row[5] == 1
        row = tariffs.parse_row({"hs6": "401110", "value": "12.5", "MIN_RATE": "10", "MAX_RATE": "15",
                                 "TOTALNOOFLINES": "2", "NBR_MFN_LINES": "2", "NBR_NA_LINES": "0"})
        assert row[1:4] == (12.5, 10.0, 15.0)
        assert tariffs.parse_row({"hs6": "TOTAL"}) is None


class TestBuildCli:
    def test_args(self):
        a = build_db.parse_args(["--core-only", "--skip", "trade,metrics", "--db", "x.db"])
        assert a.core_only and a.skip == "trade,metrics" and a.db == "x.db"

    def test_missing_optional_module_is_skipped(self, capsys):
        assert build_db._load_step("no_such_step_module", core=False) is None
        assert "skipped" in capsys.readouterr().out
        with pytest.raises(build_db.BuildError):
            build_db._load_step("no_such_step_module", core=True)

    def test_import_error_in_optional_module_is_skipped(self, monkeypatch, capsys):
        def boom(name):
            raise ImportError("half-written module")
        monkeypatch.setattr(build_db.importlib, "import_module", boom)
        assert build_db._load_step("metrics", core=False) is None
        assert "import failed" in capsys.readouterr().out

    def test_failing_step_aborts(self, monkeypatch):
        class Bad:
            @staticmethod
            def run(conn):
                raise RuntimeError("boom")
        monkeypatch.setattr(build_db, "_load_step", lambda name, core: Bad)
        conn = sqlite3.connect(":memory:")
        with pytest.raises(build_db.BuildError):
            build_db.run_steps(conn, [("compute_scores", False)], set())
        conn.close()

    def test_sanity_gate_blocks_empty_catalogue(self):
        conn = sqlite3.connect(":memory:")
        conn.executescript(build_db.SCHEMA_PATH.read_text(encoding="utf-8"))
        problems = build_db.sanity_gate(conn)
        assert any("products" in p for p in problems) and any("hs_nodes" in p for p in problems)
        conn.close()

    def test_unknown_skip_rejected(self):
        assert build_db.main(["--skip", "nope", "--db", "unused.db"]) == 2


# =========================================================================== built database

class TestDatabase:
    def test_meta(self, db):
        meta = dict(db.execute("SELECT key, value FROM meta"))
        assert {"built_at", "latest_year", "n_products", "schema_version"} <= set(meta)
        assert "guidebook_baseline" not in meta
        assert meta["latest_year"] == "2024" and meta["schema_version"] == "1"
        assert int(meta["n_products"]) == one(db, "SELECT COUNT(*) FROM products")
        assert db.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"

    def test_nomenclature(self, db):
        assert one(db, "SELECT COUNT(*) FROM sections") == 21
        assert one(db, "SELECT COUNT(*) FROM hs_nodes WHERE level = 6") == 5612
        assert one(db, "SELECT COUNT(*) FROM hs_nodes WHERE level = 2") == 96  # 01-97 without 77
        assert one(db, "SELECT COUNT(*) FROM hs_nodes WHERE level = 2 AND parent IS NOT NULL") == 0

    def test_products(self, db):
        n_current = one(db, "SELECT COUNT(*) FROM products WHERE is_current = 1")
        assert 13_000 <= n_current <= 13_200
        assert one(db, "SELECT COUNT(*) FROM products WHERE length(hsn8) != 8 OR hsn8 GLOB '*[^0-9]*'") == 0
        assert one(db, "SELECT COUNT(*) FROM products p WHERE is_current = 1 AND NOT EXISTS "
                       "(SELECT 1 FROM hs_nodes n WHERE n.code = p.hs6 AND n.level = 6)") == 0
        assert one(db, "SELECT COUNT(*) FROM products WHERE description = '' OR description IS NULL") == 0
        assert one(db, "SELECT COUNT(*) FROM products WHERE sector_id IS NULL OR section_id IS NULL") == 0
        bad = one(db, "SELECT COUNT(*) FROM products p WHERE is_current = 1 AND lines_in_hs6 != "
                      "(SELECT COUNT(*) FROM products q WHERE q.hs6 = p.hs6 AND q.is_current = 1)")
        assert bad == 0

    def test_descriptions(self, db):
        d = dict(db.execute("SELECT hsn8, description FROM products WHERE hsn8 IN "
                            "('40111010', '61091000', '40012200', '52083110')"))
        assert d["40111010"].endswith(f"{nom.DASH}radials") and "motor cars" in d["40111010"]
        assert d["61091000"].startswith("T-shirts, singlets and other vests") and "cotton" in d["61091000"]
        assert "(TSNR)" in d["40012200"]
        assert d["52083110"].endswith("lungi")
        full = one(db, "SELECT full_description FROM products WHERE hsn8 = '40111010'")
        assert full.startswith("New pneumatic tyres, of rubber") and full.count(nom.DASH) == 2

    def test_fts_rowid_join(self, db):
        assert one(db, "SELECT COUNT(*) FROM products_fts") == one(db, "SELECT COUNT(*) FROM products")
        hits = [r[0] for r in db.execute(
            "SELECT p.hsn8 FROM products_fts f JOIN products p ON p.rowid = f.rowid "
            "WHERE products_fts MATCH 'pneumatic tyres radials' ORDER BY bm25(products_fts) LIMIT 5")]
        assert "40111010" in hits
        row = db.execute("SELECT f.hsn8, f.ministry, f.sector FROM products_fts f JOIN products p "
                         "ON p.rowid = f.rowid WHERE p.hsn8 = '61091000'").fetchone()
        assert row == ("61091000", "MoT Ministry of Textiles", "Textiles & Apparel")

    def test_ministry_distribution(self, db):
        total = one(db, "SELECT COUNT(*) FROM products WHERE is_current = 1")
        dist = dict(db.execute("SELECT ministry_id, COUNT(*) FROM products WHERE is_current = 1 GROUP BY ministry_id"))
        ministries = [r[0] for r in db.execute("SELECT id FROM ministries WHERE kind != 'residual'")]
        assert len(ministries) == 33
        assert sum(1 for m in ministries if dist.get(m, 0)) == 31
        share = {k: v / total for k, v in dist.items()}
        assert 0.10 <= share["residual"] <= 0.12
        for mid, lo, hi in (("dpiit", 0.18, 0.24), ("mot", 0.13, 0.18), ("dcpc", 0.13, 0.17),
                            ("mofpi", 0.02, 0.04), ("mhi", 0.05, 0.08)):
            assert lo <= share[mid] <= hi, (mid, share[mid])
        assert one(db, "SELECT COUNT(*) FROM products WHERE (ministry_id = 'residual') != "
                       "(mapping_status = 'residual')") == 0
        assert one(db, "SELECT COUNT(*) FROM products WHERE mapping_status = 'accepted' AND "
                       "(mapping_confidence < 0.6 OR mapping_confidence > 1 OR mapping_rule IS NULL)") == 0
        assert one(db, "SELECT COUNT(*) FROM product_ministries pm JOIN products p USING (hsn8) "
                       "WHERE pm.role = 'primary' AND pm.ministry_id != p.ministry_id") == 0

    def test_official_guidebook_mapping_applied(self, db):
        assert one(db, "SELECT COUNT(*) FROM products WHERE mapping_source = 'rule'") == 0
        row = db.execute("SELECT ministry_id, mapping_source, mapping_confidence, mapping_status FROM products "
                         "WHERE hsn8 = '28112200'").fetchone()
        assert row == ("dcpc", "dpiit_guidebook", 1.0, "accepted")
        owners = set(db.execute("SELECT ministry_id, role FROM product_ministries WHERE hsn8 = '28112200'"))
        assert owners == {("dcpc", "primary"), ("mom", "secondary")}
        assert one(db, "SELECT COUNT(*) FROM guidebook_mapping") == 12174
        assert one(db, "SELECT COUNT(*) FROM products WHERE mapping_status = 'accepted'") > 11000
        assert one(db, "SELECT COUNT(*) FROM products WHERE mapping_status = 'residual'") > 1000
        assert one(db, "SELECT COUNT(*) FROM products WHERE mapping_status = 'accepted' AND mapping_source != "
                       "'dpiit_guidebook'") == 0

    def test_no_deck_overrides_or_baseline(self, db):
        assert one(db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'product_overrides'") == 0
        assert one(db, "SELECT COUNT(*) FROM meta WHERE key = 'guidebook_baseline'") == 0

    # ---- trade sanity targets: India's flows are official DGCIS TRADESTAT FY2024-25, world totals CEPII BACI 2024
    def _agg(self, db, prefix):
        return db.execute("SELECT SUM(world_trade), SUM(india_exports), SUM(india_imports) FROM hs6_metrics "
                          "WHERE hs6 LIKE ?", (prefix + "%",)).fetchone()

    def _india_rank(self, db, prefix):
        return one(db, "SELECT r FROM (SELECT country_id, RANK() OVER (ORDER BY SUM(value) DESC) r "
                       "FROM world_suppliers WHERE hs6 LIKE ? GROUP BY country_id) WHERE country_id = 'asind'",
                   (prefix + "%",))

    def test_tyres_4011(self, db):
        w, x, m = self._agg(db, "4011")
        assert w == pytest.approx(101.2e9, rel=REL)
        assert x == pytest.approx(2.962e9, rel=REL)
        assert x / w == pytest.approx(0.0293, rel=REL)
        assert m == pytest.approx(0.183e9, rel=REL)
        assert self._india_rank(db, "4011") == 8

    def test_natural_rubber_4001(self, db):
        w, _x, m = self._agg(db, "4001")
        assert w == pytest.approx(16.87e9, rel=REL)
        assert m == pytest.approx(1.069e9, rel=REL)

    def test_india_total_exports(self, db):
        x = one(db, "SELECT SUM(india_exports) FROM hs6_metrics")
        assert x == pytest.approx(437.7e9, rel=REL)
        assert one(db, "SELECT exports FROM country_totals WHERE country_id = 'asind' AND year = 2024") == \
            pytest.approx(x, rel=1e-6)

    def test_trade_series(self, db):
        years = [r[0] for r in db.execute("SELECT DISTINCT year FROM trade_hs6 ORDER BY year")]
        assert years == list(range(2018, 2025))
        assert one(db, "SELECT COUNT(*) FROM trade_hs6 WHERE hs6 = '401110'") == 7
        assert one(db, "SELECT COUNT(*) FROM country_totals WHERE country_id = 'asind' AND imports IS NULL") == 0

    def test_partner_tables_complete(self, db):
        # India's partners are the official DGCIS TRADESTAT country detail (FY2024-25, 8-digit rows rolled
        # up to the metric HS6); the OEC world tables keep full BACI coverage.
        for table, expected in (("india_partners", 245_818), ("world_suppliers", 565_074), ("world_markets", 892_580)):
            assert one(db, f"SELECT COUNT(*) FROM {table}") == pytest.approx(expected, rel=0.01)
        worst = one(db, "SELECT MAX(ABS(s - 1)) FROM (SELECT SUM(share) s FROM world_suppliers GROUP BY hs6)")
        assert worst < 1e-6
        worst = one(db, "SELECT MAX(ABS(s - 1)) FROM (SELECT SUM(share) s FROM india_partners GROUP BY hs6, flow)")
        assert worst < 1e-6
        assert one(db, "SELECT COUNT(*) FROM (SELECT hs6 FROM world_markets GROUP BY hs6 "
                       "HAVING MIN(rank) != 1 OR COUNT(DISTINCT rank) != COUNT(*))") == 0

    def test_india_partners_reconcile_with_the_official_tradestat_totals(self, db):
        """The partner table must add up to the official DGCIS totals (the source manifest's coverage).

        This is the check that matters: the row count alone says nothing about correctness, while the
        sum over both flows is exactly what TRADESTAT publishes for FY2024-25.
        """
        manifest = json.loads((RAW_DIR / "tradestat_partners_manifest.json").read_text(encoding="utf-8"))
        official = manifest["official_totals_usd"]
        for flow in ("X", "M"):
            total = one(db, "SELECT SUM(value) FROM india_partners WHERE flow = ?", (flow,))
            assert total == pytest.approx(official[flow], rel=0.005), flow

    def test_world_suppliers_sum_to_world_trade(self, db):
        diff = one(db, "SELECT MAX(ABS(s.total - t.world_trade) / t.world_trade) FROM "
                       "(SELECT hs6, SUM(value) total FROM world_suppliers GROUP BY hs6) s "
                       "JOIN trade_hs6 t ON t.hs6 = s.hs6 AND t.year = 2024 WHERE t.world_trade > 1e6")
        assert diff < 0.001

    def test_metric_formulas(self, db):
        X = one(db, "SELECT SUM(india_exports) FROM trade_hs6 WHERE year = 2024")
        W = one(db, "SELECT SUM(world_trade) FROM trade_hs6 WHERE year = 2024")
        x, w = db.execute("SELECT india_exports, world_trade FROM trade_hs6 WHERE hs6 = '401110' AND year = 2024").fetchone()
        m = db.execute("SELECT rca, india_world_share, world_supplier_hhi, india_import_hhi, china_import_share, "
                       "india_supplier_rank, export_cagr, first_year FROM hs6_metrics WHERE hs6 = '401110'").fetchone()
        assert m[0] == pytest.approx((x / X) / (w / W), rel=1e-9)
        assert m[1] == pytest.approx(x / w, rel=1e-9)
        assert m[2] == pytest.approx(one(db, "SELECT SUM(share*share) FROM world_suppliers WHERE hs6 = '401110'"))
        assert m[3] == pytest.approx(one(db, "SELECT SUM(share*share) FROM india_partners "
                                             "WHERE hs6 = '401110' AND flow = 'M'"))
        china = db.execute("SELECT share FROM india_partners WHERE hs6='401110' AND flow='M' AND country_id='aschn'").fetchone()
        assert m[4] == pytest.approx(china[0] if china else 0.0)
        assert m[5] == one(db, "SELECT rank FROM world_suppliers WHERE hs6 = '401110' AND country_id = 'asind'")
        x18 = one(db, "SELECT india_exports FROM trade_hs6 WHERE hs6 = '401110' AND year = 2018")
        assert m[7] == 2018 and m[6] == pytest.approx((x / x18) ** (1 / 6) - 1)

    def test_tariffs(self, db):
        avg, lo, hi = db.execute("SELECT mfn_avg, mfn_min, mfn_max FROM tariffs WHERE hs6 = '401110'").fetchone()
        assert (avg, lo, hi) == (12.5, 10.0, 15.0)
        avg, n_na = db.execute("SELECT mfn_avg, n_na_lines FROM tariffs WHERE hs6 = '610910'").fetchone()
        assert avg is None and n_na >= 1  # specific / compound duty -> deck BCD 20 % kept as override
        assert one(db, "SELECT COUNT(*) FROM tariffs") == 5613

    def test_hs6_products(self, db):
        assert one(db, "SELECT COUNT(*) FROM hs_nodes n WHERE level = 6 AND NOT EXISTS "
                       "(SELECT 1 FROM hs6_products h WHERE h.hs6 = n.code)") == 0
        assert one(db, "SELECT COUNT(*) FROM hs6_products WHERE description = '' OR sector_id IS NULL") == 0
        assert one(db, "SELECT sector_id FROM hs6_products WHERE hs6 = '400122'") == "rubber_tyre"
        assert one(db, "SELECT n_lines FROM hs6_products WHERE hs6 = '401110'") == 2
        assert one(db, "SELECT COUNT(*) FROM hs6_products WHERE hs6 = '271000'") == 1  # BACI aggregate of 2710

    def test_countries(self, db):
        assert db.execute("SELECT iso3, name, continent FROM countries WHERE id = 'asind'").fetchone() == \
            ("IND", "India", "Asia")
        continents = {r[0] for r in db.execute("SELECT DISTINCT continent FROM countries")}
        assert continents <= {"Africa", "Asia", "Europe", "North America", "South America", "Oceania", "Other"}

    def test_allocation_view_does_not_double_count(self, db):
        alloc = one(db, "SELECT SUM(exports_alloc) FROM v_product_trade WHERE hs6 = '401110'")
        assert alloc == pytest.approx(one(db, "SELECT india_exports FROM hs6_metrics WHERE hs6 = '401110'"))
        # Global allocation: lines DGCIS publishes keep their exact value; BACI's world total is shared
        # 1-per-line; India-side groups whose total exceeds their published catalogue lines (e.g. 721220,
        # a code DGCIS reports but GST has no line under) spread the remainder over the unpublished lines.
        # So the sums land between the published-line totals and the official totals - never above.
        listed_x = one(db, "SELECT COALESCE(SUM(india_exports), 0) FROM trade_hs8 WHERE year = 2024 "
                           "AND hsn8 IN (SELECT hsn8 FROM products)")
        listed_m = one(db, "SELECT COALESCE(SUM(india_imports), 0) FROM trade_hs8 WHERE year = 2024 "
                           "AND hsn8 IN (SELECT hsn8 FROM products)")
        alloc_x = one(db, "SELECT COALESCE(SUM(exports_alloc), 0) FROM v_product_trade")
        alloc_m = one(db, "SELECT COALESCE(SUM(imports_alloc), 0) FROM v_product_trade")
        off_x = one(db, "SELECT SUM(india_exports) FROM hs6_metrics")
        off_m = one(db, "SELECT SUM(india_imports) FROM hs6_metrics")
        assert listed_x - 1 <= alloc_x <= off_x + 1
        assert listed_m - 1 <= alloc_m <= off_m + 1
        # Codes DGCIS reports that the GST catalogue has no line under (chapter 98 specials etc.) stay
        # unallocated: the view's totals fall short of the official totals but by well under 2 %.
        assert off_x - alloc_x <= 0.02 * off_x
        assert off_m - alloc_m <= 0.02 * off_m
        # World context is split exactly (the world total reassembles without residue).
        assert math.isclose(one(db, "SELECT SUM(world_alloc) FROM v_product_trade"),
                            one(db, "SELECT SUM(world_trade) FROM hs6_metrics"), rel_tol=1e-9)

    def test_heading_aggregate_allocation(self, db):
        # BACI reports 2710 only as 271000; TRADESTAT's subheadings (271012, 271019 ...) are summed into it, so
        # India's flow and the world total stay on one row. Every national line shares the world total equally.
        assert one(db, "SELECT COUNT(*) FROM hs6_metrics WHERE hs6 LIKE '2710%' AND hs6 <> '271000'") == 0
        assert one(db, "SELECT rca FROM hs6_metrics WHERE hs6 = '271000'") > 1
        row = db.execute("SELECT metric_hs6, trade_level, weight, india_exports FROM v_product_trade "
                         "WHERE hsn8 = '27101944'").fetchone()
        assert row == ("271000", "hs8", pytest.approx(1 / 69),
                       one(db, "SELECT india_exports FROM trade_hs8 WHERE hsn8 = '27101944' AND year = 2024"))
        # a line DGCIS no longer publishes keeps the heading context but no value of its own
        row = db.execute("SELECT metric_hs6, trade_level, india_exports FROM v_product_trade "
                         "WHERE hsn8 = '27101211'").fetchone()
        assert row == ("271000", "hs4_aggregate", None)
        heading = db.execute("SELECT india_exports, india_imports, world_trade FROM v_product_trade "
                             "WHERE hs4 = '2710'").fetchall()
        totals = one(db, "SELECT SUM(exports_alloc) || '|' || SUM(imports_alloc) || '|' || SUM(world_alloc) "
                         "FROM v_product_trade WHERE hs4 = '2710'")
        assert [float(x) for x in totals.split("|")] == pytest.approx([
            one(db, "SELECT india_exports FROM hs6_metrics WHERE hs6 = '271000'"),
            one(db, "SELECT india_imports FROM hs6_metrics WHERE hs6 = '271000'"),
            one(db, "SELECT world_trade FROM hs6_metrics WHERE hs6 = '271000'")])
        assert len(heading) == 69

    def test_missing_lines_stay_unavailable(self, db):
        # A line DGCIS does not publish for the year is NULL (Not available), never zero.
        unpublished = ("FROM v_product_trade v WHERE NOT EXISTS "
                       "(SELECT 1 FROM trade_hs8 t WHERE t.hsn8 = v.hsn8 AND t.year = 2024)")
        assert one(db, f"SELECT COUNT(*) {unpublished}") > 0
        assert one(db, f"SELECT COUNT(*) {unpublished} AND (india_exports IS NOT NULL "
                       "OR india_imports IS NOT NULL)") == 0
        # Monetary gold: DGCIS lists exports as 0.00 and has no import row, so only exports are a (zero) figure.
        row = db.execute("SELECT trade_level, india_exports, india_imports FROM v_product_trade "
                         "WHERE hsn8 = '71082000'").fetchone()
        assert row == ("hs8", 0.0, None)
