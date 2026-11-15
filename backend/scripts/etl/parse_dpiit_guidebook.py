"""Parse the official DPIIT Guidebook on HSN Code Mapping (16.12.2025 revision).

The Guidebook is a PDF published by DPIIT. This script extracts the two machine-readable
tables it contains:

* the accepted HS code list, grouped by the ministry/department that accepted each code;
* the residual list, with the "probable ministry/department" suggested by DPIIT.

Output: ``data/curated/ministry_mapping.json``. The PDF itself is not committed; download it
from the URL below and pass it with ``--pdf``.

Usage (from ``backend/``)::

    python -m scripts.etl.parse_dpiit_guidebook --pdf C:/path/guidebook.pdf

The parser validates the published totals (11,679 accepted unique codes, 12,912 acceptances,
495 residual codes) and fails if its extraction drifts. Accepted ministry tables are on PDF
pages 24-429; the residual annexure is on pages 430-459, so the requested pages 24-450 are
fully covered. The Guidebook prints codes without their leading zero and sometimes splits a
description or the probable-ministry cell over two table rows; both are handled.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter, OrderedDict
from datetime import datetime, timezone
from pathlib import Path

try:
    import pymupdf
except ImportError as exc:  # pragma: no cover - dependency is in requirements.txt
    raise SystemExit("pymupdf is required: pip install pymupdf") from exc

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "curated" / "ministry_mapping.json"

SOURCE_URL = "https://www.dpiit.gov.in/static/uploads/2025/12/aa547e2ea8a7d7ddd98325a155ad4549.pdf"
SOURCE_TITLE = "Guidebook on Mapping of Harmonized System of Nomenclature (HSN) Codes"
SOURCE_EDITION = "Revised & updated version as on 16.12.2025"
SOURCE_PUBLISHER = "Department for Promotion of Industry and Internal Trade (DPIIT), Government of India"

# (heading in the PDF, Atlas ministry id). The order is the Guidebook order and is used to
# pick the primary owner when a code appears under more than one ministry.
SECTIONS: list[tuple[str, str]] = [
    ("D/o AGRICULTURE & FARMERS WELFARE", "dafw"),
    ("M/o AYUSH", "ayush"),
    ("D/o CHEMICALS AND PETRO-CHEMICALS", "dcpc"),
    ("D/o FERTILIZERS", "dofert"),
    ("D/o PHARMACEUTICALS", "dop"),
    ("M/o CIVIL AVIATION", "moca"),
    ("M/o COAL", "mocoal"),
    ("D/o COMMERCE", "doc"),
    ("DEPARTMENT FOR PROMOTION OF INDUSTRIES AND INTERNAL TRADE", "dpiit"),
    ("D/o TELECOMMUNICATIONS", "dot"),
    ("D/o POSTS", "posts"),
    ("D/o FOOD AND PUBLIC DISTRIBUTION", "dfpd"),
    ("M/o CULTURE", "mocul"),
    ("M/o DEFENCE", "ddp"),
    ("M/o ELECTRONICS AND INFORMATION TECHNOLOGY", "meity"),
    ("M/o ENVIRONMENT, FOREST AND CLIMATE CHANGE", "moefcc"),
    ("D/o FISHERIES", "dofish"),
    ("D/o ANIMAL HUSBANDRY AND DAIRYING", "dahd"),
    ("M/o FOOD PROCESSING INDUSTRIES", "mofpi"),
    ("M/o HEAVY INDUSTRIES", "mhi"),
    ("M/o INFORMATION AND BROADCASTING", "mib"),
    ("M/o MINES", "mom"),
    ("M/o NEW AND RENEWABLE ENERGY", "mnre"),
    ("M/o PETROLEUM AND NATURAL GAS", "mopng"),
    ("M/o PORTS, SHIPPING AND WATERWAYS", "mopsw"),
    ("M/o POWER", "mop"),
    ("M/o RAILWAYS", "mor"),
    ("M/o STEEL", "mos"),
    ("M/o TEXTILES", "mot"),
    ("D/o SPORTS", "sports"),
    ("D/o ATOMIC ENERGY", "dae"),
]

EXPECTED_ACCEPTED_UNIQUE = 11_679
EXPECTED_ACCEPTANCES = 12_912
EXPECTED_RESIDUAL = 495
MAIN_FIRST_PAGE = 24          # 1-based PDF pages of the ministry-wise tables
MAIN_LAST_PAGE = 429
RESIDUAL_FIRST_PAGE = 430
RESIDUAL_LAST_PAGE = 459

_WS = re.compile(r"\s+")
_CODE = re.compile(r"^\d{7,8}$")
_CHAPTER = re.compile(r"^\d{1,2}$")
_HEADER = re.compile(r"^(S\.?\s*NO\.?|CHAPTER|HS\s*CODE|DESCRIPTION|PROBABLE|MINISTRY|MENT)", re.I)


def _norm(value: str) -> str:
    return _WS.sub(" ", value).strip().upper().rstrip("0123456789 ")


def _is_section_heading(line: str) -> str | None:
    n = _norm(line)
    for heading, ministry_id in SECTIONS:
        h = _norm(heading)
        if n == h or n.startswith(h):
            return ministry_id
    return None


def _cell_text(cell) -> str:
    return _WS.sub(" ", str(cell).replace("\n", " ")).strip() if cell is not None else ""


def _table_rows(page):
    for table in page.find_tables().tables:
        for raw in table.extract():
            cells = [_cell_text(c) for c in raw]
            cells = [c for c in cells if c]
            if cells and not all(_HEADER.match(c) for c in cells):
                yield cells


def _split_code_row(cells: list[str]) -> tuple[str, str] | None:
    """Return (hsn8, description) when the cells contain an HS code; otherwise None.

    The table columns are S.NO. / CHAPTER / HS CODE / DESCRIPTION. PyMuPDF sometimes merges the
    first columns, so the description is taken from the cells *after* the code; anything before
    the code is a serial/chapter number and is not part of the description.
    """
    code = None
    code_index = None
    for index, cell in enumerate(cells):
        if _CODE.fullmatch(cell):
            code = cell.zfill(8)
            code_index = index
            break
    if code is None or code_index is None:
        return None
    description = " ".join(c for c in cells[code_index + 1:] if c and not _HEADER.match(c)).strip()
    if not description:
        description = " ".join(c for c in cells[:code_index] if c and not c.isdigit()).strip()
    return code, description


def _table_columns(raw_rows, table) -> tuple[tuple[float, float], tuple[float, float]]:
    """Return the x-ranges of the HS-code and description/probable columns.

    PyMuPDF reports merged cells differently from page to page: sometimes DESCRIPTION and
    PROBABLE are separate cells, sometimes the probable-ministry cell starts at the description
    column's right edge. Using the header cell geometry keeps the two fields separate.
    """
    bounds: dict[str, tuple[float, float]] = {}
    for raw, row in zip(raw_rows[:5], table.rows[:5]):
        for index, value in enumerate(raw):
            text = _cell_text(value)
            if not text or index >= len(row.cells):
                continue
            cell = row.cells[index]
            if cell is None:
                continue
            upper = text.upper()
            if upper.startswith("HS CODE") and "code" not in bounds:
                bounds["code"] = (float(cell[0]), float(cell[2]))
            elif upper.startswith("DESCRIPTION") and "description" not in bounds:
                bounds["description"] = (float(cell[0]), float(cell[2]))
    if "code" not in bounds or "description" not in bounds:
        raise SystemExit("could not locate HS CODE / DESCRIPTION columns in the residual table")
    return bounds["code"], bounds["description"]


def _normalise_probable(value: str) -> str:
    value = _WS.sub(" ", value).strip(" ,;")
    value = value.replace("D/O", "D/o").replace("M/O", "M/o")
    return value.replace("Petro- Chemicals", "Petro-Chemicals")


def parse_accepted(doc: pymupdf.Document) -> list[dict]:
    current: str | None = None
    rows: list[dict] = []
    for page_index in range(MAIN_FIRST_PAGE - 1, MAIN_LAST_PAGE):
        page = doc[page_index]
        lines = [line.strip() for line in page.get_text().splitlines() if line.strip()]
        for line in lines[:10]:
            found = _is_section_heading(line)
            if found:
                current = found
                break
        if current is None:
            continue
        for cells in _table_rows(page):
            parsed = _split_code_row(cells)
            if parsed is None:
                # The Guidebook sometimes wraps a description onto its own table row.
                if rows and rows[-1]["page"] == page_index + 1:
                    extra = " ".join(c for c in cells if not _HEADER.match(c)).strip()
                    if extra:
                        rows[-1]["description"] = (rows[-1]["description"] + " " + extra).strip()
                continue
            code, description = parsed
            rows.append({
                "hsn8": code,
                "ministry_id": current,
                "description": description,
                "page": page_index + 1,
            })
    return rows


def parse_residual(doc: pymupdf.Document) -> list[dict]:
    """Parse the residual annexure (pages 430-459).

    The annexure has an extra PROBABLE MINISTRY/DEPARTMENT column. A description or the
    probable-ministry text can wrap onto a continuation row, and a row can carry continuation
    fragments for both columns. Cells are assigned to columns from their x-coordinate, then
    continuation fragments are appended to the preceding HS-code row.
    """
    rows: list[dict] = []
    last: dict | None = None
    for page_index in range(RESIDUAL_FIRST_PAGE - 1, RESIDUAL_LAST_PAGE):
        page = doc[page_index]
        tables = page.find_tables().tables
        if not tables:
            raise SystemExit(f"no residual table found on PDF page {page_index + 1}")
        table = tables[0]
        raw_rows = table.extract()
        code_x, description_x = _table_columns(raw_rows, table)
        code_start, code_end = code_x
        description_start, probable_start = description_x

        for raw, row in zip(raw_rows, table.rows):
            code = None
            description_parts: list[str] = []
            probable_parts: list[str] = []
            for index, value in enumerate(raw):
                text = _cell_text(value)
                if not text or index >= len(row.cells):
                    continue
                cell = row.cells[index]
                if cell is None:
                    continue
                x0 = float(cell[0])
                if _CODE.fullmatch(text) and code_start - 3 <= x0 <= code_end:
                    code = text.zfill(8)
                elif x0 >= description_start - 3 and x0 < probable_start - 3:
                    if not _HEADER.match(text):
                        description_parts.append(text)
                elif x0 >= probable_start - 3:
                    if not _HEADER.match(text):
                        probable_parts.append(text)

            if code is not None:
                last = {
                    "hsn8": code,
                    "description": " ".join(description_parts).strip(),
                    "probable_ministry": _normalise_probable(" ".join(probable_parts)),
                    "page": page_index + 1,
                }
                rows.append(last)
                continue
            if last is None:
                continue
            if description_parts:
                addition = " ".join(description_parts).strip()
                last["description"] = f"{last['description']} {addition}".strip()
            if probable_parts:
                addition = _normalise_probable(" ".join(probable_parts))
                last["probable_ministry"] = _normalise_probable(
                    f"{last['probable_ministry']} {addition}")
    return rows


def build(pdf_path: Path) -> dict:
    raw = pdf_path.read_bytes()
    doc = pymupdf.open(pdf_path)
    accepted_rows = parse_accepted(doc)
    residual_rows = parse_residual(doc)

    missing_probable = [r["hsn8"] for r in residual_rows if not r["probable_ministry"]]
    if missing_probable:
        raise SystemExit(f"residual rows without a probable ministry: {missing_probable[:20]}")
    accepted_pages = {r["page"] for r in accepted_rows}
    residual_pages = {r["page"] for r in residual_rows}
    if not accepted_pages or (min(accepted_pages), max(accepted_pages)) != (
            MAIN_FIRST_PAGE, MAIN_LAST_PAGE):
        raise SystemExit(
            f"accepted page coverage drifted: {min(accepted_pages, default=None)}-"
            f"{max(accepted_pages, default=None)}; expected {MAIN_FIRST_PAGE}-{MAIN_LAST_PAGE}")
    if not residual_pages or (min(residual_pages), max(residual_pages)) != (
            RESIDUAL_FIRST_PAGE, RESIDUAL_LAST_PAGE):
        raise SystemExit(
            f"residual page coverage drifted: {min(residual_pages, default=None)}-"
            f"{max(residual_pages, default=None)}; expected {RESIDUAL_FIRST_PAGE}-{RESIDUAL_LAST_PAGE}")

    # Drop malformed fragments created by wrapped description rows (chapter '00'). The published
    # Guidebook has no chapter 00; these are not HS codes.
    accepted_rows = [r for r in accepted_rows if not r["hsn8"].startswith("00")]
    residual_rows = [r for r in residual_rows if not r["hsn8"].startswith("00")]

    accepted: "OrderedDict[str, dict]" = OrderedDict()
    for row in accepted_rows:
        entry = accepted.setdefault(row["hsn8"], {
            "hsn8": row["hsn8"],
            "ministries": [],
            "description": row["description"],
            "page": row["page"],
        })
        if row["ministry_id"] not in entry["ministries"]:
            entry["ministries"].append(row["ministry_id"])
        if not entry["description"] and row["description"]:
            entry["description"] = row["description"]

    residual: "OrderedDict[str, dict]" = OrderedDict()
    for row in residual_rows:
        residual.setdefault(row["hsn8"], {
            "hsn8": row["hsn8"],
            "description": row["description"],
            "probable_ministry": row["probable_ministry"],
            "page": row["page"],
        })

    # A code accepted by a ministry is not residual, even if the annexure lists it by mistake.
    residual = OrderedDict((k, v) for k, v in residual.items() if k not in accepted)

    counts = Counter(r["ministry_id"] for r in accepted_rows)
    expected_by_ministry = {
        "dafw": 453, "ayush": 49, "dcpc": 1900, "dofert": 29, "dop": 618, "moca": 49,
        "mocoal": 30, "doc": 348, "dpiit": 2684, "dot": 48, "posts": 1, "dfpd": 55,
        "mocul": 25, "ddp": 25, "meity": 178, "moefcc": 125, "dofish": 374, "dahd": 264,
        "mofpi": 869, "mhi": 841, "mib": 49, "mom": 666, "mnre": 2, "mopng": 86,
        "mopsw": 34, "mop": 3, "mor": 34, "mos": 818, "mot": 2176, "sports": 34, "dae": 45,
    }
    if len(accepted) != EXPECTED_ACCEPTED_UNIQUE or len(accepted_rows) != EXPECTED_ACCEPTANCES:
        raise SystemExit(
            f"accepted extraction drifted: {len(accepted)} unique / {len(accepted_rows)} rows; "
            f"expected {EXPECTED_ACCEPTED_UNIQUE} / {EXPECTED_ACCEPTANCES}")
    if len(residual) != EXPECTED_RESIDUAL:
        raise SystemExit(f"residual extraction drifted: {len(residual)}; expected {EXPECTED_RESIDUAL}")
    if counts != Counter(expected_by_ministry):
        diff = {k: (counts.get(k, 0), v) for k, v in expected_by_ministry.items() if counts.get(k, 0) != v}
        raise SystemExit(f"per-ministry counts drifted: {diff}")

    multi = sum(1 for e in accepted.values() if len(e["ministries"]) > 1)
    return {
        "_source": {
            "title": SOURCE_TITLE,
            "edition": SOURCE_EDITION,
            "publisher": SOURCE_PUBLISHER,
            "url": SOURCE_URL,
            "retrieved_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "pdf_bytes": len(raw),
            "pdf_pages": doc.page_count,
            "page_ranges": {
                "accepted": [MAIN_FIRST_PAGE, MAIN_LAST_PAGE],
                "residual": [RESIDUAL_FIRST_PAGE, RESIDUAL_LAST_PAGE],
            },
            "primary_owner_rule": (
                "Where the Guidebook lists one code under several ministries/departments, the "
                "first-listed section is stored as the primary owner and every other section as "
                "a secondary owner. The ownership set is the official Guidebook set."
            ),
        },
        "counts": {
            "accepted_unique_codes": len(accepted),
            "acceptances": len(accepted_rows),
            "multi_owner_codes": multi,
            "residual_codes": len(residual),
        },
        "accepted": list(accepted.values()),
        "residual": list(residual.values()),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--pdf", type=Path, required=True, help="path to the DPIIT Guidebook PDF")
    ap.add_argument("--out", type=Path, default=OUT, help=f"output JSON (default: {OUT})")
    args = ap.parse_args()
    data = build(args.pdf)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {args.out} ({args.out.stat().st_size / 1e6:.2f} MB)")
    print(json.dumps(data["counts"], indent=2))


if __name__ == "__main__":
    main()
