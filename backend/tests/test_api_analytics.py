"""Analytics, value-chain, network, policy and risk API + scoring engine tests (owner C2).

Three layers:

1. **Formula unit tests** (no database): RCA, HHI, CAGR / YoY, percentile ranks, every SPEC section 4 score,
   archetype rules, k-means determinism, log-linear forecasts, the tariff simulator maths, alert rules.
2. **ETL step on a synthetic database**: ``scripts.etl.compute_scores.run`` on an in-memory database built from
   ``schema.sql`` (made-up test rows only - never shipped) checks scores, alerts and idempotence.
3. **API tests on the real ``data/atlas.db``** (skipped when it is not built; fixtures from ``tests/conftest.py``):
   response shapes of SPEC 6.5-6.8, RBAC (public 401 / industry 403 on government endpoints), the live
   data checks (tyre sector: world ~ US$ 101 bn, India ~ 3.1 bn = 3.1 %, imports ~ 0.22 bn, India 8th;
   ATMA tyre output; Rubber Board natural rubber) and the 2.5 s performance budget (also on a cold cache).

Run from ``backend/``: ``python -m pytest -q tests/test_api_analytics.py``.
"""
from __future__ import annotations

import json
import math
import sqlite3
from pathlib import Path

import pytest

from app.services import forecast as fc
from app.services import scoring, simulator

BACKEND = Path(__file__).resolve().parents[1]
SCHEMA = BACKEND / "scripts" / "etl" / "schema.sql"
# Wall-clock guard for a cold in-process cache. The first request after a rebuild also misses the OS
# file cache (the cold-cache negotiation request measured 1.5-2.0 s on a developer machine while its
# warm path is under 1 s), so keep headroom for disk and machine load. A real regression still fails.
PERF_BUDGET_S = 2.5
ARCHETYPES = ("Champion", "Established", "Emerging", "Dependent", "Marginal")
ITEM_BASE_KEYS = {"hs6", "description", "hsn8_sample", "ministry_id", "ministry_short", "sector_id", "sector_name"}
COUNTRY_VALUE_KEYS = {"country_id", "country", "iso3", "value", "share", "rank"}
PROVENANCE_KEYS = {"source", "status", "label", "year"}
ALERT_KEYS = {"id", "kind", "hs6", "description", "severity", "title", "detail", "value", "created_at"}


def approx(value, rel=1e-6, abs_=1e-9):
    return pytest.approx(value, rel=rel, abs=abs_)


def _prov(p: dict) -> None:
    assert PROVENANCE_KEYS <= set(p)
    assert p["status"] in ("verified", "not_verified", "not_available")


# =========================================================================== 1. formulas (no database)

def test_rca_balassa():
    # (X_p / X) / (W_p / W) = (10 / 100) / (50 / 1000) = 2
    assert scoring.rca(10, 100, 50, 1000) == approx(2.0)
    assert scoring.rca(0, 100, 50, 1000) == approx(0.0)
    assert scoring.rca(10, 100, 0, 1000) is None          # W_p = 0 -> NULL (SPEC)
    assert scoring.rca(10, 0, 50, 1000) is None
    assert scoring.rca(None, 100, 50, 1000) is None


def test_hhi():
    assert scoring.hhi([0.5, 0.5]) == approx(0.5)
    assert scoring.hhi([1.0]) == approx(1.0)
    assert scoring.hhi([3, 1], normalise=True) == approx(0.75 ** 2 + 0.25 ** 2)
    assert scoring.hhi([0.25] * 4) == approx(0.25)
    assert scoring.hhi([]) is None
    assert scoring.hhi([None, 0]) is None


def test_cagr_and_yoy():
    value, first = scoring.cagr({2018: 100.0, 2021: 150.0, 2024: 200.0})
    assert first == 2018 and value == approx(2 ** (1 / 6) - 1)
    # earliest year >= 2018 with a positive value is used
    value, first = scoring.cagr({2018: 0.0, 2019: None, 2020: 100.0, 2024: 400.0})
    assert first == 2020 and value == approx(4 ** 0.25 - 1)
    assert scoring.cagr({2018: 100.0, 2024: 0.0}) == (None, None)   # end <= 0
    assert scoring.cagr({2024: 50.0}) == (None, None)               # < 2 points
    assert scoring.cagr({2017: 10.0, 2024: 50.0}) == (None, None)   # before 2018 ignored
    assert scoring.yoy({2023: 100.0, 2024: 150.0}) == approx(0.5)
    assert scoring.yoy({2023: 0.0, 2024: 150.0}) is None
    assert scoring.yoy({2024: 150.0}) is None


def test_cagr_matches_etl_metrics():
    from scripts.etl import metrics
    series = {2018: 12.0, 2019: 0.0, 2020: 30.0, 2022: 25.0, 2024: 44.0}
    assert scoring.cagr(series) == metrics.cagr(series)
    assert scoring.yoy(series) == metrics.yoy(series)


def test_percentile_rank():
    assert scoring.pct_rank([1, 2, 3, None]) == [0.0, 0.5, 1.0, None]
    assert scoring.pct_rank([1, 1, 3]) == [0.25, 0.25, 1.0]          # ties share the average rank
    assert scoring.pct_rank([None, 7]) == [None, 1.0]
    assert scoring.pct_rank([]) == []
    ranks = scoring.pct_rank([math.log(v) for v in (10, 100, 1000)])
    assert ranks == scoring.pct_rank([10, 100, 1000])                # ranks are invariant to the log


def test_export_potential_score():
    assert scoring.export_potential_score(1, 3, 1, 1) == approx(100.0)
    assert scoring.export_potential_score(0, 0, 0, 0) == approx(0.0)
    assert scoring.export_potential_score(0, 6, 0, 0) == approx(30.0)          # RCA capped at 3
    assert scoring.export_potential_score(0.5, 1.5, None, None) == approx(100 * (0.35 * 0.5 + 0.30 * 0.5))
    assert scoring.export_potential_score(None, None, None, None) == approx(0.0)  # missing -> 0


def test_untapped_potential():
    # b * W - X = 0.05 * 1000 - 20 = 30, when RCA >= 0.3
    assert scoring.untapped_potential(20, 1000, 0.5, 0.05) == approx(30.0)
    assert scoring.untapped_potential(20, 1000, 0.29, 0.05) == 0.0             # RCA < 0.3 -> 0
    assert scoring.untapped_potential(80, 1000, 2.0, 0.05) == 0.0              # never negative
    assert scoring.untapped_potential(None, 1000, 0.3, 0.05) == approx(50.0)


def test_dependency_and_import_scores():
    assert scoring.dependency_ratio(30, 70) == approx(0.3)
    assert scoring.dependency_ratio(0, 0) is None
    assert scoring.dependency_ratio(50, None) == approx(1.0)
    assert scoring.import_dependency_score(1, 1, 1) == approx(100.0)
    assert scoring.import_dependency_score(0.5, 0.5, 0.5) == approx(50.0)
    assert scoring.import_dependency_score(1, None, None) == approx(50.0)
    assert scoring.vulnerability_score(1, 1, 1, 1) == approx(100.0)
    assert scoring.vulnerability_score(0.2, 0.4, 0.1, 0.8) == approx(100 * (0.06 + 0.10 + 0.02 + 0.20))
    assert sum(scoring.VULNERABILITY_WEIGHTS.values()) == approx(1.0)
    assert sum(scoring.EXPORT_POTENTIAL_WEIGHTS.values()) == approx(1.0)
    assert sum(scoring.IMPORT_DEPENDENCY_WEIGHTS.values()) == approx(1.0)
    assert sum(scoring.SUBSTITUTION_WEIGHTS.values()) == approx(1.0)


def test_substitution_score_rules():
    assert scoring.substitution_score(20e6, 30e6, 1, 1, 0.1) is None       # not a net importer
    assert scoring.substitution_score(9e6, 1e6, 1, 1, 0.1) is None         # imports < US$ 10 mn
    assert scoring.substitution_score(20e6, 5e6, 1.0, 2.0, 0.2) == approx(100 * (0.4 + 0.3 + 0.3 * 0.8))
    assert scoring.substitution_score(20e6, 5e6, 0.5, 0.4, None) == approx(100 * (0.2 + 0.12))


def test_archetype_rules_first_match_wins():
    assert scoring.archetype(1.5, 0.10, 0.05, 0, 100) == "Champion"
    assert scoring.archetype(1.5, 0.01, 0.05, 0, 100) == "Established"
    assert scoring.archetype(1.5, None, 0.05, 0, 100) == "Established"     # growth unknown
    assert scoring.archetype(0.5, 0.10, 0.05, 0, 100) == "Emerging"
    assert scoring.archetype(0.5, 0.05, 0.05, 0, 100) != "Emerging"        # needs strictly faster growth
    assert scoring.archetype(0.1, 0.10, 0.05, 200e6, 50e6) == "Dependent"
    assert scoring.archetype(0.1, 0.10, 0.05, 40e6, 1e6) == "Marginal"     # imports < US$ 50 mn
    assert scoring.archetype(None, None, None, None, None) == "Marginal"
    # Champion beats Dependent when both hold (first rule wins)
    assert scoring.archetype(2.0, 0.2, 0.1, 500e6, 100e6) == "Champion"


def _synthetic_records(n: int = 60) -> list[dict]:
    out = []
    for i in range(n):
        out.append({"hs6": f"{100000 + i}", "hs2": "10", "india_exports": float((i % 7) * 1e6 + i * 1e5),
                    "india_imports": float(((i * 13) % 11) * 2e6), "world_trade": float(1e8 + i * 3e6),
                    "rca": (i % 9) / 3.0, "world_cagr": ((i % 5) - 2) / 20.0, "export_cagr": ((i % 4) - 1) / 10.0})
    return out


def test_kmeans_clusters_deterministic_and_ordered():
    recs = _synthetic_records()
    a = scoring.cluster_products(recs)
    b = scoring.cluster_products(recs)
    assert a["labels"] == b["labels"]
    assert len(a["clusters"]) == scoring.KMEANS_K
    assert sum(c["n"] for c in a["clusters"]) == len(recs)
    means = [c["centroid"]["log1p_x"] for c in a["clusters"]]
    assert means == sorted(means, reverse=True)        # id 0 = strongest exporters
    assert len({c["label"] for c in a["clusters"]}) == len(a["clusters"])
    few = scoring.cluster_products(recs[:3])
    assert len(few["clusters"]) == 3


def test_kmeans_feature_row():
    row = scoring.kmeans_feature_row({"india_exports": math.e - 1, "india_imports": 0, "world_trade": None,
                                      "rca": 9, "world_cagr": 0.9, "export_cagr": None})
    assert row == approx([1.0, 0.0, 0.0, 5.0, 0.5, 0.0])


def test_forecast_exact_exponential():
    series = {y: 100.0 * 1.1 ** (y - 2018) for y in range(2018, 2025)}
    fit = fc.fit_loglinear(sorted(series), [series[y] for y in sorted(series)])
    assert fit["slope"] == approx(math.log(1.1)) and fit["sigma"] == approx(0.0, abs_=1e-9)
    out = fc.forecast_series(series)
    assert [p["year"] for p in out] == [2025, 2026]
    assert out[0]["value"] == approx(100 * 1.1 ** 7, rel=1e-9)
    assert out[1]["lo"] == approx(out[1]["value"]) and out[1]["hi"] == approx(out[1]["value"])
    assert fc.trend_growth(series) == approx(0.1)


def test_forecast_band_and_minimum_points():
    series = {2018: 100.0, 2019: 130.0, 2020: 90.0, 2021: 160.0, 2022: 150.0, 2023: 210.0, 2024: 190.0}
    for p in fc.forecast_series(series):
        assert p["lo"] < p["value"] < p["hi"]
        assert p["lo"] * p["hi"] == approx(p["value"] ** 2, rel=1e-9)   # symmetric in log space
    assert fc.forecast_series({2023: 5.0, 2024: 6.0}) == []              # < 3 positive points
    assert fc.forecast_series({2018: 0.0, 2019: -1.0, 2023: 5.0, 2024: 6.0}) == []
    assert len(fc.forecast_series({2018: 0.0, 2022: 4.0, 2023: 5.0, 2024: 6.0})) == 2


def test_simulator_maths():
    m1 = simulator.imports_after(100.0, 0.10, 0.20, 2.5)
    assert m1 == approx(100.0 * (1.2 / 1.1) ** -2.5)
    row = simulator.simulate_row(100.0, 10.0, 20.0, 2.5, 0.5)
    assert row["imports_after"] == approx(m1)
    assert row["delta_imports"] == approx(m1 - 100.0)
    assert row["revenue_before"] == approx(10.0) and row["revenue_after"] == approx(0.2 * m1)
    assert row["domestic_opportunity_usd"] == approx(-(m1 - 100.0) * 0.5)
    assert simulator.simulate_row(100.0, 10.0, 10.0, 2.5, 0.5)["domestic_opportunity_usd"] == 0.0
    blank = simulator.simulate_row(None, 10.0, 20.0, 2.5, 0.5)
    assert blank["imports_after"] is None and blank["revenue_before"] is None
    assert simulator.simulate_row(100.0, None, 20.0, 2.5, 0.5)["delta_imports"] is None
    # downstream cost: input_cost_share x (ratio - 1) x 100 at one hop, x input_cost_share per extra hop
    assert simulator.cost_increase_pct(0.10, 0.20, 0.10, 1) == approx(0.10 * (1.2 / 1.1 - 1) * 100)
    assert simulator.cost_increase_pct(0.10, 0.20, 0.10, 2) == approx(0.01 * (1.2 / 1.1 - 1) * 100)
    assert simulator.cost_increase_pct(0.25, 0.10, 0.10) < 0                    # a tariff cut lowers costs


def test_detect_alert_rules():
    base = {"description": "Test product", "india_exports": 0.0, "india_imports": 0.0, "import_yoy": None,
            "export_yoy": None, "exports_2023": 0.0, "imports_2023": 0.0, "india_import_hhi": None,
            "china_import_share": None, "top_import_source_name": None, "top_import_source_share": None}
    recs = [
        {**base, "hs6": "000001", "india_imports": 30e6, "imports_2023": 10e6, "import_yoy": 2.0},      # high
        {**base, "hs6": "000002", "india_imports": 30e6, "imports_2023": 20e6, "import_yoy": 0.5},      # medium
        {**base, "hs6": "000003", "india_imports": 19e6, "imports_2023": 5e6, "import_yoy": 2.8},       # too small
        {**base, "hs6": "000010", "india_imports": 40e6, "imports_2023": 0.1e6, "import_yoy": 399.0},   # tiny base
        {**base, "hs6": "000004", "india_exports": 20e6, "exports_2023": 50e6, "export_yoy": -0.6},     # high drop
        {**base, "hs6": "000005", "india_exports": 30e6, "exports_2023": 40e6, "export_yoy": -0.25},    # no
        {**base, "hs6": "000006", "india_imports": 60e6, "india_import_hhi": 1.0, "china_import_share": 0.0},
        {**base, "hs6": "000007", "india_imports": 100e6, "india_import_hhi": 0.5, "china_import_share": 0.7},
        {**base, "hs6": "000008", "india_imports": 100e6, "india_import_hhi": 0.7, "china_import_share": 0.85},
        {**base, "hs6": "000009", "india_imports": 40e6, "india_import_hhi": 0.9, "china_import_share": 0.95},
    ]
    got = {(a["hs6"], a["kind"]): a["severity"] for a in scoring.detect_alerts(recs, "2026-10-19T00:00:00Z")}
    assert got == {("000001", "import_surge"): "high", ("000002", "import_surge"): "medium",
                   ("000004", "export_drop"): "high", ("000006", "concentration"): "medium",
                   ("000007", "china_dependence"): "medium", ("000008", "concentration"): "medium",
                   ("000008", "china_dependence"): "high"}
    ordered = scoring.detect_alerts(recs, "x")
    assert [a["severity"] for a in ordered] == sorted((a["severity"] for a in ordered),
                                                      key=scoring.SEVERITY_ORDER.get)


def test_text_helpers():
    from app.routers.valuechains import ordinal
    assert [ordinal(n) for n in (1, 2, 3, 4, 8, 11, 12, 13, 21, 22, 23, 101, 111)] == [
        "1st", "2nd", "3rd", "4th", "8th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th"]
    assert scoring.usd_text(3.106e9) == "$3.11 bn"
    assert scoring.usd_text(812.4e6) == "$812.4 mn"
    assert scoring.usd_text(45_000) == "$45 k"
    assert scoring.usd_text(92) == "$92"
    assert scoring.growth_text(0.5) == "+50%" and scoring.growth_text(-0.3) == "-30%"
    assert scoring.growth_text(302_000.0).startswith("x")


# =========================================================================== 2. compute_scores on a synthetic DB

def _synthetic_db() -> sqlite3.Connection:
    """In-memory database from schema.sql with made-up trade for 8 HS6 codes (test data only)."""
    conn = sqlite3.connect(":memory:")
    conn.executescript(SCHEMA.read_text(encoding="utf-8"))
    conn.executemany("INSERT INTO countries(id, iso3, name, continent) VALUES (?,?,?,?)",
                     [("asind", "IND", "India", "Asia"), ("aschn", "CHN", "China", "Asia"),
                      ("asjpn", "JPN", "Japan", "Asia"), ("eudeu", "DEU", "Germany", "Europe")])
    codes = [f"8400{i:02d}" for i in range(1, 9)]
    conn.executemany("INSERT INTO hs6_products(hs6, hs4, hs2, description, n_lines) VALUES (?,?,?,?,1)",
                     [(c, c[:4], c[:2], f"Synthetic product {c}") for c in codes])
    trade = []
    for i, c in enumerate(codes):
        for y in range(2018, 2025):
            x = 40e6 + i * 5e6 + (y - 2018) * 1e6
            m = 30e6
            w = 2e9 + i * 1e8 + (y - 2018) * 5e7
            if c == "840001":                     # import surge: 10 -> 30 mn (+200 %)
                m = 30e6 if y == 2024 else 10e6
            if c == "840003":                     # export drop: 50 -> 20 mn (-60 %)
                x = 20e6 if y == 2024 else 50e6
            if c in ("840002", "840004"):
                m = 100e6 if c == "840002" else 60e6
            trade.append((c, y, x, m, w))
    conn.executemany("INSERT INTO trade_hs6(hs6, year, india_exports, india_imports, world_trade) VALUES "
                     "(?,?,?,?,?)", trade)
    partners, suppliers = [], []
    latest = {c: (x, m, w) for c, y, x, m, w in trade if y == 2024}
    for c, (x, m, w) in latest.items():
        if c == "840002":
            mix = [("aschn", 0.85), ("eudeu", 0.15)]          # China dependence + concentration
        elif c == "840004":
            mix = [("asjpn", 1.0)]                            # single source: concentration only
        else:
            mix = [("aschn", 1 / 3), ("asjpn", 1 / 3), ("eudeu", 1 / 3)]
        for rank, (cid, s) in enumerate(mix, start=1):
            partners.append((c, "M", cid, m * s, s, rank))
        partners.append((c, "X", "eudeu", x, 1.0, 1))
        rest = w - x
        for rank, (cid, v) in enumerate([("aschn", rest * 0.6), ("eudeu", rest * 0.4), ("asind", x)], start=1):
            suppliers.append((c, cid, v, v / w, rank))
    conn.executemany("INSERT INTO india_partners(hs6, flow, country_id, value, share, rank) VALUES (?,?,?,?,?,?)",
                     partners)
    conn.executemany("INSERT INTO world_suppliers(hs6, country_id, value, share, rank) VALUES (?,?,?,?,?)",
                     suppliers)
    from scripts.etl import metrics
    metrics.run(conn)
    return conn


def test_compute_scores_run_on_synthetic_db():
    from scripts.etl import compute_scores
    conn = _synthetic_db()
    stats = compute_scores.run(conn)
    assert stats["hs6_scores"] == 8
    scores = {r[0]: r for r in conn.execute("SELECT hs6, export_potential_score, untapped_potential_usd, "
                                            "import_dependency_score, vulnerability_score, substitution_score, "
                                            "archetype, ml_cluster, forecast_json FROM hs6_scores")}
    assert len(scores) == 8
    for hs6, ep, untapped, ids, vul, sub, arch, cluster, fjson in scores.values():
        assert 0 <= ep <= 100 and 0 <= ids <= 100 and 0 <= vul <= 100
        assert untapped >= 0 and arch in ARCHETYPES and 0 <= cluster < 6
        f = json.loads(fjson)
        assert [p["year"] for p in f["exports"]] == [2025, 2026]
    # 840002 imports 100 mn vs exports 70 mn -> substitution candidate; 840005 exports > imports -> NULL
    assert scores["840002"][5] is not None and scores["840005"][5] is None
    alerts = {(r[0], r[1]): r[2] for r in conn.execute("SELECT hs6, kind, severity FROM alerts")}
    assert alerts == {("840001", "import_surge"): "high", ("840003", "export_drop"): "high",
                      ("840002", "concentration"): "medium", ("840002", "china_dependence"): "high",
                      ("840004", "concentration"): "medium"}
    built = conn.execute("SELECT value FROM meta WHERE key = 'scores_built_at'").fetchone()
    assert built and built[0].endswith("Z")
    # idempotent: a second run replaces (not duplicates) the rows and reproduces the scores
    compute_scores.run(conn)
    assert conn.execute("SELECT COUNT(*) FROM alerts").fetchone()[0] == len(alerts)
    again = {r[0]: r for r in conn.execute("SELECT hs6, export_potential_score, untapped_potential_usd, "
                                           "import_dependency_score, vulnerability_score, substitution_score, "
                                           "archetype, ml_cluster, forecast_json FROM hs6_scores")}
    assert again == scores
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
    assert {n for n, _ in compute_scores.ANALYTICS_INDEXES} <= names
    conn.close()


def test_compute_scores_empty_metrics():
    from scripts.etl import compute_scores
    conn = sqlite3.connect(":memory:")
    conn.executescript(SCHEMA.read_text(encoding="utf-8"))
    assert compute_scores.run(conn)["hs6_scores"] == 0
    conn.close()


# =========================================================================== 3. real database: stored scores

def test_scores_cover_every_hs6(db_conn):
    n_metrics = db_conn.execute("SELECT COUNT(*) AS n FROM hs6_metrics").fetchone()["n"]
    n_scores = db_conn.execute("SELECT COUNT(*) AS n FROM hs6_scores").fetchone()["n"]
    assert n_scores == n_metrics > 5000
    bad = db_conn.execute("""
        SELECT COUNT(*) AS n FROM hs6_scores
        WHERE export_potential_score NOT BETWEEN 0 AND 100 OR import_dependency_score NOT BETWEEN 0 AND 100
           OR vulnerability_score NOT BETWEEN 0 AND 100 OR untapped_potential_usd < 0
           OR archetype NOT IN ('Champion','Established','Emerging','Dependent','Marginal')
           OR ml_cluster NOT BETWEEN 0 AND 5""").fetchone()["n"]
    assert bad == 0
    # substitution only for net importers with imports >= US$ 10 mn, inside the scored universe (world trade > 0;
    # India-only national codes such as chapter 98 project imports have no BACI world total)
    wrong = db_conn.execute("""
        SELECT COUNT(*) AS n FROM hs6_scores s JOIN hs6_metrics m USING (hs6)
        WHERE (s.substitution_score IS NOT NULL) <>
              (COALESCE(m.india_imports, 0) > COALESCE(m.india_exports, 0) AND m.india_imports >= 10e6
               AND COALESCE(m.world_trade, 0) > 0)""").fetchone()
    assert wrong["n"] == 0
    # untapped potential is 0 when RCA < 0.3
    assert db_conn.execute("""SELECT COUNT(*) AS n FROM hs6_scores s JOIN hs6_metrics m USING (hs6)
                              WHERE COALESCE(m.rca, 0) < 0.3 AND s.untapped_potential_usd > 0""").fetchone()["n"] == 0


def _sql_pct(conn, expr: str, hs6: str) -> float:
    """Independent percentile rank (average rank of ties) of ``expr`` for ``hs6`` over HS6 with W > 0."""
    r = conn.execute(f"""
        WITH u AS (SELECT hs6, {expr} AS v FROM hs6_metrics WHERE world_trade > 0 AND {expr} IS NOT NULL),
             t AS (SELECT v FROM u WHERE hs6 = ?)
        SELECT (SELECT COUNT(*) FROM u WHERE v < (SELECT v FROM t)) AS lt,
               (SELECT COUNT(*) FROM u WHERE v = (SELECT v FROM t)) AS eq,
               (SELECT COUNT(*) FROM u) AS n""", (hs6,)).fetchone()
    rank = r["lt"] + (r["eq"] + 1) / 2.0
    return (rank - 1) / (r["n"] - 1)


def test_worked_example_401110_recomputed_independently(db_conn):
    """docs/METHODOLOGY.md worked example: every score of HS 401110 from first principles in SQL."""
    m = db_conn.execute("SELECT * FROM hs6_metrics WHERE hs6 = '401110'").fetchone()
    s = db_conn.execute("SELECT * FROM hs6_scores WHERE hs6 = '401110'").fetchone()
    p_w = _sql_pct(db_conn, "world_trade", "401110")
    p_m = _sql_pct(db_conn, "CASE WHEN india_imports > 0 THEN india_imports END", "401110")
    p_wc = _sql_pct(db_conn, "world_cagr", "401110")
    p_xc = _sql_pct(db_conn, "export_cagr", "401110")
    ep = 100 * (0.35 * p_w + 0.30 * min(m["rca"], 3) / 3 + 0.20 * p_wc + 0.15 * p_xc)
    dep = m["india_imports"] / (m["india_imports"] + m["india_exports"])
    ids = 100 * (0.5 * dep + 0.3 * p_m + 0.2 * m["india_import_hhi"])
    vul = 100 * (0.30 * dep + 0.25 * m["india_import_hhi"] + 0.20 * m["china_import_share"] + 0.25 * p_m)
    assert s["export_potential_score"] == pytest.approx(ep, abs=1e-3)
    assert s["import_dependency_score"] == pytest.approx(ids, abs=1e-3)
    assert s["vulnerability_score"] == pytest.approx(vul, abs=1e-3)
    assert m["rca"] < 0.3 and s["untapped_potential_usd"] == 0           # RCA 0.26 -> no untapped potential
    assert s["substitution_score"] is None                                # exports > imports
    assert s["archetype"] == "Marginal"                                   # RCA < 0.3, imports < 2 x exports
    # forecast = OLS on ln(exports) over 2018-2024
    hist = {r["year"]: r["india_exports"] for r in db_conn.execute(
        "SELECT year, india_exports FROM trade_hs6 WHERE hs6 = '401110'")}
    expected = fc.forecast_series(hist)
    stored = json.loads(s["forecast_json"])["exports"]
    assert [p["year"] for p in stored] == [2025, 2026]
    assert stored[0]["value"] == pytest.approx(expected[0]["value"], rel=1e-6)


def test_stored_alerts_satisfy_their_rules(db_conn):
    rows_ = db_conn.execute("""
        SELECT a.kind, a.severity, a.value, m.india_imports AS m, m.import_yoy, m.export_yoy, m.india_import_hhi,
               m.china_import_share, t.india_exports AS x23, t.india_imports AS m23
        FROM alerts a JOIN hs6_metrics m ON m.hs6 = a.hs6
        LEFT JOIN trade_hs6 t ON t.hs6 = a.hs6 AND t.year = 2023""").fetchall()
    assert rows_, "compute_scores has not been run (alerts empty)"
    for r in rows_:
        if r["kind"] == "import_surge":
            assert r["import_yoy"] >= 0.5 and r["m"] >= 20e6 and r["m23"] >= 1e6
            assert r["severity"] == ("high" if r["import_yoy"] >= 1.0 else "medium")
        elif r["kind"] == "export_drop":
            assert r["export_yoy"] <= -0.3 and r["x23"] >= 20e6
            assert r["severity"] == ("high" if r["export_yoy"] <= -0.5 else "medium")
        elif r["kind"] == "concentration":
            assert r["india_import_hhi"] >= 0.6 and r["m"] >= 50e6 and r["severity"] == "medium"
        else:
            assert r["kind"] == "china_dependence"
            assert r["china_import_share"] >= 0.6 and r["m"] >= 50e6
            assert r["severity"] == ("high" if r["china_import_share"] >= 0.8 else "medium")


# =========================================================================== RBAC

GOV_GET_ENDPOINTS = (
    "/api/analytics/opportunities", "/api/analytics/import-dependency", "/api/analytics/import-substitution",
    "/api/analytics/competitiveness", "/api/analytics/demand-supply?chain_id=tyre", "/api/analytics/archetypes",
    "/api/analytics/forecast/401110", "/api/analytics/trends", "/api/analytics/anomalies",
    "/api/risk/overview", "/api/risk/alerts", "/api/policy/negotiation?partner=eugbr",
)
PUBLIC_GET_ENDPOINTS = (
    "/api/valuechains", "/api/valuechains/tyre", "/api/valuechains/tyre/mapping", "/api/network",
    "/api/network/trace/40111090", "/api/policy/use-cases", "/api/policy/schemes", "/api/policy/schemes/pli_auto",
    "/api/policy/agreements", "/api/policy/skilling",
)
SIMULATE_BODY = {"codes": ["40012200"], "new_tariff_pct": 10}


@pytest.mark.parametrize("path", GOV_GET_ENDPOINTS)
def test_gov_endpoints_reject_public_and_industry(client, industry_headers, path):
    assert client.get(path).status_code == 401
    assert client.get(path, headers=industry_headers).status_code == 403


@pytest.mark.parametrize("role", ("analyst", "ministry", "admin"))
def test_gov_endpoints_allow_government_roles(client, auth_headers, role):
    headers = auth_headers(role, "mot") if role == "ministry" else auth_headers(role)
    for path in ("/api/analytics/opportunities?limit=5", "/api/risk/overview?limit=5",
                 "/api/policy/negotiation?partner=asare"):
        r = client.get(path, headers=headers)
        assert r.status_code == 200, (path, r.text)
    assert client.post("/api/policy/simulate-tariff", json=SIMULATE_BODY, headers=headers).status_code == 200


def test_simulator_rbac(client, industry_headers):
    assert client.post("/api/policy/simulate-tariff", json=SIMULATE_BODY).status_code == 401
    assert client.post("/api/policy/simulate-tariff", json=SIMULATE_BODY, headers=industry_headers).status_code == 403


@pytest.mark.parametrize("path", PUBLIC_GET_ENDPOINTS)
def test_public_endpoints_need_no_token(client, path):
    r = client.get(path)
    assert r.status_code == 200, r.text


# =========================================================================== analytics endpoints

def test_opportunities(client, analyst_headers, db_conn):
    r = client.get("/api/analytics/opportunities?limit=40", headers=analyst_headers)
    assert r.status_code == 200
    body = r.json()
    items = body["items"]
    assert len(items) == 40 and len(body["matrix"]) == 40
    need = ITEM_BASE_KEYS | {"india_exports", "world_trade", "rca", "world_cagr", "export_cagr",
                             "export_potential_score", "untapped_potential_usd", "archetype", "india_world_share"}
    assert need <= set(items[0])
    scores = [i["export_potential_score"] for i in items]
    assert scores == sorted(scores, reverse=True)
    assert {"hs6", "label", "x", "y", "size", "archetype"} <= set(body["matrix"][0])
    assert body["matrix"][0]["x"] == items[0]["rca"] and body["matrix"][0]["size"] == items[0]["world_trade"]
    total = db_conn.execute("SELECT SUM(untapped_potential_usd) AS s FROM hs6_scores").fetchone()["s"]
    assert body["summary"]["total_untapped_usd"] == pytest.approx(total, rel=1e-6)
    assert body["summary"]["n_products"] == db_conn.execute("SELECT COUNT(*) AS n FROM hs6_metrics").fetchone()["n"]


def test_opportunities_filters(client, analyst_headers, db_conn):
    body = client.get("/api/analytics/opportunities?ministry_id=mot&limit=500", headers=analyst_headers).json()
    mot_hs6 = {r["hs6"] for r in db_conn.execute("SELECT DISTINCT hs6 FROM products WHERE ministry_id = 'mot'")}
    assert body["items"] and all(i["hs6"] in mot_hs6 for i in body["items"])
    body = client.get("/api/analytics/opportunities?chapter=61,62&min_world_trade=1e9", headers=analyst_headers).json()
    assert all(i["hs6"][:2] in ("61", "62") and i["world_trade"] >= 1e9 for i in body["items"])
    body = client.get("/api/analytics/opportunities?chain_id=tyre", headers=analyst_headers).json()
    assert "401110" in {i["hs6"] for i in body["items"]}
    assert client.get("/api/analytics/opportunities?ministry_id=nope", headers=analyst_headers).status_code == 404
    assert client.get("/api/analytics/opportunities?chapter=abc", headers=analyst_headers).status_code == 400
    assert client.get("/api/analytics/opportunities?limit=501", headers=analyst_headers).status_code == 422


def test_import_dependency(client, analyst_headers):
    body = client.get("/api/analytics/import-dependency?limit=25", headers=analyst_headers).json()
    need = ITEM_BASE_KEYS | {"india_imports", "india_exports", "dependency_ratio", "india_import_hhi",
                             "top_import_source", "top_import_source_name", "top_import_source_share",
                             "china_import_share", "import_dependency_score", "vulnerability_score"}
    assert len(body["items"]) == 25 and need <= set(body["items"][0])
    scores = [i["import_dependency_score"] for i in body["items"]]
    assert scores == sorted(scores, reverse=True)
    countries = body["by_source_country"]
    assert {"country_id", "country", "imports", "n_products"} <= set(countries[0])
    assert [c["imports"] for c in countries] == sorted((c["imports"] for c in countries), reverse=True)
    assert countries[0]["country_id"] == "aschn"                     # China is India's largest source
    assert 0 < body["summary"]["china_share"] < 1 and body["summary"]["total_imports"] > 5e11


def test_import_substitution(client, analyst_headers):
    body = client.get("/api/analytics/import-substitution?limit=30", headers=analyst_headers).json()
    items = body["items"]
    assert items and all(i["substitution_score"] is not None for i in items)
    assert all(i["india_imports"] > (i["india_exports"] or 0) and i["india_imports"] >= 10e6 for i in items)
    assert {"rca", "world_supplier_hhi", "mfn_tariff", "schemes"} <= set(items[0])
    assert body["summary"]["n_products"] >= len(items)


def test_competitiveness(client, analyst_headers):
    body = client.get("/api/analytics/competitiveness", headers=analyst_headers).json()
    assert sum(b["count"] for b in body["histogram"]) == body["summary"]["n_products"]
    assert {"bucket", "count", "exports"} <= set(body["histogram"][0])
    assert {"sector_id", "name", "rca_weighted", "n_rca_gt1", "exports"} <= set(body["by_sector"][0])
    assert 0 < body["summary"]["exports_rca_gt1_share"] < 1
    rcas = [i["rca"] for i in body["top_rca"]]
    assert rcas == sorted(rcas, reverse=True) and all(i["india_exports"] >= 5e6 for i in body["top_rca"])


def test_demand_supply(client, analyst_headers):
    body = client.get("/api/analytics/demand-supply?chain_id=tyre", headers=analyst_headers).json()
    first = body["items"][0]
    assert first["code"] == "4011" and first["production"] == 217_000_000 and first["unit"] == "units"
    assert first["production_year"] == 2023
    assert first["apparent_consumption"] is None                # physical units: not computable (SPEC)
    assert first["provenance"]["status"] == "verified" and first["provenance"]["source"] == "atma"
    assert first["exports"] == pytest.approx(2.962e9, rel=0.01)
    others = [i for i in body["items"][1:] if i["production"] is None]
    assert others and others[0]["provenance"]["status"] == "not_available"
    assert client.get("/api/analytics/demand-supply?chain_id=nope", headers=analyst_headers).status_code == 404
    assert client.get("/api/analytics/demand-supply?sector_id=textiles", headers=analyst_headers).status_code == 200


def test_archetypes(client, analyst_headers, db_conn):
    body = client.get("/api/analytics/archetypes", headers=analyst_headers).json()
    assert [a["name"] for a in body["archetypes"]] == list(ARCHETYPES)
    assert sum(a["n"] for a in body["archetypes"]) == db_conn.execute(
        "SELECT COUNT(*) AS n FROM hs6_scores").fetchone()["n"]
    assert len(body["clusters"]) == 6
    c0 = body["clusters"][0]
    assert {"id", "n", "centroid", "label", "examples"} <= set(c0) and c0["label"]
    assert set(c0["centroid"]) == set(scoring.KMEANS_FEATURES)


def test_forecast(client, analyst_headers):
    body = client.get("/api/analytics/forecast/401110", headers=analyst_headers).json()
    assert body["code"] == "401110" and body["description"]
    assert [h["year"] for h in body["history"]] == list(range(2018, 2025))
    for flow in ("exports", "imports"):
        pts = body["forecast"][flow]
        assert [p["year"] for p in pts] == [2025, 2026]
        assert all(p["lo"] <= p["value"] <= p["hi"] for p in pts)
    assert "OLS" in body["method"]
    line = client.get("/api/analytics/forecast/4011.10.10", headers=analyst_headers).json()
    assert line["hs6_codes"] == ["401110"] and line["forecast"] == body["forecast"]
    heading = client.get("/api/analytics/forecast/4011", headers=analyst_headers).json()
    assert heading["n_hs6"] >= 8 and heading["history"][-1]["exports"] == pytest.approx(2.962e9, rel=0.01)
    assert client.get("/api/analytics/forecast/abc", headers=analyst_headers).status_code == 404
    assert client.get("/api/analytics/forecast/99999999", headers=analyst_headers).status_code == 404


def test_trends(client, analyst_headers):
    total = client.get("/api/analytics/trends", headers=analyst_headers).json()["series"]
    assert [s["year"] for s in total] == list(range(2018, 2025))
    assert total[-1]["exports"] == pytest.approx(437.70e9, rel=0.01)     # India FY2024-25 (DGCIS TRADESTAT)
    mot = client.get("/api/analytics/trends?level=ministry&id=mot", headers=analyst_headers).json()["series"]
    assert len(mot) == 7 and 0 < mot[-1]["exports"] < total[-1]["exports"]
    ch = client.get("/api/analytics/trends?level=chapter&id=40", headers=analyst_headers).json()["series"]
    assert ch[-1]["exports"] > 0
    assert client.get("/api/analytics/trends?level=ministry", headers=analyst_headers).status_code == 400
    assert client.get("/api/analytics/trends?level=sector&id=nope", headers=analyst_headers).status_code == 404


def test_anomalies_same_shape_as_risk_alerts(client, analyst_headers):
    anomalies = client.get("/api/analytics/anomalies?limit=30", headers=analyst_headers).json()
    alerts = client.get("/api/risk/alerts?limit=30", headers=analyst_headers).json()
    assert anomalies == alerts and len(alerts) == 30
    assert ALERT_KEYS <= set(alerts[0])
    order = {"high": 0, "medium": 1, "low": 2}
    assert [order[a["severity"]] for a in alerts] == sorted(order[a["severity"]] for a in alerts)


# =========================================================================== value chains

KPI_KEYS = ["global_production", "india_production", "global_exports", "india_exports", "india_share",
            "india_imports"]


def test_value_chain_list(client):
    chains = client.get("/api/valuechains").json()
    ids = [c["id"] for c in chains]
    assert ids[:2] == ["tyre", "natural_rubber"]
    assert {"cotton_apparel", "auto_components", "pharma_api", "mobile_electronics", "solar_pv", "steel",
            "ev_battery", "leather_footwear"} <= set(ids)
    need = {"id", "name", "title", "anchor_hs", "lead_ministry", "description", "n_stages", "n_items",
            "india_exports", "world_trade", "india_share"}
    for c in chains:
        assert need <= set(c) and c["n_stages"] >= 3 and c["n_items"] > 0
    tyre = chains[0]
    assert tyre["lead_ministry"]["id"] == "dpiit" and tyre["india_share"] == pytest.approx(0.0293, abs=5e-4)


def test_tyre_deep_dive_uses_live_data(client):
    """Tyre sector (HS 4011, 2024): official TRADESTAT India trade, CEPII BACI world trade, ATMA production."""
    d = client.get("/api/valuechains/tyre").json()
    kpis = {k["key"]: k for k in d["kpis"]}
    assert [k["key"] for k in d["kpis"]] == KPI_KEYS
    assert kpis["global_exports"]["value"] == pytest.approx(101.218e9, rel=0.01)
    assert kpis["india_exports"]["value"] == pytest.approx(2.962e9, rel=0.01)
    assert kpis["india_share"]["value"] == pytest.approx(0.02926, abs=5e-4)
    assert kpis["india_imports"]["value"] == pytest.approx(0.1831e9, rel=0.02)
    assert d["india_rank"]["rank"] == 8
    assert d["india_rank"]["text"] == "India's rank is 8th in global suppliers"
    assert {k: kpis[k]["unit"] for k in KPI_KEYS} == {
        "global_production": None, "india_production": "units", "global_exports": "usd",
        "india_exports": "usd", "india_share": "fraction", "india_imports": "usd"}
    # no global production source exists; India's output is the ATMA 2023 figure
    assert kpis["global_production"]["value"] is None
    assert kpis["global_production"]["provenance"]["status"] == "not_available"
    assert kpis["india_production"]["value"] == 217_000_000
    assert kpis["india_production"]["year"] == 2023
    assert kpis["india_production"]["provenance"]["status"] == "verified"
    assert kpis["india_production"]["provenance"]["source"] == "atma"
    assert kpis["india_exports"]["provenance"]["status"] == "verified"
    for k in d["kpis"]:
        _prov(k["provenance"])
        assert "playbook_value" not in k and "playbook_unit" not in k
    assert "playbook_reference" not in d
    # country panels: China the top supplier, USA the top market and destination, Thailand top source
    assert d["world_top_suppliers"][0]["country_id"] == "aschn"
    assert COUNTRY_VALUE_KEYS <= set(d["world_top_suppliers"][0])
    assert any(s["country_id"] == "asind" and s["rank"] == 8 for s in d["world_top_suppliers"])
    assert d["world_top_markets"][0]["country_id"] == "nausa"
    assert d["india_top_destinations"][0]["country_id"] == "nausa"
    assert d["india_top_sources"][0]["country_id"] == "astha"
    assert [c["code"] for c in d["top_export_categories"]] == ["401170", "401120", "401180", "401110", "401140"]
    assert d["top_export_categories"][0]["value"] == pytest.approx(1.17e9, rel=0.15)


def test_tyre_stages_items_and_extras(client, db_conn):
    d = client.get("/api/valuechains/tyre").json()
    assert [(s["stage_id"], s["order"]) for s in d["stages"]] == [("raw", 1), ("components", 2), ("finished", 3)]
    assert [len(s["items"]) for s in d["stages"]] == [19, 3, 8]
    item = d["stages"][0]["items"][0]
    assert {"id", "item_name", "hs_code", "hsn8", "description", "ministry_text", "ministries", "exports",
            "imports", "rca", "mfn_tariff", "linked"} <= set(item)
    assert item["item_name"] == "Natural Rubber" and item["ministries"][0]["id"] == "doc" and item["linked"]
    cord = next(i for s in d["stages"] for i in s["items"] if i["hs_code"] == "5902")
    assert cord["linked"] and cord["hsn8"] is None and cord["trade_level"] == "hs4"
    assert {m["id"] for m in d["stages"][1]["ministries"]} == {"dpiit", "mot", "mos"}
    assert [m["name"] for m in d["manufacturers"]][:2] == ["MRF", "Apollo Tyres"]
    assert d["skill_council"]["name"].startswith("Rubber, Chemical")
    assert {"qco_tyres"} <= {s["id"] for s in d["schemes"]}
    assert d["clusters"] and {"id", "name", "state", "district", "products", "lat", "lon"} <= set(d["clusters"][0])
    flags = d["risk_flags"]
    assert flags and {"code", "description", "vulnerability_score", "reason"} <= set(flags[0])
    assert len({f["code"] for f in flags}) == len(flags)
    assert "playbook_reference" not in d and d["notes"] == []
    assert {it["source"] for s in d["stages"] for it in s["items"]} == {"curated"}
    assert all("deck_hs_code" not in it and "deck_code_differs" not in it
               for s in d["stages"] for it in s["items"])


def test_natural_rubber_uses_rubber_board_and_baci(client):
    d = client.get("/api/valuechains/natural_rubber").json()
    kpis = {k["key"]: k for k in d["kpis"]}
    assert kpis["global_production"]["value"] is None
    assert kpis["global_production"]["provenance"]["status"] == "not_available"
    assert kpis["india_production"]["value"] == 857_000 and kpis["india_production"]["unit"] == "tonnes"
    assert kpis["india_production"]["provenance"]["source"] == "rubber_board"
    assert kpis["india_production"]["provenance"]["status"] == "verified"
    assert kpis["global_exports"]["value"] == pytest.approx(16.874e9, rel=0.01)
    assert kpis["india_imports"]["value"] == pytest.approx(1.069e9, rel=0.01)
    assert kpis["india_share"]["value"] == pytest.approx(0.000524, abs=5e-5)
    assert all("playbook_value" not in k for k in d["kpis"])
    assert d["india_rank"]["rank"] and d["india_rank"]["text"].startswith("India's rank is")


def test_curated_chain_has_no_deck_reference(client):
    d = client.get("/api/valuechains/cotton_apparel").json()
    assert "playbook_reference" not in d
    assert all("playbook_value" not in k for k in d["kpis"])
    assert d["kpis"][0]["value"] is None and d["kpis"][0]["provenance"]["status"] == "not_available"
    assert d["kpis"][3]["value"] > 1e9                           # India's chapter-52 exports
    assert d["kpis"][1]["value"] == pytest.approx(19_245_687_346)  # UNIDO INDSTAT 2022
    assert d["kpis"][1]["provenance"]["source"] == "unido_indstat"


def test_value_chain_mapping_table(client, db_conn):
    m = client.get("/api/valuechains/tyre/mapping").json()
    assert m["chain_id"] == "tyre" and m["title"] == "Tyre Sector (HS Code 4011)"
    rows_ = m["rows"]
    assert len(rows_) == 30
    assert {"s_no", "stage_id", "stage", "item", "hs_code", "description", "ministry_text", "linked_hsn8"} <= set(rows_[0])
    assert all("deck_hs_code" not in r and "deck_slide" not in r for r in rows_)
    stage_rank = {"raw": 1, "components": 2, "finished": 3}
    assert [stage_rank[r["stage_id"]] for r in rows_] == sorted(stage_rank[r["stage_id"]] for r in rows_)
    raw = [r for r in rows_ if r["stage_id"] == "raw"]
    assert [r["s_no"] for r in raw] == list(range(1, 20))
    assert raw[0]["hs_code"] == "40012100" and raw[0]["linked_hsn8"] == "40012100"
    expected = {r["id"]: r["item_order"] for r in db_conn.execute(
        "SELECT id, item_order FROM vc_items WHERE chain_id = 'tyre'")}
    assert all(expected[r["item_id"]] == r["s_no"] for r in rows_)
    comp = client.get("/api/valuechains/tyre/mapping?stage_id=components").json()["rows"]
    assert len(comp) == 3 and {r["stage_id"] for r in comp} == {"components"}
    assert next(r for r in comp if r["hs_code"] == "5902")["linked_hsn8"] is None
    assert client.get("/api/valuechains/tyre/mapping?stage_id=nope").status_code == 404
    assert client.get("/api/valuechains/nope/mapping").status_code == 404
    assert client.get("/api/valuechains/nope").status_code == 404


# =========================================================================== network

NODE_KEYS = {"id", "code", "label", "description", "level", "ministry_id", "ministry_short", "color", "sector_id",
             "exports", "imports", "world_trade", "rca", "vulnerability_score", "production", "chain_ids",
             "stage_id", "is_center"}
EDGE_KEYS = {"id", "source", "target", "relation", "chain_id", "source_kind"}


def _check_graph(body: dict) -> None:
    ids = {n["id"] for n in body["nodes"]}
    assert len(ids) == len(body["nodes"])
    assert all(e["source"] in ids and e["target"] in ids for e in body["edges"])
    assert body["stats"]["n_nodes"] == len(body["nodes"]) and body["stats"]["n_edges"] == len(body["edges"])
    if body["nodes"]:
        assert NODE_KEYS <= set(body["nodes"][0])
    if body["edges"]:
        assert EDGE_KEYS <= set(body["edges"][0])


def test_network_default_and_parts(client):
    body = client.get("/api/network").json()
    _check_graph(body)
    relations = {e["relation"] for e in body["edges"]}
    assert relations <= {"input_to", "component_of", "hs_hierarchy"} and "input_to" in relations
    assert len(body["stats"]["chains"]) >= 10
    with_parts = client.get("/api/network?include_parts=true").json()
    _check_graph(with_parts)
    assert "parts_of" in {e["relation"] for e in with_parts["edges"]}
    assert with_parts["stats"]["n_edges"] > body["stats"]["n_edges"]
    tyre = next(n for n in body["nodes"] if n["code"] == "4011")
    assert tyre["exports"] == pytest.approx(2.962e9, rel=0.01) and tyre["production"]["unit"] == "units"


def test_network_chain_and_center(client):
    tyre = client.get("/api/network?chain_id=tyre").json()
    _check_graph(tyre)
    assert {e["chain_id"] for e in tyre["edges"]} <= {"tyre", None}
    assert tyre["stats"]["chains"] == ["tyre"]
    centred = client.get("/api/network?center=4001&depth=1").json()
    _check_graph(centred)
    center = [n for n in centred["nodes"] if n["is_center"]]
    assert [n["code"] for n in center] == ["4001"]
    assert all(n.get("hops") is None or n["hops"] <= 1 for n in centred["nodes"])
    assert client.get("/api/network?chain_id=nope").status_code == 404
    assert client.get("/api/network?center=99999999").status_code == 404
    assert client.get("/api/network?depth=9").status_code == 422
    lone = client.get("/api/network?center=01012100").json()    # a valid line outside every chain
    assert [n["code"] for n in lone["nodes"]] == ["01012100"] and lone["edges"] == []


def test_network_trace_critical_inputs(client):
    body = client.get("/api/network/trace/40111090?direction=upstream&depth=3").json()
    _check_graph(body)
    codes = {n["code"] for n in body["nodes"]}
    assert "40012200" in codes and "5902" in codes               # natural rubber and tyre cord upstream of tyres
    crit = body["critical_inputs"]
    assert crit and {"code", "description", "vulnerability_score", "imports", "top_import_source", "reason"} <= set(crit[0])
    assert all(c["imports"] >= 1e6 for c in crit)
    vul = [c["vulnerability_score"] or 0 for c in crit]
    assert vul == sorted(vul, reverse=True)
    assert "China" in " ".join(c["reason"] for c in crit)
    down = client.get("/api/network/trace/40012200?direction=downstream&depth=2").json()
    assert "4011" in {n["code"] for n in down["nodes"]} and down["critical_inputs"] == []
    assert client.get("/api/network/trace/40111090?direction=sideways").status_code == 422
    assert client.get("/api/network/trace/abcd").status_code == 404


# =========================================================================== policy

def test_use_cases(client):
    cases = client.get("/api/policy/use-cases").json()
    assert [c["id"] for c in cases] == ["import_substitution", "pli_targeting", "trade_negotiations", "skilling",
                                        "quality_control"]
    for c in cases:
        assert {"id", "title", "description", "question", "route", "metrics"} <= set(c)
        assert c["route"].startswith("/") and c["metrics"] and all(isinstance(m, str) for m in c["metrics"])


def test_schemes_list_and_detail(client):
    pli = client.get("/api/policy/schemes?kind=PLI").json()
    assert len(pli) == 14 and {s["kind"] for s in pli} == {"PLI"}
    need = {"id", "name", "kind", "ministry", "outlay_crore", "launched", "description", "url", "n_products",
            "exports", "imports", "source"}
    assert need <= set(pli[0])
    qco = client.get("/api/policy/schemes?kind=qco").json()
    assert qco and {s["kind"] for s in qco} == {"QCO"}
    assert client.get("/api/policy/schemes?kind=SEZ").status_code == 400
    d = client.get("/api/policy/schemes/pli_auto").json()
    prefixes = [p["prefix"] for p in d["scheme"]["prefixes"]]
    assert d["products"] and len(d["products"]) <= 200
    assert all(any(p["hsn8"].startswith(x) for x in prefixes) for p in d["products"])
    k = d["kpis"]
    assert k["trade_balance"] == pytest.approx(k["exports"] - k["imports"])
    assert k["n_products"] == d["scheme"]["n_products"] > 0
    deps = d["top_dependencies"]
    assert deps and len({x["hs6"] for x in deps}) == len(deps)
    assert {"vulnerability_score", "top_import_source", "top_import_source_share", "china_import_share"} <= set(deps[0])
    assert client.get("/api/policy/schemes/nope").status_code == 404


def test_agreements(client):
    agreements = client.get("/api/policy/agreements").json()
    assert len(agreements) >= 20
    need = {"id", "name", "short_name", "partners", "status", "year", "url", "notes", "india_exports_to",
            "india_imports_from"}
    assert need <= set(agreements[0])
    uae = next(a for a in agreements if a["id"] == "ind_uae_cepa")
    assert uae["partners"] == [{"id": "asare", "name": uae["partners"][0]["name"]}]
    assert uae["india_exports_to"] > 1e10 and uae["india_imports_from"] > 1e10


def test_negotiation_rules(client, analyst_headers):
    r = client.get("/api/policy/negotiation?partner=eugbr", headers=analyst_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["partners"] == [{"id": "eugbr", "name": "United Kingdom"}]
    b = body["bilateral"]
    assert b["balance"] == pytest.approx(b["india_exports_to"] - b["india_imports_from"])
    assert b["top_exports"] and {"hs6", "description", "value"} <= set(b["top_exports"][0])
    off = body["offensive"]
    assert off and len(off) <= 50
    for o in off:
        assert o["india_rca"] >= 1 and o["partner_imports_world"] >= 5e6
        expected = max(0.0, o["india_world_share"] * o["partner_imports_world"] - o["india_exports_to_partner"])
        assert o["gap_usd"] == pytest.approx(expected, rel=1e-9, abs=1e-6)
    assert [o["gap_usd"] for o in off] == sorted((o["gap_usd"] for o in off), reverse=True)
    for d in body["defensive"]:
        assert d["india_imports_from_partner"] >= 5e6 and d["partner_rca"] >= 1
        assert (d["india_rca"] or 0) >= 0.5 or d["pli_schemes"]
        assert d["reason"]
    s = body["summary"]
    assert s["n_offensive"] >= len(off) and s["n_defensive"] >= len(body["defensive"])
    assert s["total_gap_usd"] >= sum(o["gap_usd"] for o in off) - 1


def test_negotiation_agreement_and_errors(client, analyst_headers):
    body = client.get("/api/policy/negotiation?agreement=aitiga", headers=analyst_headers).json()
    assert len(body["partners"]) == 10 and body["agreement"]["id"] == "aitiga"
    assert body["defensive"]
    assert client.get("/api/policy/negotiation", headers=analyst_headers).status_code == 400
    assert client.get("/api/policy/negotiation?partner=xxnope", headers=analyst_headers).status_code == 404
    assert client.get("/api/policy/negotiation?agreement=nope", headers=analyst_headers).status_code == 404
    assert client.get("/api/policy/negotiation?partner=asind", headers=analyst_headers).status_code == 400


def test_simulate_tariff_maths(client, analyst_headers, db_conn):
    body = {"codes": ["40012200"], "new_tariff_pct": 10, "elasticity": 2.0, "substitution_share": 0.4,
            "input_cost_share": 0.2}
    r = client.post("/api/policy/simulate-tariff", json=body, headers=analyst_headers)
    assert r.status_code == 200, r.text
    out = r.json()
    res = out["results"][0]
    m0 = db_conn.execute("SELECT india_imports FROM hs6_metrics WHERE hs6 = '400122'").fetchone()["india_imports"]
    t0 = db_conn.execute("SELECT mfn_avg FROM tariffs WHERE hs6 = '400122'").fetchone()["mfn_avg"]
    lines = db_conn.execute("SELECT lines_in_hs6 FROM products WHERE hsn8 = '40012200'").fetchone()["lines_in_hs6"]
    m0 = m0 / lines
    m1 = m0 * ((1.10) / (1 + t0 / 100)) ** -2.0
    assert res["tariff_before"] == t0 and res["tariff_after"] == 10
    assert res["imports_before"] == pytest.approx(m0) and res["imports_after"] == pytest.approx(m1)
    assert res["revenue_after"] == pytest.approx(0.10 * m1)
    assert res["domestic_opportunity_usd"] == pytest.approx(-(m1 - m0) * 0.4)
    tyre = next(d for d in out["downstream"] if d["code"] == "4011")
    assert tyre["cost_increase_pct"] == pytest.approx(0.2 * (1.10 / (1 + t0 / 100) - 1) * 100)
    assert {"code", "description", "via", "cost_increase_pct"} <= set(tyre) and tyre["via"] == "40012200"
    assert out["totals"]["imports_after"] == pytest.approx(sum(x["imports_after"] for x in out["results"]))
    a = out["assumptions"]
    assert (a["elasticity"], a["substitution_share"], a["input_cost_share"]) == (2.0, 0.4, 0.2) and a["formula"]


def test_simulate_tariff_defaults_and_errors(client, analyst_headers):
    out = client.post("/api/policy/simulate-tariff", json={"codes": ["4011"], "new_tariff_pct": 15},
                      headers=analyst_headers).json()
    assert len(out["results"]) >= 8 and {r["hs6"][:4] for r in out["results"]} == {"4011"}
    a = out["assumptions"]
    assert (a["elasticity"], a["substitution_share"], a["input_cost_share"]) == (2.5, 0.5, 0.1)
    post = lambda b: client.post("/api/policy/simulate-tariff", json=b, headers=analyst_headers)  # noqa: E731
    assert post({"codes": ["99999999"], "new_tariff_pct": 10}).status_code == 400
    assert post({"codes": [], "new_tariff_pct": 10}).status_code == 422
    assert post({"codes": ["4011"]}).status_code == 422
    assert post({"codes": ["4011"], "new_tariff_pct": -5}).status_code == 422
    assert post({"codes": ["4011"], "new_tariff_pct": 5, "substitution_share": 2}).status_code == 422


def test_skilling(client):
    tyre = client.get("/api/policy/skilling?chain_id=tyre").json()
    assert {"id", "name", "url", "sectors", "chains"} <= set(tyre[0])
    assert all("tyre" in c["chains"] for c in tyre) and "rcpsdc" in {c["id"] for c in tyre}
    assert len(client.get("/api/policy/skilling").json()) >= len(tyre)
    assert client.get("/api/policy/skilling?chain_id=nope").status_code == 404


# =========================================================================== risk

def test_risk_overview(client, analyst_headers, db_conn):
    body = client.get("/api/risk/overview?limit=20", headers=analyst_headers).json()
    k = body["kpis"]
    assert {"high_risk_products", "imports_at_risk_usd", "china_dependent_imports_usd", "concentrated_products"} <= set(k)
    expected = db_conn.execute("""SELECT COUNT(*) AS n, SUM(m.india_imports) AS v FROM hs6_scores s
                                  JOIN hs6_metrics m USING (hs6)
                                  WHERE s.vulnerability_score >= 65 AND m.india_imports >= 1e6""").fetchone()
    assert k["high_risk_products"] == expected["n"] and k["imports_at_risk_usd"] == pytest.approx(expected["v"])
    china = db_conn.execute("""SELECT SUM(india_imports * china_import_share) AS v FROM hs6_metrics
                               WHERE china_import_share >= 0.6 AND india_imports > 0""").fetchone()["v"]
    assert k["china_dependent_imports_usd"] == pytest.approx(china)
    top = body["top_vulnerable"]
    assert len(top) == 20 and {"vulnerability_score", "top_import_source_name", "china_import_share"} <= set(top[0])
    assert [t["vulnerability_score"] for t in top] == sorted((t["vulnerability_score"] for t in top), reverse=True)
    assert {"sector_id", "name", "avg_vulnerability", "imports_at_risk"} <= set(body["by_sector"][0])
    assert {"country_id", "country", "imports_at_risk", "n_products"} <= set(body["by_source_country"][0])
    assert 0 < len(body["alerts"]) <= 20 and ALERT_KEYS <= set(body["alerts"][0])
    mot = client.get("/api/risk/overview?ministry_id=mot", headers=analyst_headers).json()
    assert mot["kpis"]["high_risk_products"] < k["high_risk_products"]


def test_risk_alerts_filters(client, analyst_headers, ministry_headers):
    high = client.get("/api/risk/alerts?severity=high&limit=500", headers=analyst_headers).json()
    assert high and {a["severity"] for a in high} == {"high"}
    china = client.get("/api/risk/alerts?kind=china_dependence", headers=ministry_headers).json()
    assert china and {a["kind"] for a in china} == {"china_dependence"}
    assert len(client.get("/api/risk/alerts?limit=5", headers=analyst_headers).json()) == 5
    tyre = client.get("/api/risk/alerts?chain_id=tyre&limit=500", headers=analyst_headers).json()
    assert tyre and len(tyre) < len(client.get("/api/risk/alerts?limit=2000", headers=analyst_headers).json())
    assert client.get("/api/risk/alerts?severity=urgent", headers=analyst_headers).status_code == 422


# =========================================================================== performance (SPEC section 9)

PERF_PATHS = GOV_GET_ENDPOINTS + PUBLIC_GET_ENDPOINTS + (
    "/api/network?include_parts=true", "/api/valuechains/cotton_apparel", "/api/valuechains/steel",
    "/api/policy/negotiation?agreement=ind_eu_fta", "/api/network/trace/4011?direction=both&depth=6",
    "/api/analytics/opportunities?limit=500", "/api/analytics/import-dependency?sector_id=textiles",
    "/api/risk/overview?chain_id=tyre",
)


def test_performance_budget(timed_get, analyst_headers):
    slow = []
    for path in PERF_PATHS:
        response, seconds = timed_get(path, headers=analyst_headers)
        assert response.status_code == 200, (path, response.text)
        if seconds > PERF_BUDGET_S:
            slow.append((path, round(seconds, 2)))
    assert not slow, f"endpoints over {PERF_BUDGET_S}s: {slow}"


@pytest.mark.parametrize("path", ("/api/analytics/opportunities", "/api/network", "/api/valuechains/cotton_apparel",
                                  "/api/policy/negotiation?agreement=ind_eu_fta", "/api/policy/agreements",
                                  "/api/risk/overview", "/api/policy/use-cases"))
def test_performance_cold_cache(timed_get, analyst_headers, path):
    """Each heavy endpoint stays within budget even when the in-process caches are empty."""
    scoring.clear_cache()
    response, seconds = timed_get(path, headers=analyst_headers)
    assert response.status_code == 200
    assert seconds <= PERF_BUDGET_S, f"{path} took {seconds:.2f}s on a cold cache"


# =========================================================================== review fixes: curated rows,
# per-row provenance, curated owners, production chooser, substitution candidates

def test_tyre_rows_resolve_to_matching_gst_lines(client, db_conn):
    """Every chain row links the GST line its text describes; no deck transcription remains."""
    d = client.get("/api/valuechains/tyre").json()
    fin = next(s for s in d["stages"] if s["stage_id"] == "finished")["items"]
    assert [(i["hs_code"], i["hsn8"]) for i in fin] == [
        ("40111010", "40111010"), ("40111090", "40111090"), ("40112010", "40112010"), ("40112090", "40112090"),
        ("40113000", "40113000"), ("40114010", "40114010"), ("40114020", "40114020"), ("40114090", "40114090")]
    aircraft = next(i for i in fin if i["item_name"] == "Aircraft Tyres")
    aircraft_hs6 = db_conn.execute("SELECT india_imports, india_exports FROM hs6_metrics WHERE hs6 = '401130'").fetchone()
    assert aircraft["hsn8"] == "40113000" and aircraft["hs6"] == "401130"
    assert aircraft["imports"] == pytest.approx(aircraft_hs6["india_imports"])          # aircraft trade, not motorcycles
    assert "aircraft" in aircraft["gst_description"].lower()
    assert aircraft["source"] == "curated" and aircraft["provenance"]["status"] == "not_verified"
    assert "awaiting ministry validation" in aircraft["provenance"]["label"]
    crepe = d["stages"][0]["items"][4]
    assert (crepe["hs_code"], crepe["hsn8"]) == ("40012930", "40012930")
    assert "estate brown crepe" in crepe["gst_description"].lower()
    # the product page of the resolved line agrees with the row
    product = client.get("/api/hsn/product/40113000").json()
    assert "aircraft" in product["description"].lower()
    assert any(v["chain_id"] == "tyre" for v in product["value_chains"])
    assert all("deck_hs_code" not in i and "deck_code_differs" not in i and "deck_description" not in i
               for s in d["stages"] for i in s["items"])
    m = client.get("/api/valuechains/tyre/mapping").json()
    assert m["notes"] == d["notes"] == []
    assert all("deck_hs_code" not in r and "deck_slide" not in r and "note" not in r for r in m["rows"])
    assert m["provenance"]["status"] == "not_verified"
    assert m["provenance"]["counts"] == {"curated": 30}
    assert "Curated value chain" in m["provenance"]["label"]
    assert {r["source"] for r in m["rows"]} == {"curated"}


def test_curated_mapping_provenance(client):
    """All chain rows and mappings are curated and Not verified until ministry validation."""
    d = client.get("/api/valuechains/natural_rubber").json()
    prov = d["provenance"]["mapping"]
    assert prov["status"] == "not_verified" and prov["counts"] == {"curated": 16}
    assert "Curated value chain" in prov["label"] and "playbook" not in prov
    for s in d["stages"]:
        assert s["provenance"]["status"] == "not_verified"
        assert s["provenance"]["counts"] == {"curated": len(s["items"])}
        for it in s["items"]:
            assert it["source"] == "curated"
            assert it["provenance"]["status"] == "not_verified"
            assert "awaiting ministry validation" in it["provenance"]["label"]
    m = client.get("/api/valuechains/natural_rubber/mapping").json()
    assert m["provenance"]["status"] == "not_verified" and m["provenance"]["counts"]["curated"] == 16
    assert {r["provenance"]["status"] for r in m["rows"]} == {"not_verified"}
    assert {r["source"] for r in m["rows"]} == {"curated"}
    curated = client.get("/api/valuechains/cotton_apparel").json()["provenance"]["mapping"]
    assert curated["status"] == "not_verified" and curated["counts"] == {"curated": 20}


def test_curated_items_show_the_atlas_product_mapping(client, db_conn):
    """DI-1: a curated row never names a different owner than the product page (residual shown as Residual)."""
    chains = [c["id"] for c in client.get("/api/valuechains").json()]
    checked = 0
    for cid in chains:
        d = client.get(f"/api/valuechains/{cid}").json()
        mapping = {r["linked_hsn8"]: r for r in client.get(f"/api/valuechains/{cid}/mapping").json()["rows"]
                   if r["linked_hsn8"]}
        for s in d["stages"]:
            for it in s["items"]:
                if not it["hsn8"]:
                    continue
                owner = db_conn.execute("SELECT ministry_id FROM products WHERE hsn8 = ?", (it["hsn8"],)).fetchone()
                ids = [m["id"] for m in it["ministries"]]
                assert ids and ids[0] == owner["ministry_id"], (cid, it["hsn8"], ids, owner)
                assert [m["id"] for m in mapping[it["hsn8"]]["ministries"]] == ids
                if owner["ministry_id"] == "residual":
                    assert it["ministries"][0]["short_name"] == "Residual" and "Residual" in it["ministry_text"]
                checked += 1
    assert checked > 100
    # the examples of the review
    leather = client.get("/api/valuechains/leather_footwear").json()
    hides = next(i for s in leather["stages"] for i in s["items"] if i["hsn8"] == "41015010")
    assert [m["id"] for m in hides["ministries"]] == ["dpiit"]
    assert client.get("/api/hsn/product/41015010").json()["ministry_id"] == "dpiit"
    toys = client.get("/api/valuechains/toys").json()
    moulded = next(i for s in toys["stages"] for i in s["items"] if i["hsn8"] == "39269099")
    assert [m["id"] for m in moulded["ministries"]] == ["dcpc"]
    # stage boxes of curated stages follow their items (residual excluded)
    raw_stage = leather["stages"][0]
    assert {m["id"] for m in raw_stage["ministries"]} == {"dpiit", "dcpc"} and "DAHD" not in raw_stage["ministry_text"]


def test_choose_production_prefers_verified_then_latest_then_newest():
    """F1: one chooser for every page - a verified row displaces an unverified one, the oldest row never wins."""
    from app.common import choose_production

    unverified = {"id": 1, "year": 2023, "value": 217e6, "unit": "units", "source": "atma", "status": "not_verified"}
    old = {"id": 4, "year": 2022, "value": 3e9, "unit": "usd", "source": "MOFPI", "status": "verified"}
    new = {"id": 5, "year": 2024, "value": 5e9, "unit": "usd", "source": "MOFPI", "status": "verified"}
    draft = {"id": 9, "year": 2025, "value": 1.0, "unit": "usd", "source": "x", "status": "not_verified"}
    assert choose_production([unverified, old, new, draft]) is new
    assert choose_production([draft, unverified]) is draft       # a verified newer row beats an unverified year
    assert choose_production([unverified]) is unverified and choose_production([]) is None
    assert choose_production([{**unverified, "value": None}]) is None


def test_uploaded_production_displaces_the_atma_figure_everywhere(mutable_client, mutable_conn):
    """F1: the chain KPI, the demand-supply table and the network node agree after an official upload."""
    mutable_conn.execute("INSERT INTO production (scope, key, label, year, value, unit, source, status) VALUES "
                         "('chain', 'tyre', 'india_production', 2024, 5e9, 'usd', 'MoCI annual report 2024-25', "
                         "'verified')")
    mutable_conn.commit()
    scoring.clear_cache()  # a direct insert bypasses the upload fingerprint; the Data Hub path is tested in ops
    kpi = {k["key"]: k for k in mutable_client.get("/api/valuechains/tyre").json()["kpis"]}["india_production"]
    assert (kpi["value"], kpi["unit"], kpi["year"], kpi["provenance"]["status"]) == (5e9, "usd", 2024, "verified")
    assert "playbook_value" not in kpi and "playbook_unit" not in kpi
    assert "MoCI" in kpi["provenance"]["label"]
    token = mutable_client.post("/api/auth/demo-login", json={"role": "analyst"}).json()["access_token"]
    ds = mutable_client.get("/api/analytics/demand-supply?chain_id=tyre",
                            headers={"Authorization": f"Bearer {token}"}).json()["items"][0]
    assert ds["production"] == 5e9 and ds["unit"] == "usd" and ds["apparent_consumption"] is not None
    assert ds["provenance"]["source"] == "MoCI annual report 2024-25"
    node = next(n for n in mutable_client.get("/api/network?chain_id=tyre").json()["nodes"] if n["code"] == "4011")
    assert node["production"]["value"] == 5e9 and node["production"]["status"] == "verified"
    scoring.clear_cache()


def test_import_substitution_leaves_out_primary_commodities(client, analyst_headers):
    """DI-4: ores, fuels, unworked stones and precious / unwrought metals are not substitution candidates."""
    body = client.get("/api/analytics/import-substitution?limit=100", headers=analyst_headers).json()
    assert body["items"] and not any(scoring.is_primary_good(i["hs6"]) for i in body["items"])
    assert body["excluded"]["n_products"] > 0 and body["excluded"]["included"] is False
    assert "include_primary" in body["excluded"]["rule"]
    everything = client.get("/api/analytics/import-substitution?limit=100&include_primary=true",
                            headers=analyst_headers).json()
    assert any(scoring.is_primary_good(i["hs6"]) for i in everything["items"])
    assert everything["excluded"] == {**everything["excluded"], "n_products": 0, "included": True}
    assert everything["summary"]["n_products"] == body["summary"]["n_products"] + body["excluded"]["n_products"]
    assert scoring.is_primary_good("710692") and scoring.is_primary_good("710231") and scoring.is_primary_good("780199")
    assert not scoring.is_primary_good("710239") and not scoring.is_primary_good("841112")
