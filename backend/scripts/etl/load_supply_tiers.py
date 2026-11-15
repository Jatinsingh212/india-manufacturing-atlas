"""ETL step 10b — supplier tiers (``data/curated/supply_tiers.json``).

The stages of a value chain say *what* the product is made of (raw materials -> components -> finished
goods). The tiers say *how deep the supply chain runs*: Tier 1 are the direct suppliers of the
manufacturer, Tier 2 the suppliers of those suppliers, Tier 3 the basic materials and commodities
underneath them. For sports goods the tier structure comes from the study's supply-chain table; the
items are the Atlas's own HS-coded grounding of each tier.

Tables written
--------------
* ``vc_tiers``      one row per tier of a chain: ``tier_level``, ``name``, ``description``,
                    ``examples_json`` (JSON array of strings) and ``sort_order``.
* ``vc_tier_items`` one row per item of a tier; ``hs_code`` keeps the curated code (8, 6 or 4 digits);
                    ``hsn8`` is set only when ``hs_code`` is an 8-digit line present in ``products``.

Ministries
----------
As for the value chains, the curated ``ministry_ids`` are only the curator's suggestion: the loader
replaces them with the Atlas's product mapping, so a tier page can never name a different owner than
the product page. An 8-digit line gets ``products.ministry_id`` (``residual`` when unmapped) followed
by its secondary owners; a 4/6-digit code gets the most common non-residual primary owner of the lines
under it (ties -> the owner of the lowest line). Codes with no mapped line keep the curated ids.

Validation (raises :class:`SupplyTierError`, which aborts the build)
-------------------------------------------------------------------
* unknown chain id (not in ``value_chains``), unknown ministry ids, duplicate tier levels, malformed
  HS codes, or an item without a name.

Idempotent: ``vc_tiers`` and ``vc_tier_items`` are fully owned and rebuilt on every run.
"""
from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import Any

from scripts.etl import CURATED_DIR
from scripts.etl.load_value_chains import (CODE_LENGTHS, RESIDUAL, ValueChainError, _clean_text,
                                          build_alias_index, load_ministries, normalize_code,
                                          resolve_ministry_text)

SUPPLY_TIERS_JSON = CURATED_DIR / "supply_tiers.json"


class SupplyTierError(ValueError):
    """Raised when supply_tiers.json is inconsistent with the contract."""


def load_json(path: Path | str = SUPPLY_TIERS_JSON) -> dict:
    """Read the curated tier document (UTF-8, BOM tolerated)."""
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def normalise_tiers(data: dict, known_ministries: set[str], alias_index) -> list[dict]:
    """Validate the document and return the chain/tier/item structure with normalised codes.

    Raises :class:`SupplyTierError` listing every problem found.
    """
    errors: list[str] = []
    chains_in = data.get("chains") if isinstance(data, dict) else None
    if not isinstance(chains_in, list) or not chains_in:
        raise SupplyTierError("supply_tiers.json must contain a non-empty 'chains' list")

    chains: list[dict] = []
    seen_chains: set[str] = set()
    for pos, raw in enumerate(chains_in, start=1):
        cid = raw.get("chain_id")
        where = f"chain {cid or pos}"
        if not cid:
            errors.append(f"{where}: 'chain_id' is required")
            continue
        if cid in seen_chains:
            errors.append(f"{where}: duplicate chain_id")
        seen_chains.add(cid)

        tiers: list[dict] = []
        seen_levels: set[int] = set()
        for t_pos, tier in enumerate(raw.get("tiers") or [], start=1):
            t_where = f"{where} tier {t_pos}"
            level = tier.get("level")
            if not isinstance(level, int) or level < 1:
                errors.append(f"{t_where}: 'level' must be a positive integer")
                continue
            if level in seen_levels:
                errors.append(f"{t_where}: duplicate tier level {level}")
            seen_levels.add(level)
            if not tier.get("name"):
                errors.append(f"{t_where}: 'name' is required")
            examples = tier.get("examples") or []
            if not isinstance(examples, list) or any(not isinstance(e, str) or not e.strip() for e in examples):
                errors.append(f"{t_where}: 'examples' must be a list of non-empty strings")
                examples = []

            items: list[dict] = []
            for i_pos, item in enumerate(tier.get("items") or [], start=1):
                i_where = f"{t_where} item {i_pos}"
                if not _clean_text(item.get("item")):
                    errors.append(f"{i_where}: 'item' is required")
                try:
                    code = normalize_code(item.get("hs_code"))
                except ValueChainError as exc:
                    errors.append(f"{i_where}: {exc}")
                    code = None
                if not code:
                    errors.append(f"{i_where}: 'hs_code' is required")
                ids = item.get("ministry_ids")
                if ids is None:
                    ids = resolve_ministry_text(item.get("ministry_text"), alias_index)
                else:
                    ids = list(ids)
                for mid in ids:
                    if mid not in known_ministries:
                        errors.append(f"{i_where}: unknown ministry id {mid!r}")
                items.append({
                    "item_order": i_pos,
                    "item_name": _clean_text(item.get("item")) or "",
                    "hs_code": code,
                    "description": _clean_text(item.get("description")),
                    "ministry_text": _clean_text(item.get("ministry_text")),
                    "ministry_ids": ids,
                    "source": item.get("source") or raw.get("source") or "curated",
                })

            tiers.append({
                "tier_level": level,
                "name": _clean_text(tier.get("name")),
                "description": _clean_text(tier.get("description")),
                "examples": [e.strip() for e in examples if e and e.strip()],
                "items": items,
            })

        tiers.sort(key=lambda t: t["tier_level"])
        chains.append({
            "chain_id": cid,
            "source": raw.get("source") or "curated",
            "source_label": _clean_text(raw.get("source_label")),
            "tiers": tiers,
        })

    if errors:
        raise SupplyTierError("supply_tiers.json is invalid:\n  - " + "\n  - ".join(errors))
    return chains


def _apply_atlas_owners(chains: list[dict], owners) -> list[dict]:
    """Replace the curated ministry ids of every tier item with the Atlas mapping."""
    changed: list[dict] = []
    for ch in chains:
        for tier in ch["tiers"]:
            for it in tier["items"]:
                atlas = owners.for_code(it["hs_code"])
                if atlas is None:
                    continue
                if atlas != it["ministry_ids"]:
                    changed.append({"chain": ch["chain_id"], "tier": tier["tier_level"],
                                    "hs_code": it["hs_code"], "item": it["item_name"],
                                    "curated": list(it["ministry_ids"]), "atlas": atlas})
                    it["ministry_ids"] = atlas
                    it["ministry_text"] = owners.text(atlas)
    return changed


def load_tiers(conn: sqlite3.Connection, data: dict) -> dict:
    """Load an already-parsed tier document into ``conn``; returns stats."""
    from scripts.etl.load_value_chains import _Owners

    ministries = load_ministries()
    alias_index = build_alias_index(ministries)
    known = {r[0] for r in conn.execute("SELECT id FROM ministries")} or {m["id"] for m in ministries}
    chains = normalise_tiers(data, known, alias_index)

    known_chains = {r[0] for r in conn.execute("SELECT id FROM value_chains")}
    if known_chains:
        unknown = sorted(c["chain_id"] for c in chains if c["chain_id"] not in known_chains)
        if unknown:
            raise SupplyTierError(f"supply_tiers.json: unknown chain id(s) {unknown} "
                                  "(load_value_chains runs first)")

    products = {r[0] for r in conn.execute("SELECT hsn8 FROM products")}
    rederived = _apply_atlas_owners(chains, _Owners(conn))

    conn.execute("DELETE FROM vc_tier_items")
    conn.execute("DELETE FROM vc_tiers")

    stats: dict[str, Any] = {"chains": 0, "tiers": 0, "items": 0, "items_with_code": 0, "items_linked_hsn8": 0}
    unlinked: set[str] = set()
    for ch in chains:
        stats["chains"] += 1
        for order, tier in enumerate(ch["tiers"], start=1):
            stats["tiers"] += 1
            conn.execute(
                "INSERT INTO vc_tiers (chain_id, tier_level, name, description, examples_json, sort_order, source) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (ch["chain_id"], tier["tier_level"], tier["name"], tier["description"],
                 json.dumps(tier["examples"], ensure_ascii=False) if tier["examples"] else None,
                 order, ch["source"]),
            )
            for it in tier["items"]:
                stats["items"] += 1
                code = it["hs_code"]
                hsn8 = None
                if code:
                    stats["items_with_code"] += 1
                    if len(code) == 8:
                        if code in products:
                            hsn8 = code
                            stats["items_linked_hsn8"] += 1
                        else:
                            unlinked.add(code)
                conn.execute(
                    "INSERT INTO vc_tier_items (chain_id, tier_level, item_order, item_name, hs_code, hsn8, "
                    "description, ministry_text, ministry_ids_json, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (ch["chain_id"], tier["tier_level"], it["item_order"], it["item_name"], code, hsn8,
                     it["description"], it["ministry_text"],
                     json.dumps(it["ministry_ids"], ensure_ascii=False), it["source"]),
                )
    conn.commit()
    stats["items_8digit_not_in_products"] = sorted(unlinked)
    stats["curated_ministries_rederived"] = rederived
    return stats


def run(conn: sqlite3.Connection, path: Path | str | None = None) -> dict:
    """ETL entry point: load ``data/curated/supply_tiers.json`` (or ``path``) into ``conn``."""
    return load_tiers(conn, load_json(path or SUPPLY_TIERS_JSON))


if __name__ == "__main__":  # pragma: no cover - quick validation without a database
    doc = load_json()
    mins = load_ministries()
    result = normalise_tiers(doc, {m["id"] for m in mins}, build_alias_index(mins))
    print(f"{len(result)} chains valid:",
          ", ".join(f"{c['chain_id']} ({len(c['tiers'])} tiers)" for c in result))
