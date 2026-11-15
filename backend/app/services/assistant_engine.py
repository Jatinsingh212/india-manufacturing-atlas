"""AI assistant over the Atlas's own data (docs/SPEC.md section 6.14; AI/ML insights).

Two modes, one data layer
-------------------------
* :class:`AtlasTools` - the assistant's data functions. Each one runs SQL / ``app.common`` helpers (and the C1
  builders ``build_product_detail``, ``build_node_lookup``, ``build_entity_dashboard``) on the request's connection,
  returns a compact JSON-able payload and records **citations** (``{type, id, label, route}`` with ``type`` in
  ``product`` | ``ministry`` | ``sector`` | ``chain`` | ``hs6``) and the names of the tools used. Both modes call the
  same functions, so an offline answer and a Claude answer rest on identical numbers.

  ======================  ==================================================================================
  ``search_products``     product search (code prefix / full text / facets) -> lines with owner and trade
  ``get_product``         one 8-digit line: hierarchy, owner + mapping provenance, trade, tariff, partners,
                          production figures, model scores, value chains, schemes, alerts
  ``lookup_code``         any 2/4/6/8-digit code: an HS node with its children, owners and trade, or a line
  ``ministry_summary``    a ministry's KPIs, top exports / imports, dependency hotspots, opportunities
  ``sector_summary``      the same for a sector
  ``chain_summary``       a curated value chain: stages, items, anchor trade, India's supplier rank, real
                          figures, the most import-exposed inputs
  ``top_opportunities``   HS6 products ranked by export-potential score (model estimate)
  ``import_dependencies`` HS6 products ranked by vulnerability, or by imports from one country (e.g. China)
  ======================  ==================================================================================

* **Claude mode** (``ANTHROPIC_API_KEY`` set): :func:`chat_claude` runs a manual tool-use loop on the Messages API
  with model :data:`MODEL` (``claude-opus-5-5``; adaptive thinking is always on for this model, depth set with
  ``output_config.effort``), a frozen system prompt that grounds the model in the Atlas (data sources, provenance
  legend, honesty rules, the ministry / sector / chain catalogue) with prompt caching, the tools above, and
  server-side refusal fallback (``fallbacks="default"``, beta ``server-side-fallback-2026-07-01``). The loop is
  append-only, runs at most :data:`MAX_TOOL_ROUNDS` tool rounds (the last request sets ``tool_choice`` ``none``),
  handles ``pause_turn`` / ``refusal`` / ``max_tokens`` and returns tool errors as ``is_error`` results. Any API
  failure (bad key, rate limit, network, 5xx) falls back to the offline engine with a one-line notice, so the
  assistant always answers. Only the conversation and tool results go to the Anthropic API - nothing else
  leaves the server.
* **Offline mode** (no key): :func:`chat_offline` - deterministic intents that still give data-backed answers with
  citations: an HS code in the text -> product / node card; "which ministry ... <product>" -> ownership search
  (a compound question such as "which ministry handles X and how dependent is India on imports of it" keeps
  the product and adds the import dependence of the matching lines); "top exports / imports of <ministry |
  sector>"; "opportunities in <sector>"; "dependence on <country>" (China by default for "China dependence");
  "import dependence / vulnerability"; a metric question about a named product ("what is India's RCA in cotton
  T-shirts", "tariff on lithium-ion cells") -> the product card of the closest line (which prints RCA, trade,
  tariff and scores) - metric words are stripped from the product phrase before searching; "<chain> value
  chain"; a ministry or sector name -> its summary; otherwise a product search, else the help text.

:func:`chat(conn, messages)` dispatches on the configured key; :func:`status()` reports ``{mode, model}``.
"""
from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Callable

from app.common import (CHINA_ID, INDIA_ID, country_values, hs6_trade_totals, latest_year, normalize_code,
                        parse_json, prefix_hs6_list, search_products)
from app.config import get_settings
from app.db import in_json, json_param, row, rows
from app.routers.hsn import build_node_lookup, build_product_detail
from app.routers.ministries import build_entity_dashboard
from app.services.reports_pdf import fmt_qty, fmt_usd

log = logging.getLogger("atlas.assistant")

MODEL = "claude-opus-5-5"
EFFORT = "medium"
MAX_TOKENS = 16000
MAX_TOOL_ROUNDS = 6
FALLBACK_BETA = "server-side-fallback-2026-07-01"
TOOL_RESULT_MAX_CHARS = 16000
MAX_LIST = 25
TABLE_ROWS = 8
MODEL_NOTE = "model estimate (method: /about#methodology)"
TRADE_NOTE = ("India's exports and imports: DGFT/DGCIS TRADESTAT FY{year}-{fy_end}; world trade, RCA base and "
              "partner tables: CEPII BACI HS 2022 {year} via OEC, HS6 level")


def trade_note(year: int) -> str:
    return TRADE_NOTE.format(year=year, fy_end=str(year + 1)[-2:])
MAPPING_NOTE = ("Mapping: the DPIIT Guidebook on HSN Code Mapping (16.12.2025 revision) is applied directly; "
                "accepted lines are verified. Residual or Guidebook-unlisted lines have no accepted owner; "
                "2/4/6-digit ownership is aggregated from accepted 8-digit lines.")

# --------------------------------------------------------------------------- small formatting helpers


def usd(value: Any) -> str:
    return fmt_usd(value)


def pct(value: Any, decimals: int = 1) -> str:
    """Fraction -> ``"12.3%"``; None -> ``"Not available"``."""
    if value is None:
        return "Not available"
    try:
        return f"{float(value) * 100:.{decimals}f}%"
    except (TypeError, ValueError):
        return str(value)


def num(value: Any, decimals: int = 2) -> str:
    if value is None:
        return "Not available"
    try:
        return f"{float(value):.{decimals}f}"
    except (TypeError, ValueError):
        return str(value)


def code_label(code: str | None) -> str:
    """``40111010 -> 4011.10.10``, ``401110 -> 4011.10``."""
    code = code or ""
    if code.isdigit() and len(code) in (6, 8):
        return ".".join([code[:4], *(code[i:i + 2] for i in range(4, len(code), 2))])
    return code


def _cell(value: Any) -> str:
    text = "" if value is None else str(value)
    return text.replace("|", "/").replace("\n", " ").strip()


def md_table(headers: list[str], data: list[list[Any]]) -> str:
    """A GitHub-flavoured markdown table."""
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    lines += ["| " + " | ".join(_cell(v) for v in r) + " |" for r in data]
    return "\n".join(lines)


def _short(text: str | None, limit: int = 90) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "..."


# --------------------------------------------------------------------------- citations


ROUTES = {"product": "/product/{id}", "ministry": "/ministry/{id}", "sector": "/sector/{id}",
          "chain": "/value-chains/{id}", "hs6": "/explore?q={id}"}


@dataclass
class Trace:
    """Citations and tool names collected while answering."""

    citations: dict[tuple[str, str], dict] = field(default_factory=dict)
    tools_used: list[str] = field(default_factory=list)

    def cite(self, kind: str, ident: str | None, label: str | None) -> None:
        if not ident:
            return
        key = (kind, str(ident))
        if key not in self.citations:
            self.citations[key] = {"type": kind, "id": str(ident), "label": _short(label or str(ident), 80),
                                   "route": ROUTES[kind].format(id=ident)}

    def used(self, name: str) -> None:
        if name not in self.tools_used:
            self.tools_used.append(name)

    def citation_list(self, reply: str | None = None, limit: int = 15) -> list[dict]:
        """Citations, those whose id appears in ``reply`` first."""
        items = list(self.citations.values())
        if reply:
            text = reply.replace(".", "")
            items.sort(key=lambda c: 0 if c["id"] in text or c["label"][:20] in reply else 1)
        return items[:limit]


# --------------------------------------------------------------------------- entity resolution

_STOP = frozenset("""a an and are as at be by can do does for from has have how i in into is it its me my of on or
our please show tell that the their them there these this those to us was we what when where which who why will
with you your give list about""".split())
_GENERIC_NAME_WORDS = frozenset("""ministry department of and the for promotion industry industries internal trade new
public family welfare information technology micro small medium enterprise enterprises natural climate change
production product products residual unmapped civil distribution energy food farmer farmers waterway waterways
broadcasting animal husbandry affairs""".split())
MINISTRY_ALIASES = {
    "textile": "mot", "apparel": "mot", "garment": "mot", "handloom": "mot", "solar": "mnre", "renewable": "mnre",
    "electronic": "meity", "semiconductor": "meity", "pharma": "dop", "drug": "dop", "medicine": "dop",
    "chemical": "dcpc", "petrochemical": "dcpc", "fertiliser": "dofert", "fertilizer": "dofert", "steel": "mos",
    "coal": "mocoal", "mine": "mom", "mining": "mom", "mineral": "mom", "petroleum": "mopng", "telecom": "dot",
    "defence": "ddp", "railway": "mor", "aviation": "moca", "shipping": "mopsw", "fisheries": "dofish",
    "fish": "dofish", "dairy": "dahd", "agriculture": "dafw", "automobile": "mhi", "heavy": "mhi",
    "processing": "mofpi", "msme": "msme", "ayush": "ayush", "health": "mohfw", "atomic": "dae",
}
SECTOR_ALIASES = {
    "pharma": "pharma", "medicine": "pharma", "drug": "pharma", "auto": "automotive", "automotive": "automotive",
    "automobile": "automotive", "vehicle": "automotive", "tyre": "rubber_tyre", "tire": "rubber_tyre",
    "toy": "consumer_goods", "furniture": "consumer_goods", "chemical": "chemicals", "food": "food_processing",
    "jewellery": "gems_jewellery", "jewelry": "gems_jewellery", "gem": "gems_jewellery", "garment": "textiles",
    "apparel": "textiles", "textile": "textiles", "machinery": "engineering", "steel": "iron_steel",
    "electronic": "electronics", "electrical": "electronics", "plastic": "plastics", "fertiliser": "fertilizers",
    "fertilizer": "fertilizers", "leather": "leather", "footwear": "leather", "mineral": "minerals",
    "mining": "minerals", "petroleum": "energy", "coal": "energy", "energy": "energy", "agriculture": "agriculture",
    "defence": "defence", "medical": "instruments",
}
COUNTRY_ALIASES = {"usa": "United States", "us": None, "america": "United States", "uk": "United Kingdom",
                   "britain": "United Kingdom", "uae": "United Arab Emirates", "korea": "South Korea",
                   "russia": "Russia", "vietnam": "Vietnam"}
_WORD_RE = re.compile(r"[a-z][a-z&/'-]*")


def stem(word: str) -> str:
    """Light plural stemming for matching (``textiles -> textile``, ``batteries -> battery``)."""
    word = word.lower().strip("'-/&")
    if len(word) > 4 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def text_stems(text: str) -> list[str]:
    return [stem(w) for w in _WORD_RE.findall(text.lower())]


class Catalog:
    """Ministries, sectors, value chains and countries with name matching (loaded once per request)."""

    def __init__(self, conn: sqlite3.Connection):
        self.ministries = rows(conn, "SELECT id, short_name, name FROM ministries WHERE id <> 'residual' ORDER BY id")
        self.sectors = rows(conn, "SELECT id, name FROM sectors ORDER BY id")
        self.chains = rows(conn, "SELECT id, name, title, anchor_hs FROM value_chains ORDER BY sort_order, id")
        self._conn = conn
        self._countries: list[dict] | None = None
        self.m_by_id = {m["id"]: m for m in self.ministries}
        self.s_by_id = {s["id"]: s for s in self.sectors}
        self.c_by_id = {c["id"]: c for c in self.chains}
        self._m_words = self._unique_words({m["id"]: m["name"] for m in self.ministries})
        self._s_words = self._unique_words({s["id"]: s["name"] for s in self.sectors})

    @staticmethod
    def _unique_words(names: dict[str, str]) -> dict[str, str]:
        """``{stem: id}`` for name words that identify exactly one entity."""
        owners: dict[str, set[str]] = {}
        for ident, name in names.items():
            for w in text_stems(name):
                if w not in _GENERIC_NAME_WORDS and w not in _STOP and len(w) > 2:
                    owners.setdefault(w, set()).add(ident)
        return {w: next(iter(ids)) for w, ids in owners.items() if len(ids) == 1}

    def countries(self) -> list[dict]:
        if self._countries is None:
            self._countries = rows(self._conn, "SELECT id, name FROM countries WHERE id <> ? ORDER BY length(name) DESC",
                                   (INDIA_ID,))
        return self._countries

    # ---- ministries
    def ministry(self, text: str | None) -> dict | None:
        """Resolve an id, short name, full name or keyword to a ministry."""
        if not text:
            return None
        t = text.strip()
        low = t.lower()
        for m in self.ministries:
            if low in (m["id"], m["short_name"].lower(), m["name"].lower()):
                return m
        return self.find_ministry(t)

    def find_ministry(self, text: str) -> dict | None:
        """A ministry named anywhere in free text (short name, distinctive name word or alias)."""
        found = self.ministry_by_short_name(text)
        if found:
            return found
        words = text_stems(text)
        hits = Counter(self._m_words[w] for w in words if w in self._m_words)
        if hits:
            return self.m_by_id[hits.most_common(1)[0][0]]
        for w in words:
            if w in MINISTRY_ALIASES:
                return self.m_by_id.get(MINISTRY_ALIASES[w])
        return None

    def ministry_by_short_name(self, text: str) -> dict | None:
        """A ministry written by its short name or id (``MoT``, ``DPIIT``, ``meity``); short names of three
        letters must match case (``DoT``, not the word "dot")."""
        for m in self.ministries:
            short = m["short_name"]
            if len(short) >= 4:
                if re.search(rf"(?<![\w&/]){re.escape(short)}(?![\w&/])", text, re.IGNORECASE):
                    return m
            elif re.search(rf"(?<![\w&/]){re.escape(short)}(?![\w&/])", text):
                return m
            if len(m["id"]) >= 4 and re.search(rf"\b{re.escape(m['id'])}\b", text, re.IGNORECASE):
                return m
        return None

    # ---- sectors
    def sector(self, text: str | None) -> dict | None:
        if not text:
            return None
        low = text.strip().lower()
        for s in self.sectors:
            if low in (s["id"], s["name"].lower()):
                return s
        return self.find_sector(text)

    def find_sector(self, text: str) -> dict | None:
        words = text_stems(text)
        hits = Counter(self._s_words[w] for w in words if w in self._s_words)
        if hits:
            return self.s_by_id[hits.most_common(1)[0][0]]
        for w in words:
            if w in SECTOR_ALIASES:
                return self.s_by_id.get(SECTOR_ALIASES[w])
        return None

    # ---- chains
    def chain(self, text: str | None) -> dict | None:
        if not text:
            return None
        low = text.strip().lower()
        for c in self.chains:
            if low in (c["id"], c["name"].lower(), (c["title"] or "").lower()):
                return c
        return self.find_chain(text)

    def find_chain(self, text: str) -> dict | None:
        """The value chain whose name (or id words) appears in the text, preferring the longest name."""
        words = set(text_stems(text))
        best, best_score = None, 0.0
        for c in self.chains:
            name_words = [w for w in text_stems(c["name"]) if w not in _STOP and w not in ("ksm", "formulation")]
            id_words = [stem(w) for w in c["id"].split("_")]
            for candidate in (name_words, id_words):
                if not candidate:
                    continue
                hit = sum(1 for w in candidate if w in words)
                score = hit / len(candidate) + 0.01 * hit
                if hit and score > best_score and (hit == len(candidate) or hit >= 1 and len(candidate) <= 2):
                    best, best_score = c, score
        return best

    # ---- countries
    def country(self, text: str | None) -> dict | None:
        if not text:
            return None
        low = text.strip().lower()
        for c in self.countries():
            if low in (c["id"], c["name"].lower()):
                return c
        return self.find_country(text)

    def find_country(self, text: str) -> dict | None:
        low = text.lower()
        for alias, name in COUNTRY_ALIASES.items():
            if name and re.search(rf"\b{alias}\b", low):
                found = next((c for c in self.countries() if c["name"].lower() == name.lower()), None)
                if found:
                    return found
        for c in self.countries():  # longest names first ("South Korea" before "Korea")
            name = c["name"].lower()
            if len(name) >= 4 and re.search(rf"\b{re.escape(name)}\b", low):
                return c
        return None

    def prompt_block(self) -> str:
        """Compact catalogue text for the system prompt (stable per database build)."""
        ministries = "; ".join(f"{m['id']}={m['short_name']} ({m['name']})" for m in self.ministries)
        sectors = "; ".join(f"{s['id']}={s['name']}" for s in self.sectors)
        chains = "; ".join(f"{c['id']}={c['name']} (anchor HS {c['anchor_hs']})" for c in self.chains)
        return (f"Ministry ids: {ministries}; residual = unmapped lines.\nSector ids: {sectors}.\n"
                f"Value-chain ids: {chains}.\nCountry ids are OEC ids: China = {CHINA_ID}, India = {INDIA_ID}; "
                "other countries can be passed by name.")


# --------------------------------------------------------------------------- the data tools


class ToolInputError(ValueError):
    """A tool was called with unusable arguments (returned to Claude as an ``is_error`` tool result)."""


def _limit(value: Any, default: int = 10, maximum: int = MAX_LIST) -> int:
    try:
        n = int(value) if value is not None else default
    except (TypeError, ValueError) as exc:
        raise ToolInputError("limit must be an integer") from exc
    return max(1, min(maximum, n))


def _code_arg(value: Any, name: str = "code") -> str:
    code = normalize_code(value)
    if not code or not code.isdigit() or len(code) not in (2, 4, 6, 8):
        raise ToolInputError(f"{name} must be a 2, 4, 6 or 8-digit HS code, got {value!r}")
    return code


def _summary_row(p: dict) -> dict:
    return {"hsn8": p["hsn8"], "description": _short(p["description"], 140), "ministry_id": p["ministry_id"],
            # full name with the abbreviation, so no model has to guess what "MoT" stands for
            "ministry": (f"{p.get('ministry_name')} ({p.get('ministry_short')})" if p.get("ministry_name")
                         else p.get("ministry_short")),
            "sector": p.get("sector_name"),
            "mapping": f"{p['mapping_status']}/{p['mapping_source']}", "exports_usd": p.get("exports"),
            "imports_usd": p.get("imports"), "world_trade_usd": p.get("world_trade"), "rca": p.get("rca"),
            "tariff": p.get("bcd_display")}


class AtlasTools:
    """The assistant's data functions on one connection (see module docstring)."""

    def __init__(self, conn: sqlite3.Connection, trace: Trace | None = None):
        self.conn = conn
        self.trace = trace or Trace()
        self.catalog = Catalog(conn)
        self.year = latest_year(conn)

    # ---------------------------------------------------------------- helpers
    def _scope(self, ministry_id: str | None, sector_id: str | None, chapter: str | None,
               prefix: str | None) -> tuple[str, list, list[str]]:
        """WHERE fragment over an ``hs6`` column + params + human-readable scope labels."""
        where, params, labels = [], [], []
        if ministry_id:
            m = self.catalog.ministry(ministry_id)
            if not m:
                raise ToolInputError(f"unknown ministry {ministry_id!r} - use an id from the catalogue")
            where.append("x.hs6 IN (SELECT hs6 FROM products WHERE ministry_id = ?)")
            params.append(m["id"])
            labels.append(f"{m['short_name']}")
            self.trace.cite("ministry", m["id"], m["name"])
        if sector_id:
            s = self.catalog.sector(sector_id)
            if not s:
                raise ToolInputError(f"unknown sector {sector_id!r} - use an id from the catalogue")
            where.append("x.hs6 IN (SELECT hs6 FROM products WHERE sector_id = ?)")
            params.append(s["id"])
            labels.append(s["name"])
            self.trace.cite("sector", s["id"], s["name"])
        if chapter:
            ch = normalize_code(chapter).zfill(2)
            if not (ch.isdigit() and len(ch) == 2):
                raise ToolInputError("chapter must be a 2-digit HS chapter")
            where.append("substr(x.hs6, 1, 2) = ?")
            params.append(ch)
            labels.append(f"chapter {ch}")
        if prefix:
            code = _code_arg(prefix, "prefix")
            where.append("x.hs6 GLOB ?")
            params.append(code[:6] + "*")
            labels.append(f"HS {code_label(code)}")
        return (" AND ".join(where) or "1=1"), params, labels

    def _hs6_meta(self, hs6_list: list[str]) -> dict[str, dict]:
        """``{hs6: {description, hsn8, ministry_id, ministry}}`` (most common owner, lowest line)."""
        if not hs6_list:
            return {}
        data = rows(self.conn, f"""
            SELECT p.hs6, p.hsn8, p.ministry_id, mi.short_name, COALESCE(h.description, p.description) AS description
            FROM products p LEFT JOIN ministries mi ON mi.id = p.ministry_id LEFT JOIN hs6_products h ON h.hs6 = p.hs6
            WHERE {in_json('p.hs6')} ORDER BY p.hsn8""", (json_param(hs6_list),))
        out: dict[str, dict] = {}
        owners: dict[str, Counter] = {}
        for r in data:
            owners.setdefault(r["hs6"], Counter())[(r["ministry_id"], r["short_name"])] += 1
            out.setdefault(r["hs6"], {"hsn8": r["hsn8"], "description": r["description"]})
        for hs6, counter in owners.items():
            (mid, short), _n = counter.most_common(1)[0]
            out[hs6].update({"ministry_id": mid, "ministry": short})
        return out

    def _cite_hs6(self, hs6: str, meta: dict) -> None:
        if meta.get("hsn8"):
            self.trace.cite("product", meta["hsn8"], f"{code_label(meta['hsn8'])} {meta.get('description') or ''}")
        else:
            self.trace.cite("hs6", hs6, f"HS {code_label(hs6)} {meta.get('description') or ''}")

    # ---------------------------------------------------------------- tools
    def _closest_strict(self, query: str, **facets: Any) -> tuple[str, dict] | None:
        """When no line contains every word of ``query``, the best one-word-shorter query that has strict matches.

        The search falls back to an any-word match when no description holds all the words (e.g. HS writes
        "electric accumulators; lithium-ion", so "lithium-ion batteries" matches no line strictly and the loose
        match ranks primary lithium cells first). Dropping one word at a time - the last word first, hyphenated
        compounds such as "lithium-ion" always kept - and keeping the first variant with an all-words match gives
        the user the lines that are actually about the product.
        """
        units = query.split()
        if not 2 <= len(units) <= 6:
            return None
        for i in reversed(range(len(units))):
            if "-" in units[i]:
                continue
            sub = " ".join(units[:i] + units[i + 1:])
            result = search_products(self.conn, q=sub, page_size=100, **facets)
            if result["total"] and result.get("match") in ("text", "text_all_columns"):
                return sub, result
        return None

    def search_products(self, query: str | None = None, ministry_id: str | None = None,
                        sector_id: str | None = None, sort: str = "relevance", limit: int = 10) -> dict:
        self.trace.used("search_products")
        limit = _limit(limit, 10)
        if sort not in ("relevance", "exports", "imports", "rca", "code", "world_trade"):
            raise ToolInputError("sort must be relevance, exports, imports, rca, code or world_trade")
        m = self.catalog.ministry(ministry_id) if ministry_id else None
        s = self.catalog.sector(sector_id) if sector_id else None
        if ministry_id and not m:
            raise ToolInputError(f"unknown ministry {ministry_id!r}")
        if sector_id and not s:
            raise ToolInputError(f"unknown sector {sector_id!r}")
        facets = {"ministry_id": m["id"] if m else None, "sector_id": s["id"] if s else None, "sort": sort}
        query = " ".join((query or "").split()) or None
        try:
            result = search_products(self.conn, q=query, page_size=max(limit, 100), **facets)
            relaxed = None
            if query and result.get("match") == "text_any":
                closest = self._closest_strict(query, **facets)
                if closest:
                    relaxed, result = closest
        except ValueError as exc:
            raise ToolInputError(str(exc)) from exc
        items = result["items"]
        # owner split over the returned (best-ranked) rows, so the statement matches the table the user sees
        voters = items[:limit]
        owners = Counter((p["ministry_id"], p.get("ministry_short")) for p in voters)
        for p in items[:limit]:
            self.trace.cite("product", p["hsn8"], f"{code_label(p['hsn8'])} {p['description']}")
        return {"query": query, "relaxed_query": relaxed, "total_matches": result["total"],
                "match": result.get("match"), "owners_considered": len(voters),
                "owners_among_top_matches": [{"ministry_id": mid, "ministry": short, "lines": n}
                                             for (mid, short), n in owners.most_common(6)],
                "items": [_summary_row(p) for p in items[:limit]],
                "provenance": f"Trade: {trade_note(self.year)}. {MAPPING_NOTE}"}

    def get_product(self, hsn8: str) -> dict:
        self.trace.used("get_product")
        code = normalize_code(hsn8)
        if not (code.isdigit() and len(code) == 8):
            raise ToolInputError("hsn8 must be an 8-digit line code - use lookup_code for 2/4/6 digits")
        d = build_product_detail(self.conn, code)
        if d is None:
            raise ToolInputError(f"{code} is not a line in the Atlas")
        self.trace.cite("product", d["hsn8"], f"{code_label(d['hsn8'])} {d['description']}")
        for m in d.get("ministries") or []:
            self.trace.cite("ministry", m["id"], m["name"])
        for c in d.get("value_chains") or []:
            self.trace.cite("chain", c["chain_id"], c["name"])
        trade = d.get("trade") or {}
        scores = d.get("scores") or {}
        tariff = d.get("tariff") or {}
        return {
            "hsn8": d["hsn8"], "description": d["description"], "full_description": d.get("full_description"),
            "hierarchy": [f"{h['code']} {h['description']}" for h in d.get("hierarchy") or []],
            "owners": [{"id": m["id"], "name": m["name"], "role": m.get("role")} for m in d.get("ministries") or []],
            "sector": d.get("sector_name"),
            "mapping": {"status": d["mapping_status"], "source": d["mapping_source"],
                        "confidence": d.get("mapping_confidence"),
                        "provenance": (d.get("mapping") or {}).get("provenance", {}).get("label")},
            "trade_hs6": {k: trade.get(k) for k in (
                "year", "exports", "imports", "world_trade", "trade_balance", "rca", "india_world_share",
                "india_supplier_rank", "n_suppliers", "top_import_source_name", "top_import_source_share",
                "china_import_share", "top_destination_name", "export_cagr", "import_cagr", "world_cagr",
                "export_yoy", "import_yoy", "trade_level", "metric_hs6", "heading_lines")} if trade else None,
            "lines_in_hs6": d.get("lines_in_hs6"),
            "tariff": {"display": d.get("bcd_display"), "mfn_avg_pct": tariff.get("mfn_avg"),
                       "source": tariff.get("bcd_source"), "year": tariff.get("year")} if tariff else None,
            "top_sources": [{"country": c["country"], "value": c["value"], "share": c["share"]}
                            for c in (d.get("top_sources") or [])[:5]],
            "top_destinations": [{"country": c["country"], "value": c["value"], "share": c["share"]}
                                 for c in (d.get("top_destinations") or [])[:5]],
            "model_scores": {k: scores.get(k) for k in (
                "export_potential_score", "untapped_potential_usd", "import_dependency_score", "vulnerability_score",
                "substitution_score", "archetype")} if scores else None,
            "value_chains": [{"chain_id": c["chain_id"], "name": c["name"], "stage": c.get("stage_name")}
                             for c in d.get("value_chains") or []],
            "schemes": [{"id": s["id"], "name": s["name"], "kind": s["kind"]} for s in d.get("schemes") or []],
            "production": d.get("production") or [],
            "alerts": [{"kind": a["kind"], "severity": a["severity"], "title": a["title"]}
                       for a in d.get("alerts") or []],
            "data_quality_score": d.get("data_quality_score"),
            "provenance": (f"Trade: {trade_note(self.year)} ("
                           + ("India's exports and imports are this 8-digit line's own figures"
                              if trade.get("trade_level") == "hs8" else
                              "DGCIS does not publish this line separately for the year, so it has no exports or "
                              "imports of its own")
                           + (f"; BACI reports heading {d['hs4']} only as {trade.get('metric_hs6')}, so RCA and "
                              f"world figures are the heading totals" if (trade.get("metric_hs6") or "").endswith("00")
                              and trade.get("metric_hs6") != d.get("hs6") else "")
                           + f"); tariff: WITS TRAINS MFN applied average; scores: {MODEL_NOTE}."),
        }

    def lookup_code(self, code: str) -> dict:
        self.trace.used("lookup_code")
        code = _code_arg(code)
        if len(code) == 8:
            return {"type": "product", "product": self.get_product(code)}
        node = build_node_lookup(self.conn, code)
        if node is None:
            raise ToolInputError(f"HS {code} is not in the HS 2022 nomenclature")
        n = node["node"]
        owners = rows(self.conn, """SELECT p.ministry_id, mi.short_name, mi.name, COUNT(*) AS lines FROM products p
                                    LEFT JOIN ministries mi ON mi.id = p.ministry_id WHERE p.hsn8 GLOB ?
                                    GROUP BY p.ministry_id ORDER BY lines DESC LIMIT 8""", (code + "*",))
        for o in owners[:4]:
            self.trace.cite("ministry", o["ministry_id"], o["name"])
        hs6s = prefix_hs6_list(self.conn, code)
        top = rows(self.conn, f"""SELECT x.hs6, x.india_exports, x.india_imports, x.rca, x.india_world_share,
                                         x.india_supplier_rank
                                  FROM hs6_metrics x
                                  WHERE {in_json('x.hs6')} ORDER BY x.india_exports DESC LIMIT 5""",
                   (json_param(hs6s),)) if hs6s else []
        meta = self._hs6_meta([t["hs6"] for t in top])
        first = node["products"][0]["hsn8"] if node["products"] else None
        if first:
            self.trace.cite("product", first, f"{code_label(first)} {node['products'][0]['description']}")
        return {
            "type": "node", "code": n["code"], "level": n["level"], "description": n["description"],
            "hierarchy": [f"{h['code']} {h['description']}" for h in n.get("hierarchy") or []],
            "national_lines": n.get("n_products"),
            "trade": {k: (n.get("trade") or {}).get(k) for k in ("exports", "imports", "world_trade", "n_hs6")},
            "owners": [{"ministry_id": o["ministry_id"],
                        "ministry": f"{o['name']} ({o['short_name']})" if o.get("name") else o["short_name"],
                        "lines": o["lines"]} for o in owners],
            "children": [{"code": c["code"], "description": _short(c["description"], 100),
                          "lines": c.get("n_products")} for c in node["children"][:15]],
            "top_hs6_by_exports": [{"hs6": t["hs6"], "description": _short(meta.get(t["hs6"], {}).get("description"), 100),
                                    "exports": t["india_exports"], "imports": t["india_imports"],
                                    "rca": t["rca"], "india_world_share": t["india_world_share"],
                                    "india_supplier_rank": t["india_supplier_rank"]} for t in top],
            "provenance": (f"Trade: {trade_note(self.year)}, summed over distinct HS6 codes. RCA, world "
                           "share and supplier rank are per HS6 (Balassa RCA; > 1 = comparative advantage)."),
        }

    def _entity_summary(self, kind: str, entity: dict) -> dict:
        d = build_entity_dashboard(self.conn, kind, entity["id"])
        if d is None:
            raise ToolInputError(f"unknown {kind} {entity['id']!r}")
        self.trace.cite(kind, entity["id"], entity["name"])
        for p in (d.get("top_exports") or [])[:5] + (d.get("top_imports") or [])[:5]:
            self.trace.cite("product", p["hsn8"], f"{code_label(p['hsn8'])} {p['description']}")
        for c in d.get("value_chains") or []:
            self.trace.cite("chain", c["chain_id"], c["name"])
        k = d["kpis"]

        def brief(items: list[dict], *extra: str) -> list[dict]:
            out = []
            for p in items[:5]:
                item = {"hsn8": p["hsn8"], "description": _short(p["description"], 100), "exports": p.get("exports"),
                        "imports": p.get("imports"), "rca": p.get("rca")}
                item.update({e: p.get(e) for e in extra})
                out.append(item)
            return out

        return {
            kind: {"id": entity["id"], "name": entity["name"], "short_name": entity.get("short_name")},
            "kpis": {key: k.get(key) for key in ("codes", "accepted", "verified_codes", "secondary_codes", "exports",
                                                 "imports", "trade_balance", "world_trade", "sectors_covered",
                                                 "ministries_covered", "chains_involved", "open_tickets",
                                                 "pending_claims") if key in k},
            "mix": [{"name": x.get("name") or x.get("short_name"), "codes": x["codes"], "exports": x["exports"]}
                    for x in (d.get("sector_mix") or d.get("ministry_mix") or [])[:6]],
            "top_exports": brief(d.get("top_exports") or []),
            "top_imports": brief(d.get("top_imports") or []),
            "dependency_hotspots": brief(d.get("dependency_hotspots") or [], "vulnerability_score",
                                         "top_import_source_name", "china_import_share"),
            "opportunities": brief(d.get("opportunities") or [], "export_potential_score", "untapped_potential_usd",
                                   "archetype"),
            "value_chains": [{"chain_id": c["chain_id"], "name": c["name"], "stages": c.get("stages")}
                             for c in d.get("value_chains") or []],
            "schemes": [{"id": s["id"], "name": s["name"], "kind": s["kind"]} for s in d.get("schemes") or []],
            "trend": [{"year": t["year"], "exports": t["exports"], "imports": t["imports"]} for t in d.get("trend") or []],
            "ranking_basis": d.get("ranking"),
            "provenance": f"Trade: {trade_note(self.year)}, each HS6 value allocated over its national "
                          f"lines; hotspots / opportunities: {MODEL_NOTE}.",
        }

    def ministry_summary(self, ministry_id: str) -> dict:
        self.trace.used("ministry_summary")
        m = self.catalog.ministry(ministry_id)
        if not m:
            raise ToolInputError(f"unknown ministry {ministry_id!r} - use an id from the catalogue")
        return self._entity_summary("ministry", m)

    def sector_summary(self, sector_id: str) -> dict:
        self.trace.used("sector_summary")
        s = self.catalog.sector(sector_id)
        if not s:
            raise ToolInputError(f"unknown sector {sector_id!r} - use an id from the catalogue")
        return self._entity_summary("sector", s)

    def chain_summary(self, chain_id: str) -> dict:
        self.trace.used("chain_summary")
        c = self.catalog.chain(chain_id)
        if not c:
            raise ToolInputError(f"unknown value chain {chain_id!r} - use an id from the catalogue")
        chain = row(self.conn, "SELECT * FROM value_chains WHERE id = ?", (c["id"],))
        self.trace.cite("chain", chain["id"], chain.get("title") or chain["name"])
        lead = self.catalog.m_by_id.get(chain.get("lead_ministry_id") or "")
        if lead:
            self.trace.cite("ministry", lead["id"], lead["name"])
        hs6s = prefix_hs6_list(self.conn, chain["anchor_hs"])
        totals = hs6_trade_totals(self.conn, hs6s)
        suppliers = country_values(self.conn, "world_suppliers", hs6s, limit=5, include_india=True)
        india = next((s for s in suppliers if s["country_id"] == INDIA_ID), None)
        stages = []
        exposed = []
        for st in rows(self.conn, "SELECT stage_id, name, ministry_text FROM vc_stages WHERE chain_id = ? "
                                  "ORDER BY stage_order", (chain["id"],)):
            items = rows(self.conn, "SELECT item_name, hs_code, hsn8, ministry_text FROM vc_items WHERE chain_id = ? "
                                    "AND stage_id = ? ORDER BY item_order, id", (chain["id"], st["stage_id"]))
            stages.append({"stage": st["name"], "ministries": st["ministry_text"],
                           "items": [{"item": i["item_name"], "hs_code": i["hs_code"]} for i in items]})
            for i in items:
                codes = prefix_hs6_list(self.conn, i["hs_code"]) if i["hs_code"] else []
                if not codes:
                    continue
                r = row(self.conn, f"""SELECT SUM(m.india_imports) AS imports, MAX(sc.vulnerability_score) AS vuln,
                                              MAX(m.china_import_share) AS china
                                       FROM hs6_metrics m LEFT JOIN hs6_scores sc ON sc.hs6 = m.hs6
                                       WHERE {in_json('m.hs6')}""", (json_param(codes),))
                if r and r["vuln"] is not None:
                    exposed.append({"item": i["item_name"], "hs_code": i["hs_code"], "stage": st["name"],
                                    "imports": r["imports"], "vulnerability_score": r["vuln"],
                                    "max_china_import_share": r["china"]})
        exposed.sort(key=lambda e: -(e["vulnerability_score"] or 0))
        production = rows(self.conn, "SELECT label, year, value, unit, source, status FROM production "
                                     "WHERE scope = 'chain' AND key = ? ORDER BY label, year", (chain["id"],))
        return {
            "chain": {"id": chain["id"], "name": chain["name"], "title": chain.get("title"),
                      "anchor_hs": chain["anchor_hs"], "lead_ministry": lead["name"] if lead else None,
                      "phase": chain.get("phase"), "mapping_source": chain.get("source"),
                      "description": _short(chain.get("description"), 400)},
            "anchor_trade": {"india_exports": totals.get("exports"), "india_imports": totals.get("imports"),
                             "world_trade": totals.get("world_trade"),
                             "india_share": (totals["exports"] / totals["world_trade"])
                             if totals.get("exports") and totals.get("world_trade") else None,
                             "n_hs6": totals.get("n_hs6")},
            "india_supplier_rank": india["rank"] if india else None,
            "top_world_suppliers": [{"country": s["country"], "value": s["value"], "share": s["share"],
                                     "rank": s["rank"]} for s in suppliers],
            "production": production,
            "stages": stages,
            "most_import_exposed_inputs": exposed[:5],
            "provenance": f"Trade: {trade_note(self.year)}, summed over the HS6 codes under the anchor "
                          f"{chain['anchor_hs']}; production: real sourced figures (UNIDO INDSTAT, Rubber Board, "
                          f"ATMA or official uploads); vulnerability: {MODEL_NOTE}.",
        }

    def top_opportunities(self, ministry_id: str | None = None, sector_id: str | None = None,
                          chapter: str | None = None, prefix: str | None = None, rank_by: str = "score",
                          limit: int = 10) -> dict:
        self.trace.used("top_opportunities")
        limit = _limit(limit, 10)
        if rank_by not in ("score", "untapped"):
            raise ToolInputError("rank_by must be 'score' or 'untapped'")
        where, params, labels = self._scope(ministry_id, sector_id, chapter, prefix)
        order = ("x.untapped_potential_usd DESC, x.export_potential_score DESC" if rank_by == "untapped"
                 else "x.export_potential_score DESC, x.untapped_potential_usd DESC")
        data = rows(self.conn, f"""
            SELECT x.hs6, m.india_exports, m.world_trade, m.rca, m.world_cagr, m.export_cagr, m.india_world_share,
                   x.export_potential_score, x.untapped_potential_usd, x.archetype
            FROM hs6_scores x JOIN hs6_metrics m ON m.hs6 = x.hs6
            WHERE x.export_potential_score IS NOT NULL AND {where}
            ORDER BY {order}, x.hs6 LIMIT ?""", (*params, limit))
        total_untapped = row(self.conn, f"""SELECT SUM(x.untapped_potential_usd) AS v, COUNT(*) AS n
                                            FROM hs6_scores x WHERE x.export_potential_score IS NOT NULL
                                            AND {where}""", params)
        meta = self._hs6_meta([d["hs6"] for d in data])
        items = []
        for d in data:
            info = meta.get(d["hs6"], {})
            self._cite_hs6(d["hs6"], info)
            items.append({"hs6": d["hs6"], "description": _short(info.get("description"), 110),
                          "ministry": info.get("ministry"), "sample_line": info.get("hsn8"),
                          "india_exports": d["india_exports"], "world_trade": d["world_trade"], "rca": d["rca"],
                          "world_cagr": d["world_cagr"], "export_cagr": d["export_cagr"],
                          "india_world_share": d["india_world_share"],
                          "export_potential_score": d["export_potential_score"],
                          "untapped_potential_usd": d["untapped_potential_usd"], "archetype": d["archetype"]})
        return {"scope": ", ".join(labels) or "all products", "rank_by": rank_by, "items": items,
                "scope_total_untapped_usd": total_untapped["v"] if total_untapped else None,
                "scope_hs6_scored": total_untapped["n"] if total_untapped else 0,
                "method": "export_potential_score = 100 x (0.35 pct(log world trade) + 0.30 min(RCA,3)/3 + 0.20 "
                          "pct(world CAGR) + 0.15 pct(India export CAGR)); untapped = exports India would gain at its "
                          "chapter-average world share (RCA >= 0.3 only).",
                "provenance": f"Inputs: {trade_note(self.year)}; scores: {MODEL_NOTE}."}

    def import_dependencies(self, country: str | None = None, ministry_id: str | None = None,
                            sector_id: str | None = None, chapter: str | None = None, prefix: str | None = None,
                            min_imports_usd: float | None = None, limit: int = 10) -> dict:
        self.trace.used("import_dependencies")
        limit = _limit(limit, 10)
        where, params, labels = self._scope(ministry_id, sector_id, chapter, prefix)
        try:
            floor = float(min_imports_usd) if min_imports_usd is not None else None
        except (TypeError, ValueError) as exc:
            raise ToolInputError("min_imports_usd must be a number (US$)") from exc
        if country:
            c = self.catalog.country(country)
            if not c:
                raise ToolInputError(f"unknown country {country!r}")
            floor = floor if floor is not None else 0.0
            data = rows(self.conn, f"""
                SELECT x.hs6, x.value AS imports_from_country, x.share AS country_share, m.india_imports,
                       m.india_exports, sc.vulnerability_score
                FROM india_partners x JOIN hs6_metrics m ON m.hs6 = x.hs6 LEFT JOIN hs6_scores sc ON sc.hs6 = x.hs6
                WHERE x.flow = 'M' AND x.country_id = ? AND x.value >= ? AND {where}
                ORDER BY x.value DESC, x.hs6 LIMIT ?""", (c["id"], floor, *params, limit))
            agg = row(self.conn, f"""
                SELECT SUM(x.value) AS from_country,
                       SUM(CASE WHEN x.share >= 0.6 AND m.india_imports >= 5e7 THEN 1 ELSE 0 END) AS n_dependent,
                       SUM(CASE WHEN x.share >= 0.6 AND m.india_imports >= 5e7 THEN x.value ELSE 0 END) AS dep_value
                FROM india_partners x JOIN hs6_metrics m ON m.hs6 = x.hs6
                WHERE x.flow = 'M' AND x.country_id = ? AND {where}""", (c["id"], *params))
            total = row(self.conn, f"SELECT SUM(x.india_imports) AS v FROM hs6_metrics x WHERE {where}", params)
        else:
            c = None
            floor = floor if floor is not None else 1e7
            data = rows(self.conn, f"""
                SELECT x.hs6, x.india_imports, x.india_exports, x.india_import_hhi, x.top_import_source,
                       co.name AS top_import_source_name, x.top_import_source_share, x.china_import_share,
                       sc.vulnerability_score, sc.import_dependency_score
                FROM hs6_metrics x JOIN hs6_scores sc ON sc.hs6 = x.hs6
                LEFT JOIN countries co ON co.id = x.top_import_source
                WHERE sc.vulnerability_score IS NOT NULL AND x.india_imports >= ? AND {where}
                ORDER BY sc.vulnerability_score DESC, x.hs6 LIMIT ?""", (floor, *params, limit))
            agg, total = None, row(self.conn, f"SELECT SUM(x.india_imports) AS v FROM hs6_metrics x WHERE {where}",
                                   params)
        meta = self._hs6_meta([d["hs6"] for d in data])
        items = []
        for d in data:
            info = meta.get(d["hs6"], {})
            self._cite_hs6(d["hs6"], info)
            item = {"hs6": d["hs6"], "description": _short(info.get("description"), 110),
                    "ministry": info.get("ministry"), "sample_line": info.get("hsn8"),
                    "india_imports": d["india_imports"], "india_exports": d["india_exports"],
                    "vulnerability_score": d["vulnerability_score"]}
            if c:
                item.update({"imports_from_country": d["imports_from_country"], "country_share": d["country_share"]})
            else:
                item.update({"top_import_source": d["top_import_source_name"],
                             "top_import_source_share": d["top_import_source_share"],
                             "china_import_share": d["china_import_share"],
                             "import_hhi": d["india_import_hhi"]})
            items.append(item)
        out = {"scope": ", ".join(labels) or "all products", "country": c["name"] if c else None,
               "min_imports_usd": floor, "items": items, "scope_total_imports_usd": total["v"] if total else None,
               "provenance": f"CEPII BACI {self.year} partner data via OEC (India's sources by country); "
                             f"vulnerability: {MODEL_NOTE}."}
        if c and agg:
            out.update({"imports_from_country_usd": agg["from_country"],
                        "country_share_of_scope_imports": (agg["from_country"] / total["v"])
                        if agg["from_country"] and total and total["v"] else None,
                        "hs6_with_country_share_ge_60pct_and_imports_ge_50mn": agg["n_dependent"],
                        "value_of_those_imports_usd": agg["dep_value"]})
        return out


# --------------------------------------------------------------------------- tool schemas (Claude mode)

_SCOPE_PROPS = {
    "ministry_id": {"type": "string", "description": "Ministry id from the catalogue (e.g. 'mot', 'dpiit')"},
    "sector_id": {"type": "string", "description": "Sector id from the catalogue (e.g. 'textiles')"},
    "chapter": {"type": "string", "description": "2-digit HS chapter, e.g. '61'"},
    "prefix": {"type": "string", "description": "HS code prefix (2-6 digits), e.g. '8507'"},
    "limit": {"type": "integer", "description": f"Rows to return (1-{MAX_LIST}, default 10)"},
}
TOOL_DEFS: list[dict] = [
    {"name": "search_products",
     "description": "Search India's 8-digit HSN lines by code prefix or product words (full-text), optionally within "
                    "a ministry or sector. Returns matching lines with their owning ministry, mapping status/source, "
                    "HS6-level India exports/imports/world trade (US$), RCA and tariff, plus how the top matches split "
                    "across ministries. Use it to answer 'which ministry handles X' and to find codes for products.",
     "input_schema": {"type": "object", "properties": {
         "query": {"type": "string", "description": "Product words or a code, e.g. 'lithium-ion batteries' or '8507'"},
         "ministry_id": _SCOPE_PROPS["ministry_id"], "sector_id": _SCOPE_PROPS["sector_id"],
         "sort": {"type": "string", "enum": ["relevance", "exports", "imports", "rca", "code", "world_trade"]},
         "limit": _SCOPE_PROPS["limit"]}, "required": [], "additionalProperties": False}},
    {"name": "get_product",
     "description": "Everything about one 8-digit HSN line: hierarchy, owning ministries and mapping provenance, "
                    "2024 HS6 trade (exports, imports, world trade, RCA, India's world share and supplier rank, top "
                    "import source, China share, CAGRs), tariff, top partner countries, model scores, value chains, "
                    "PLI/QCO schemes, production and alerts.",
     "input_schema": {"type": "object", "properties": {
         "hsn8": {"type": "string", "description": "8-digit code, e.g. '40111010'"}},
         "required": ["hsn8"], "additionalProperties": False}},
    {"name": "lookup_code",
     "description": "Look up any HS code: 2-digit chapter, 4-digit heading or 6-digit subheading (description, "
                    "children, number of national lines, owning ministries, summed trade, top HS6 by exports) or an "
                    "8-digit line (same as get_product).",
     "input_schema": {"type": "object", "properties": {
         "code": {"type": "string", "description": "2, 4, 6 or 8-digit HS code; dots and spaces are ignored"}},
         "required": ["code"], "additionalProperties": False}},
    {"name": "ministry_summary",
     "description": "A ministry's dashboard: lines owned, accepted / verified mappings, exports, imports, trade "
                    "balance, sector mix, top 5 exports and imports, dependency hotspots, export opportunities, value "
                    "chains, schemes and the 2018-2024 trend.",
     "input_schema": {"type": "object", "properties": {"ministry_id": _SCOPE_PROPS["ministry_id"]},
                      "required": ["ministry_id"], "additionalProperties": False}},
    {"name": "sector_summary",
     "description": "A sector's dashboard (same content as ministry_summary, with the owning-ministry mix).",
     "input_schema": {"type": "object", "properties": {"sector_id": _SCOPE_PROPS["sector_id"]},
                      "required": ["sector_id"], "additionalProperties": False}},
    {"name": "chain_summary",
     "description": "A curated value chain (sectors such as tyre, natural_rubber, solar_pv): stages and items with "
                    "HS codes and ministries, anchor-code trade, India's rank among world suppliers, top world "
                    "suppliers, real production figures and the most import-exposed inputs.",
     "input_schema": {"type": "object", "properties": {
         "chain_id": {"type": "string", "description": "Value-chain id from the catalogue"}},
         "required": ["chain_id"], "additionalProperties": False}},
    {"name": "top_opportunities",
     "description": "HS6 products with the highest export potential (model estimate), optionally within a ministry, "
                    "sector, chapter or code prefix; rank by the export-potential score or by untapped potential "
                    "(US$ India would gain at its chapter-average world share).",
     "input_schema": {"type": "object", "properties": {
         **{k: _SCOPE_PROPS[k] for k in ("ministry_id", "sector_id", "chapter", "prefix")},
         "rank_by": {"type": "string", "enum": ["score", "untapped"]}, "limit": _SCOPE_PROPS["limit"]},
         "required": [], "additionalProperties": False}},
    {"name": "import_dependencies",
     "description": "India's import dependencies at HS6 level. With 'country' (e.g. 'China'): products with the "
                    "largest imports from that country, its share of India's imports of each, and the scope total. "
                    "Without: products ranked by the vulnerability score (dependency ratio, sourcing concentration, "
                    "China share, import size), with the top source country.",
     "input_schema": {"type": "object", "properties": {
         "country": {"type": "string", "description": "Country name or OEC id, e.g. 'China' or 'aschn'"},
         **{k: _SCOPE_PROPS[k] for k in ("ministry_id", "sector_id", "chapter", "prefix")},
         "min_imports_usd": {"type": "number", "description": "Minimum India imports (US$)"},
         "limit": _SCOPE_PROPS["limit"]}, "required": [], "additionalProperties": False}},
]
_TOOL_METHODS = {t["name"]: t["name"] for t in TOOL_DEFS}


def run_tool(tools: AtlasTools, name: str, args: dict | None) -> dict:
    """Execute one tool call by name with validated keyword arguments."""
    spec = next((t for t in TOOL_DEFS if t["name"] == name), None)
    if spec is None:
        raise ToolInputError(f"unknown tool {name!r}")
    args = dict(args or {})
    allowed = set(spec["input_schema"]["properties"])
    unknown = set(args) - allowed
    if unknown:
        raise ToolInputError(f"unexpected argument(s) {sorted(unknown)}; allowed: {sorted(allowed)}")
    missing = [k for k in spec["input_schema"].get("required", []) if args.get(k) in (None, "")]
    if missing:
        raise ToolInputError(f"missing required argument(s) {missing}")
    for key, value in list(args.items()):
        if value in ("", None):
            args.pop(key)
        elif spec["input_schema"]["properties"][key].get("type") == "string" and not isinstance(value, str):
            args[key] = str(value)
    return getattr(tools, _TOOL_METHODS[name])(**args)


# --------------------------------------------------------------------------- offline intents

HELP_TEXT = (
    "I answer from the Atlas's own data (DGCIS TRADESTAT and CEPII BACI trade, WITS tariffs, UNIDO INDSTAT, the Rubber Board, ATMA "
    "and the HSN master). Try for example:\n\n"
    "- **An HS code** - `4011.10.10`, `HS 8507` or `chapter 61` -> owner, trade, tariff, partners, scores\n"
    "- **Which ministry handles lithium-ion batteries?** - ownership of matching lines\n"
    "- **Top exports of the Ministry of Textiles** / **top imports of DPIIT**\n"
    "- **Opportunities in pharmaceuticals** - export-potential ranking (model estimate)\n"
    "- **Dependence on China** (optionally *in electronics*) - largest imports from a country\n"
    "- **Import dependence in the automotive sector** - vulnerability ranking\n"
    "- **Tyre value chain** - stages, ministries, India's rank, exposed inputs\n\n"
    "Numbers are 2024 HS6-level US$ values unless stated; ownership comes from the DPIIT Guidebook "
    "(16.12.2025), with residual lines marked as such.")

_CODE_ANY = re.compile(r"(?<![\d.])(\d{4}[.\s]?\d{2}[.\s]?\d{2}|\d{4}[.\s]\d{2}|\d{6}|\d{8})(?![\d.])")
_CODE_PREFIXED = re.compile(r"(?i)\b(?:hsn?|itc[\s-]*hs|code|heading|chapter|ch\.?|tariff\s+line)\s*[:#]?\s*"
                            r"(\d{2}(?:[.\s]?\d{2}){0,3})\b")
_WHICH_MINISTRY = re.compile(r"(?i)\b(which|what|who)\b.*\b(ministry|ministries|department|dept|owner|owns|"
                             r"handles?|responsible|in charge)\b|\bwho\s+(owns|handles|regulates|looks after)\b|"
                             r"\b(owning|nodal)\s+(ministry|department)\b|\bministry\s+(for|responsible|handling)\b")
_TOP_FLOW = re.compile(r"(?i)\b(top|largest|biggest|main|major|leading|key|highest)\b[\w\s'&-]{0,40}?\b"
                       r"(exports?|imports?|exported|imported)\b|\b(exports?|imports?)\s+(of|by|for|under|in)\b")
_OPPORTUNITY = re.compile(r"(?i)\b(opportunit\w*|export\s+potential|untapped|promising|potential\s+exports?|"
                          r"where\s+can\s+india\s+(grow|export))\b")
_DEPENDENCE = re.compile(r"(?i)\b(depend\w*|relian\w*|reliant|imports?\s+from|sourced?\s+from|exposure\s+to|"
                         r"exposed\s+to)\b")
_VULNERABLE = re.compile(r"(?i)\b(dependen\w*|vulnerab\w*|supply[\s-]+chain\s+risk|import\s+risk|"
                         r"concentrat\w*|critical\s+inputs?)\b")
_MINISTRY_CUE = re.compile(r"(?i)\b(ministry|ministries|department|dept)\b")
_SECTOR_CUE = re.compile(r"(?i)\b(sector|sectors|industry|industries)\b")
_SUMMARY_CUE = re.compile(r"(?i)\b(dashboard|summary|overview|profile|about)\b")
_CHAIN_WORD = re.compile(r"(?i)\b(value[\s-]+chain|supply[\s-]+chain|chain|deep[\s-]+dive)\b")
_HELP = re.compile(r"(?i)^\s*(help|hi|hello|hey|what can you do|how do i use( this)?|\?)\W*$")
_QUESTION_WORDS = frozenset("""which what who ministry ministries department departments dept is are the a an
responsible for handles handle handling own owns owner owned looks look after deal deals with covers cover of in
charge mapped to does do belong belongs under falls fall product products hsn code codes please tell me about
regulates regulate line lines item items nodal owning hs india india's how much many it its on from this that
these those and or""".split())
#: Metric / indicator words that name *what* is asked about a product, not the product (stripped before search).
_METRIC_WORDS = frozenset("""rca revealed comparative advantage competitiveness competitive tariff tariffs bcd duty
duties mfn share shares exports export exported imports import imported trade balance growth cagr rank ranking
figure figures stats statistics dependence dependent dependency reliance reliant vulnerability vulnerable score
scores potential""".split())
_RANK_WORDS = frozenset("top largest biggest main major leading key highest lowest best".split())
_METRIC_Q = re.compile(r"(?i)\b(rca|revealed\s+comparative\s+advantage|comparative\s+advantage|competitiveness|"
                       r"tariffs?|bcd|dut(?:y|ies)|mfn|trade\s+balance|(?:world|global|export)\s+share|"
                       r"how\s+(?:much|many)|what\s+(?:is|are|was|were)\b.{0,40}\b(?:exports?|imports?|trade)|"
                       r"(?:exports?|imports?)\s+(?:of|in|for)\b)")
_RANKING_Q = re.compile(r"(?i)\b(top|largest|biggest|main|major|leading|key|highest)\b[\w\s'&-]{0,40}?\b"
                        r"(exports?|imports?|exported|imported)\b")
_CONJUNCTION = re.compile(r"(?i)\s+(?:and|,|;|&)\s+(?:how|what|is|are|does|do|which|where|why|when)\b")


def _strip_metrics(phrase: str) -> str:
    """Drop metric / indicator words so 'RCA cotton T-shirts' searches for 'cotton T-shirts'."""
    words = re.findall(r"[A-Za-z0-9][A-Za-z0-9'-]*", phrase)
    return " ".join(w for w in words if w.lower() not in _METRIC_WORDS).strip()


def _years_free(text: str) -> str:
    """Remove 4-digit years so '2024' is not taken for an HS heading."""
    return re.sub(r"\b(19|20)\d{2}\b", " ", text)


def find_codes(text: str) -> list[str]:
    """HS codes written in the text: 6/8-digit codes anywhere, 2/4-digit codes only after 'HS', 'code', 'chapter'."""
    found: list[str] = []
    for m in _CODE_PREFIXED.finditer(text):
        digits = re.sub(r"\D", "", m.group(1))
        if len(digits) in (2, 4, 6, 8):
            found.append(digits)
    for m in _CODE_ANY.finditer(_years_free(text)):
        digits = re.sub(r"\D", "", m.group(1))
        if len(digits) in (6, 8):
            found.append(digits)
    return list(dict.fromkeys(found))[:3]


#: Everyday product names -> the wording the HS nomenclature uses (offline mode only; each target was checked
#: to find the intended lines with an all-words match). Applied to the product phrase before searching.
HS_VOCABULARY: tuple[tuple[re.Pattern, str], ...] = tuple((re.compile(rf"(?i)\b(?:{k})\b"), v) for k, v in (
    (r"solar\s+(?:pv\s+)?(?:panels?|modules?)|pv\s+(?:panels?|modules?)", "photovoltaic panels"),
    (r"solar\s+(?:pv\s+)?cells?|pv\s+cells?", "photovoltaic cells"),
    (r"li-?ion(?:\s+batter(?:y|ies)|\s+cells?)?|lithium[\s-]ion\s+(?:batter(?:y|ies)|cells?)", "lithium-ion"),
    (r"drones?", "unmanned aircraft"),
    (r"mobile\s+phones?|cell\s*phones?|smart\s*phones?", "smartphones"),
    (r"laptops?|notebook\s+computers?", "portable automatic data processing"),
    (r"(?:semiconductor|computer)\s+chips?|microchips?|semiconductors?\s+ics?", "electronic integrated circuits"),
    (r"electric\s+vehicles?|e-?vs?", "vehicles electric motor propulsion"),
    (r"medicines?|drugs?", "medicaments"),
    (r"wind\s+turbines?|wind\s+generators?", "wind-powered"),
    (r"air\s+conditioners?|acs", "air conditioning"),
    (r"tvs?|televisions?", "television"),
))


def hs_vocabulary(phrase: str) -> str:
    """Rewrite everyday product names in ``phrase`` into HS wording (see :data:`HS_VOCABULARY`)."""
    out = phrase
    for pattern, replacement in HS_VOCABULARY:
        out = pattern.sub(replacement, out)
    return " ".join(out.split())


def _product_phrase(text: str, *, strip_metrics: bool = True) -> str:
    """The product words of a question: question words (and, by default, metric words) removed; a compound
    question ("... tyre cord fabric and how dependent is India on imports of it") is cut at the conjunction."""
    cut = _CONJUNCTION.split(text, maxsplit=1)[0]
    words = re.findall(r"[A-Za-z0-9][A-Za-z0-9'-]*", cut)
    phrase = " ".join(w for w in words if w.lower() not in _QUESTION_WORDS).strip()
    return _strip_metrics(phrase) if strip_metrics else phrase


@dataclass
class Answer:
    reply: str
    trace: Trace


class OfflineAssistant:
    """Deterministic intent handling over :class:`AtlasTools` (see module docstring)."""

    def __init__(self, conn: sqlite3.Connection):
        self.tools = AtlasTools(conn)
        self.trace = self.tools.trace
        self.cat = self.tools.catalog

    # ---------------------------------------------------------------- entry point
    def answer(self, text: str) -> str:
        text = (text or "").strip()
        if not text or _HELP.match(text):
            return HELP_TEXT
        # A product named next to a 'which ministry' cue wins over the sector-level dependence / vulnerability
        # intents, so a compound question keeps its product; metric questions about a product come before the
        # generic search so the product card (RCA, tariff, trade) answers them.
        handlers: list[Callable[[str], str | None]] = [
            self._codes, self._which_ministry, self._dependence, self._vulnerability, self._opportunities,
            self._top_flow, self._metric_product, self._chain, self._entity, self._search]
        for handler in handlers:
            try:
                reply = handler(text)
            except ToolInputError as exc:
                log.info("offline intent %s could not answer: %s", handler.__name__, exc)
                reply = None
            if reply:
                return reply
        return "I could not match that to a product, code, ministry or sector in the Atlas.\n\n" + HELP_TEXT

    def _entities(self, text: str) -> tuple[dict | None, dict | None]:
        """(ministry, sector) named in the text: a short name always counts; a ministry name word only next to
        'ministry' / 'department'; "sector" in the text prefers the sector reading."""
        m = self.cat.ministry_by_short_name(text)
        if not m and _MINISTRY_CUE.search(text) and not _SECTOR_CUE.search(text):
            m = self.cat.find_ministry(text)
        s = None if m else self.cat.find_sector(text)
        return m, s

    def _scope_from_text(self, text: str) -> dict:
        """ministry / sector / chain mentioned in the text, as tool filters (+ a label)."""
        m, s = self._entities(text)
        c = None if (m or s) else self.cat.find_chain(text)
        if m:
            return {"ministry_id": m["id"], "label": m["name"]}
        if s:
            return {"sector_id": s["id"], "label": s["name"]}
        if c:
            chain = row(self.tools.conn, "SELECT anchor_hs FROM value_chains WHERE id = ?", (c["id"],))
            return {"prefix": chain["anchor_hs"], "label": f"the {c['name']} value chain (HS {chain['anchor_hs']})"}
        return {}

    # ---------------------------------------------------------------- intents
    def _codes(self, text: str) -> str | None:
        codes = find_codes(text)
        if not codes:
            return None
        parts = []
        for code in codes:
            try:
                data = self.tools.lookup_code(code)
            except ToolInputError as exc:
                parts.append(f"**{code_label(code)}**: {exc}.")
                continue
            parts.append(self._product_card(data["product"]) if data["type"] == "product" else self._node_card(data))
        return "\n\n---\n\n".join(parts)

    def _product_card(self, p: dict) -> str:
        t = p.get("trade_hs6") or {}
        owners = ", ".join(f"{o['name']}{' (secondary)' if o.get('role') == 'secondary' else ''}"
                           for o in p.get("owners") or []) or "Residual - no owning ministry yet"
        mapping = p["mapping"]
        lines = [f"### {code_label(p['hsn8'])} - {p['description']}",
                 f"*{' > '.join(p['hierarchy'][1:3])}*" if len(p.get("hierarchy") or []) > 2 else "",
                 "",
                 f"- **Owning ministry:** {owners} - mapping *{mapping['status']}* via *{mapping['source']}*"
                 f" ({mapping.get('provenance') or 'not verified'})",
                 f"- **Sector:** {p.get('sector') or 'Not available'}"]
        if t:
            rank = (f"#{t['india_supplier_rank']} of {t['n_suppliers']} exporters" if t.get("india_supplier_rank")
                    else "Not available")
            shared = t.get("heading_lines") if t.get("trade_level") == "hs4_aggregate" else p.get("lines_in_hs6")
            code_note = code_label(t.get("metric_hs6") or p["hsn8"][:6])
            if t.get("trade_level") == "hs4_aggregate":
                code_note += " - heading aggregate"
            lines += [f"- **India {t.get('year')} (HS6 {code_note}, shared by {shared} line(s)):** "
                      f"exports {usd(t.get('exports'))}, imports {usd(t.get('imports'))}, "
                      f"balance {usd(t.get('trade_balance'))}",
                      f"- **World trade:** {usd(t.get('world_trade'))}; India's share {pct(t.get('india_world_share'), 2)}, "
                      f"supplier rank {rank}; RCA {num(t.get('rca'))}",
                      f"- **Main import source:** {t.get('top_import_source_name') or 'Not available'} "
                      f"({pct(t.get('top_import_source_share'))}); China's share {pct(t.get('china_import_share'))}",
                      f"- **Growth (CAGR 2018-{t.get('year')}):** exports {pct(t.get('export_cagr'))}, "
                      f"imports {pct(t.get('import_cagr'))}, world {pct(t.get('world_cagr'))}"]
        else:
            lines.append("- **Trade:** Not available for this HS6 in BACI")
        tariff = p.get("tariff") or {}
        lines.append(f"- **Tariff:** {tariff.get('display') or 'Not available'}"
                     + (f" (WITS MFN average {tariff.get('year')})" if tariff.get("display") else ""))
        s = p.get("model_scores")
        if s:
            lines.append(f"- **Scores ({MODEL_NOTE}):** export potential {num(s.get('export_potential_score'), 0)}/100, "
                         f"vulnerability {num(s.get('vulnerability_score'), 0)}/100, archetype *{s.get('archetype')}*")
        if p.get("value_chains"):
            lines.append("- **Value chains:** " + ", ".join(f"{c['name']} ({c.get('stage') or 'linked'})"
                                                            for c in p["value_chains"]))
        if p.get("schemes"):
            lines.append("- **Schemes:** " + "; ".join(f"{s['name']} ({s['kind']})" for s in p["schemes"][:4]))
        if p.get("alerts"):
            lines.append("- **Alerts:** " + "; ".join(a["title"] for a in p["alerts"][:3]))
        lines.append(f"\n_Data-quality score {p.get('data_quality_score')}/100. Source: {p['provenance']}_")
        return "\n".join(line for line in lines if line is not None)

    def _node_card(self, n: dict) -> str:
        level = {2: "Chapter", 4: "Heading", 6: "Subheading"}.get(n["level"], "HS node")
        t = n.get("trade") or {}
        out = [f"### {level} {code_label(n['code'])} - {n['description']}",
               f"{n.get('national_lines') or 0} national 8-digit line(s); India exports {usd(t.get('exports'))}, "
               f"imports {usd(t.get('imports'))}, world trade {usd(t.get('world_trade'))} "
               f"({t.get('n_hs6') or 0} HS6 codes).", ""]
        if n.get("owners"):
            out.append("**Owning ministries:** " + ", ".join(f"{o['ministry']} ({o['lines']} lines)"
                                                             for o in n["owners"][:6]))
        if n.get("top_hs6_by_exports"):
            out += ["", md_table(["HS6", "Product", "India exports", "India imports"],
                                 [[code_label(x["hs6"]), _short(x["description"], 70), usd(x["exports"]),
                                   usd(x["imports"])] for x in n["top_hs6_by_exports"]])]
        elif n.get("children"):
            out += ["", md_table(["Code", "Description", "Lines"],
                                 [[code_label(c["code"]), _short(c["description"], 70), c["lines"]]
                                  for c in n["children"][:TABLE_ROWS]])]
        out.append(f"\n_Source: {n['provenance']}_")
        return "\n".join(out)

    def _search_phrase(self, phrase: str) -> dict:
        """Search a product phrase in HS wording first (:func:`hs_vocabulary`), then as typed."""
        hs_phrase = hs_vocabulary(phrase)
        if hs_phrase.lower() != phrase.lower():
            data = self.tools.search_products(query=hs_phrase, limit=TABLE_ROWS)
            if data["items"] and data["match"] != "text_any":
                data["hs_wording"] = hs_phrase
                return data
        return self.tools.search_products(query=phrase, limit=TABLE_ROWS)

    def _dependence_lines(self, items: list[dict], limit: int = 4) -> str | None:
        """Import-dependence facts (HS6 level) of the closest matching lines, for compound questions."""
        from app.services.scoring import analytics_frame

        frame = analytics_frame(self.tools.conn)
        out = []
        seen: set[str] = set()
        for p in items:
            hs6 = p["hsn8"][:6]
            r = frame.by_hs6.get(hs6)
            if r is None or hs6 in seen:
                continue
            seen.add(hs6)
            dep = r.get("dependency_ratio")
            out.append([code_label(hs6), _short(r.get("description"), 48), usd(r.get("india_imports")),
                        usd(r.get("india_exports")), pct(dep), r.get("top_import_source_name") or "Not available",
                        pct(r.get("top_import_source_share")), pct(r.get("china_import_share")),
                        num(r.get("vulnerability_score"), 0)])
            if len(out) >= limit:
                break
        if not out:
            return None
        return ("**Import dependence of the closest lines (HS6 level):**\n\n"
                + md_table(["HS6", "Product", "India imports", "India exports", "Imports / trade", "Top source",
                            "Share", "China share", "Vulnerability"], out)
                + f"\n\n_Imports / trade = M / (M + X); vulnerability is a {MODEL_NOTE}._")

    def _which_ministry(self, text: str) -> str | None:
        if not _WHICH_MINISTRY.search(text):
            return None
        if _RANKING_Q.search(text) or _OPPORTUNITY.search(text):
            return None  # "what are the top exports of the Ministry of Textiles" is a ranking, not an ownership question
        phrase = _product_phrase(text)
        if len(phrase) < 3:
            return None
        data = self._search_phrase(phrase)
        if not data["items"]:
            return (f"No HSN line matches **{phrase}**. Try a more specific product name or an HS code.\n\n"
                    + HELP_TEXT.split("\n\n")[0])
        extra = ""
        if _DEPENDENCE.search(text) or _VULNERABLE.search(text):
            dependence = self._dependence_lines(data["items"])
            extra = f"\n\n{dependence}" if dependence else ""
        owners = data["owners_among_top_matches"]
        lead = owners[0] if owners else None
        considered = data["owners_considered"]
        if data["relaxed_query"]:
            subject = f"No line contains every word of *{phrase}*; closest matches for **{data['relaxed_query']}**"
        elif data.get("hs_wording"):
            subject = f"The HS describes *{phrase}* as **{data['hs_wording']}**"
        else:
            subject = f"**{phrase}**"
        head = (f"{subject} - {data['total_matches']:,} matching line(s). "
                + (f"Most of the best matches are owned by **{self.cat.m_by_id.get(lead['ministry_id'], {}).get('name', lead['ministry'])}** "
                   f"({lead['lines']} of the {considered} best matches shown)" if lead else ""))
        if len(owners) > 1:
            head += "; others: " + ", ".join(f"{o['ministry']} ({o['lines']})" for o in owners[1:5])
            best = data["items"][0]
            if lead and best["ministry_id"] != lead["ministry_id"]:
                best_name = self.cat.m_by_id.get(best["ministry_id"], {}).get("name", best["ministry"])
                head += f". The closest match, {code_label(best['hsn8'])}, is owned by **{best_name}**"
        table = md_table(["HS code", "Product", "Ministry", "Mapping", "India exports"],
                         [[code_label(p["hsn8"]), _short(p["description"], 60), p["ministry"], p["mapping"],
                           usd(p["exports_usd"])] for p in data["items"]])
        return (f"{head}.\n\n{table}{extra}\n\n_{MAPPING_NOTE} Open a line for its full profile, or raise a "
                "helpdesk query - it is routed to the owning ministry automatically._")

    def _metric_product(self, text: str) -> str | None:
        """A metric question about a named product -> the product card of the closest line (prints RCA, trade,
        tariff, scores), followed by the other close matches."""
        if not _METRIC_Q.search(text):
            return None
        if self.cat.ministry_by_short_name(text) or (_CHAIN_WORD.search(text) and self.cat.find_chain(text)):
            return None  # "RCA of the tyre value chain" / "exports of MoT" belong to other intents
        phrase = _product_phrase(text)
        if len(phrase) < 3:
            return None
        data = self._search_phrase(phrase)
        items = data["items"]
        if not items or data.get("match") not in ("text", "text_all_columns", "code") and not data.get("relaxed_query"):
            return None
        best = items[0]
        try:
            detail = self.tools.get_product(best["hsn8"])
        except ToolInputError:
            return None
        shown = data.get("relaxed_query") or data.get("hs_wording") or phrase
        head = (f"Closest line for **{phrase}**" + (f" (matched on *{shown}*)" if shown != phrase else "")
                + f" - {data['total_matches']:,} matching line(s); figures are HS6-level.")
        card = self._product_card(detail)
        others = items[1:5]
        tail = ""
        if others:
            tail = "\n\n**Other close matches:**\n\n" + md_table(
                ["HS code", "Product", "Ministry", "RCA", "India exports", "India imports"],
                [[code_label(p["hsn8"]), _short(p["description"], 55), p["ministry"], num(p["rca"]),
                  usd(p["exports_usd"]), usd(p["imports_usd"])] for p in others])
        return f"{head}\n\n{card}{tail}"

    def _top_flow(self, text: str) -> str | None:
        m = _TOP_FLOW.search(text)
        if not m:
            return None
        flow = "imports" if "import" in m.group(0).lower() else "exports"
        mentioned, sector = self._entities(text)
        if not mentioned and not sector and not _SECTOR_CUE.search(text):
            mentioned = self.cat.find_ministry(text)  # "top exports of textiles" -> MoT
        if not mentioned and not sector:
            # "exports of cotton T-shirts" names a product, not a scope: the product card answers it
            leftover = [w for w in _product_phrase(text).split() if w.lower() not in _RANK_WORDS]
            if len(" ".join(leftover)) >= 3:
                return None
        if mentioned or sector:
            kind, entity = ("ministry", mentioned) if mentioned else ("sector", sector)
            data = self.tools._entity_summary(kind, entity)
            self.trace.used(f"{kind}_summary")
            items = data[f"top_{flow}"]
            k = data["kpis"]
            head = (f"**Top {flow} - {entity['name']}** ({k.get('codes'):,} lines; total {flow} "
                    f"{usd(k.get(flow))}, trade balance {usd(k.get('trade_balance'))})")
            table = md_table(["HS code", "Product", "India exports", "India imports", "RCA"],
                             [[code_label(p["hsn8"]), _short(p["description"], 60), usd(p["exports"]),
                               usd(p["imports"]), num(p["rca"])] for p in items])
            return (f"{head}\n\n{table}\n\n_One line per HS6 (trade is reported at HS6). Source: "
                    f"{trade_note(self.tools.year)}._")
        column = "india_exports" if flow == "exports" else "india_imports"
        data = rows(self.tools.conn, f"SELECT hs6, india_exports, india_imports, rca FROM hs6_metrics "
                                     f"ORDER BY {column} DESC LIMIT ?", (TABLE_ROWS,))
        total = row(self.tools.conn, f"SELECT SUM({column}) AS v FROM hs6_metrics")["v"]
        meta = self.tools._hs6_meta([d["hs6"] for d in data])
        for d in data:
            self.tools._cite_hs6(d["hs6"], meta.get(d["hs6"], {}))
        self.trace.used("search_products")
        table = md_table(["HS6", "Product", "Ministry", "India exports", "India imports"],
                         [[code_label(d["hs6"]), _short(meta.get(d["hs6"], {}).get("description"), 60),
                           meta.get(d["hs6"], {}).get("ministry"), usd(d["india_exports"]), usd(d["india_imports"])]
                          for d in data])
        return (f"**India's top {flow} {self.tools.year}** (total {usd(total)} across all HS6 products)\n\n{table}\n\n"
                f"_Source: {trade_note(self.tools.year)}. Name a ministry or sector to narrow it down._")

    def _opportunities(self, text: str) -> str | None:
        if not _OPPORTUNITY.search(text):
            return None
        scope = self._scope_from_text(text)
        label = scope.pop("label", None)
        rank_by = "untapped" if re.search(r"(?i)untapped|gap", text) else "score"
        data = self.tools.top_opportunities(**scope, rank_by=rank_by, limit=TABLE_ROWS)
        if not data["items"]:
            return f"No scored products for {label or 'that scope'}."
        table = md_table(["HS6", "Product", "Score", "Untapped", "India exports", "RCA", "World CAGR", "Archetype"],
                         [[code_label(i["hs6"]), _short(i["description"], 55), num(i["export_potential_score"], 0),
                           usd(i["untapped_potential_usd"]), usd(i["india_exports"]), num(i["rca"]),
                           pct(i["world_cagr"]), i["archetype"]] for i in data["items"]])
        return (f"**Export opportunities - {label or 'all products'}** (ranked by "
                f"{'untapped potential' if rank_by == 'untapped' else 'export-potential score'}; scope total untapped "
                f"potential {usd(data['scope_total_untapped_usd'])})\n\n{table}\n\n_{MODEL_NOTE.capitalize()}: "
                f"{data['method']} Inputs: {trade_note(self.tools.year)}._")

    def _dependence(self, text: str) -> str | None:
        if not _DEPENDENCE.search(text):
            return None
        target = None
        m = re.search(r"(?i)\b(?:on|from|upon|to)\s+([A-Za-z][A-Za-z .'-]{2,40})", text)
        if m:
            target = self.cat.find_country(m.group(1))
        target = target or self.cat.find_country(text)
        if not target:
            return None
        scope = self._scope_from_text(re.sub(re.escape(target["name"]), " ", text, flags=re.IGNORECASE))
        label = scope.pop("label", None)
        data = self.tools.import_dependencies(country=target["id"], **scope, limit=TABLE_ROWS)
        if not data["items"]:
            return f"India's partner data shows no imports from {target['name']} in {label or 'this scope'}."
        head = (f"**India's import dependence on {target['name']} - {label or 'all products'}**\n\n"
                f"Imports from {target['name']}: {usd(data.get('imports_from_country_usd'))} = "
                f"{pct(data.get('country_share_of_scope_imports'))} of India's imports in this scope "
                f"({usd(data.get('scope_total_imports_usd'))}). "
                f"{data.get('hs6_with_country_share_ge_60pct_and_imports_ge_50mn') or 0} HS6 products import >= 60% "
                f"from {target['name']} with imports >= $50 mn (worth {usd(data.get('value_of_those_imports_usd'))}).")
        table = md_table(["HS6", "Product", "Ministry", f"From {target['name']}", "Share", "India imports",
                          "Vulnerability"],
                         [[code_label(i["hs6"]), _short(i["description"], 50), i["ministry"],
                           usd(i["imports_from_country"]), pct(i["country_share"]), usd(i["india_imports"]),
                           num(i["vulnerability_score"], 0)] for i in data["items"]])
        return (f"{head}\n\n{table}\n\n_Source: CEPII BACI {self.tools.year} partner data via OEC; vulnerability "
                f"is a {MODEL_NOTE}._")

    def _vulnerability(self, text: str) -> str | None:
        if not _VULNERABLE.search(text):
            return None
        scope = self._scope_from_text(text)
        label = scope.pop("label", None)
        data = self.tools.import_dependencies(**scope, limit=TABLE_ROWS)
        if not data["items"]:
            return f"No scored import-dependent products for {label or 'this scope'}."
        table = md_table(["HS6", "Product", "Ministry", "India imports", "Top source", "Share", "China share",
                          "Vulnerability"],
                         [[code_label(i["hs6"]), _short(i["description"], 50), i["ministry"], usd(i["india_imports"]),
                           i["top_import_source"], pct(i["top_import_source_share"]), pct(i["china_import_share"]),
                           num(i["vulnerability_score"], 0)] for i in data["items"]])
        return (f"**Most import-vulnerable products - {label or 'all products'}** (imports >= "
                f"{usd(data['min_imports_usd'])})\n\n{table}\n\n_Vulnerability = 100 x (0.30 dependency ratio + 0.25 "
                f"import HHI + 0.20 China share + 0.25 pct(log imports)) - a {MODEL_NOTE}. Source: "
                f"{trade_note(self.tools.year)}._")

    def _chain(self, text: str) -> str | None:
        chain = self.cat.find_chain(text)
        if not chain or not _CHAIN_WORD.search(text):
            return None
        d = self.tools.chain_summary(chain["id"])
        c, t = d["chain"], d["anchor_trade"]
        out = [f"### {c['title'] or c['name']}", c["description"] or "", "",
               f"- **Lead ministry:** {c['lead_ministry'] or 'Not available'}; mapping source *{c['mapping_source']}*",
               f"- **Anchor HS {c['anchor_hs']} ({self.tools.year}):** India exports {usd(t['india_exports'])}, imports "
               f"{usd(t['india_imports'])}, world trade {usd(t['world_trade'])}, India's share {pct(t['india_share'], 2)}"
               + (f", rank **#{d['india_supplier_rank']}** among world suppliers" if d["india_supplier_rank"] else "")]
        top = ", ".join(f"{s['country']} ({pct(s['share'])})" for s in d["top_world_suppliers"][:5]
                        if s["country"] != "India")
        if top:
            out.append(f"- **Top world suppliers:** {top}")
        for p in d["production"][:2]:
            if p.get("value") is not None:
                out.append(f"- **{str(p.get('label') or '').replace('_', ' ').capitalize()}:** {fmt_qty(p['value'])} "
                           f"{p.get('unit') or ''} ({p.get('source') or 'source not stated'}, "
                           f"{p.get('status') or 'not verified'})")
        out += ["", "**Stages:** " + " -> ".join(f"{s['stage']} ({len(s['items'])} items)" for s in d["stages"])]
        if d["most_import_exposed_inputs"]:
            out += ["", md_table(["Input", "HS code", "Stage", "India imports", "Vulnerability"],
                                 [[e["item"], e["hs_code"], e["stage"], usd(e["imports"]),
                                   num(e["vulnerability_score"], 0)] for e in d["most_import_exposed_inputs"]])]
        out.append(f"\n_Source: {d['provenance']}_")
        return "\n".join(out)

    def _entity(self, text: str) -> str | None:
        m = self.cat.ministry_by_short_name(text)
        if not m and not (_MINISTRY_CUE.search(text) or _SECTOR_CUE.search(text) or _SUMMARY_CUE.search(text)):
            return None  # a bare product word ("natural rubber", "steel") is a search, not a dashboard
        s = None
        if not m:
            m, s = self._entities(text)
            if not m and not s and _SUMMARY_CUE.search(text):
                m = self.cat.find_ministry(text)
        kind, entity = ("ministry", m) if m else ("sector", s)
        if not entity:
            return None
        d = self.tools._entity_summary(kind, entity)
        self.trace.used(f"{kind}_summary")
        k = d["kpis"]
        out = [f"### {entity['name']}",
               f"- **Lines owned:** {k.get('codes', 0):,} ({k.get('accepted', 0):,} accepted"
               + (f", {k['verified_codes']:,} verified" if k.get("verified_codes") is not None else "") + ")",
               f"- **Trade {self.tools.year}:** exports {usd(k.get('exports'))}, imports {usd(k.get('imports'))}, "
               f"balance {usd(k.get('trade_balance'))}",
               f"- **Value chains involved:** {k.get('chains_involved', 0)}"
               + (f" ({', '.join(c['name'] for c in d['value_chains'][:5])})" if d["value_chains"] else "")]
        if kind == "ministry":
            out.append(f"- **Helpdesk / residual:** {k.get('open_tickets', 0)} open tickets, "
                       f"{k.get('pending_claims', 0)} pending claims")
        out += ["", "**Top exports**", md_table(["HS code", "Product", "Exports", "RCA"],
                                                [[code_label(p["hsn8"]), _short(p["description"], 60),
                                                  usd(p["exports"]), num(p["rca"])] for p in d["top_exports"]])]
        if d["dependency_hotspots"]:
            out += ["", f"**Dependency hotspots** ({MODEL_NOTE})",
                    md_table(["HS code", "Product", "Imports", "Top source", "Vulnerability"],
                             [[code_label(p["hsn8"]), _short(p["description"], 55), usd(p["imports"]),
                               p.get("top_import_source_name"), num(p.get("vulnerability_score"), 0)]
                              for p in d["dependency_hotspots"][:5]])]
        out.append(f"\n_Source: {d['provenance']}_")
        return "\n".join(out)

    def _search(self, text: str) -> str | None:
        phrase = _product_phrase(text)
        if len(phrase) < 3:
            return None
        data = self._search_phrase(phrase)
        if not data["items"]:
            return None
        table = md_table(["HS code", "Product", "Ministry", "India exports", "India imports"],
                         [[code_label(p["hsn8"]), _short(p["description"], 60), p["ministry"], usd(p["exports_usd"]),
                           usd(p["imports_usd"])] for p in data["items"]])
        shown = data["relaxed_query"] or data.get("hs_wording") or phrase
        relaxed = (f"No line contains every word of *{phrase}*; closest matches shown. "
                   if data["relaxed_query"] else
                   f"The HS describes *{phrase}* as *{shown}*. " if data.get("hs_wording") else "")
        return (f"{relaxed}Lines matching **{shown}** ({data['total_matches']:,} in total):\n\n{table}\n\n"
                "_Ask about one code for its full profile, or try 'which ministry handles ...', 'top exports of ...', "
                "'opportunities in ...' or 'dependence on China'._")


def chat_offline(conn: sqlite3.Connection, messages: list[dict], notice: str | None = None) -> dict:
    """Deterministic answer to the last user message (see :class:`OfflineAssistant`)."""
    question = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
    bot = OfflineAssistant(conn)
    reply = bot.answer(question)
    if notice:
        reply = f"_{notice}_\n\n{reply}"
    return {"reply": reply, "citations": bot.trace.citation_list(reply), "mode": "offline",
            "tools_used": bot.trace.tools_used, "model": None}


# --------------------------------------------------------------------------- Claude mode

SYSTEM_PROMPT = """You are "Ask Atlas", the analyst assistant of the India Manufacturing Atlas - DPIIT's HSN-code \
intelligence platform. It turns the HSN Guidebook (about 12,000 eight-digit HSN codes mapped to 31 ministries and \
departments) into a live, evidence-led atlas for government officials and industry users.

What the data is:
- Product lines: India's 8-digit ITC-HS / GST HSN lines, each with a primary owning ministry from the public \
DPIIT Guidebook on HSN Code Mapping (16.12.2025 revision; accepted lines are verified). Residual lines, including \
GST lines absent from the Guidebook, have no accepted owner and are not verified. 'official_upload' comes from \
DPIIT uploads and 'manual' from approved ministry claims (both verified). Ownership at 2/4/6 digits is aggregated \
from the accepted 8-digit lines and must be described as derived.
- Trade: India's exports and imports are the official DGFT/DGCIS TRADESTAT series, financial years FY2018-19 to \
FY2024-25 (the latest, labelled 2024), US$, per 8-digit line; a line DGCIS does not publish separately has no figure \
of its own (say "not available", never zero). World trade, partner countries and supplier ranks are CEPII BACI HS 2022 \
(via the OEC API), 2024, at HS6 level. RCA is Balassa revealed comparative advantage (> 1 = advantage).
- Tariffs: WITS / UNCTAD TRAINS India MFN applied simple averages (2022).
- Production: UNIDO INDSTAT 2026 (ISIC Rev.4 output, US$, 2022), the Rubber Board (natural rubber, 2023-24) and \
ATMA (tyre production, FY2022-23), plus official uploads. Always give the source and year.
- Model estimates: export-potential, untapped potential, import-dependency, vulnerability and substitution scores, \
archetypes and forecasts are model estimates (method at /about#methodology) - always label them so.

How to answer:
- Use the tools for every number and every ownership statement; never estimate or recall figures yourself. If the \
tools return nothing, say the figure is "Not available". Name ministries exactly as the tools do (e.g. "Ministry of \
Textiles (MoT)"); never expand an abbreviation yourself.
- For one product's RCA, tariff, partners or scores call get_product with its 8-digit hsn8 (use search_products \
first if you only have a name); lookup_code gives heading-level totals plus per-HS6 RCA.
- Prefer one or two well-chosen tool calls; call several in parallel when they are independent.
- Write concise markdown for a policy audience: a one-line answer first, then a short table or bullets. Format \
money as $3.11 bn / $812 mn and shares as percentages. Write HS codes as 4011.10.10 (8-digit) or 4011.10 (HS6).
- Mention provenance briefly (source and year; "DPIIT Guidebook" for accepted owners, "residual" for unowned \
lines, "derived from 8-digit lines" for parent-level ownership; "model estimate" for scores).
- Stay within the Atlas's scope (Indian manufacturing, HS codes, trade, tariffs, ministries, value chains, \
policy schemes). For anything else, say briefly what you can help with instead.

Catalogue (ids accepted by the tools):
{catalog}"""


def _system_blocks(catalog: Catalog) -> list[dict]:
    return [{"type": "text", "text": SYSTEM_PROMPT.format(catalog=catalog.prompt_block()),
             "cache_control": {"type": "ephemeral"}}]


def _tool_result_content(payload: Any) -> str:
    text = json.dumps(payload, ensure_ascii=False, default=str, separators=(",", ":"))
    if len(text) > TOOL_RESULT_MAX_CHARS:
        text = text[:TOOL_RESULT_MAX_CHARS] + '..."[truncated - narrow the query or lower the limit]"'
    return text


def _text_of(content: list) -> str:
    return "\n\n".join(b.text for b in content if getattr(b, "type", None) == "text" and b.text).strip()


def chat_claude(conn: sqlite3.Connection, messages: list[dict], api_key: str,
                client_factory: Callable[[str], Any] | None = None) -> dict:
    """Claude tool-use loop (see module docstring). ``client_factory(api_key)`` lets tests inject a fake client."""
    import anthropic

    tools = AtlasTools(conn)
    client = (client_factory or (lambda key: anthropic.Anthropic(api_key=key, timeout=90.0, max_retries=2)))(api_key)
    convo: list[dict] = [{"role": m["role"], "content": m["content"]} for m in messages]
    system = _system_blocks(tools.catalog)
    reply = ""
    try:
        for round_no in range(MAX_TOOL_ROUNDS + 1):
            last_round = round_no == MAX_TOOL_ROUNDS
            response = client.beta.messages.create(
                model=MODEL, max_tokens=MAX_TOKENS, system=system, tools=TOOL_DEFS, messages=convo,
                output_config={"effort": EFFORT}, betas=[FALLBACK_BETA], fallbacks="default",
                **({"tool_choice": {"type": "none"}} if last_round else {}))
            stop = response.stop_reason
            if stop == "refusal":
                reply = ("I can't help with that request. I can answer questions about HS codes, ministries, trade, "
                         "tariffs, value chains and policy schemes in the Atlas.")
                break
            if stop == "pause_turn":
                convo.append({"role": "assistant", "content": response.content})
                continue
            tool_uses = [b for b in response.content if getattr(b, "type", None) == "tool_use"]
            if stop == "tool_use" and tool_uses and not last_round:
                convo.append({"role": "assistant", "content": response.content})
                results = []
                for block in tool_uses:
                    try:
                        payload = run_tool(tools, block.name, block.input if isinstance(block.input, dict) else {})
                        results.append({"type": "tool_result", "tool_use_id": block.id,
                                        "content": _tool_result_content(payload)})
                    except ToolInputError as exc:
                        results.append({"type": "tool_result", "tool_use_id": block.id,
                                        "content": f"Error: {exc}", "is_error": True})
                    except (sqlite3.Error, KeyError, TypeError, ValueError) as exc:
                        log.exception("assistant tool %s failed", block.name)
                        results.append({"type": "tool_result", "tool_use_id": block.id,
                                        "content": f"Error: the tool failed ({exc.__class__.__name__})",
                                        "is_error": True})
                convo.append({"role": "user", "content": results})
                continue
            reply = _text_of(response.content)
            if stop == "max_tokens":
                reply += "\n\n_(Answer cut short - ask a narrower question for the rest.)_"
            break
    except anthropic.AuthenticationError:
        return chat_offline(conn, messages, "Claude mode is unavailable (the API key was rejected) - offline answer:")
    except anthropic.PermissionDeniedError:
        return chat_offline(conn, messages, "Claude mode is unavailable (permission denied) - offline answer:")
    except anthropic.RateLimitError:
        return chat_offline(conn, messages, "Claude is rate-limited right now - offline answer:")
    except anthropic.BadRequestError as exc:
        log.warning("assistant request rejected by the API: %s", exc)
        return chat_offline(conn, messages, "Claude could not process this conversation - offline answer:")
    except anthropic.APIStatusError as exc:
        log.warning("assistant API error %s: %s", exc.status_code, exc)
        return chat_offline(conn, messages, f"Claude is unavailable (HTTP {exc.status_code}) - offline answer:")
    except anthropic.APIConnectionError as exc:  # includes timeouts
        log.warning("assistant API connection error: %s", exc)
        return chat_offline(conn, messages, "Claude could not be reached - offline answer:")
    if not reply:
        reply = "I could not produce an answer from the Atlas data for that question."
    return {"reply": reply, "citations": tools.trace.citation_list(reply), "mode": "claude",
            "tools_used": tools.trace.tools_used, "model": MODEL}


# --------------------------------------------------------------------------- free / OpenAI-compatible LLMs

#: Providers that speak the OpenAI chat-completions protocol with tool calling, most with a free tier.
#: ``LLM_MODEL`` / ``LLM_BASE_URL`` override the defaults (model names change; check the provider's console).
LLM_PROVIDERS = {
    "groq": {"base_url": "https://api.groq.com/openai/v1", "model": "openai/gpt-oss-120b",
             "key_env": "GROQ_API_KEY", "label": "Groq",
             # each Groq model has its own free-tier rate limit: on a 429 the question moves to the next one
             "fallbacks": ["openai/gpt-oss-20b", "qwen/qwen3.8-27b"]},
    "xai": {"base_url": "https://api.x.ai/v1", "model": "grok-3-mini", "key_env": "XAI_API_KEY", "label": "xAI Grok"},
    "gemini": {"base_url": "https://generativelanguage.googleapis.com/v1beta/openai", "model": "gemini-2.0-flash",
               "key_env": "GEMINI_API_KEY", "label": "Google Gemini"},
    "openrouter": {"base_url": "https://openrouter.ai/api/v1", "model": "meta-llama/llama-3.3-70b-instruct:free",
                   "key_env": "OPENROUTER_API_KEY", "label": "OpenRouter"},
}
# Free tiers allow roughly 6-8k tokens per minute, and every tool round resends the whole conversation, so the
# free-LLM loop is deliberately lean: few rounds, compact tool results, short answers, one wait on a brief 429.
LLM_MAX_TOKENS = 1200
LLM_MAX_TOOL_ROUNDS = 3
LLM_TOOL_RESULT_MAX_CHARS = 3500
LLM_RETRY_MAX_WAIT_S = 8.0


def llm_config() -> dict | None:
    """The configured OpenAI-compatible provider, or None.

    ``LLM_PROVIDER`` picks a preset (groq | xai | gemini | openrouter); without it the first provider whose own key
    variable (``GROQ_API_KEY`` ...) is set wins. ``LLM_API_KEY`` works for any provider.
    """
    name = (os.environ.get("LLM_PROVIDER") or "").strip().lower()
    if name and name not in LLM_PROVIDERS and not os.environ.get("LLM_BASE_URL"):
        log.warning("LLM_PROVIDER=%s is unknown and LLM_BASE_URL is not set - assistant stays offline", name)
        return None
    if not name:
        name = next((n for n, p in LLM_PROVIDERS.items() if os.environ.get(p["key_env"])), "")
        if not name and os.environ.get("LLM_API_KEY") and os.environ.get("LLM_BASE_URL"):
            name = "custom"
    if not name:
        return None
    preset = LLM_PROVIDERS.get(name, {"base_url": "", "model": "", "key_env": "", "label": name})
    key = os.environ.get("LLM_API_KEY") or (os.environ.get(preset["key_env"]) if preset["key_env"] else None)
    base = (os.environ.get("LLM_BASE_URL") or preset["base_url"]).rstrip("/")
    model = os.environ.get("LLM_MODEL") or preset["model"]
    if not (key and base and model):
        return None
    raw_fallbacks = os.environ.get("LLM_FALLBACK_MODELS")
    fallbacks = ([m.strip() for m in raw_fallbacks.split(",") if m.strip()] if raw_fallbacks is not None
                 else list(preset.get("fallbacks", [])))
    models = [model] + [m for m in fallbacks if m != model]
    return {"provider": name, "label": preset["label"], "base_url": base, "model": model, "models": models,
            "api_key": key}


def _openai_tools() -> list[dict]:
    return [{"type": "function", "function": {"name": t["name"], "description": t["description"],
                                              "parameters": t["input_schema"]}} for t in TOOL_DEFS]


def _retry_after_seconds(resp: Any) -> float | None:
    """Seconds a 429 asks us to wait (``retry-after`` header, or Groq's "try again in 2.5s" message), else None."""
    headers = getattr(resp, "headers", None) or {}
    raw = headers.get("retry-after") or headers.get("Retry-After")
    try:
        if raw is not None:
            return float(raw)
    except (TypeError, ValueError):
        pass
    match = re.search(r"try again in ([\d.]+)\s*(ms|s)\b", getattr(resp, "text", "") or "")
    if match:
        value = float(match.group(1))
        return value / 1000 if match.group(2) == "ms" else value
    return None


def chat_llm(conn: sqlite3.Connection, messages: list[dict], cfg: dict, post: Callable[..., Any] | None = None,
             sleep: Callable[[float], None] | None = None) -> dict:
    """Tool-calling loop against an OpenAI-compatible endpoint (Groq, xAI, Gemini, OpenRouter ...).

    ``post`` / ``sleep`` let tests inject fakes. Any API failure falls back to the offline assistant.
    """
    import time as _time

    import requests

    post = post or requests.post
    sleep = sleep or _time.sleep
    tools = AtlasTools(conn)
    system = SYSTEM_PROMPT.format(catalog=tools.catalog.prompt_block())
    convo: list[dict] = [{"role": "system", "content": system}] + [
        {"role": m["role"], "content": m["content"]} for m in messages]
    url = f"{cfg['base_url']}/chat/completions"
    headers = {"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"}
    label = cfg["label"]
    models = list(cfg.get("models") or [cfg["model"]])
    used_model = models[0]
    reply = ""

    def request(body: dict) -> Any:
        """POST, moving to the next model on a 429 (own rate-limit bucket) or a 404 (model retired)."""
        nonlocal used_model
        resp = None
        while models:
            used_model = models[0]
            body["model"] = used_model
            if used_model.startswith("openai/gpt-oss"):
                body["reasoning_effort"] = "low"   # fewer hidden reasoning tokens against the free budget
            else:
                body.pop("reasoning_effort", None)
            resp = post(url, headers=headers, json=body, timeout=60)
            if resp.status_code == 429:
                wait = _retry_after_seconds(resp)
                if wait is not None and wait <= LLM_RETRY_MAX_WAIT_S and len(models) == 1:
                    sleep(wait + 0.25)
                    resp = post(url, headers=headers, json=body, timeout=60)
            if resp.status_code in (404, 429) and len(models) > 1:
                log.info("LLM %s model %s answered %s - trying %s", label, used_model, resp.status_code, models[1])
                models.pop(0)
                continue
            return resp
        return resp

    for round_no in range(LLM_MAX_TOOL_ROUNDS + 1):
        last_round = round_no == LLM_MAX_TOOL_ROUNDS
        body = {"messages": convo, "max_tokens": LLM_MAX_TOKENS, "temperature": 0.2}
        if not last_round:
            body.update(tools=_openai_tools(), tool_choice="auto")
        try:
            resp = request(body)
        except requests.RequestException as exc:
            log.warning("LLM %s connection error: %s", label, exc)
            return chat_offline(conn, messages, f"{label} could not be reached - offline answer:")
        if resp.status_code in (401, 403):
            return chat_offline(conn, messages, f"{label} rejected the API key - offline answer:")
        if resp.status_code == 429:
            return chat_offline(conn, messages, f"{label} free-tier limit reached right now - offline answer:")
        if resp.status_code >= 400:
            log.warning("LLM %s HTTP %s: %s", label, resp.status_code, resp.text[:500])
            return chat_offline(conn, messages, f"{label} is unavailable (HTTP {resp.status_code}) - offline answer:")
        try:
            choice = resp.json()["choices"][0]
            msg = choice["message"]
        except (ValueError, KeyError, IndexError, TypeError):
            return chat_offline(conn, messages, f"{label} returned an unreadable answer - offline answer:")
        calls = msg.get("tool_calls") or []
        if calls and not last_round:
            convo.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": calls})
            for call in calls:
                fn = call.get("function") or {}
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                    payload = run_tool(tools, fn.get("name", ""), args if isinstance(args, dict) else {})
                    content = _tool_result_content(payload)
                except ToolInputError as exc:
                    content = f"Error: {exc}"
                except (json.JSONDecodeError, sqlite3.Error, KeyError, TypeError, ValueError) as exc:
                    log.exception("assistant tool %s failed", fn.get("name"))
                    content = f"Error: the tool failed ({exc.__class__.__name__})"
                if len(content) > LLM_TOOL_RESULT_MAX_CHARS:
                    content = content[:LLM_TOOL_RESULT_MAX_CHARS] + '..."[truncated]"'
                convo.append({"role": "tool", "tool_call_id": call.get("id", ""), "content": content})
            continue
        reply = (msg.get("content") or "").strip()
        if choice.get("finish_reason") == "length":
            reply += "\n\n_(Answer cut short - ask a narrower question for the rest.)_"
        break
    if not reply:
        reply = "I could not produce an answer from the Atlas data for that question."
    return {"reply": reply, "citations": tools.trace.citation_list(reply), "mode": cfg["provider"],
            "tools_used": tools.trace.tools_used, "model": used_model}


# --------------------------------------------------------------------------- dispatch


def status() -> dict:
    """``{mode, model}`` - ``claude`` when ``ANTHROPIC_API_KEY`` is set, else the configured free LLM, else offline."""
    key = get_settings().anthropic_api_key
    tool_names = [t["name"] for t in TOOL_DEFS]
    if key:
        return {"mode": "claude", "model": MODEL, "provider": "Anthropic", "tools": tool_names}
    cfg = llm_config()
    if cfg:
        return {"mode": cfg["provider"], "model": cfg["model"], "provider": cfg["label"], "tools": tool_names}
    return {"mode": "offline", "model": None, "provider": None, "tools": tool_names}


def normalize_messages(messages: list[dict]) -> list[dict]:
    """Drop empty / leading assistant turns and merge consecutive same-role turns (the API needs alternation)."""
    out: list[dict] = []
    for m in messages:
        content = (m.get("content") or "").strip()
        role = m.get("role")
        if not content or role not in ("user", "assistant"):
            continue
        if not out and role == "assistant":
            continue
        if out and out[-1]["role"] == role:
            out[-1]["content"] += "\n\n" + content
        else:
            out.append({"role": role, "content": content})
    return out


def chat(conn: sqlite3.Connection, messages: list[dict]) -> dict:
    """Answer a conversation (``[{role, content}]``, last turn from the user) in the configured mode."""
    convo = normalize_messages(messages)
    key = get_settings().anthropic_api_key
    if key and convo:
        try:
            import anthropic  # noqa: F401 - availability check; chat_claude imports it again (cached)
        except ImportError:
            log.warning("ANTHROPIC_API_KEY is set but the anthropic SDK is not installed - answering offline")
            return chat_offline(conn, convo, "Claude mode is unavailable (SDK not installed) - offline answer:")
        return chat_claude(conn, convo, key)
    cfg = llm_config()
    if cfg and convo:
        return chat_llm(conn, convo, cfg)
    return chat_offline(conn, convo)


__all__ = ["AtlasTools", "Catalog", "OfflineAssistant", "TOOL_DEFS", "MODEL", "chat", "chat_offline",
           "chat_claude", "chat_llm", "llm_config", "LLM_PROVIDERS", "status", "run_tool", "find_codes", "normalize_messages", "ToolInputError"]
