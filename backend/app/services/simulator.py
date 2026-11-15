"""Tariff (BCD) scenario simulator with downstream cost propagation (docs/SPEC.md sections 4 and 6.7). Owner: C2.

For each simulated code with current tariff ``t0`` (WITS MFN applied simple average / 100) and new tariff
``t1``:

* imports respond with a constant price elasticity ``sigma`` (default 2.5), full pass-through of the tariff to
  the landed price: ``M1 = M0 * ((1 + t1) / (1 + t0)) ** (-sigma)``;
* customs revenue ``R = t * M`` (before: ``t0 * M0``, after: ``t1 * M1``);
* ``domestic_opportunity = -(M1 - M0) * substitution_share`` (default 0.5) - the part of the import change that
  domestic producers are assumed to capture (negative for a tariff cut);
* every product reachable downstream through ``vc_edges`` (``app.services.graph.downstream_paths``; an edge
  whose ``src`` is the code, a prefix of it or a line under it) sees an input cost change
  ``cost_increase_pct = input_cost_share * ((1 + t1) / (1 + t0) - 1) * 100`` at one hop (``input_cost_share``
  default 0.10). Decision: the trace continues up to ``downstream_depth`` hops (default 3) and at ``h`` hops
  the effect is scaled by ``input_cost_share ** h`` (each stage passes on only its input share), so the
  one-hop value is exactly the SPEC formula. ``via`` is the immediate input through which the cost arrives
  (the simulated code at one hop), ``path`` the whole chain of codes.

``M0`` is India's official FY2024-25 import value (DGCIS TRADESTAT) of the code's HS6; for an 8-digit line it is
the HS6 value apportioned by
``1 / lines_in_hs6`` (SPEC aggregation rule), and a 2/4-digit code is simulated HS6 by HS6. A code whose MFN
tariff is not ad valorem (or unknown) cannot be simulated unless ``base_tariff_pct`` is given: its row is
returned with null outcomes and a note. All outputs are model estimates; the response returns every assumption.
"""
from __future__ import annotations

import sqlite3
from collections.abc import Sequence

from app.services.scoring import analytics_frame

DEFAULT_ELASTICITY = 2.5
DEFAULT_SUBSTITUTION_SHARE = 0.5
DEFAULT_INPUT_COST_SHARE = 0.10
MAX_CODES = 50
MAX_RESULT_ROWS = 300
MAX_DOWNSTREAM = 200
FORMULA = ("M1 = M0 * ((1 + t1) / (1 + t0))^(-elasticity); revenue = t * M; "
           "domestic_opportunity = -(M1 - M0) * substitution_share; "
           "downstream cost_increase_pct = input_cost_share^hops * ((1 + t1) / (1 + t0) - 1) * 100")


def imports_after(m0: float, t0: float, t1: float, elasticity: float = DEFAULT_ELASTICITY) -> float:
    """Constant-elasticity import response: ``M0 * ((1 + t1) / (1 + t0)) ** (-elasticity)`` (rates as fractions)."""
    return m0 * ((1.0 + t1) / (1.0 + t0)) ** (-elasticity)


def price_ratio(t0: float, t1: float) -> float:
    """Landed-price ratio ``(1 + t1) / (1 + t0)``."""
    return (1.0 + t1) / (1.0 + t0)


def cost_increase_pct(t0: float, t1: float, input_cost_share: float = DEFAULT_INPUT_COST_SHARE,
                      hops: int = 1) -> float:
    """Downstream input-cost change in percent: ``input_cost_share ** hops * (ratio - 1) * 100``."""
    return (input_cost_share ** max(1, hops)) * (price_ratio(t0, t1) - 1.0) * 100.0


def simulate_row(m0: float | None, t0_pct: float | None, t1_pct: float, elasticity: float,
                 substitution_share: float) -> dict:
    """One result row's outcome fields (``tariff_*`` in percent, money in US$); nulls when not computable."""
    out = {"tariff_before": t0_pct, "tariff_after": t1_pct, "imports_before": m0, "imports_after": None,
           "delta_imports": None, "revenue_before": None, "revenue_after": None, "domestic_opportunity_usd": None}
    if m0 is None or t0_pct is None:
        return out
    t0, t1 = t0_pct / 100.0, t1_pct / 100.0
    m1 = imports_after(m0, t0, t1, elasticity)
    delta = m1 - m0
    out.update({"imports_after": m1, "delta_imports": delta + 0.0, "revenue_before": t0 * m0,
                "revenue_after": t1 * m1, "domestic_opportunity_usd": -delta * substitution_share + 0.0})
    return out


def _digits(code: str) -> str:
    return "".join(ch for ch in str(code or "") if ch.isdigit())


def _line_info(conn: sqlite3.Connection, hsn8: str) -> dict | None:
    cur = conn.execute("""SELECT p.hsn8, p.hs6, p.description, p.lines_in_hs6,
                                 m.weight, m.metric_hs6, m.trade_level, t.mfn_avg AS mfn_exact
                          FROM products p
                          LEFT JOIN v_product_trade m ON m.hsn8 = p.hsn8
                          LEFT JOIN tariffs t ON t.hs6 = p.hs6
                          WHERE p.hsn8 = ?""", (hsn8,))
    r = cur.fetchone()
    if r is None:
        return None
    if not isinstance(r, dict):
        r = dict(zip([c[0] for c in cur.description], r))
    return r


def simulate(conn: sqlite3.Connection, codes: Sequence[str], new_tariff_pct: float, *,
             elasticity: float = DEFAULT_ELASTICITY, substitution_share: float = DEFAULT_SUBSTITUTION_SHARE,
             input_cost_share: float = DEFAULT_INPUT_COST_SHARE, base_tariff_pct: float | None = None,
             downstream_depth: int = 3) -> dict:
    """Run the scenario for ``codes`` (8/6/4/2-digit) -> the ``POST /api/policy/simulate-tariff`` body.

    Raises ``ValueError`` for an empty / oversized code list or a code that matches nothing.
    """
    from app.services.graph import downstream_paths

    clean = [c for c in dict.fromkeys(_digits(c) for c in codes) if c]
    if not clean:
        raise ValueError("codes must contain at least one HS code (2, 4, 6 or 8 digits)")
    if len(clean) > MAX_CODES:
        raise ValueError(f"at most {MAX_CODES} codes per simulation")
    frame = analytics_frame(conn)
    results: list[dict] = []
    unknown: list[str] = []
    ratios: dict[str, tuple[float, float]] = {}
    for code in clean:
        rows: list[tuple] = []  # (code, hs6, description, M0, t0 %, note, tariff source, share of HS6)
        if len(code) == 8:
            line = _line_info(conn, code)
            if line is None:
                unknown.append(code)
                continue
            hs6s, level = frame.resolve(code)
            rec = frame.by_hs6.get(hs6s[0]) if hs6s else None
            m_hs6 = rec.get("india_imports") if rec else None
            share = float(line.get("weight") or 0.0)
            m0 = None if m_hs6 is None or share <= 0 else m_hs6 * share
            t0 = base_tariff_pct if base_tariff_pct is not None else line.get("mfn_exact")
            src = "request" if base_tariff_pct is not None else "wits"
            note = None
            if level == "hs4_aggregate":
                note = (f"Trade reported only for heading aggregate {hs6s[0]}; the line gets an equal "
                        f"share of the heading (weight {share:.6f})")
            rows.append((code, line["hs6"], line["description"], m0, t0, note, src, share))
        elif len(code) in (2, 4, 6):
            hs6s = frame.resolve(code)[0] if len(code) == 6 else frame.under(code)
            if not hs6s:
                unknown.append(code)
                continue
            for h in hs6s:
                rec = frame.by_hs6[h]
                t0 = base_tariff_pct if base_tariff_pct is not None else rec.get("mfn_tariff")
                rows.append((code, h, rec["description"], rec.get("india_imports"), t0, None,
                             "request" if base_tariff_pct is not None else "wits", 1.0))
        else:
            unknown.append(code)
            continue
        for code_, hs6, desc, m0, t0, note, src, share in rows:
            row = {"code": code_, "hs6": hs6, "description": desc, "tariff_source": src,
                   "import_share_of_hs6": share}
            row.update(simulate_row(m0, t0, new_tariff_pct, elasticity, substitution_share))
            if t0 is None:
                note = (note + "; " if note else "") + ("Current tariff not ad valorem / not available - pass "
                                                        "base_tariff_pct to simulate")
            if m0 is None:
                note = (note + "; " if note else "") + "No 2024 import data"
            row["note"] = note
            results.append(row)
            if t0 is not None and code_ not in ratios:
                ratios[code_] = (t0 / 100.0, new_tariff_pct / 100.0)
    if unknown and not results:
        raise ValueError(f"unknown code(s): {', '.join(unknown)}")
    if len(results) > MAX_RESULT_ROWS:
        raise ValueError(f"the codes expand to {len(results)} HS6 rows; simulate at most {MAX_RESULT_ROWS}")

    def total(key: str) -> float | None:
        vals = [r[key] for r in results if r[key] is not None]
        return float(sum(vals)) if vals else None

    downstream: list[dict] = []
    seen: set[str] = set(clean)
    for code, (t0, t1) in ratios.items():
        for d in downstream_paths(conn, code, depth=downstream_depth):
            if d["code"] in seen:
                continue
            seen.add(d["code"])
            downstream.append({"code": d["code"], "via": d["path"][-2] if len(d["path"]) > 1 else code,
                               "path": " -> ".join(d["path"]), "hops": d["hops"], "from_code": code,
                               "cost_increase_pct": cost_increase_pct(t0, t1, input_cost_share, d["hops"]) + 0.0})
    downstream.sort(key=lambda d: (d["hops"], -abs(d["cost_increase_pct"]), d["code"]))
    downstream = downstream[:MAX_DOWNSTREAM]
    if downstream:
        from app.services.graph import _descriptions  # noqa: PLC0415 - shared private helper of the same owner
        desc = _descriptions(conn, [d["code"] for d in downstream])
        for d in downstream:
            d["description"] = desc.get(d["code"], {}).get("description") or f"HS {d['code']}"
    return {
        "results": results,
        "downstream": [{"code": d["code"], "description": d["description"], "via": d["via"], "path": d["path"],
                        "hops": d["hops"], "from_code": d["from_code"], "cost_increase_pct": d["cost_increase_pct"]}
                       for d in downstream],
        "totals": {k: total(k) for k in ("imports_before", "imports_after", "delta_imports", "revenue_before",
                                         "revenue_after", "domestic_opportunity_usd")},
        "assumptions": {"elasticity": elasticity, "substitution_share": substitution_share,
                        "input_cost_share": input_cost_share, "formula": FORMULA,
                        "new_tariff_pct": new_tariff_pct, "base_tariff_pct": base_tariff_pct,
                        "tariff_basis": "WITS MFN applied 2022 simple average of national lines; full pass-through "
                                        "to landed prices",
                        "import_basis": ("DGFT/DGCIS TRADESTAT FY2024-25 imports at HS6; an 8-digit line gets HS6 imports / "
                                         "lines_in_hs6, or an equal share of the heading aggregate when BACI "
                                         "reports the heading only (e.g. 2710 -> 271000)"),
                        "downstream_depth": downstream_depth,
                        "label": "Model estimate"},
        "unknown_codes": unknown,
    }
