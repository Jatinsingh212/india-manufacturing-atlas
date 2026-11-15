"""Two-year trade forecasts (docs/SPEC.md section 4 "forecast"; docs/METHODOLOGY.md). Owner: C2.

Method: ordinary least squares of ``ln(value)`` on the calendar year over the available years >= 2018 with
value > 0 (at least three points), extrapolated to 2025 and 2026. The 95 % band is ``+- 1.96 * sigma`` in log
space, with ``sigma`` the residual standard error ``sqrt(SSR / (n - 2))``; values are converted back to US$
(so the band is asymmetric around the point forecast). Fewer than three positive points -> no forecast
(empty list), never a made-up number. Every forecast is a *model estimate*.

``forecast_series`` works on one ``{year: value}`` series; ``forecast_set`` on an exports / imports pair (the
``hs6_scores.forecast_json`` shape ``{"exports": [...], "imports": [...]}``); ``series_for`` loads the summed
2018-2024 series of one or many HS6 codes from ``trade_hs6``.
"""
from __future__ import annotations

import math
import sqlite3
from collections.abc import Iterable, Mapping, Sequence

import numpy as np

FIRST_YEAR = 2018
LAST_YEAR = 2024
HORIZON = (2025, 2026)
MIN_POINTS = 3
Z_95 = 1.96
METHOD = ("Log-linear trend: OLS of ln(US$ value) on year over 2018-2024 (years with value > 0, at least 3 "
          "points), extrapolated to 2025-2026; 95% band = +-1.96 x residual standard error in log space. "
          "Model estimate - not an official projection.")


def fit_loglinear(years: Sequence[int], values: Sequence[float | None],
                  first_year: int = FIRST_YEAR) -> dict | None:
    """OLS fit of ``ln(v) = a + b (year - first_year)``; None with fewer than :data:`MIN_POINTS` points.

    Returns ``{intercept, slope, sigma, n, first_year, years}`` where ``slope`` is the log growth per year
    (``exp(slope) - 1`` = trend growth rate) and ``sigma`` the residual standard error (0 for a perfect fit).
    """
    pts = [(int(y), float(v)) for y, v in zip(years, values)
           if y is not None and y >= first_year and v is not None and not (isinstance(v, float) and math.isnan(v))
           and float(v) > 0]
    if len(pts) < MIN_POINTS:
        return None
    t = np.array([y - first_year for y, _ in pts], dtype=float)
    ly = np.log(np.array([v for _, v in pts], dtype=float))
    design = np.column_stack([np.ones_like(t), t])
    coef, *_ = np.linalg.lstsq(design, ly, rcond=None)
    resid = ly - design @ coef
    dof = len(pts) - 2
    sigma = float(math.sqrt(float(resid @ resid) / dof)) if dof > 0 else 0.0
    return {"intercept": float(coef[0]), "slope": float(coef[1]), "sigma": sigma, "n": len(pts),
            "first_year": first_year, "years": [y for y, _ in pts]}


def predict(fit: Mapping, year: int) -> dict:
    """Point forecast and 95 % band for ``year`` from :func:`fit_loglinear` output (US$)."""
    mu = fit["intercept"] + fit["slope"] * (year - fit["first_year"])
    band = Z_95 * fit["sigma"]
    return {"year": int(year), "value": float(math.exp(mu)), "lo": float(math.exp(mu - band)),
            "hi": float(math.exp(mu + band))}


def forecast_series(series: Mapping[int, float | None], horizon: Iterable[int] = HORIZON,
                    first_year: int = FIRST_YEAR) -> list[dict]:
    """``[{year, value, lo, hi}]`` for each horizon year, or ``[]`` when the series is too short."""
    years = sorted(series)
    fit = fit_loglinear(years, [series[y] for y in years], first_year)
    if fit is None:
        return []
    return [predict(fit, y) for y in horizon]


def forecast_set(exports: Mapping[int, float | None], imports: Mapping[int, float | None]) -> dict:
    """``{"exports": [...], "imports": [...]}`` (the ``hs6_scores.forecast_json`` shape)."""
    return {"exports": forecast_series(exports), "imports": forecast_series(imports)}


def trend_growth(series: Mapping[int, float | None]) -> float | None:
    """Fitted trend growth rate per year (``exp(slope) - 1``) or None."""
    years = sorted(series)
    fit = fit_loglinear(years, [series[y] for y in years])
    return None if fit is None else math.exp(fit["slope"]) - 1.0


def series_for(conn: sqlite3.Connection, hs6_list: Iterable[str]) -> list[dict]:
    """Yearly ``[{year, exports, imports, world_trade}]`` summed over distinct HS6 codes (``trade_hs6``)."""
    codes = list(dict.fromkeys(c for c in hs6_list if c))
    if not codes:
        return []
    import json
    cur = conn.execute(
        "SELECT year, SUM(india_exports), SUM(india_imports), SUM(world_trade) FROM trade_hs6 "
        "WHERE hs6 IN (SELECT value FROM json_each(?)) GROUP BY year ORDER BY year", (json.dumps(codes),))
    out = []
    for r in cur.fetchall():
        values = list(r.values()) if isinstance(r, dict) else list(r)
        out.append({"year": int(values[0]), "exports": values[1], "imports": values[2], "world_trade": values[3]})
    return out


def forecast_from_history(history: Sequence[Mapping]) -> dict:
    """Forecast set from a ``[{year, exports, imports}]`` history list."""
    return forecast_set({h["year"]: h.get("exports") for h in history},
                        {h["year"]: h.get("imports") for h in history})
