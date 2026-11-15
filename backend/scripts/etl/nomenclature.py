"""ETL step 2 — HS nomenclature and India's 8-digit product lines.

Tables written
--------------
* ``sections``   21 HS sections (roman numeral id) from ``raw/hs_sections.csv``.
* ``hs_nodes``   WCO HS2022 chapters / headings / subheadings from ``raw/hs_nomenclature.csv``
                 (the synthetic ``TOTAL`` / chapter-99 rows of that file are not HS2022 nodes and are skipped).
* ``products``   India's national 8-digit lines from the GST portal HSN master
                 (``raw/gst_hsn_master.xlsx``, sheet ``HSN_MSTR``).

Which 8-digit lines are kept
----------------------------
The GST master mixes 8-digit codes from several tariff revisions (14,709 codes). A line is *current*
(``is_current = 1``) when its first six digits are an HS2022 subheading present in ``hs_nodes``
(13,110 lines). Lines that are not current are kept with ``is_current = 0`` only when
``curated/value_chains.json`` references them. The handful of
5- and 7-digit rows and the two codes containing spaces are ignored.

Note: CEPII BACI reports HS 2710 only at the aggregated code 271000 and has no rows for 7108.20 / 7118.90,
so 71 current lines (69 of them petroleum products in 2710) have a valid HS2022 subheading but no HS6
trade series; their trade is "Not available" rather than invented.

Descriptions
------------
* ``line_description``  raw GST text (whitespace normalised, Excel artefacts removed).
* ``description``       readable sentence-case label. The GST text is often a whole hierarchy path
                        ('…~Other~Other', '… - OTHER: SUPERIOR KEROSINE OIL'); the last segment is used.
                        When that segment is generic ('Other', short fragments such as 'Radials', text that
                        starts with a preposition or a dash) the subheading text is prefixed:
                        'Rubber; new pneumatic tyres, of a kind used on motor cars (…) — radials'.
                        Labels shared by several subheadings ('Shirting fabrics', 'Flexible, plain') are
                        prefixed the same way so every label is self-explanatory. A line ending in '00'
                        that is the only current line of its subheading takes the (authoritative)
                        subheading text itself.
* ``full_description``  'Heading — Subheading — Line'.
* ``lines_in_hs6``      number of current lines sharing the HS6 (aggregation weight 1/lines_in_hs6).

``products_fts`` is (re)built by :func:`rebuild_fts` once ministries and sectors are assigned
(``mapping_rules`` calls it), with ``rowid = products.rowid``.
"""
from __future__ import annotations

import csv
import json
import re
import sqlite3
from collections import Counter
from pathlib import Path

from scripts.etl import CURATED_DIR, RAW_DIR

NOMENCLATURE_CSV = RAW_DIR / "hs_nomenclature.csv"
SECTIONS_CSV = RAW_DIR / "hs_sections.csv"
GST_XLSX = RAW_DIR / "gst_hsn_master.xlsx"
GST_SHEET = "HSN_MSTR"
VALUE_CHAINS_JSON = CURATED_DIR / "value_chains.json"

DASH = " \u2014 "  # em dash used to join label parts

# Upper-case tokens kept upper-case when shouting GST text is converted to sentence case.
ACRONYMS = frozenset("""
ABS AC ATF ATM BIS BOPP BR CD CDMA CFL CKD CNG CPU CR CRGO CRNO CRT DC DNA DTH DVD ECG EEG EPDM EPS EV EVA
FRP GI GLS GPS GRP GSM HDF HDPE HF HR HSD IC ICS IGBT INN IR ISO IT LAN LCD LED LDO LDPE LLDPE LNG LPG MCP
MDF MOSFET MRI NBR OLED PC PCB PCP PE PET PF PP PS PU PUF PVA PVC RAM RCC RF RNA ROM SBR SIM SKD SKO SS TMT
TSNR TV UF UHF UPS US USA USB UV VHF WAN XPS
""".split())

# A segment is "generic" when it carries no meaning without its subheading.
GENERIC_WORDS = frozenset({"OTHER", "OTHERS", "OTHER:", "OTHERS:", "NES", "N.E.S.", "N.E.C."})
FRAGMENT_PREFIXES = (
    "OF ", "FOR ", "IN ", "WITH ", "WITHOUT ", "NOT ", "EXCEEDING ", "CONTAINING ", "HAVING ", "WEIGHING ",
    "WHETHER ", "OTHER ", "OTHERS ", "USED ", "PUT UP ", "BASED ON ", "AND ", "OR ", "IMPREGNATED ",
    "EXCLUDING ", "INCLUDING ", "BUT ", "THE ", "ABOVE ", "BELOW ", "UP TO ", "UPTO ", "MORE THAN ",
    "LESS THAN ", "NOT EXCEEDING", "COATED ", "PLATED ", "CLAD ", "CLAD,", "MIXED ", "ALSO ",
)
GENERIC_MAX_LEN = 13  # 'RADIALS', 'HEVEA', 'SMOKED SHEETS' (13) are fragments of their subheading
EXCEL_ERRORS = frozenset({"#NAME?", "#VALUE!", "#REF!", "#N/A", "#DIV/0!", "#NUM!", "#NULL!"})

_WS = re.compile(r"\s+")
_UNIT_SUFFIX = re.compile(r"\s+KGS?\.?$", re.I)  # GST unit-quantity code glued to some lines ('LENTILS KG.')
_SEGMENT_SPLIT = re.compile(r"\s*(?:~|-{2,}|:-|:\s*-\s|:|\s-\s)\s*")
_TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9]*")


# --------------------------------------------------------------------------- text helpers

def clean_text(value) -> str:
    """Return a clean single-line string from a GST master cell.

    Handles ``None``, openpyxl ``ArrayFormula`` objects (one cell holds the formula ``=--- LUNGI``),
    Excel line-break artefacts (``_x000D_``), the Unicode replacement character and runs of whitespace.
    """
    if value is None:
        return ""
    if not isinstance(value, str):
        value = getattr(value, "text", None) or str(value)
    text = value.replace("_x000D_", " ").replace("\ufffd", "'")
    if text.startswith("="):  # a formula typed into a text cell
        text = text.lstrip("=")
    text = _WS.sub(" ", text).strip()
    if text in EXCEL_ERRORS:  # cached value of a broken formula carries no text
        return ""
    return text


def _is_shouting(text: str) -> bool:
    letters = [c for c in text if c.isalpha()]
    return bool(letters) and sum(c.isupper() for c in letters) / len(letters) > 0.7


def sentence_case(text: str) -> str:
    """Sentence-case a label: lower-case shouting text, keep known acronyms, capitalise the first letter.

    Mixed-case text (already readable) is left alone apart from the first letter. Short all-caps tokens
    inside parentheses ('(TSNR)', '(INN)') and 'IS' before a standard number ('IS 2795') stay upper-case.
    """
    text = _WS.sub(" ", text or "").strip()
    if not text:
        return text
    if _is_shouting(text):
        def repl(m: re.Match) -> str:
            tok = m.group(0)
            up = tok.upper()
            if up in ACRONYMS:
                return up
            start, end = m.start(), m.end()
            before = text[start - 1] if start > 0 else ""
            after = text[end] if end < len(text) else ""
            if before == "(" and after == ")" and len(tok) <= 6 and tok.isupper():
                return tok
            if up == "IS" and re.match(r"\s*\d", text[end:end + 3]):
                return "IS"
            return tok.lower()
        text = _TOKEN.sub(repl, text)
    for i, ch in enumerate(text):
        if ch.isalpha():
            return text[:i] + ch.upper() + text[i + 1:]
    return text


def lower_label(text: str) -> str:
    """Lower-case a label for use after an em dash, preserving acronyms (see :func:`sentence_case`)."""
    s = sentence_case(text)
    if s and s[0].isupper() and not (len(s) > 1 and s[1].isupper()):
        first_tok = _TOKEN.match(s)
        if not (first_tok and first_tok.group(0).upper() in ACRONYMS and first_tok.group(0).isupper()):
            s = s[0].lower() + s[1:]
    return s


def _strip_punct(seg: str) -> str:
    return seg.strip(" \t-–—:;,.*").strip()


def line_label(raw_text: str) -> str:
    """Extract the line's own text from a GST description that may contain its whole hierarchy.

    Splits on '~', runs of dashes, ':' / ':-' and ' - ' and returns the last meaningful segment;
    returns the whole (cleaned) text when no separator is present.
    """
    text = clean_text(raw_text)
    parts = [_strip_punct(p) for p in _SEGMENT_SPLIT.split(text)]
    parts = [p for p in parts if sum(c.isalnum() for c in p) >= 2]
    if not parts:
        return _strip_punct(text) or text
    return parts[-1]


def own_label(raw_text: str) -> str:
    """The line's own label: :func:`line_label` without the GST unit code some lines carry ('… KG.')."""
    return _UNIT_SUFFIX.sub("", line_label(raw_text))


def is_generic(label: str) -> bool:
    """True when a line label is meaningless on its own ('Other', 'Radials', 'of cotton', '- Lungi')."""
    raw = (label or "").strip()
    if not raw or raw.startswith(("-", "–", "—")):
        return True
    up = _strip_punct(raw).upper()
    if up in GENERIC_WORDS or len(up) <= GENERIC_MAX_LEN:
        return True
    return up.startswith(FRAGMENT_PREFIXES)


def _norm_cmp(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def _contained(label: str, text: str) -> bool:
    """True when a (multi-word, non-generic) label already appears inside ``text``."""
    lab = _norm_cmp(label)
    if not lab or lab in ("other", "others") or (" " not in lab and len(lab) < 8):
        return False
    return f" {lab} " in f" {_norm_cmp(text)} "


def _capitalise(text: str) -> str:
    for i, ch in enumerate(text):
        if ch.isalpha():
            return text[:i] + ch.upper() + text[i + 1:]
    return text


def label_key(raw_text: str) -> str:
    """Normalised line label, used to detect labels shared by several subheadings ('Shirting fabrics')."""
    return _norm_cmp(own_label(raw_text))


def build_descriptions(hsn8: str, raw_text: str, heading: str | None, subheading: str | None,
                       single_line_subheading: bool, ambiguous: bool = False) -> tuple[str, str, str]:
    """Return ``(description, line_description, full_description)`` for one 8-digit line.

    ``ambiguous`` marks a label that several subheadings share (e.g. 'Shirting fabrics' under 37 cotton and
    man-made fabric subheadings); such labels are prefixed with their subheading like generic ones.
    """
    line_desc = clean_text(raw_text)
    label = own_label(line_desc) or line_desc or hsn8
    base = subheading or heading
    if subheading and hsn8.endswith("00") and single_line_subheading:
        description = subheading
    elif base and (is_generic(label) or ambiguous):
        lab = lower_label(_strip_punct(label) or "other")
        description = base if _contained(lab, base) else f"{base}{DASH}{lab}"
    else:
        description = sentence_case(label)
    pieces = [p for p in (heading, subheading) if p]
    line_part = sentence_case(_strip_punct(label) or label)
    if not pieces or not (_norm_cmp(line_part) == _norm_cmp(pieces[-1]) or _contained(line_part, pieces[-1])):
        pieces.append(line_part)
    full_description = DASH.join(pieces)
    return _capitalise(_WS.sub(" ", description).strip()), line_desc, _capitalise(full_description)


# --------------------------------------------------------------------------- loaders

def load_sections() -> list[tuple[str, int, str]]:
    """Rows ``(id, num, name)`` for the 21 HS sections, in nomenclature order."""
    with open(SECTIONS_CSV, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    return [(r["section"].strip(), i, sentence_case(r["name"].strip())) for i, r in enumerate(rows, start=1)]


def load_hs_nodes(valid_sections: set[str]) -> list[tuple[str, int, str | None, str, str]]:
    """Rows ``(code, level, parent, section_id, description)`` for HS2022 chapters/headings/subheadings."""
    out = []
    with open(NOMENCLATURE_CSV, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            section = r["section"].strip()
            level = int(r["level"])
            if section not in valid_sections or level not in (2, 4, 6):
                continue  # 'TOTAL' pseudo-section (chapter 99 / grand total rows)
            parent = r["parent"].strip()
            out.append((r["hscode"].strip(), level, None if parent == "TOTAL" else parent, section,
                        _WS.sub(" ", r["description"]).strip()))
    return out


def load_gst_master(path: Path = GST_XLSX) -> dict[str, str]:
    """``{hsn8: raw text}`` for every 8-digit numeric code in the GST HSN master (sheet HSN_MSTR)."""
    import openpyxl  # local import: only the ETL needs it

    wb = openpyxl.load_workbook(path, read_only=True)
    try:
        ws = wb[GST_SHEET]
        out: dict[str, str] = {}
        for code, text in ws.iter_rows(min_row=2, max_col=2, values_only=True):
            if code is None:
                continue
            code = str(code).strip()
            if len(code) == 8 and code.isdigit():
                out[code] = clean_text(text)
        return out
    finally:
        wb.close()


def value_chain_codes(path: Path = VALUE_CHAINS_JSON) -> set[str]:
    """8-digit codes referenced by ``curated/value_chains.json`` (items and edges), if the file exists."""
    if not path.exists():
        return set()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:  # a half-written file must not break the core build
        print(f"    ! could not read {path.name}: {exc}")
        return set()
    codes: set[str] = set()

    def add(v) -> None:
        s = re.sub(r"[\s.]", "", str(v or ""))
        if len(s) == 8 and s.isdigit():
            codes.add(s)

    for chain in data.get("chains", []) if isinstance(data, dict) else []:
        for stage in chain.get("stages", []) or []:
            for item in stage.get("items", []) or []:
                add(item.get("hs_code"))
        for edge in chain.get("edges", []) or []:
            add(edge.get("src"))
            add(edge.get("dst"))
    return codes


# --------------------------------------------------------------------------- step

def run(conn: sqlite3.Connection) -> dict:
    """Load sections, hs_nodes and products. Products get placeholder ministry/sector (set by mapping_rules)."""
    sections = load_sections()
    conn.executemany("INSERT INTO sections(id, num, name) VALUES (?,?,?)", sections)
    nodes = load_hs_nodes({s[0] for s in sections})
    conn.executemany("INSERT INTO hs_nodes(code, level, parent, section_id, description) VALUES (?,?,?,?,?)", nodes)
    node_desc = {n[0]: n[4] for n in nodes}
    node_section = {n[0]: n[3] for n in nodes}
    hs6_valid = {n[0] for n in nodes if n[1] == 6}

    gst = load_gst_master()
    current = sorted(c for c in gst if c[:6] in hs6_valid)
    referenced = set(value_chain_codes())
    extra = sorted(c for c in referenced if c in gst and c[:6] not in hs6_valid)
    missing_refs = sorted(c for c in referenced if c not in gst)

    n_current_in_hs6 = Counter(c[:6] for c in current)
    n_extra_in_hs6 = Counter(c[:6] for c in extra)
    label_hs6: dict[str, set[str]] = {}
    for code in current + extra:
        label_hs6.setdefault(label_key(gst[code]), set()).add(code[:6])
    rows = []
    for code in sorted(current + extra):
        hs6, hs4, hs2 = code[:6], code[:4], code[:2]
        is_current = 1 if hs6 in hs6_valid else 0
        lines = n_current_in_hs6[hs6] if is_current else n_extra_in_hs6[hs6]
        desc, line_desc, full_desc = build_descriptions(
            code, gst[code], node_desc.get(hs4), node_desc.get(hs6) if is_current else None,
            single_line_subheading=(lines == 1), ambiguous=len(label_hs6[label_key(gst[code])]) > 1)
        rows.append((code, hs6, hs4, hs2, node_section.get(hs2), desc, line_desc, full_desc,
                     None, "residual", "residual", "rule", None, None, is_current, max(1, lines)))
    conn.executemany(
        "INSERT INTO products(hsn8, hs6, hs4, hs2, section_id, description, line_description, full_description,"
        " sector_id, ministry_id, mapping_status, mapping_source, mapping_confidence, mapping_rule, is_current,"
        " lines_in_hs6) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    stats = {
        "sections": len(sections),
        "hs_nodes": len(nodes),
        "gst_8digit_codes": len(gst),
        "products": len(rows),
        "products_current": len(current),
        "products_noncurrent_referenced": len(extra),
        "hs6_with_lines": len(n_current_in_hs6),
    }
    if missing_refs:
        stats["referenced_codes_not_in_gst_master"] = missing_refs
    return stats


def rebuild_fts(conn: sqlite3.Connection) -> int:
    """Rebuild ``products_fts`` from ``products`` (rowid = products.rowid). Returns the row count.

    Call again whenever product descriptions, ministries or sectors change. Note that ``VACUUM`` may
    renumber the implicit rowids of ``products``; rebuild the index after a VACUUM.
    """
    conn.execute("DELETE FROM products_fts")
    conn.execute(
        "INSERT INTO products_fts(rowid, hsn8, description, full_description, ministry, sector) "
        "SELECT p.rowid, p.hsn8, p.description, COALESCE(p.full_description, ''), "
        "       COALESCE(m.short_name || ' ' || m.name, ''), COALESCE(s.name, '') "
        "FROM products p LEFT JOIN ministries m ON m.id = p.ministry_id "
        "LEFT JOIN sectors s ON s.id = p.sector_id ORDER BY p.rowid")
    return conn.execute("SELECT COUNT(*) FROM products_fts").fetchone()[0]
