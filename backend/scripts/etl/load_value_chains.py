"""ETL step 9 — curated value chains (``data/curated/value_chains.json``, owner B1).

Tables written
--------------
* ``value_chains``  one row per chain; ``manufacturers_json`` and ``skill_council_json`` hold the JSON objects
                    verbatim; ``notes_json`` holds the chain's optional curator notes.
* ``vc_stages``     ``(chain_id, stage_id)``; ``ministry_ids_json`` = JSON array of ministry ids.
* ``vc_items``      one row per item. ``item_order`` is the 1-based position inside its stage. ``hs_code`` keeps
                    the curated code (8, 6, 4 or 2 digits); ``hsn8`` is set only when ``hs_code`` is an 8-digit
                    line present in ``products``.

Ministries of curated items (the Atlas's own mapping, never a second opinion)
-----------------------------------------------------------------------------
The curated ``ministry_ids`` / ``ministry_text`` of the JSON are only the curator's suggestion: the loader
replaces them with the Atlas's product mapping so a chain page can never name a different owner than the
product page - an 8-digit line gets ``products.ministry_id`` (``residual`` when the line is unmapped) followed
by its secondary owners from ``product_ministries``; a 4/6-digit code gets the most common non-residual primary
owner of the lines under it (ties -> the owner of the lowest line). Codes with no mapped line keep the curated
ids. Stages whose items were re-derived get the union of their items' owners (residual excluded) and a matching
``ministry_text``. ``stats["curated_ministries_rederived"]`` lists every item whose owner changed.
* ``vc_edges``      the chain's explicit ``edges`` (``source`` = edge ``source`` if given, else the chain's
                    ``source``); when a chain omits ``edges`` every coded item of stage k is linked to every coded item
                    of stage k+1 with relation ``input_to``. ``chain_id`` = the chain that declares the edge, also for
                    cross-chain edges (edges whose src or dst is an item of another chain).
* ``clusters``      manufacturing clusters; a cluster id listed by several chains is stored once with all their
                    chain ids. ``sector_ids_json`` comes from each chain's ``anchor_hs`` via ``curated/sectors.json``
                    (heading override first, then chapter) unless the cluster lists ``sector_ids`` itself.
* ``production``    scope ``'chain'`` rows are owned by :mod:`scripts.etl.seed_ops`, which loads the real sourced
                    figures from ``data/curated/production.json``; this step clears them before a reload.

Validation (raises :class:`ValueChainError`, which aborts the build)
-------------------------------------------------------------------
* unknown ministry ids (``lead_ministry_id``, stage and item ``ministry_ids``) — checked against the ``ministries``
  table, or against ``curated/ministries.json`` when that table is still empty;
* duplicate chain ids / stage ids, malformed HS codes, unknown edge relations or sources.

Stage/item ``ministry_ids`` missing in the JSON are resolved from ``ministry_text`` with the ``aliases`` of
``curated/ministries.json`` (:func:`resolve_ministry_text`). Codes that are in neither ``products`` nor
``hs_nodes`` are only reported (``unknown_codes``), never invented or dropped.

Idempotent: ``value_chains``, ``vc_stages`` and ``vc_items`` are fully owned and rebuilt; from ``vc_edges`` only rows
with source ``curated`` are replaced (``hs_text`` links and uploaded edges are kept); from ``clusters`` only
rows with source ``curated``; chain-scope production rows are cleared for ``seed_ops`` to reload.
The ``value_chains.notes_json`` column is created with ``ALTER TABLE`` when the step runs against an older
database, so ``run(conn)`` also works in place.
"""
from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import Any, Iterable

from scripts.etl import CURATED_DIR

VALUE_CHAINS_JSON = CURATED_DIR / "value_chains.json"
MINISTRIES_JSON = CURATED_DIR / "ministries.json"
SECTORS_JSON = CURATED_DIR / "sectors.json"

RELATIONS = frozenset({"input_to", "component_of"})      # 'parts_of' is reserved for derive_part_links
OWNED_SOURCES = ("curated",)                            # vc_edges / clusters rows this step owns
CODE_LENGTHS = frozenset({2, 4, 6, 8})
RESIDUAL = "residual"
# Columns added after the first schema release: (table, column, type) - created in place when missing.
LATER_COLUMNS = (
    ("value_chains", "notes_json", "TEXT"),
)

_ZERO_WIDTH = re.compile(r"[​‌‍﻿]")
_WS = re.compile(r"\s+")


class ValueChainError(ValueError):
    """Raised when value_chains.json is inconsistent with the contract (unknown ministry ids, bad codes...)."""


# --------------------------------------------------------------------------- file helpers

def load_json(path: Path | str = VALUE_CHAINS_JSON) -> dict:
    """Read a curated JSON document (UTF-8, BOM tolerated)."""
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def load_ministries(path: Path | str = MINISTRIES_JSON) -> list[dict]:
    """The ministry records of ``curated/ministries.json`` (with their ``aliases``)."""
    return load_json(path).get("ministries", [])


def normalize_code(value: Any) -> str | None:
    """Return a clean HS code ('4011', '06029090') or None; dots, spaces and zero-width characters are removed.

    Raises :class:`ValueChainError` for anything that is not 2, 4, 6 or 8 digits.
    """
    if value is None:
        return None
    text = _ZERO_WIDTH.sub("", str(value))
    text = re.sub(r"[\s.]", "", text)
    if not text:
        return None
    if not text.isdigit() or len(text) not in CODE_LENGTHS:
        raise ValueChainError(f"malformed HS code {value!r}")
    return text


def _clean_text(value: Any) -> str | None:
    if value is None:
        return None
    text = _WS.sub(" ", _ZERO_WIDTH.sub("", str(value))).strip()
    return text or None


# --------------------------------------------------------------------------- ministry resolution

def build_alias_index(ministries: Iterable[dict]) -> list[tuple[re.Pattern, str]]:
    """Compile one regex per ministry alias (and full name), longest first.

    Short single-token aliases ('DPIIT', 'MoT', 'DoC') match case-sensitively so ordinary words are not mistaken
    for ministries; longer aliases match case-insensitively ('D/o AGRICULTURE & FARMERS WELFARE').
    """
    pairs: list[tuple[str, str]] = []
    for m in ministries:
        for alias in list(m.get("aliases") or []) + [m.get("name")]:
            if alias:
                pairs.append((alias.strip(), m["id"]))
    pairs.sort(key=lambda p: -len(p[0]))
    index = []
    for alias, mid in pairs:
        short = " " not in alias and len(alias) <= 6
        pattern = re.compile(r"(?<![A-Za-z0-9])" + re.escape(alias) + r"(?![A-Za-z0-9])",
                             0 if short else re.IGNORECASE)
        index.append((pattern, mid))
    return index


def resolve_ministry_text(text: str | None, alias_index: list[tuple[re.Pattern, str]]) -> list[str]:
    """Ministry ids named in a free-text cell, in order of appearance.

    >>> idx = build_alias_index(load_ministries())
    >>> resolve_ministry_text("Ministry of Mines & D/o Chemicals and Petrochemicals", idx)
    ['mom', 'dcpc']
    """
    if not text:
        return []
    work = _WS.sub(" ", _ZERO_WIDTH.sub("", text))
    hits: list[tuple[int, str]] = []
    for pattern, mid in alias_index:
        for m in pattern.finditer(work):
            hits.append((m.start(), mid))
        work = pattern.sub(lambda m: " " * len(m.group(0)), work)
    out: list[str] = []
    for _, mid in sorted(hits):
        if mid not in out:
            out.append(mid)
    return out


# --------------------------------------------------------------------------- sectors

def sector_for_code(code: str | None, sectors_doc: dict) -> str | None:
    """Sector id of an HS code per ``curated/sectors.json`` (heading override wins over the chapter)."""
    if not code:
        return None
    overrides = sectors_doc.get("heading_overrides") or {}
    if len(code) >= 4 and code[:4] in overrides:
        return overrides[code[:4]]
    for sector in sectors_doc.get("sectors", []):
        if code[:2] in (sector.get("chapters") or []):
            return sector["id"]
    return None


# --------------------------------------------------------------------------- validation / normalisation

def _known_ministries(conn: sqlite3.Connection | None, ministries: list[dict]) -> set[str]:
    ids: set[str] = set()
    if conn is not None:
        ids = {r[0] for r in conn.execute("SELECT id FROM ministries")}
    return ids or {m["id"] for m in ministries}


def _ids_or_resolved(obj: dict, alias_index, where: str, known: set[str], errors: list[str]) -> list[str]:
    ids = obj.get("ministry_ids")
    if ids is None:
        ids = resolve_ministry_text(obj.get("ministry_text"), alias_index)
    ids = list(ids)
    for mid in ids:
        if mid not in known:
            errors.append(f"{where}: unknown ministry id {mid!r}")
    return ids


def normalise_chains(data: dict, known_ministries: set[str], alias_index) -> list[dict]:
    """Validate the document and return chains with normalised codes and resolved ministry ids.

    Raises :class:`ValueChainError` listing every problem found.
    """
    errors: list[str] = []
    chains_in = data.get("chains") if isinstance(data, dict) else None
    if not isinstance(chains_in, list) or not chains_in:
        raise ValueChainError("value_chains.json must contain a non-empty 'chains' list")
    seen_chains: set[str] = set()
    chains: list[dict] = []
    for pos, raw in enumerate(chains_in, start=1):
        cid = raw.get("id")
        where = f"chain {cid or pos}"
        if not cid or not raw.get("name"):
            errors.append(f"{where}: 'id' and 'name' are required")
            continue
        if cid in seen_chains:
            errors.append(f"{where}: duplicate chain id")
        seen_chains.add(cid)
        try:
            anchor = normalize_code(raw.get("anchor_hs"))
        except ValueChainError as exc:
            errors.append(f"{where}: anchor_hs {exc}")
            anchor = None
        if not anchor:
            errors.append(f"{where}: 'anchor_hs' is required")
        lead = raw.get("lead_ministry_id")
        if lead is not None and lead not in known_ministries:
            errors.append(f"{where}: unknown lead_ministry_id {lead!r}")
        source = raw.get("source") or "curated"
        if source not in OWNED_SOURCES:
            errors.append(f"{where}: source must be one of {OWNED_SOURCES}, got {source!r}")

        stages: list[dict] = []
        seen_stages: set[str] = set()
        for s_pos, st in enumerate(sorted(raw.get("stages") or [], key=lambda s: s.get("order", 0)), start=1):
            sid = st.get("id")
            s_where = f"{where} stage {sid or s_pos}"
            if not sid or not st.get("name"):
                errors.append(f"{s_where}: 'id' and 'name' are required")
                continue
            if sid in seen_stages:
                errors.append(f"{s_where}: duplicate stage id")
            seen_stages.add(sid)
            items: list[dict] = []
            for i_pos, item in enumerate(st.get("items") or [], start=1):
                i_where = f"{s_where} item {i_pos}"
                if not _clean_text(item.get("item")):
                    errors.append(f"{i_where}: 'item' is required")
                try:
                    code = normalize_code(item.get("hs_code"))
                except ValueChainError as exc:
                    errors.append(f"{i_where}: {exc}")
                    code = None
                items.append({
                    "item_order": i_pos,
                    "item_name": _clean_text(item.get("item")) or "",
                    "hs_code": code,
                    "description": _clean_text(item.get("description")),
                    "ministry_text": _clean_text(item.get("ministry_text")),
                    "ministry_ids": _ids_or_resolved(item, alias_index, i_where, known_ministries, errors),
                    "source": item.get("source") or source,
                })
            stage_ids = st.get("ministry_ids")
            if stage_ids is None and not st.get("ministry_text"):
                stage_ids = list(dict.fromkeys(m for it in items for m in it["ministry_ids"]))
                st = {**st, "ministry_ids": stage_ids}
            stages.append({
                "stage_id": sid,
                "name": _clean_text(st.get("name")),
                "stage_order": int(st.get("order") or s_pos),
                "ministry_text": _clean_text(st.get("ministry_text")),
                "ministry_ids": _ids_or_resolved(st, alias_index, s_where, known_ministries, errors),
                "items": items,
            })

        edges = None
        if raw.get("edges") is not None:
            edges = []
            for e_pos, e in enumerate(raw["edges"], start=1):
                e_where = f"{where} edge {e_pos}"
                try:
                    src, dst = normalize_code(e.get("src")), normalize_code(e.get("dst"))
                except ValueChainError as exc:
                    errors.append(f"{e_where}: {exc}")
                    continue
                relation = e.get("relation") or "input_to"
                e_source = e.get("source") or source
                if not src or not dst:
                    errors.append(f"{e_where}: 'src' and 'dst' are required")
                    continue
                if relation not in RELATIONS:
                    errors.append(f"{e_where}: relation must be one of {sorted(RELATIONS)}, got {relation!r}")
                if e_source not in OWNED_SOURCES:
                    errors.append(f"{e_where}: source must be one of {OWNED_SOURCES}, got {e_source!r}")
                edges.append({"src": src, "dst": dst, "relation": relation, "source": e_source,
                              "weight": float(e.get("weight", 1) or 1)})

        clusters = []
        for c in raw.get("clusters") or []:
            if not c.get("id") or not c.get("name") or not c.get("state"):
                errors.append(f"{where}: cluster needs 'id', 'name' and 'state' ({c!r})")
                continue
            clusters.append(c)

        notes_raw = raw.get("_notes") or raw.get("notes") or []
        if not isinstance(notes_raw, list):
            errors.append(f"{where}: _notes must be a list of strings")
            notes_raw = []
        notes = [_clean_text(n) for n in notes_raw if _clean_text(n)]

        chains.append({
            "id": cid,
            "name": _clean_text(raw.get("name")),
            "title": _clean_text(raw.get("title")),
            "anchor_hs": anchor,
            "lead_ministry_id": lead,
            "description": _clean_text(raw.get("description")),
            "phase": raw.get("phase"),
            "source": source,
            "sort_order": raw.get("sort_order", pos),
            "manufacturers": raw.get("manufacturers") or [],
            "skill_council": raw.get("skill_council"),
            "stages": stages,
            "edges": edges,
            "clusters": clusters,
            "notes": notes,
        })
    if errors:
        raise ValueChainError("value_chains.json is invalid:\n  - " + "\n  - ".join(errors))
    return chains


def default_edges(stages: list[dict], source: str) -> list[dict]:
    """Every coded item of stage k -> every coded item of stage k+1 (relation ``input_to``), de-duplicated."""
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    ordered = sorted(stages, key=lambda s: s["stage_order"])
    for left, right in zip(ordered, ordered[1:]):
        for a in left["items"]:
            for b in right["items"]:
                if a["hs_code"] and b["hs_code"] and a["hs_code"] != b["hs_code"]:
                    key = (a["hs_code"], b["hs_code"])
                    if key not in seen:
                        seen.add(key)
                        out.append({"src": key[0], "dst": key[1], "relation": "input_to",
                                    "source": source, "weight": 1.0})
    return out


# --------------------------------------------------------------------------- loading

def _dumps(obj: Any) -> str | None:
    return None if obj is None else json.dumps(obj, ensure_ascii=False)


def ensure_columns(conn: sqlite3.Connection) -> list[str]:
    """Add the columns of :data:`LATER_COLUMNS` that an older database lacks; returns the ones added."""
    added: list[str] = []
    for table, column, kind in LATER_COLUMNS:
        existing = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        if existing and column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")
            added.append(f"{table}.{column}")
    return added


class _Owners:
    """The Atlas's product mapping, used to replace the curated ministry guesses (see module docstring)."""

    def __init__(self, conn: sqlite3.Connection):
        self.primary: dict[str, str] = {}
        self.secondary: dict[str, list[str]] = {}
        self.names: dict[str, tuple[str, str]] = {}
        for mid, short, name in conn.execute("SELECT id, short_name, name FROM ministries"):
            self.names[mid] = (short, name)
        for hsn8, mid in conn.execute("SELECT hsn8, ministry_id FROM products"):
            self.primary[hsn8] = mid
        for hsn8, mid in conn.execute("SELECT hsn8, ministry_id FROM product_ministries WHERE role = 'secondary' "
                                      "ORDER BY hsn8, ministry_id"):
            self.secondary.setdefault(hsn8, []).append(mid)
        self._by_prefix: dict[str, list[str] | None] = {}

    def for_code(self, code: str | None) -> list[str] | None:
        """Owner ids for a code, or None when the Atlas has no mapped line for it."""
        if not code:
            return None
        if len(code) == 8:
            primary = self.primary.get(code)
            if primary is None:
                return None
            return [primary] + [m for m in self.secondary.get(code, []) if m != primary]
        if code not in self._by_prefix:
            counts: dict[str, list] = {}
            for hsn8, mid in self.primary.items():
                if hsn8.startswith(code) and mid != RESIDUAL:
                    entry = counts.setdefault(mid, [0, hsn8])
                    entry[0] += 1
                    entry[1] = min(entry[1], hsn8)
            best = max(counts.items(), key=lambda kv: (kv[1][0], -int(kv[1][1]))) if counts else None
            self._by_prefix[code] = [best[0]] if best else None
        return self._by_prefix[code]

    def text(self, ids: list[str]) -> str | None:
        labels = []
        for mid in ids:
            short, name = self.names.get(mid, (mid, mid))
            labels.append("Residual (no owning ministry yet)" if mid == RESIDUAL else name or short)
        return ", ".join(labels) or None


def _apply_atlas_owners(chains: list[dict], owners: _Owners) -> list[dict]:
    """Replace the curated ministry ids of every item (and its stage) with the Atlas mapping."""
    changed: list[dict] = []
    for ch in chains:
        for st in ch["stages"]:
            touched = False
            for it in st["items"]:
                atlas = owners.for_code(it["hs_code"])
                if atlas is None:
                    continue
                if atlas != it["ministry_ids"]:
                    changed.append({"chain": ch["id"], "stage": st["stage_id"], "hs_code": it["hs_code"],
                                    "item": it["item_name"], "curated": list(it["ministry_ids"]), "atlas": atlas})
                    it["ministry_ids"] = atlas
                    it["ministry_text"] = owners.text(atlas)
                touched = True
            if touched:
                stage_ids = list(dict.fromkeys(m for it in st["items"] for m in it["ministry_ids"] if m != RESIDUAL))
                if stage_ids and stage_ids != st["ministry_ids"]:
                    st["ministry_ids"] = stage_ids
                    st["ministry_text"] = owners.text(stage_ids)
    return changed


def _delete_owned(conn: sqlite3.Connection) -> None:
    conn.execute("DELETE FROM vc_items")
    conn.execute("DELETE FROM vc_stages")
    conn.execute("DELETE FROM value_chains")
    marks = ",".join("?" * len(OWNED_SOURCES))
    conn.execute(f"DELETE FROM vc_edges WHERE source IN ({marks})", OWNED_SOURCES)
    conn.execute(f"DELETE FROM clusters WHERE source IN ({marks})", OWNED_SOURCES)
    # Chain production is owned by seed_ops (real, sourced rows), so clear every chain figure here.
    conn.execute("DELETE FROM production WHERE scope = 'chain'")


def load_chains(conn: sqlite3.Connection, data: dict, *, ministries: list[dict] | None = None,
                sectors_doc: dict | None = None) -> dict:
    """Load an already-parsed value_chains document into ``conn``; returns stats (see module docstring)."""
    ministries = ministries if ministries is not None else load_ministries()
    if sectors_doc is None:
        sectors_doc = load_json(SECTORS_JSON) if SECTORS_JSON.exists() else {}
    alias_index = build_alias_index(ministries)
    chains = normalise_chains(data, _known_ministries(conn, ministries), alias_index)
    ensure_columns(conn)

    products = {r[0] for r in conn.execute("SELECT hsn8 FROM products")}
    nodes = {r[0] for r in conn.execute("SELECT code FROM hs_nodes")}
    rederived = _apply_atlas_owners(chains, _Owners(conn))

    def known_code(code: str) -> bool:
        return code in products if len(code) == 8 else code in nodes

    _delete_owned(conn)
    stats: dict[str, Any] = {
        "chains": 0, "stages": 0, "items": 0, "items_with_code": 0, "items_linked_hsn8": 0,
        "edges_explicit": 0, "edges_default": 0, "edges_inserted": 0, "edges_duplicate_skipped": 0,
        "cross_chain_edges": 0, "clusters": 0,
    }
    unlinked_8: set[str] = set()
    unknown: set[str] = set()
    clusters: dict[str, dict] = {}
    cluster_conflicts: list[str] = []

    for ch in chains:
        stats["chains"] += 1
        conn.execute(
            "INSERT INTO value_chains (id, name, title, anchor_hs, lead_ministry_id, description, phase, source, "
            "manufacturers_json, skill_council_json, sort_order, notes_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (ch["id"], ch["name"], ch["title"], ch["anchor_hs"], ch["lead_ministry_id"], ch["description"],
             ch["phase"], ch["source"], _dumps(ch["manufacturers"]), _dumps(ch["skill_council"]), ch["sort_order"],
             _dumps(ch["notes"]) if ch["notes"] else None),
        )
        own_codes: set[str] = set()
        for st in ch["stages"]:
            stats["stages"] += 1
            conn.execute(
                "INSERT INTO vc_stages (chain_id, stage_id, name, stage_order, ministry_text, ministry_ids_json) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (ch["id"], st["stage_id"], st["name"], st["stage_order"], st["ministry_text"],
                 _dumps(st["ministry_ids"])),
            )
            for it in st["items"]:
                stats["items"] += 1
                code = it["hs_code"]
                hsn8 = None
                if code:
                    stats["items_with_code"] += 1
                    own_codes.add(code)
                    if not known_code(code):
                        unknown.add(code)
                    if len(code) == 8:
                        if code in products:
                            hsn8 = code
                            stats["items_linked_hsn8"] += 1
                        else:
                            unlinked_8.add(code)
                conn.execute(
                    "INSERT INTO vc_items (chain_id, stage_id, item_order, item_name, hs_code, hsn8, description, "
                    "ministry_text, ministry_ids_json, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (ch["id"], st["stage_id"], it["item_order"], it["item_name"], code, hsn8, it["description"],
                     it["ministry_text"], _dumps(it["ministry_ids"]), it["source"]),
                )

        if ch["edges"] is None:
            edges = default_edges(ch["stages"], ch["source"])
            stats["edges_default"] += len(edges)
        else:
            edges = ch["edges"]
            stats["edges_explicit"] += len(edges)
        for e in edges:
            for code in (e["src"], e["dst"]):
                if not known_code(code):
                    unknown.add(code)
            cur = conn.execute(
                "INSERT OR IGNORE INTO vc_edges (src, dst, relation, chain_id, weight, source) VALUES (?, ?, ?, ?, ?, ?)",
                (e["src"], e["dst"], e["relation"], ch["id"], e["weight"], e["source"]),
            )
            if cur.rowcount:
                stats["edges_inserted"] += 1
                if e["src"] not in own_codes or e["dst"] not in own_codes:
                    stats["cross_chain_edges"] += 1
            else:
                stats["edges_duplicate_skipped"] += 1

        chain_sector = sector_for_code(ch["anchor_hs"], sectors_doc)
        for c in ch["clusters"]:
            entry = clusters.get(c["id"])
            fields = {k: c.get(k) for k in ("name", "state", "district", "products", "lat", "lon")}
            if entry is None:
                entry = clusters[c["id"]] = {**fields, "chain_ids": [], "sector_ids": list(c.get("sector_ids") or [])}
            elif any(entry[k] != v for k, v in fields.items()):
                cluster_conflicts.append(c["id"])
            if ch["id"] not in entry["chain_ids"]:
                entry["chain_ids"].append(ch["id"])
            if not c.get("sector_ids") and chain_sector and chain_sector not in entry["sector_ids"]:
                entry["sector_ids"].append(chain_sector)

        # Production figures are loaded from real sources by seed_ops, never from the chain document.

    for cid, c in clusters.items():
        conn.execute(
            "INSERT OR REPLACE INTO clusters (id, name, state, district, chain_ids_json, sector_ids_json, products, "
            "lat, lon, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'curated')",
            (cid, c["name"], c["state"], c["district"], _dumps(c["chain_ids"]), _dumps(c["sector_ids"]),
             c["products"], c["lat"], c["lon"]),
        )
    stats["clusters"] = len(clusters)
    conn.commit()
    stats["items_8digit_not_in_products"] = sorted(unlinked_8)
    stats["unknown_codes"] = sorted(unknown)
    stats["curated_ministries_rederived"] = rederived
    if cluster_conflicts:
        stats["cluster_conflicts"] = sorted(set(cluster_conflicts))
    return stats


def run(conn: sqlite3.Connection, path: Path | str | None = None) -> dict:
    """ETL entry point: load ``data/curated/value_chains.json`` (or ``path``) into ``conn``."""
    return load_chains(conn, load_json(path or VALUE_CHAINS_JSON))


if __name__ == "__main__":  # pragma: no cover - quick validation without a database
    doc = load_json()
    mins = load_ministries()
    result = normalise_chains(doc, {m["id"] for m in mins}, build_alias_index(mins))
    print(f"{len(result)} chains valid:",
          ", ".join(f"{c['id']} ({sum(len(s['items']) for s in c['stages'])} items)" for c in result))
