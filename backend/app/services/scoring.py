"""Scoring engine (docs/SPEC.md section 4; plain-language version in docs/METHODOLOGY.md). Owner: C2.

Two layers live here:

1. **Formulas** - small pure functions (no database) for every indicator of SPEC section 4: Balassa RCA, HHI,
   CAGR / YoY, percentile ranks, export potential, untapped potential, import dependency, supply-chain
   vulnerability, import substitution, rule-based archetypes, k-means product clusters and automated alerts.
   ``scripts/etl/compute_scores.py`` calls :func:`score_products`, :func:`cluster_products` and
   :func:`detect_alerts` to fill ``hs6_scores`` / ``alerts``; the unit tests exercise them directly.

2. **The cached HS6 analytics frame** - :func:`analytics_frame` loads one row per HS6 with trade (``hs6_metrics``
   + ``hs6_scores`` + tariff + the HS6's most common ministry / sector) into memory, keyed on a cheap data
   fingerprint (:func:`data_fingerprint`: database file, ``meta.built_at`` / ``meta.scores_built_at``, the
   latest mapping change and connector refresh). The analytics, risk, policy, value-chain and network routers
   filter and rank this frame in Python, which keeps every endpoint far below the 1.5 s budget.

Decisions (the SPEC leaves them open)
-------------------------------------
* ``pct(v)`` is the percentile rank ``(r - 1) / (n - 1)`` with ``r`` the average rank (ties share a rank) among
  the HS6 codes with world trade > 0 *and a defined value* of ``v``; so the smallest value scores 0 and the
  largest 1. ``log M_p`` is undefined for ``M_p = 0`` and missing CAGRs are undefined: such components
  contribute 0, as the SPEC's "missing components contribute 0" rule says. (Ranks are invariant to the log, so
  ``pct(log W)`` = ``pct(W)`` for W > 0.)
* ``india_import_hhi`` / ``china_import_share`` / ``world_supplier_hhi`` that are NULL contribute 0
  (for ``1 - world_supplier_hhi`` too).
* Archetype comparisons need both CAGRs; a missing CAGR fails the comparison.
* k-means: missing CAGRs are imputed as 0 (no growth) and a missing RCA as 0 before standardising; cluster ids
  are renumbered 0..5 in descending order of the cluster's mean ``log1p(exports)`` so that ids are stable and
  cluster 0 is always the strongest exporters' group. Labels are generated from the centroid's z-scores.
"""
from __future__ import annotations

import math
import sqlite3
import threading
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

import numpy as np

LATEST_YEAR = 2024
FIRST_TREND_YEAR = 2018
INDIA_ID = "asind"
CHINA_ID = "aschn"

# --------------------------------------------------------------------------- weights and thresholds (SPEC 4)

EXPORT_POTENTIAL_WEIGHTS = {"world_size": 0.35, "rca": 0.30, "world_growth": 0.20, "export_growth": 0.15}
RCA_CAP_POTENTIAL = 3.0
IMPORT_DEPENDENCY_WEIGHTS = {"dependency_ratio": 0.5, "import_size": 0.3, "import_hhi": 0.2}
VULNERABILITY_WEIGHTS = {"dependency_ratio": 0.30, "import_hhi": 0.25, "china_share": 0.20, "import_size": 0.25}
SUBSTITUTION_WEIGHTS = {"import_size": 0.4, "rca": 0.3, "supplier_diversity": 0.3}
SUBSTITUTION_MIN_IMPORTS = 10e6
UNTAPPED_MIN_RCA = 0.3
ARCHETYPES = ("Champion", "Established", "Emerging", "Dependent", "Marginal")
DEPENDENT_MIN_IMPORTS = 50e6

KMEANS_K = 6
KMEANS_RANDOM_STATE = 42
KMEANS_N_INIT = 10
KMEANS_FEATURES = ("log1p_x", "log1p_m", "log1p_w", "rca_capped", "world_cagr", "export_cagr")
KMEANS_RCA_CAP = 5.0
KMEANS_CAGR_CLIP = 0.5

ALERT_RULES = {
    "import_surge": "import_yoy >= 0.5, imports >= $20 mn and 2023 imports >= $1 mn (high if import_yoy >= 1.0, "
                    "else medium)",
    "export_drop": "export_yoy <= -0.3 and 2023 exports >= $20 mn (high if export_yoy <= -0.5, else medium)",
    "concentration": "india_import_hhi >= 0.6 and imports >= $50 mn (medium)",
    "china_dependence": "china_import_share >= 0.6 and imports >= $50 mn (high if >= 0.8, else medium)",
}
SURGE_MIN_BASE = 1e6  # import_surge: 2023 imports must be at least US$ 1 mn (SPEC section 4)

SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}


# --------------------------------------------------------------------------- formula primitives

def _num(value: Any) -> float | None:
    """``float(value)`` or None for None / NaN / non-numeric."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(number) or math.isinf(number) else number


def rca(x_p: float | None, x_total: float | None, w_p: float | None, w_total: float | None) -> float | None:
    """Balassa revealed comparative advantage ``(X_p / X) / (W_p / W)``; None when W_p (or a total) is 0."""
    x_p, x_total, w_p, w_total = (_num(v) for v in (x_p, x_total, w_p, w_total))
    if not w_p or not x_total or not w_total or x_p is None:
        return None
    return (x_p / x_total) / (w_p / w_total)


def hhi(shares_or_values: Iterable[float | None], *, normalise: bool = False) -> float | None:
    """Herfindahl-Hirschman index ``sum(s_c ** 2)`` (0..1). ``normalise=True`` turns raw values into shares."""
    values = [v for v in (_num(x) for x in shares_or_values) if v is not None and v > 0]
    if not values:
        return None
    if normalise:
        total = sum(values)
        values = [v / total for v in values]
    return float(sum(v * v for v in values))


def cagr(series: Mapping[int, float | None], last_year: int = LATEST_YEAR,
         first_allowed: int = FIRST_TREND_YEAR) -> tuple[float | None, int | None]:
    """``(cagr, first_year)``: ``(v_last / v_first) ** (1 / (y_last - y_first)) - 1`` (SPEC section 4).

    ``first_year`` is the earliest year >= ``first_allowed`` (and before ``last_year``) with a value > 0;
    None when there are fewer than two points or an end value is <= 0. Same rule as ``scripts.etl.metrics``.
    """
    v_last = _num(series.get(last_year))
    if v_last is None or v_last <= 0:
        return None, None
    years = sorted(y for y, v in series.items()
                   if first_allowed <= y < last_year and _num(v) is not None and _num(v) > 0)
    if not years:
        return None, None
    first = years[0]
    return (v_last / float(series[first])) ** (1.0 / (last_year - first)) - 1.0, first


def yoy(series: Mapping[int, float | None], year: int = LATEST_YEAR) -> float | None:
    """``v_year / v_(year-1) - 1``; None when the previous value is missing or <= 0."""
    prev, cur = _num(series.get(year - 1)), _num(series.get(year))
    if prev is None or prev <= 0 or cur is None:
        return None
    return cur / prev - 1.0


def _average_ranks(values: Sequence[float]) -> np.ndarray:
    """1-based ranks with ties sharing their average rank - same result as ``scipy.stats.rankdata(method="average")``
    (numpy only, so the deployed API does not need scipy)."""
    _, inverse, counts = np.unique(np.asarray(values, dtype=float), return_inverse=True, return_counts=True)
    upper = np.cumsum(counts)                     # rank of the last member of each tie group
    return (upper - (counts - 1) / 2.0)[inverse.reshape(-1)]


def pct_rank(values: Sequence[float | None]) -> list[float | None]:
    """Percentile rank in [0, 1] of every defined value: ``(r - 1) / (n - 1)``, ``r`` = average rank.

    None stays None. A single defined value gets 1.0.
    """
    idx = [i for i, v in enumerate(values) if _num(v) is not None]
    out: list[float | None] = [None] * len(values)
    if not idx:
        return out
    if len(idx) == 1:
        out[idx[0]] = 1.0
        return out
    ranks = _average_ranks([float(values[i]) for i in idx])
    n = len(idx)
    for i, r in zip(idx, ranks):
        out[i] = float((r - 1.0) / (n - 1.0))
    return out


def dependency_ratio(imports: float | None, exports: float | None) -> float | None:
    """``M / (M + X)``; None when both are zero / missing."""
    m, x = _num(imports) or 0.0, _num(exports) or 0.0
    if m < 0 or x < 0 or m + x <= 0:
        return None
    return m / (m + x)


def _z(value: float | None) -> float:
    """Missing component -> 0 (SPEC: missing components contribute 0)."""
    v = _num(value)
    return 0.0 if v is None else v


def export_potential_score(pct_log_world: float | None, rca_value: float | None,
                           pct_world_cagr: float | None, pct_export_cagr: float | None) -> float:
    """``100 * (0.35 pct(log W) + 0.30 min(RCA, 3) / 3 + 0.20 pct(world_cagr) + 0.15 pct(export_cagr))``."""
    r = _num(rca_value)
    rca_part = 0.0 if r is None else max(0.0, min(r, RCA_CAP_POTENTIAL)) / RCA_CAP_POTENTIAL
    w = EXPORT_POTENTIAL_WEIGHTS
    return 100.0 * (w["world_size"] * _z(pct_log_world) + w["rca"] * rca_part
                    + w["world_growth"] * _z(pct_world_cagr) + w["export_growth"] * _z(pct_export_cagr))


def untapped_potential(exports: float | None, world_trade: float | None, rca_value: float | None,
                       benchmark_share: float | None) -> float:
    """``max(0, b_p * W_p - X_p)`` when RCA >= 0.3, else 0 (``b_p`` = benchmark world share, see below).

    ``b_p = max(India's share of world exports in the product's HS2 chapter, India's overall share X / W)`` -
    the exports India would gain if it reached its chapter-average world share in this product.
    """
    r = _num(rca_value)
    w = _num(world_trade)
    b = _num(benchmark_share)
    if r is None or r < UNTAPPED_MIN_RCA or not w or b is None:
        return 0.0
    return max(0.0, b * w - (_num(exports) or 0.0))


def import_dependency_score(dep_ratio: float | None, pct_log_imports: float | None,
                            import_hhi: float | None) -> float:
    """``100 * (0.5 dependency_ratio + 0.3 pct(log M) + 0.2 india_import_hhi)``."""
    w = IMPORT_DEPENDENCY_WEIGHTS
    return 100.0 * (w["dependency_ratio"] * _z(dep_ratio) + w["import_size"] * _z(pct_log_imports)
                    + w["import_hhi"] * _z(import_hhi))


def vulnerability_score(dep_ratio: float | None, import_hhi: float | None, china_share: float | None,
                        pct_log_imports: float | None) -> float:
    """``100 * (0.30 dependency_ratio + 0.25 india_import_hhi + 0.20 china_import_share + 0.25 pct(log M))``."""
    w = VULNERABILITY_WEIGHTS
    return 100.0 * (w["dependency_ratio"] * _z(dep_ratio) + w["import_hhi"] * _z(import_hhi)
                    + w["china_share"] * _z(china_share) + w["import_size"] * _z(pct_log_imports))


def substitution_score(imports: float | None, exports: float | None, pct_log_imports: float | None,
                       rca_value: float | None, world_supplier_hhi: float | None) -> float | None:
    """Only for net importers with M >= $10 mn (else None):
    ``100 * (0.4 pct(log M) + 0.3 min(RCA, 1) + 0.3 (1 - world_supplier_hhi))``."""
    m, x = _num(imports) or 0.0, _num(exports) or 0.0
    if not (m > x and m >= SUBSTITUTION_MIN_IMPORTS):
        return None
    r = _num(rca_value)
    rca_part = 0.0 if r is None else max(0.0, min(r, 1.0))
    h = _num(world_supplier_hhi)
    diversity = 0.0 if h is None else 1.0 - h
    w = SUBSTITUTION_WEIGHTS
    return 100.0 * (w["import_size"] * _z(pct_log_imports) + w["rca"] * rca_part + w["supplier_diversity"] * diversity)


def archetype(rca_value: float | None, export_cagr: float | None, world_cagr: float | None,
              imports: float | None, exports: float | None) -> str:
    """First matching rule wins: Champion, Established, Emerging, Dependent, else Marginal (SPEC section 4)."""
    r = _num(rca_value)
    ec, wc = _num(export_cagr), _num(world_cagr)
    m, x = _num(imports) or 0.0, _num(exports) or 0.0
    growth_known = ec is not None and wc is not None
    if r is not None and r >= 1 and growth_known and ec >= wc:
        return "Champion"
    if r is not None and r >= 1:
        return "Established"
    if r is not None and 0.3 <= r < 1 and growth_known and ec > wc:
        return "Emerging"
    if m >= 2 * x and m >= DEPENDENT_MIN_IMPORTS:
        return "Dependent"
    return "Marginal"


# --------------------------------------------------------------------------- batch scoring

def _log_or_none(value: float | None) -> float | None:
    v = _num(value)
    return math.log(v) if v is not None and v > 0 else None


def score_products(records: Sequence[Mapping[str, Any]]) -> list[dict]:
    """Score every HS6 record; returns one dict per record (same order) with the ``hs6_scores`` columns.

    Each record needs ``hs6``, ``hs2``, ``india_exports``, ``india_imports``, ``world_trade``, ``rca``,
    ``world_cagr``, ``export_cagr``, ``india_import_hhi``, ``china_import_share``, ``world_supplier_hhi``.
    Percentiles are taken over the records with ``world_trade > 0`` (the SPEC universe); records outside it
    (India-only national codes such as chapter 98, which BACI does not report) get NULL scores except the archetype.
    """
    universe = [i for i, r in enumerate(records) if (_num(r.get("world_trade")) or 0) > 0]

    def pct_over_universe(key_fn) -> dict[int, float | None]:
        values = [key_fn(records[i]) for i in universe]
        return dict(zip(universe, pct_rank(values)))

    p_logw = pct_over_universe(lambda r: _log_or_none(r.get("world_trade")))
    p_logm = pct_over_universe(lambda r: _log_or_none(r.get("india_imports")))
    p_wcagr = pct_over_universe(lambda r: _num(r.get("world_cagr")))
    p_xcagr = pct_over_universe(lambda r: _num(r.get("export_cagr")))

    # Benchmark shares for the untapped potential: India's share of world exports per HS2 chapter / overall.
    chap_x: dict[str, float] = defaultdict(float)
    chap_w: dict[str, float] = defaultdict(float)
    for i in universe:
        r = records[i]
        ch = str(r.get("hs2") or str(r["hs6"])[:2])
        chap_x[ch] += _num(r.get("india_exports")) or 0.0
        chap_w[ch] += _num(r.get("world_trade")) or 0.0
    total_x, total_w = sum(chap_x.values()), sum(chap_w.values())
    overall_share = total_x / total_w if total_w else None

    out: list[dict] = []
    in_universe = set(universe)
    for i, r in enumerate(records):
        x, m, w = _num(r.get("india_exports")), _num(r.get("india_imports")), _num(r.get("world_trade"))
        rca_v = _num(r.get("rca"))
        dep = dependency_ratio(m, x)
        arche = archetype(rca_v, r.get("export_cagr"), r.get("world_cagr"), m, x)
        if i not in in_universe:
            out.append({"hs6": r["hs6"], "export_potential_score": None, "untapped_potential_usd": None,
                        "import_dependency_score": None, "vulnerability_score": None,
                        "substitution_score": None, "archetype": arche, "dependency_ratio": dep})
            continue
        ch = str(r.get("hs2") or str(r["hs6"])[:2])
        chapter_share = chap_x[ch] / chap_w[ch] if chap_w[ch] else None
        bench = max(s for s in (chapter_share, overall_share) if s is not None) \
            if (chapter_share is not None or overall_share is not None) else None
        out.append({
            "hs6": r["hs6"],
            "export_potential_score": export_potential_score(p_logw[i], rca_v, p_wcagr[i], p_xcagr[i]),
            "untapped_potential_usd": untapped_potential(x, w, rca_v, bench),
            "import_dependency_score": import_dependency_score(dep, p_logm[i], r.get("india_import_hhi")),
            "vulnerability_score": vulnerability_score(dep, r.get("india_import_hhi"),
                                                       r.get("china_import_share"), p_logm[i]),
            "substitution_score": substitution_score(m, x, p_logm[i], rca_v, r.get("world_supplier_hhi")),
            "archetype": arche,
            "dependency_ratio": dep,
            "benchmark_share": bench,
        })
    return out


# --------------------------------------------------------------------------- k-means clusters

def kmeans_feature_row(record: Mapping[str, Any]) -> list[float]:
    """``[log1p X, log1p M, log1p W, min(RCA, 5), clip(world_cagr, +-0.5), clip(export_cagr, +-0.5)]``."""
    def clip(v: Any) -> float:
        n = _num(v)
        return 0.0 if n is None else max(-KMEANS_CAGR_CLIP, min(KMEANS_CAGR_CLIP, n))

    r = _num(record.get("rca"))
    return [math.log1p(max(0.0, _num(record.get("india_exports")) or 0.0)),
            math.log1p(max(0.0, _num(record.get("india_imports")) or 0.0)),
            math.log1p(max(0.0, _num(record.get("world_trade")) or 0.0)),
            0.0 if r is None else max(0.0, min(KMEANS_RCA_CAP, r)),
            clip(record.get("world_cagr")),
            clip(record.get("export_cagr"))]


def cluster_products(records: Sequence[Mapping[str, Any]], k: int = KMEANS_K) -> dict:
    """k-means (``k`` = 6, ``random_state`` = 42, ``n_init`` = 10) on standardised features (SPEC section 4).

    Returns ``{"labels": {hs6: cluster_id}, "clusters": [{id, n, centroid: {feature: mean}, z: {feature: z},
    label}]}`` for the records with world trade > 0. Cluster ids are renumbered by descending mean
    ``log1p_x``. With fewer records than ``k`` every record is its own cluster.
    """
    from sklearn.cluster import KMeans
    from sklearn.preprocessing import StandardScaler

    rows = [r for r in records if (_num(r.get("world_trade")) or 0) > 0]
    if not rows:
        return {"labels": {}, "clusters": []}
    feats = np.array([kmeans_feature_row(r) for r in rows], dtype=float)
    k_eff = max(1, min(k, len(rows)))
    scaled = StandardScaler().fit_transform(feats)
    model = KMeans(n_clusters=k_eff, random_state=KMEANS_RANDOM_STATE, n_init=KMEANS_N_INIT)
    raw = model.fit_predict(scaled)
    # stable ids: descending mean log1p(exports)
    order = sorted(range(k_eff), key=lambda c: (-float(feats[raw == c, 0].mean()), c))
    remap = {old: new for new, old in enumerate(order)}
    labels = np.array([remap[int(c)] for c in raw])
    mean, std = feats.mean(axis=0), feats.std(axis=0)
    std[std == 0] = 1.0
    clusters = []
    for cid in range(k_eff):
        members = feats[labels == cid]
        centroid = members.mean(axis=0)
        z = (centroid - mean) / std
        clusters.append({
            "id": cid, "n": int(len(members)),
            "centroid": {f: round(float(v), 4) for f, v in zip(KMEANS_FEATURES, centroid)},
            "z": {f: round(float(v), 3) for f, v in zip(KMEANS_FEATURES, z)},
        })
    for c in clusters:
        c["label"] = cluster_label(c["centroid"], c["z"])
    seen: Counter = Counter()
    for c in clusters:  # make labels unique
        seen[c["label"]] += 1
        if seen[c["label"]] > 1:
            c["label"] = f"{c['label']} ({c['id']})"
    return {"labels": {r["hs6"]: int(c) for r, c in zip(rows, labels)}, "clusters": clusters}


_PHRASES = {  # feature -> (phrase when z > 0, phrase when z < 0)
    "log1p_x": ("high India exports", "little or no India exports"),
    "log1p_m": ("high India imports", "low India imports"),
    "log1p_w": ("large world market", "small world market"),
    "rca_capped": ("strong comparative advantage", "weak comparative advantage"),
    "world_cagr": ("growing world demand", "shrinking world demand"),
    "export_cagr": ("fast-growing India exports", "falling India exports"),
}


def cluster_label(centroid: Mapping[str, float], z: Mapping[str, float], n_phrases: int = 3) -> str:
    """Readable label from the centroid's most distinctive features (largest |z| first), e.g.
    ``"Strong comparative advantage, high India exports, large world market"``."""
    ranked = sorted(((abs(float(z.get(f, 0.0))), f) for f in KMEANS_FEATURES), reverse=True)
    phrases = []
    for score, feature in ranked:
        if len(phrases) >= n_phrases or (phrases and score < 0.25):
            break
        pos, neg = _PHRASES[feature]
        phrases.append(pos if float(z.get(feature, 0.0)) > 0 else neg)
    if not phrases:
        return "Average profile"
    # "little or no India exports" + "fast-growing India exports" reads as a contradiction: it is growth
    # from a small base, so say that once.
    small, fast = _PHRASES["log1p_x"][1], _PHRASES["export_cagr"][0]
    if small in phrases and fast in phrases:
        phrases[phrases.index(small)] = "fast-growing India exports from a small base"
        phrases.remove(fast)
    text = ", ".join(phrases)
    return text[0].upper() + text[1:]


# --------------------------------------------------------------------------- alerts

def usd_text(value: float | None) -> str:
    """``$3.11 bn`` / ``$812.4 mn`` / ``$45 k`` / ``$92`` (alert texts)."""
    v = _num(value)
    if v is None:
        return "n/a"
    a = abs(v)
    if a >= 1e9:
        return f"${v / 1e9:,.2f} bn"
    if a >= 1e6:
        return f"${v / 1e6:,.1f} mn"
    if a >= 1e3:
        return f"${v / 1e3:,.0f} k"
    return f"${v:,.0f}"


def _short(text: str | None, limit: int = 70) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[: limit - 3].rstrip(" ,;") + "..."


def growth_text(rate: float) -> str:
    """``+134%`` / ``-45%``; growth above +999% is shown as a multiple (``x303,886``) to stay readable."""
    if rate >= 9.99:
        ratio = rate + 1.0
        return f"x{ratio:,.1f}" if ratio < 100 else f"x{ratio:,.0f}"
    return f"{rate:+.0%}"


def detect_alerts(records: Sequence[Mapping[str, Any]], created_at: str) -> list[dict]:
    """Automated alerts per SPEC section 4 for HS6 records.

    Each record needs ``hs6``, ``description``, ``india_imports``, ``india_exports``, ``import_yoy``,
    ``export_yoy``, ``exports_2023``, ``imports_2023``, ``india_import_hhi``, ``china_import_share``,
    ``top_import_source_name``, ``top_import_source_share``. Returns alert dicts (without ``id``) ordered by
    severity (high first), then kind, then |value| descending.
    """
    out: list[dict] = []
    for r in records:
        hs6, desc = r["hs6"], _short(r.get("description"))
        m = _num(r.get("india_imports")) or 0.0
        imp_yoy, exp_yoy = _num(r.get("import_yoy")), _num(r.get("export_yoy"))
        x23, m23 = _num(r.get("exports_2023")) or 0.0, _num(r.get("imports_2023"))
        hhi_m, china = _num(r.get("india_import_hhi")), _num(r.get("china_import_share"))
        src, src_share = r.get("top_import_source_name"), _num(r.get("top_import_source_share"))
        src_text = f" Top source: {src} ({src_share:.0%})." if src and src_share is not None else ""
        # the 2023 base floor keeps near-zero bases (x300,000 'surges' on a first shipment) out of the feed
        if imp_yoy is not None and imp_yoy >= 0.5 and m >= 20e6 and (m23 or 0.0) >= SURGE_MIN_BASE:
            out.append({"kind": "import_surge", "hs6": hs6, "severity": "high" if imp_yoy >= 1.0 else "medium",
                        "title": f"Import surge ({growth_text(imp_yoy)}): {desc}",
                        "detail": (f"India's imports rose from {usd_text(m23)} in {LATEST_YEAR - 1} to "
                                   f"{usd_text(m)} in {LATEST_YEAR} ({growth_text(imp_yoy)}).{src_text}"),
                        "value": imp_yoy, "created_at": created_at})
        if exp_yoy is not None and exp_yoy <= -0.3 and x23 >= 20e6:
            x = _num(r.get("india_exports")) or 0.0
            out.append({"kind": "export_drop", "hs6": hs6, "severity": "high" if exp_yoy <= -0.5 else "medium",
                        "title": f"Export drop ({growth_text(exp_yoy)}): {desc}",
                        "detail": (f"India's exports fell from {usd_text(x23)} in {LATEST_YEAR - 1} to "
                                   f"{usd_text(x)} in {LATEST_YEAR} ({growth_text(exp_yoy)})."),
                        "value": exp_yoy, "created_at": created_at})
        if hhi_m is not None and hhi_m >= 0.6 and m >= 50e6:
            out.append({"kind": "concentration", "hs6": hs6, "severity": "medium",
                        "title": f"Concentrated sourcing (HHI {hhi_m:.2f}): {desc}",
                        "detail": (f"India's {usd_text(m)} of imports come from very few countries "
                                   f"(import HHI {hhi_m:.2f}).{src_text}"),
                        "value": hhi_m, "created_at": created_at})
        if china is not None and china >= 0.6 and m >= 50e6:
            out.append({"kind": "china_dependence", "hs6": hs6, "severity": "high" if china >= 0.8 else "medium",
                        "title": f"China dependence ({china:.0%}): {desc}",
                        "detail": (f"China supplies {china:.0%} of India's {usd_text(m)} of imports "
                                   f"in {LATEST_YEAR}."),
                        "value": china, "created_at": created_at})
    kind_order = {k: i for i, k in enumerate(ALERT_RULES)}
    out.sort(key=lambda a: (SEVERITY_ORDER[a["severity"]], kind_order[a["kind"]], -abs(a["value"] or 0), a["hs6"]))
    return out


# =========================================================================== cached HS6 analytics frame

_CACHE_LOCK = threading.Lock()
_CACHE: dict[tuple, Any] = {}
_BUILD_LOCKS: dict[tuple, threading.Lock] = {}
_CACHE_MAX = 128


def _db_file(conn: sqlite3.Connection) -> str:
    try:
        for r in conn.execute("PRAGMA database_list"):
            values = list(r.values()) if isinstance(r, dict) else list(r)
            if values[1] == "main":
                return str(values[2] or "")
    except sqlite3.Error:
        pass
    return ""


def _scalar(conn: sqlite3.Connection, sql: str, params: Sequence = ()) -> Any:
    try:
        r = conn.execute(sql, params).fetchone()
    except sqlite3.Error:
        return None
    if r is None:
        return None
    return next(iter(r.values())) if isinstance(r, dict) else r[0]


def data_fingerprint(conn: sqlite3.Connection) -> tuple:
    """Cheap key that changes whenever the analysed data can have changed (used by every cache here).

    = (database file, ``meta.built_at``, ``meta.scores_built_at``, latest ``mapping_changes`` id / count,
    latest successful connector refresh, count / latest time of *applied* Data Hub uploads - production figures
    and value-chain edges land through them without a mapping change).
    """
    return (
        _db_file(conn),
        _scalar(conn, "SELECT value FROM meta WHERE key = 'built_at'"),
        _scalar(conn, "SELECT value FROM meta WHERE key = 'scores_built_at'"),
        _scalar(conn, "SELECT COUNT(*) || ':' || COALESCE(MAX(id), 0) FROM mapping_changes"),
        _scalar(conn, "SELECT MAX(finished_at) FROM refresh_jobs WHERE status = 'success'"),
        _scalar(conn, "SELECT COUNT(*) || ':' || COALESCE(MAX(applied_at), '') FROM uploads WHERE status = 'applied'"),
    )


# --------------------------------------------------------------------------- primary commodities (substitution)

#: HS prefixes of primary commodities that domestic *manufacturing* cannot substitute: ores (26), coal / crude
#: oil / natural gas (2701-2703, 2709, 2711), unworked diamonds and precious stones (7102 10/21/31, 7103 10),
#: precious metals and their waste (7106-7112) and unwrought base metals (copper 7401-7403, nickel 7501-7502,
#: aluminium 7601, lead 7801, zinc 7901, tin 8001). The import-substitution ranking leaves them out by default
#: (``include_primary=true`` shows them); docs/METHODOLOGY.md section 4.5 states the limitation.
PRIMARY_GOODS_PREFIXES: tuple[str, ...] = (
    "26", "2701", "2702", "2703", "2709", "2711",
    "710210", "710221", "710231", "710310",
    "7106", "7107", "7108", "7109", "7110", "7111", "7112",
    "7401", "7402", "7403", "7501", "7502", "7601", "7801", "7901", "8001",
)


def is_primary_good(hs6: str | None) -> bool:
    """True when ``hs6`` is a primary commodity (ore, fuel, unworked stone, precious or unwrought metal)."""
    code = str(hs6 or "")
    return bool(code) and code.startswith(PRIMARY_GOODS_PREFIXES)


def cached(conn: sqlite3.Connection, name: str, builder, *args) -> Any:
    """Memoise ``builder(conn, *args)`` under ``(name, args, data_fingerprint(conn))`` (thread-safe, bounded).

    Eviction is least-recently-used (the shared analytics frame, used by almost every request, stays).
    Single-flight: concurrent requests for the same key (a dashboard firing several analytics calls at once)
    wait for the one build in progress instead of each building the object. Builders may call ``cached`` for
    other keys (e.g. a chain detail needs the analytics frame). Callers must treat the returned object as
    read-only (copy before mutating).
    """
    key = (name, args, data_fingerprint(conn))
    with _CACHE_LOCK:
        if key in _CACHE:
            _CACHE[key] = value = _CACHE.pop(key)  # least-recently-used order: a hit moves to the end
            return value
        build_lock = _BUILD_LOCKS.setdefault(key, threading.Lock())
    try:
        with build_lock:
            with _CACHE_LOCK:
                if key in _CACHE:
                    return _CACHE[key]
            value = builder(conn, *args)
            with _CACHE_LOCK:
                if len(_CACHE) >= _CACHE_MAX:
                    for old in list(_CACHE)[: _CACHE_MAX // 4]:
                        _CACHE.pop(old, None)
                _CACHE[key] = value
            return value
    finally:
        with _CACHE_LOCK:
            if key in _CACHE or not build_lock.locked():
                _BUILD_LOCKS.pop(key, None)


def clear_cache() -> None:
    """Drop every cached object (tests / after an in-place recompute in the same process)."""
    with _CACHE_LOCK:
        _CACHE.clear()


def _dict_rows(conn: sqlite3.Connection, sql: str, params: Sequence = ()) -> list[dict]:
    """Rows as dicts whatever the connection's ``row_factory`` (tuple cursor + zip: faster than a dict factory)."""
    cur = conn.cursor()
    cur.row_factory = None
    cur.execute(sql, params)
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def cluster_stats(rows: Sequence[Mapping[str, Any]]) -> dict[int, dict]:
    """``{cluster_id: {id, n_total, centroid, z, label}}`` of the stored ``ml_cluster`` ids over ``rows``.

    Centroids are the members' mean k-means features (feature units), ``z`` their distance from the mean of
    all clustered products in standard deviations; labels as :func:`cluster_label`, made unique.
    """
    members = [(int(r["ml_cluster"]), kmeans_feature_row(r)) for r in rows if r.get("ml_cluster") is not None]
    if not members:
        return {}
    ids = np.array([cid for cid, _ in members], dtype=int)
    feats = np.array([f for _, f in members], dtype=float)
    mean, std = feats.mean(axis=0), feats.std(axis=0)
    std[std == 0] = 1.0
    out: dict[int, dict] = {}
    for cid in sorted(set(ids.tolist())):
        centroid = feats[ids == cid].mean(axis=0)
        z = (centroid - mean) / std
        out[cid] = {"id": cid, "n_total": int((ids == cid).sum()),
                    "centroid": {f: round(float(v), 4) for f, v in zip(KMEANS_FEATURES, centroid)},
                    "z": {f: round(float(v), 3) for f, v in zip(KMEANS_FEATURES, z)}}
        out[cid]["label"] = cluster_label(out[cid]["centroid"], out[cid]["z"])
    seen: Counter = Counter()
    for cid in sorted(out):
        lab = out[cid]["label"]
        seen[lab] += 1
        if seen[lab] > 1:
            out[cid]["label"] = f"{lab} ({cid})"
    return out


class Frame:
    """In-memory HS6 analytics table (read-only). ``rows`` is a list of dicts sorted by hs6; ``by_hs6`` indexes
    it; ``hs6_sorted`` supports prefix lookups; ``totals`` holds India's total exports ``X`` and world ``W``.
    ``clusters_global`` (k-means cluster profiles over all products) is computed on first use - only the
    archetype endpoint needs it, so the shared frame builds faster."""

    def __init__(self, rows: list[dict], line_ministries: dict[str, set], line_sectors: dict[str, set],
                 totals: dict, scored: bool):
        self.rows = rows
        self.by_hs6 = {r["hs6"]: r for r in rows}
        self.hs6_sorted = [r["hs6"] for r in rows]
        self.line_ministries = line_ministries
        self.line_sectors = line_sectors
        self.totals = totals
        self.scored = scored
        self._clusters_global: dict | None = None
        self._clusters_lock = threading.Lock()

    @property
    def clusters_global(self) -> dict[int, dict]:
        """:func:`cluster_stats` over every frame row (lazy, computed once)."""
        if self._clusters_global is None:
            with self._clusters_lock:
                if self._clusters_global is None:
                    self._clusters_global = cluster_stats(self.rows) if self.scored else {}
        return self._clusters_global

    def under(self, prefix: str) -> list[str]:
        """HS6 codes of the frame under a 2/4/6-digit prefix (8 digits -> its HS6)."""
        import bisect
        code = "".join(ch for ch in str(prefix or "") if ch.isdigit())
        if not code:
            return []
        if len(code) >= 6:
            return [code[:6]] if code[:6] in self.by_hs6 else []
        lo = bisect.bisect_left(self.hs6_sorted, code)
        hi = bisect.bisect_left(self.hs6_sorted, code + "￿")
        return self.hs6_sorted[lo:hi]

    def resolve(self, code: str) -> tuple[list[str], str]:
        """HS6 codes carrying the trade of ``code`` and the level label.

        2/4/6/8-digit codes map to their HS6 set (``"hs6"`` for 6/8 digits, ``"hs4"`` / ``"hs2"`` otherwise).
        When a 6/8-digit code has no HS6 trade row but the source reports the whole heading under
        ``<hs4>00`` (CEPII/OEC does this for petroleum oils, 2710 -> 271000), that aggregate is used and the
        level is ``"hs4_aggregate"``.
        """
        code = "".join(ch for ch in str(code or "") if ch.isdigit())
        if len(code) >= 6:
            if code[:6] in self.by_hs6:
                return [code[:6]], "hs6"
            agg = code[:4] + "00"
            if agg in self.by_hs6:
                return [agg], "hs4_aggregate"
            return [], "hs6"
        level = {2: "hs2", 4: "hs4"}.get(len(code), f"hs{len(code)}")
        return self.under(code), level


def _build_frame(conn: sqlite3.Connection) -> Frame:
    rows = _dict_rows(conn, """
        SELECT m.*, hp.hs4 AS hs4, hp.hs2 AS hs2, hp.description AS hp_description, hp.sector_id AS hp_sector,
               n.description AS node_description,
               t.mfn_avg AS mfn_tariff,
               sc.export_potential_score, sc.untapped_potential_usd, sc.import_dependency_score,
               sc.vulnerability_score, sc.substitution_score, sc.archetype, sc.ml_cluster,
               c.name AS top_import_source_name, d.name AS top_destination_name
        FROM hs6_metrics m
        LEFT JOIN hs6_products hp ON hp.hs6 = m.hs6
        LEFT JOIN hs_nodes n ON n.code = m.hs6
        LEFT JOIN tariffs t ON t.hs6 = m.hs6
        LEFT JOIN hs6_scores sc ON sc.hs6 = m.hs6
        LEFT JOIN countries c ON c.id = m.top_import_source
        LEFT JOIN countries d ON d.id = m.top_destination
        ORDER BY m.hs6""")
    # most common ministry / sector among the HS6's lines (ties -> the owner of the lowest hsn8)
    line_rows = _dict_rows(conn, """
        SELECT p.hs6, p.ministry_id, p.sector_id, COUNT(*) AS n, MIN(p.hsn8) AS first_hsn8
        FROM products p GROUP BY p.hs6, p.ministry_id, p.sector_id""")
    best_ministry: dict[str, tuple] = {}
    best_sector: dict[str, tuple] = {}
    sample: dict[str, str] = {}
    line_ministries: dict[str, set] = defaultdict(set)
    line_sectors: dict[str, set] = defaultdict(set)
    min_counts: dict[tuple, list] = defaultdict(lambda: [0, "99999999"])
    sec_counts: dict[tuple, list] = defaultdict(lambda: [0, "99999999"])
    for r in line_rows:
        h = r["hs6"]
        line_ministries[h].add(r["ministry_id"])
        if r["sector_id"]:
            line_sectors[h].add(r["sector_id"])
        mc = min_counts[(h, r["ministry_id"])]
        mc[0] += r["n"]
        mc[1] = min(mc[1], r["first_hsn8"])
        if r["sector_id"]:
            scn = sec_counts[(h, r["sector_id"])]
            scn[0] += r["n"]
            scn[1] = min(scn[1], r["first_hsn8"])
        sample[h] = min(sample.get(h, "99999999"), r["first_hsn8"])
    for (h, mid), (n, first) in min_counts.items():
        cur = best_ministry.get(h)
        if cur is None or (n, -int(first)) > (cur[1], -int(cur[2])):
            best_ministry[h] = (mid, n, first)
    for (h, sid), (n, first) in sec_counts.items():
        cur = best_sector.get(h)
        if cur is None or (n, -int(first)) > (cur[1], -int(cur[2])):
            best_sector[h] = (sid, n, first)
    ministries = {r["id"]: r for r in _dict_rows(conn, "SELECT id, short_name, name, color FROM ministries")}
    sectors = {r["id"]: r for r in _dict_rows(conn, "SELECT id, name, color FROM sectors")}
    scored = False
    for r in rows:
        h = r["hs6"]
        r["hs4"] = r.get("hs4") or h[:4]
        r["hs2"] = r.get("hs2") or h[:2]
        r["description"] = r.pop("hp_description", None) or r.pop("node_description", None) or f"HS {h}"
        r.pop("node_description", None)
        mid = best_ministry.get(h, (None,))[0]
        sid = best_sector.get(h, (None,))[0] or r.pop("hp_sector", None)
        r.pop("hp_sector", None)
        r["ministry_id"] = mid
        r["ministry_short"] = ministries.get(mid, {}).get("short_name") if mid else None
        r["ministry_color"] = ministries.get(mid, {}).get("color") if mid else None
        r["sector_id"] = sid
        r["sector_name"] = sectors.get(sid, {}).get("name") if sid else None
        r["hsn8_sample"] = sample.get(h)
        r["dependency_ratio"] = dependency_ratio(r.get("india_imports"), r.get("india_exports"))
        if r.get("export_potential_score") is not None:
            scored = True
        if r["hs6"] not in line_sectors and r.get("sector_id"):
            line_sectors[h].add(r["sector_id"])
    totals = {
        "X": float(sum(r.get("india_exports") or 0.0 for r in rows)),
        "M": float(sum(r.get("india_imports") or 0.0 for r in rows)),
        "W": float(sum(r.get("world_trade") or 0.0 for r in rows)),
    }
    return Frame(rows, dict(line_ministries), dict(line_sectors), totals, scored)


def analytics_frame(conn: sqlite3.Connection) -> Frame:
    """The cached :class:`Frame` for the database behind ``conn``."""
    return cached(conn, "analytics_frame", _build_frame)


def aggregate(frame: Frame, hs6_list: Iterable[str]) -> dict:
    """Sums over distinct HS6 codes: ``{exports, imports, world_trade, rca, india_share, n_hs6,
    vulnerability_score (import-weighted mean), mfn_tariff (simple mean)}``; values None without data."""
    codes = [h for h in dict.fromkeys(hs6_list) if h in frame.by_hs6]
    if not codes:
        return {"exports": None, "imports": None, "world_trade": None, "rca": None, "india_share": None,
                "n_hs6": 0, "vulnerability_score": None, "mfn_tariff": None}
    rows = [frame.by_hs6[h] for h in codes]
    x = sum(_num(r.get("india_exports")) or 0.0 for r in rows)
    m = sum(_num(r.get("india_imports")) or 0.0 for r in rows)
    w = sum(_num(r.get("world_trade")) or 0.0 for r in rows)
    vw = [(r["vulnerability_score"], _num(r.get("india_imports")) or 0.0) for r in rows
          if r.get("vulnerability_score") is not None]
    vuln = None
    if vw:
        weight = sum(wt for _, wt in vw)
        vuln = (sum(v * wt for v, wt in vw) / weight) if weight > 0 else sum(v for v, _ in vw) / len(vw)
    tariffs = [r["mfn_tariff"] for r in rows if r.get("mfn_tariff") is not None]
    return {
        "exports": x, "imports": m, "world_trade": w,
        "rca": rca(x, frame.totals["X"], w, frame.totals["W"]),
        "india_share": (x / w) if w else None,
        "n_hs6": len(codes),
        "vulnerability_score": vuln,
        "mfn_tariff": (sum(tariffs) / len(tariffs)) if tariffs else None,
    }
