"""Connectors behind the product deep-dive: ``cluster_observatory``, ``market_tariffs`` and ``iilb``.

``cluster_observatory`` (source ``cluster_observatory``)
    Scrapes the cluster register of the Cluster Observatory (Foundation for MSME Clusters)::

        https://www.clusterobservatory.in/gl_sme.php?sid=<type>&page_num=<n>&qty=500

    ``sid`` 1 = industrial, 2 = handloom, 3 = handicraft (5 services and 6 micro-enterprise are published empty).
    Each row is ``Sr No | Cluster Name | State | Products | Cluster Profile`` (a diagnostic-study PDF or N/A).
    The Observatory's own search page (``clustermap/m1.php``) returns an error for every query, so the register
    pages are the only usable source. The Observatory publishes no HS codes: ``hs_prefixes_json`` comes from the
    curated label / name-keyword map in ``data/curated/deep_dive.json``.

``market_tariffs`` (source ``wits_markets``)
    Each destination market's own MFN applied tariff at HS6 from WITS / TRAINS (partner 000 = World). WITS has no
    India-specific rows for these reporters, so the duty an Indian exporter pays is computed in the deep-dive
    router as MFN (or the agreement rate) + the market's additional duty on Indian goods (``markets`` table).
    For each market the newest of the last four years that WITS publishes is used.

``iilb`` (source ``iilb``)
    India Industrial Land Bank. Default: the public Park Report (``/exploreParkReport``, no login) - every park with
    state, district, type, sector, total and available land - read with a headless browser that picks "All" entries,
    because the page loads its rows through its own encrypted request (the Atlas never calls or decrypts that
    endpoint). When ``ATLAS_IILB_ACCESS_TOKEN`` and ``ATLAS_IILB_STATE_LGCS`` are set it uses the IIS 2.0 web API
    instead (``/IIS_api/GetAllParkNo`` per state, ``hmac = sha256(accessToken + StateLGC)``), which adds coordinates
    and vacant plots.

Every connector writes a raw cache under ``data/raw`` so a database rebuild (``scripts/etl/load_deep_dive.py``)
keeps the last successful pull.
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

from app.services.connectors import base
from app.services.connectors.base import ConnectorError, ConnectorResult, Progress
from app.services.connectors.wits import parse_sdmx

BACKEND_DIR = Path(__file__).resolve().parents[3]
RAW_DIR = BACKEND_DIR / "data" / "raw"
CURATED_JSON = BACKEND_DIR / "data" / "curated" / "deep_dive.json"
CO_CACHE = RAW_DIR / "cluster_observatory.json"
MT_CACHE = RAW_DIR / "market_tariffs.json"
IILB_CACHE = RAW_DIR / "iilb_parks.json"

CO_URL = "https://www.clusterobservatory.in/gl_sme.php"
CO_BASE = "https://www.clusterobservatory.in/"
CO_TYPES = {1: "industrial", 2: "handloom", 3: "handicraft"}
CO_PAGE_SIZE = 500
CO_MAX_PAGES = 20
CO_MIN_ROWS = 1_000
_DISTRICT_SELECT_RE = re.compile(r'id="district"(.*?)</select>', re.S)
_OPTION_RE = re.compile(r"<option value=['\"]([^'\"]*)['\"]")

WITS_MARKET_URL = ("https://wits.worldbank.org/API/V1/SDMX/V21/datasource/TRN/reporter/{code}/partner/000/"
                   "product/all/year/{year}/datatype/reported")
IILB_URL = "https://indiaindustriallandbank.gov.in/IIS_api/GetAllParkNo"

_ROW_RE = re.compile(r'<div class="row" id="">(.*?)</div>\s*</div>', re.S)
_CELL_RE = re.compile(r'<div class="(srno1|cl_name|locationid|detail)">(.*?)</div>', re.S)
_HREF_RE = re.compile(r'href="([^"]+)"')
_TAG_RE = re.compile(r"<[^>]+>")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def count(conn: sqlite3.Connection, table: str) -> int:
    cur = conn.cursor()
    cur.row_factory = None
    return cur.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]  # noqa: S608 - fixed table names


def load_curated(path: Path = CURATED_JSON) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _text(fragment: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(_TAG_RE.sub("", fragment))).strip()


def slug(*parts: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", "_".join(p or "" for p in parts).lower()).strip("_")


# --------------------------------------------------------------------------- Cluster Observatory

def parse_cluster_page(page_html: str, cluster_type: str) -> list[dict]:
    """Rows of one register page -> ``[{name, cluster_type, state, products, profile_url}]``."""
    out = []
    for row_html in _ROW_RE.findall(page_html):
        cells = _CELL_RE.findall(row_html + "</div>")
        names = [v for k, v in cells if k == "cl_name"]
        locs = [v for k, v in cells if k == "locationid"]
        if not names or not _text(names[0]):
            continue
        href = _HREF_RE.search(row_html)
        out.append({
            "name": _text(names[0]),
            "cluster_type": cluster_type,
            "state": _text(locs[0]) if locs else None,
            "products": _text(locs[1]) if len(locs) > 1 else None,
            "profile_url": CO_BASE + html.unescape(href.group(1)) if href else None,
        })
    return out


def parse_district_options(page_html: str) -> list[str]:
    """District names from the register page's district filter (``<select id="district">``)."""
    m = _DISTRICT_SELECT_RE.search(page_html)
    if not m:
        return []
    return sorted({html.unescape(v).strip() for v in _OPTION_RE.findall(m.group(1))} - {""})


def infer_district(name: str, districts: list[str]) -> str | None:
    """A district named at the start of a cluster name ("Munger Gun" -> Munger); longest match wins."""
    low = name.lower()
    hits = [d for d in districts if low == d.lower() or low.startswith(d.lower() + " ")]
    return max(hits, key=len) if hits else None


def assign_districts(clusters: list[dict], found: dict[tuple, str], districts: list[str]) -> None:
    """Set ``district`` / ``district_source`` ('observatory' from the filter, 'name' when inferred, else None)."""
    for c in clusters:
        d = found.get((c["cluster_type"], c["name"], c.get("state")))
        src = "observatory" if d else None
        if not d:
            d = infer_district(c["name"], districts)
            src = "name" if d else None
        c["district"], c["district_source"] = d, src


def hs_prefixes(cluster: dict, product_map: dict) -> list[str]:
    """HS prefixes for a cluster from the curated label map, refined by name keywords."""
    labels = product_map.get("labels") or {}
    prefixes = list(labels.get((cluster.get("products") or "").strip(), []))
    name = (cluster.get("name") or "").lower()
    for keyword, codes in (product_map.get("name_keywords") or {}).items():
        if keyword in name:
            prefixes = codes + [p for p in prefixes if not any(c.startswith(p) for c in codes)]
    return prefixes


def cluster_rows(clusters: list[dict], curated: dict, fetched_at: str) -> list[tuple]:
    """``co_clusters`` rows (deduplicated on type + name + state)."""
    product_map = curated.get("cluster_products") or {}
    coords = curated.get("cluster_coordinates") or {}
    seen: dict[str, tuple] = {}
    for c in clusters:
        cid = slug(c["cluster_type"], c["name"], c.get("state") or "")
        latlon = coords.get(c["name"]) or [None, None]
        seen[cid] = (cid, c["name"], c["cluster_type"], c.get("state"), c.get("district"), c.get("district_source"),
                     c.get("products"), c.get("profile_url"), json.dumps(hs_prefixes(c, product_map)),
                     latlon[0], latlon[1], c.get("fetched_at") or fetched_at, "cluster_observatory")
    return list(seen.values())


def write_clusters(conn: sqlite3.Connection, rows: list[tuple]) -> None:
    conn.execute("DELETE FROM co_clusters WHERE source = 'cluster_observatory'")
    conn.executemany(
        "INSERT OR REPLACE INTO co_clusters (id, name, cluster_type, state, district, district_source, products, "
        "profile_url, hs_prefixes_json, lat, lon, fetched_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rows)


class ClusterObservatoryConnector:
    name = "cluster_observatory"
    source_id = "cluster_observatory"
    title = "Cluster Observatory - MSME cluster register"

    def is_configured(self) -> tuple[bool, str]:
        return True, "public website, no key required"

    @staticmethod
    def _get(params: dict, *, timeout: float = 90, tries: int = 3) -> str:
        return base.http_get(CO_URL, params, timeout=timeout, tries=tries, headers={"Accept": "text/html"}).text

    def fetch(self, progress: Progress = base.no_progress, previous: dict | None = None,
              budget_s: float | None = None) -> tuple[list[dict], dict]:
        """``(clusters, district_state)``: every cluster of the register, each with a district.

        The list pages carry no district; the register's district filter does, one query per district and type
        (about 1,400). The Observatory is a small site that slows to ~5 s per request under parallel load, so the
        district pass is **sequential and incremental**: it starts at ``previous["district_state"]["cursor"]``,
        stops after ``budget_s`` seconds (None = all districts) and keeps every district already known from the
        previous snapshot. Successive daily runs therefore re-check the whole register over a cycle of days; a
        cluster not yet confirmed gets its district from its name (``district_source = 'name'``).
        """
        out: list[dict] = []
        known = {(c["cluster_type"], c["name"], c.get("state")): c["district"]
                 for c in (previous or {}).get("clusters") or []
                 if c.get("district") and c.get("district_source") == "observatory"}
        queue: list[tuple[int, str, str]] = []
        all_districts: set[str] = set()
        for sid, ctype in CO_TYPES.items():
            for page in range(1, CO_MAX_PAGES + 1):
                progress(f"Cluster Observatory: {ctype} clusters, page {page}")
                rows = parse_cluster_page(self._get({"sid": sid, "page_num": page, "qty": CO_PAGE_SIZE}), ctype)
                out.extend(rows)
                if len(rows) < CO_PAGE_SIZE:
                    break
            districts = parse_district_options(self._get({"sid": sid, "f": 1}))   # the full page carries the filter
            all_districts.update(districts)
            queue += [(sid, ctype, d) for d in districts]
        state = dict((previous or {}).get("district_state") or {})
        cursor = int(state.get("cursor") or 0) % max(1, len(queue))
        deadline = None if budget_s is None else time.monotonic() + budget_s
        queried = failed = 0
        for step in range(len(queue)):
            if deadline is not None and time.monotonic() >= deadline:
                break
            sid, ctype, d = queue[(cursor + step) % len(queue)]
            if step % 50 == 0:
                progress(f"Cluster Observatory: district {step + 1} of {len(queue)} ({d})")
            try:
                text = self._get({"sid": sid, "district": d, "page_num": 1, "qty": CO_PAGE_SIZE}, timeout=20, tries=1)
            except ConnectorError:
                failed += 1
                continue
            finally:
                queried += 1
            known.update({(ctype, r["name"], r["state"]): d for r in parse_cluster_page(text, ctype)})
        new_cursor = (cursor + queried) % max(1, len(queue))
        assign_districts(out, known, sorted(all_districts))
        district_state = {"cursor": new_cursor, "total": len(queue), "queried": queried, "failed": failed,
                          "full_pass": queried >= len(queue)}
        return out, district_state

    def run(self, conn: sqlite3.Connection, progress: Progress) -> ConnectorResult:
        previous = json.loads(CO_CACHE.read_text(encoding="utf-8")) if CO_CACHE.exists() else None
        clusters, district_state = self.fetch(progress, previous)
        if len(clusters) < CO_MIN_ROWS:
            raise ConnectorError(f"Cluster Observatory returned only {len(clusters)} clusters - refusing to replace "
                                 f"the register with a possibly truncated pull (expected > {CO_MIN_ROWS})")
        fetched_at = now_iso()
        rows = cluster_rows(clusters, load_curated(), fetched_at)
        try:
            write_clusters(conn, rows)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        CO_CACHE.write_text(json.dumps({"fetched_at": fetched_at, "clusters": clusters,
                                        "district_state": district_state}, ensure_ascii=False), encoding="utf-8")
        mapped = sum(1 for r in rows if r[8] != "[]")
        with_district = sum(1 for r in rows if r[4])
        by_type = {t: sum(1 for r in rows if r[2] == t) for t in CO_TYPES.values()}
        return ConnectorResult(records=len(rows), source_records=len(rows),
                               message=(f"Loaded {len(rows)} clusters ({', '.join(f'{v} {k}' for k, v in by_type.items())}); "
                                        f"{mapped} mapped to HS codes; {with_district} with a district."),
                               details={"by_type": by_type, "mapped": mapped, "with_district": with_district})


# --------------------------------------------------------------------------- WITS market MFN tariffs

def market_tariff_rows(market_id: str, records: list[dict], year: int) -> list[tuple]:
    rows = []
    for rec in records:
        hs6 = str(rec.get("hs6") or "").strip()
        if not re.fullmatch(r"\d{6}", hs6):
            continue
        n_mfn = int(float(rec.get("NBR_MFN_LINES") or 0))
        n_na = int(float(rec.get("NBR_NA_LINES") or 0))
        non_adv = n_mfn == 0 and n_na > 0

        def num(v):
            try:
                return None if non_adv or v in (None, "") else float(v)
            except (TypeError, ValueError):
                return None
        rows.append((market_id, hs6, num(rec.get("value")), num(rec.get("MIN_RATE")), num(rec.get("MAX_RATE")),
                     year, "wits"))
    return rows


def write_market_tariffs(conn: sqlite3.Connection, market_id: str, rows: list[tuple]) -> None:
    conn.execute("DELETE FROM market_tariffs WHERE market_id = ?", (market_id,))
    conn.executemany("INSERT OR REPLACE INTO market_tariffs (market_id, hs6, mfn_avg, mfn_min, mfn_max, year, source) "
                     "VALUES (?, ?, ?, ?, ?, ?, ?)", rows)


class MarketTariffsConnector:
    name = "market_tariffs"
    source_id = "wits_markets"
    title = "WITS / UNCTAD TRAINS - destination-market MFN tariffs"
    min_rows = 3_000

    def is_configured(self) -> tuple[bool, str]:
        return True, "public API, no key required"

    def fetch_market(self, market: dict, progress: Progress) -> tuple[int, list[tuple]]:
        this_year = datetime.now(timezone.utc).year
        last_error: Exception | None = None
        for year in range(this_year - 1, this_year - 6, -1):
            progress(f"WITS: {market['name']} MFN {year}")
            try:
                payload = base.http_get_json(WITS_MARKET_URL.format(code=market["wits_code"], year=year),
                                             {"format": "JSON"}, timeout=300, tries=2)
            except ConnectorError as exc:   # 404 NoRecordsFound for a year not yet published
                last_error = exc
                continue
            rows = market_tariff_rows(market["id"], parse_sdmx(payload), year)
            if len(rows) >= self.min_rows:
                return year, rows
        raise ConnectorError(f"WITS has no complete MFN schedule for {market['name']} in the last five years "
                             f"({last_error})")

    def run(self, conn: sqlite3.Connection, progress: Progress) -> ConnectorResult:
        cur = conn.cursor()
        cur.row_factory = None
        markets = [{"id": i, "name": n, "wits_code": w}
                   for i, n, w in cur.execute("SELECT id, name, wits_code FROM markets ORDER BY sort_order")]
        if not markets:
            raise ConnectorError("no markets configured - run the load_deep_dive ETL step first")
        cache: dict[str, dict] = {}
        total, years, failed = 0, {}, []
        for m in markets:
            try:
                year, rows = self.fetch_market(m, progress)
            except ConnectorError as exc:
                failed.append(f"{m['name']}: {exc}")
                continue
            write_market_tariffs(conn, m["id"], rows)
            conn.commit()
            cache[m["id"]] = {"year": year, "rows": rows}
            total += len(rows)
            years[m["id"]] = year
        if not years:
            raise ConnectorError("; ".join(failed))
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        old = json.loads(MT_CACHE.read_text(encoding="utf-8")) if MT_CACHE.exists() else {}
        old.update({"fetched_at": now_iso(), **{k: v for k, v in cache.items()}})
        MT_CACHE.write_text(json.dumps(old), encoding="utf-8")
        n_after = count(conn, "market_tariffs")
        msg = f"Loaded {total} HS6 MFN rows for {len(years)} markets ({', '.join(f'{k} {v}' for k, v in years.items())})."
        if failed:
            msg += " Not refreshed: " + "; ".join(failed)
        return ConnectorResult(records=total, message=msg, source_records=n_after,
                               details={"years": years, "failed": failed})


# --------------------------------------------------------------------------- India Industrial Land Bank

def iilb_hmac(token: str, *parts: str) -> str:
    return hashlib.sha256((token + "".join(parts)).encode("utf-8")).hexdigest()


def _f(value) -> float | None:
    try:
        return None if value in (None, "") else float(value)
    except (TypeError, ValueError):
        return None


def park_row(state_lgc: str, park: dict, fetched_at: str) -> tuple | None:
    """Map one GetAllParkNo record to ``iilb_parks`` (field names per IIS API doc v2.3.5; unknown keys kept raw)."""
    get = lambda *keys: next((park.get(k) for k in keys if park.get(k) not in (None, "")), None)  # noqa: E731
    park_no = get("ParkNo", "park_no", "parkno", "gid", "id")
    if park_no is None:
        return None
    vacant = _f(get("vacant_plots", "VacantPlots", "no_of_vacant_plots"))
    return (str(park_no), state_lgc, get("ParkName", "park_name", "name"), get("StateName", "state_name", "state"),
            get("DistrictName", "dist_name", "district"), get("Sector", "sector", "park_sector"),
            _f(get("TotalArea", "total_area", "area_ha")), _f(get("AvailableArea", "available_area", "avail_area")),
            int(vacant) if vacant is not None else None, _f(get("lat", "Latitude", "latitude")),
            _f(get("lon", "long", "Longitude", "longitude")), json.dumps(park, ensure_ascii=False), fetched_at)


IILB_REPORT_URL = "https://indiaindustriallandbank.gov.in/exploreParkReport"
IILB_REPORT_COLUMNS = ("sr_no", "park_id", "user", "user_level", "state", "district", "park_name", "industrial_park_type",
                       "total_area_ha", "total_area_acres", "available_area_ha", "plug_and_play", "park_type", "sector",
                       "land_category", "upload_mode", "created", "updated")
IILB_MIN_PARKS = 1_000


def fetch_park_report(progress: Progress = base.no_progress, timeout_s: int = 180) -> list[dict]:
    """Every park of the public IILB Park Report (no login), read the way a visitor sees it.

    The report table loads its rows through the page's own encrypted request, so the Atlas does not call that
    endpoint itself: a headless Chromium (Playwright) opens the page, chooses "All" entries and reads the table.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:  # pragma: no cover - depends on the server
        raise ConnectorError("the IILB park report needs Playwright: pip install playwright && "
                             "python -m playwright install chromium") from exc
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        try:
            page = browser.new_page(user_agent=base.USER_AGENT)
            progress("IILB: opening the public park report")
            page.goto(IILB_REPORT_URL, wait_until="domcontentloaded", timeout=timeout_s * 1000)
            page.wait_for_selector("#selection tbody tr td", timeout=timeout_s * 1000)
            total = page.evaluate("() => (document.body.innerText.match(/Total Parks\\s*::\\s*([\\d,]+)/) || [])[1]")
            progress(f"IILB: showing all {total or ''} parks")
            page.select_option("select[name='selection_length']", "-1")
            page.wait_for_function(
                "() => { const i = document.querySelector('.dataTables_info'); const m = i && i.innerText.match(/to ([\\d,]+) of ([\\d,]+)/);"
                " return m && m[1] === m[2] && document.querySelectorAll('#selection tbody tr').length > 10; }",
                timeout=timeout_s * 1000)
            cells = page.evaluate("() => [...document.querySelectorAll('#selection tbody tr')]"
                                  ".map(r => [...r.cells].slice(0, 18).map(c => c.innerText.trim()))")
        finally:
            browser.close()
    return [dict(zip(IILB_REPORT_COLUMNS, row)) for row in cells if len(row) >= 18]


def report_park_row(park: dict, fetched_at: str) -> tuple | None:
    """``iilb_parks`` row from a Park Report record (``state_lgc`` = '' : the report gives state names, not codes)."""
    if not park.get("park_id"):
        return None
    return (str(park["park_id"]), "", park.get("park_name"), (park.get("state") or "").title() or None,
            park.get("district"), park.get("sector"), _f(park.get("total_area_ha")), _f(park.get("available_area_ha")),
            None, None, None, json.dumps(park, ensure_ascii=False), fetched_at)


def write_parks(conn: sqlite3.Connection, rows: list[tuple]) -> None:
    conn.execute("DELETE FROM iilb_parks")
    conn.executemany("INSERT OR REPLACE INTO iilb_parks (park_no, state_lgc, name, state, district, sector, total_area_ha, "
                     "available_area_ha, vacant_plots, lat, lon, raw_json, fetched_at) VALUES "
                     "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)


class IilbConnector:
    """Two modes: the public Park Report (default, needs Playwright) or the IIS 2.0 API when a token is set."""

    name = "iilb"
    source_id = "iilb"
    title = "India Industrial Land Bank"
    token_var = "ATLAS_IILB_ACCESS_TOKEN"
    states_var = "ATLAS_IILB_STATE_LGCS"

    def required_env(self) -> list[str]:
        return []

    def api_configured(self) -> bool:
        return all((os.environ.get(v) or "").strip() for v in (self.token_var, self.states_var))

    def is_configured(self) -> tuple[bool, str]:
        if self.api_configured():
            return True, "IIS 2.0 API access token present"
        try:
            import playwright  # noqa: F401
        except ImportError:
            return False, ("India Industrial Land Bank needs either Playwright (to read the public park report: "
                           "pip install playwright && python -m playwright install chromium) or an IIS 2.0 API token "
                           f"({self.token_var} and {self.states_var}).")
        return True, "public park report (headless browser)"

    def run(self, conn: sqlite3.Connection, progress: Progress) -> ConnectorResult:
        configured, message = self.is_configured()
        if not configured:
            return ConnectorResult(records=0, message=message, status="not_configured",
                                   source_status="not_configured")
        if self.api_configured():
            return self._run_api(conn, progress)
        fetched_at = now_iso()
        parks = fetch_park_report(progress)
        if len(parks) < IILB_MIN_PARKS:
            raise ConnectorError(f"IILB park report returned only {len(parks)} parks - refusing a possibly "
                                 f"truncated pull (expected > {IILB_MIN_PARKS})")
        rows = [r for r in (report_park_row(p, fetched_at) for p in parks) if r]
        try:
            write_parks(conn, rows)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        IILB_CACHE.write_text(json.dumps({"fetched_at": fetched_at, "source": "park_report", "parks": parks},
                                         ensure_ascii=False), encoding="utf-8")
        free = sum(r[7] or 0 for r in rows)
        return ConnectorResult(records=len(rows), source_records=len(rows),
                               message=f"Loaded {len(rows)} parks from the public park report "
                                       f"({free:,.0f} ha available).")

    def _run_api(self, conn: sqlite3.Connection, progress: Progress) -> ConnectorResult:
        token = os.environ[self.token_var].strip()
        states = [s.strip() for s in os.environ[self.states_var].split(",") if s.strip()]
        fetched_at, rows, raw = now_iso(), [], {}
        for lgc in states:
            progress(f"IILB: parks of state {lgc}")
            try:
                resp = requests.post(IILB_URL, json={"StateLGC": lgc, "agcy_code": None, "hmac": iilb_hmac(token, lgc)},
                                     headers={"User-Agent": base.USER_AGENT}, timeout=120)
                resp.raise_for_status()
                payload = resp.json()
            except (requests.RequestException, ValueError) as exc:
                raise ConnectorError(f"IILB GetAllParkNo failed for state {lgc}: {exc}") from exc
            parks = payload.get("data") if isinstance(payload, dict) else payload
            if isinstance(parks, dict):
                parks = [parks]
            raw[lgc] = payload
            rows += [r for r in (park_row(lgc, p, fetched_at) for p in parks or [] if isinstance(p, dict)) if r]
        write_parks(conn, rows)
        conn.commit()
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        IILB_CACHE.write_text(json.dumps({"fetched_at": fetched_at, "source": "api", "states": raw}, ensure_ascii=False),
                              encoding="utf-8")
        return ConnectorResult(records=len(rows), source_records=count(conn, "iilb_parks"),
                               message=f"Loaded {len(rows)} parks for {len(states)} state(s) from the IIS 2.0 API.")


# --------------------------------------------------------------------------- snapshots -> tables
# One snapshot shape per source (the raw caches in data/raw and the cloud-sync snapshots in Blob storage):
#   cluster_observatory  {"fetched_at", "clusters": [...]}
#   market_tariffs       {"fetched_at", "<market_id>": {"year", "rows": [[market_id, hs6, avg, min, max, year, src]]}}
#   iilb_parks           {"fetched_at", "source": "park_report", "parks": [...]} or {"source": "api", "states": {...}}

def apply_cluster_snapshot(conn: sqlite3.Connection, snap: dict, curated: dict | None = None) -> int:
    rows = cluster_rows(snap.get("clusters") or [], curated or load_curated(), snap.get("fetched_at") or now_iso())
    write_clusters(conn, rows)
    return len(rows)


def apply_tariff_snapshot(conn: sqlite3.Connection, snap: dict) -> int:
    n = 0
    for market_id, entry in snap.items():
        if isinstance(entry, dict) and "rows" in entry:
            write_market_tariffs(conn, market_id, [tuple(r) for r in entry["rows"]])
            n += len(entry["rows"])
    return n


def apply_iilb_snapshot(conn: sqlite3.Connection, snap: dict) -> int:
    fetched_at = snap.get("fetched_at") or now_iso()
    if snap.get("source") == "park_report":
        rows = [r for r in (report_park_row(p, fetched_at) for p in snap.get("parks") or []) if r]
    else:
        rows = []
        for lgc, payload in (snap.get("states") or {}).items():
            parks = payload.get("data") if isinstance(payload, dict) else payload
            parks = [parks] if isinstance(parks, dict) else parks or []
            rows += [r for r in (park_row(lgc, p, fetched_at) for p in parks if isinstance(p, dict)) if r]
    write_parks(conn, rows)
    return len(rows)


cluster_observatory = ClusterObservatoryConnector()
market_tariffs = MarketTariffsConnector()
iilb = IilbConnector()
CONNECTORS = (cluster_observatory, market_tariffs, iilb)
