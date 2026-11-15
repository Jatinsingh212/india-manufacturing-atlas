"""ETL step 10 — "parts-of" links derived from the HS nomenclature text.

The WCO texts of many headings and subheadings say which goods their parts belong to, e.g.

* 8708   "Motor vehicles; parts and accessories, of heading no. 8701 to 8705"
* 8409   "Parts suitable for use solely or principally with the engines of heading no. 8407 or 8408"
* 8473   "... parts and accessories ... suitable for use solely or principally with machines of headings 84.70 to 84.72"
* 847321 "... parts and accessories of the electronic calculating machines of item no. 8470.10, 8470.21 or 8470.29"

This step turns those references into directed edges of the value-chain graph::

    vc_edges(src = <parts heading/subheading>, dst = <referenced heading/subheading>,
             relation = 'parts_of', chain_id = NULL, weight = 1, source = 'hs_text')

so the network extends beyond the curated chains automatically (``/api/network?include_parts=true``).

Parsing rules (documented decisions)
------------------------------------
1. Only ``hs_nodes`` of level 4 and 6 are scanned (their ``description``).
2. A reference is ``heading(s) | subheading(s) | sub-heading(s) | item(s)``, optionally followed by
   ``no.``/``nos.``, then a list of codes written ``8407``, ``84.07`` or ``8470.10``, separated by ``,``, ``.``
   (a typo in the source: "8470.30. 8470.50"), ``or``, ``and``, ``to`` or ``-``. ``A to B`` / ``A-B`` is a range.
3. A reference counts only when a parts phrase — ``parts``, ``accessories``, ``chassis`` or ``bodies`` —
   occurs *before* it in the same description ("Printing machinery; ... components of heading 84.42; ...;
   parts and accessories thereof" therefore yields nothing, because the reference precedes the phrase).
4. A reference is negated (skipped) when the text just before it (up to 60 characters, cut at the last
   ``;`` or ``)``) contains ``excluding``, ``except``, ``other than``, ``not``, ``n.e.c.``/``n.e.s.`` or
   ``elsewhere``. This drops "(excluding those of heading no. 8402)", "n.e.c. in heading no. 8466",
   "other than those of heading no. 6212", "not meters of heading no. 9028" and similar.
5. Self references are skipped: a subheading pointing to its own heading ("parts of machinery of heading
   no. 8422" inside 8422.90) and any target that contains, or is contained in, the source code.
6. Codes are normalised (dots removed). 4-digit codes are headings, 6-digit codes subheadings; anything else
   (e.g. "8448.3") is ignored. Ranges expand to the codes of the same level that exist in ``hs_nodes``;
   single codes are kept only when they exist in ``hs_nodes``.
7. A subheading's edges are written only when its target set differs from its parent heading's target set
   (870810 "bumpers ... for the vehicles of heading no. 8701 to 8705" repeats 8708 and is not duplicated;
   843110 "parts of the machinery of heading no. 8425" is more specific than 8431 and is kept).

Idempotent: all rows with ``source = 'hs_text'`` are deleted first. Curated edges never use relation
``parts_of``, so ``INSERT OR IGNORE`` on the (src, dst, relation) key cannot shadow them.
"""
from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass, field

RELATION = "parts_of"
SOURCE = "hs_text"

PARTS_PHRASE = re.compile(r"\b(?:parts|accessories|chassis|bodies)\b", re.IGNORECASE)

_CODE = r"\d{2}\.?\d{2}(?:\.\d{1,2})?"
_SEP = r"(?:\s*,\s*|\s*\.\s+|\s+or\s+|\s+and\s+|\s+to\s+|\s*-\s*|\s*–\s*)"
REFERENCE = re.compile(
    rf"\b(?:sub-?headings?|headings?|items?)\b(?:\s+nos?\b\.?)?\s*(?P<list>{_CODE}(?:{_SEP}{_CODE})*)",
    re.IGNORECASE,
)
_CODE_RE = re.compile(_CODE)
_RANGE_SEP = re.compile(r"^\s*(?:to|-|–)\s*$", re.IGNORECASE)
NEGATION = re.compile(
    r"\bexcluding\b|\bexcept\b|\bother\s+than\b|\bnot\b|\bn\.?\s?e\.?\s?[cs]\b\.?|\belsewhere\b",
    re.IGNORECASE,
)
NEGATION_WINDOW = 60


@dataclass
class Reference:
    """One parsed reference list: the codes it names and whether it was negated."""

    codes: list[str]
    negated: bool
    raw: str


@dataclass
class ParseStats:
    """Counters accumulated while parsing (returned by :func:`run`)."""

    references: int = 0
    negated: int = 0
    before_parts_phrase: int = 0
    self_refs: int = 0
    unknown_codes: set[str] = field(default_factory=set)


# --------------------------------------------------------------------------- parsing helpers

def _norm(code: str) -> str | None:
    """'84.70' -> '8470', '8470.10' -> '847010'; returns None for anything that is not 4 or 6 digits."""
    digits = code.replace(".", "")
    return digits if len(digits) in (4, 6) and digits.isdigit() else None


def _expand_list(text: str, nodes_by_level: dict[int, list[str]], known: set[str],
                 stats: ParseStats) -> list[str]:
    """Expand a reference list such as '8701 to 8705' or '8535, 8536 and 8537' to existing codes."""
    tokens = list(_CODE_RE.finditer(text))
    out: list[str] = []
    i = 0
    while i < len(tokens):
        lo = _norm(tokens[i].group(0))
        is_range = (i + 1 < len(tokens)
                    and _RANGE_SEP.match(text[tokens[i].end():tokens[i + 1].start()]) is not None)
        if is_range:
            hi = _norm(tokens[i + 1].group(0))
            i += 2
            if lo is None or hi is None or len(lo) != len(hi) or lo > hi:
                continue
            out.extend(c for c in nodes_by_level.get(len(lo), []) if lo <= c <= hi)
        else:
            i += 1
            if lo is None:
                continue
            if lo in known:
                out.append(lo)
            else:
                stats.unknown_codes.add(lo)
    return out


def _is_negated(description: str, start: int) -> bool:
    """True when the text just before position ``start`` negates the reference (rule 4)."""
    window = description[max(0, start - NEGATION_WINDOW):start]
    cut = max(window.rfind(";"), window.rfind(")"))
    if cut >= 0:
        window = window[cut + 1:]
    return NEGATION.search(window) is not None


def parse_references(description: str, nodes_by_level: dict[int, list[str]], known: set[str],
                     stats: ParseStats | None = None) -> list[Reference]:
    """Return the heading/subheading references of ``description`` that follow a parts phrase."""
    stats = stats if stats is not None else ParseStats()
    first_parts = PARTS_PHRASE.search(description)
    refs: list[Reference] = []
    for m in REFERENCE.finditer(description):
        stats.references += 1
        if first_parts is None or first_parts.start() > m.start():
            stats.before_parts_phrase += 1
            continue
        negated = _is_negated(description, m.start())
        if negated:
            stats.negated += 1
        codes = _expand_list(m.group("list"), nodes_by_level, known, stats)
        refs.append(Reference(codes=codes, negated=negated, raw=m.group(0)))
    return refs


def targets_for(code: str, description: str, nodes_by_level: dict[int, list[str]], known: set[str],
                stats: ParseStats | None = None) -> list[str]:
    """Ordered, de-duplicated parts-of targets of one node (rules 3–6)."""
    stats = stats if stats is not None else ParseStats()
    out: list[str] = []
    for ref in parse_references(description, nodes_by_level, known, stats):
        if ref.negated:
            continue
        for dst in ref.codes:
            if dst == code or dst.startswith(code) or code.startswith(dst) or dst == code[:4]:
                stats.self_refs += 1
                continue
            if dst not in out:
                out.append(dst)
    return out


def derive_links(nodes: list[tuple[str, int, str]]) -> tuple[list[tuple[str, str]], dict]:
    """Derive (src, dst) parts-of pairs from ``(code, level, description)`` rows.

    Pure function (no database access) so it can be unit-tested directly.
    """
    nodes_by_level: dict[int, list[str]] = {}
    for code, level, _ in nodes:
        nodes_by_level.setdefault(level, []).append(code)
    for codes in nodes_by_level.values():
        codes.sort()
    known = {code for code, _, _ in nodes}
    stats = ParseStats()

    heading_targets: dict[str, list[str]] = {}
    for code, level, desc in nodes:
        if level == 4:
            heading_targets[code] = targets_for(code, desc or "", nodes_by_level, known, stats)

    pairs: list[tuple[str, str]] = []
    redundant = 0
    n_head = n_sub = 0
    for code, level, desc in sorted(nodes):
        if level == 4:
            targets = heading_targets.get(code, [])
            if targets:
                n_head += 1
        elif level == 6:
            targets = targets_for(code, desc or "", nodes_by_level, known, stats)
            if targets and set(targets) == set(heading_targets.get(code[:4], [])):
                redundant += 1
                continue
            if targets:
                n_sub += 1
        else:
            continue
        pairs.extend((code, dst) for dst in targets)

    info = {
        "references_seen": stats.references,
        "references_before_parts_phrase": stats.before_parts_phrase,
        "references_negated": stats.negated,
        "self_references": stats.self_refs,
        "subheadings_redundant_with_heading": redundant,
        "headings_with_links": n_head,
        "subheadings_with_links": n_sub,
        "unknown_codes": sorted(stats.unknown_codes),
    }
    return pairs, info


# --------------------------------------------------------------------------- step

def run(conn: sqlite3.Connection) -> dict:
    """Rebuild the ``hs_text`` parts-of edges from ``hs_nodes``; returns stats."""
    nodes = [(r[0], int(r[1]), r[2] or "") for r in
             conn.execute("SELECT code, level, description FROM hs_nodes WHERE level IN (4, 6)")]
    pairs, info = derive_links(nodes)
    conn.execute("DELETE FROM vc_edges WHERE source = ?", (SOURCE,))
    inserted = 0
    for src, dst in pairs:
        cur = conn.execute(
            "INSERT OR IGNORE INTO vc_edges (src, dst, relation, chain_id, weight, source) VALUES (?, ?, ?, NULL, 1, ?)",
            (src, dst, RELATION, SOURCE),
        )
        inserted += cur.rowcount
    conn.commit()
    return {
        "nodes_scanned": len(nodes),
        "parts_of_edges": inserted,
        "parts_sources": len({s for s, _ in pairs}),
        **info,
    }


if __name__ == "__main__":  # pragma: no cover - manual inspection helper
    import csv
    import sys

    from scripts.etl import RAW_DIR

    with open(RAW_DIR / "hs_nomenclature.csv", encoding="utf-8") as fh:
        rows = [(r["hscode"], int(r["level"]), r["description"]) for r in csv.DictReader(fh)
                if r["level"] in ("4", "6")]
    found, summary = derive_links(rows)
    for s, d in found:
        if not sys.argv[1:] or any(s.startswith(p) for p in sys.argv[1:]):
            print(s, "->", d)
    print(summary, len(found))
