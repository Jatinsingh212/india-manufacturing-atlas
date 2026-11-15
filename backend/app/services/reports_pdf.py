"""Report documents and their PDF / XLSX / CSV renderings (docs/SPEC.md section 6.12; "Download
Report").

The routers build a format-neutral :class:`ReportDoc` - title, key facts, KPI tiles, a list of :class:`Table`
objects and provenance footnotes - and this module renders it. (The file is called ``reports_pdf`` after the SPEC's
file list; it renders all three formats so the content of a PDF, a workbook and a CSV can never drift apart.)

* **PDF** (reportlab platypus, A4 portrait): a royal-blue header band (``#0033A0``) and navy rules (``#0B1F3A``) -
  the Atlas identity - on every page; title block with generated timestamp; key-facts table; KPI tiles with
  magenta numerals (``#E6007E``); each table with a navy header row, zebra striping, right-aligned numbers and
  wrapped text (at most ``Table.pdf_limit`` rows - the workbook / CSV carry every row); a "Sources and
  provenance" section; footer with page numbers. Text uses the Bitstream Vera fonts bundled with reportlab
  (they cover every character in the Atlas data: em dashes, degree signs, accents); any other character is
  transliterated so no glyph renders as a box.
* **XLSX** (a lean SpreadsheetML writer, see :func:`render_xlsx`): a ``Summary`` sheet (title, facts, KPIs,
  provenance, sheet index) and one sheet per table with a formatted, frozen header row, auto-filter, sensible
  column widths and real number formats (US$ as ``#,##0``, shares as ``0.00%``) - values stay numeric for
  analysis.
* **CSV**: the whole report as sections (``# ...`` comment lines with title / provenance, then for each table a
  ``[Title]`` line, the header and the rows, separated by blank lines), or - with ``table=<key>`` - exactly one
  table as a plain machine-readable CSV. Raw values (US$, fractions), UTF-8 with BOM (opens cleanly in Excel).

Column kinds (``Column.kind``): ``text``, ``code`` (kept as text, leading zeros intact), ``usd`` (US$),
``pct`` (a fraction shown as %), ``pct_value`` (already in percent, e.g. a tariff 12.5), ``ratio`` (2 decimals,
e.g. RCA), ``num`` (1 decimal), ``int``, ``year`` (an integer without thousands separator), ``qty`` (a physical
quantity shown compactly: ``1.5 bn``, ``200 mn``). ``None`` is rendered
as "Not available" in PDF tables and left empty in XLSX / CSV. ``Table.pdf_columns`` (optional list of column
keys) narrows a wide table to the columns that fit on an A4 page; XLSX / CSV always carry every column.
"""
from __future__ import annotations

import csv
import io
import os
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

PLATFORM = "India Manufacturing Atlas"
PLATFORM_TAGLINE = "HSN intelligence platform - DPIIT"
ROYAL = "#0033A0"
NAVY = "#0B1F3A"
MAGENTA = "#E6007E"
GREY = "#5B6573"
LIGHT = "#EEF2F8"
NOT_AVAILABLE = "Not available"

_FONT = "Helvetica"
_FONT_BOLD = "Helvetica-Bold"
_FONT_ITALIC = "Helvetica-Oblique"
_fonts_ready = False
_font_cmap: set[int] | None = None
_FALLBACK_CHARS = {"→": "->", "←": "<-", "₹": "Rs ", "Δ": "delta ", " ": " ",
                   " ": " ", "​": ""}


# --------------------------------------------------------------------------- document model

@dataclass
class Column:
    """A table column: ``key`` in the row dicts, header ``label`` and a value ``kind`` (see module doc)."""

    key: str
    label: str
    kind: str = "text"
    width: float = 1.0          # relative width in the PDF


@dataclass
class Table:
    """One table of a report (one XLSX sheet, one CSV section)."""

    key: str
    title: str
    columns: list[Column]
    rows: list[dict]
    note: str | None = None
    pdf_limit: int | None = 25
    pdf_columns: list[str] | None = None   # column keys shown in the PDF (None = all)

    def columns_for_pdf(self) -> list[Column]:
        if not self.pdf_columns:
            return list(self.columns)
        wanted = set(self.pdf_columns)
        return [c for c in self.columns if c.key in wanted] or list(self.columns)


@dataclass
class Kpi:
    """A headline number."""

    label: str
    value: Any
    kind: str = "text"
    note: str | None = None


@dataclass
class ReportDoc:
    """A format-neutral report."""

    kind: str
    entity_id: str
    title: str
    subtitle: str | None = None
    facts: list[tuple[str, str]] = field(default_factory=list)
    kpis: list[Kpi] = field(default_factory=list)
    tables: list[Table] = field(default_factory=list)
    provenance: list[str] = field(default_factory=list)
    generated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="seconds"))

    @property
    def filename_stem(self) -> str:
        safe = re.sub(r"[^A-Za-z0-9_-]+", "_", str(self.entity_id)).strip("_") or "report"
        return f"atlas_{self.kind}_{safe}_{self.generated_at[:10].replace('-', '')}"

    def table(self, key: str) -> Table | None:
        return next((t for t in self.tables if t.key == key), None)


# --------------------------------------------------------------------------- value formatting

def fmt_usd(value: Any) -> str:
    """``3.11e9 -> "$3.11 bn"``, ``8.12e8 -> "$812 mn"``, ``45_300 -> "$45,300"``; None -> "Not available"."""
    if value is None:
        return NOT_AVAILABLE
    try:
        v = float(value)
    except (TypeError, ValueError):
        return str(value)
    sign = "-" if v < 0 else ""
    a = abs(v)
    if a >= 1e12:
        return f"{sign}${a / 1e12:.2f} tn"
    if a >= 1e9:
        return f"{sign}${a / 1e9:.2f} bn"
    if a >= 1e6:
        return f"{sign}${a / 1e6:,.0f} mn" if a >= 1e8 else f"{sign}${a / 1e6:.1f} mn"
    return f"{sign}${a:,.0f}"


def fmt_qty(value: Any) -> str:
    """Compact quantity: ``1.5e9 -> "1.5 bn"``, ``2e8 -> "200 mn"``, ``45_300 -> "45,300"``."""
    v = float(value)
    a = abs(v)
    for div, unit in ((1e12, "tn"), (1e9, "bn"), (1e6, "mn")):
        if a >= div:
            text = f"{v / div:.2f}".rstrip("0").rstrip(".")
            return f"{text} {unit}"
    return f"{v:,.0f}" if a >= 100 else f"{v:,.2f}".rstrip("0").rstrip(".")


KIND_LABELS = {"product": "Product report", "ministry": "Ministry report", "sector": "Sector report",
               "valuechain": "Value-chain report", "search": "Search export"}


def format_value(value: Any, kind: str) -> str:
    """Display string of a value for the PDF (and KPI tiles)."""
    if value is None or value == "":
        return NOT_AVAILABLE
    try:
        if kind == "usd":
            return fmt_usd(value)
        if kind == "pct":
            return f"{float(value) * 100:.2f}%"
        if kind == "pct_value":
            text = f"{float(value):.2f}".rstrip("0").rstrip(".")
            return f"{text}%"
        if kind == "ratio":
            return f"{float(value):.2f}"
        if kind == "num":
            return f"{float(value):,.1f}"
        if kind == "int":
            return f"{int(round(float(value))):,}"
        if kind == "year":
            return str(int(float(value)))
        if kind == "qty":
            return fmt_qty(value)
    except (TypeError, ValueError):
        return str(value)
    return str(value)


def _raw(value: Any, kind: str) -> Any:
    """Value for XLSX / CSV: numbers stay numbers; codes and text stay text."""
    if value is None:
        return None
    if kind in ("usd", "pct", "pct_value", "ratio", "num", "qty"):
        try:
            return float(value)
        except (TypeError, ValueError):
            return value
    if kind in ("int", "year"):
        try:
            return int(round(float(value)))
        except (TypeError, ValueError):
            return value
    return str(value) if not isinstance(value, str) else value


# --------------------------------------------------------------------------- PDF

def _setup_fonts() -> None:
    """Register the bundled Bitstream Vera family (falls back to Helvetica if it cannot be loaded)."""
    global _fonts_ready, _FONT, _FONT_BOLD, _FONT_ITALIC, _font_cmap
    if _fonts_ready:
        return
    _fonts_ready = True
    try:
        import reportlab
        from reportlab.lib.fonts import addMapping
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont

        folder = os.path.join(os.path.dirname(reportlab.__file__), "fonts")
        faces = {"AtlasSans": "Vera.ttf", "AtlasSans-Bold": "VeraBd.ttf", "AtlasSans-Italic": "VeraIt.ttf",
                 "AtlasSans-BoldItalic": "VeraBI.ttf"}
        for name, file in faces.items():
            font = TTFont(name, os.path.join(folder, file))
            pdfmetrics.registerFont(font)
            if name == "AtlasSans":
                _font_cmap = set(font.face.charToGlyph)
        addMapping("AtlasSans", 0, 0, "AtlasSans")
        addMapping("AtlasSans", 1, 0, "AtlasSans-Bold")
        addMapping("AtlasSans", 0, 1, "AtlasSans-Italic")
        addMapping("AtlasSans", 1, 1, "AtlasSans-BoldItalic")
        _FONT, _FONT_BOLD, _FONT_ITALIC = "AtlasSans", "AtlasSans-Bold", "AtlasSans-Italic"
    except Exception:  # noqa: BLE001 - any font problem: keep the built-in Helvetica (Latin-1 only)
        _font_cmap = set(range(32, 256))


def _safe(text: Any) -> str:
    """Text the PDF font can draw (unsupported characters transliterated) - not yet XML-escaped."""
    text = "" if text is None else str(text)
    cmap = _font_cmap
    if cmap is None or all(ord(ch) in cmap or ch in "\n\t" for ch in text):
        return text
    out = []
    for ch in text:
        if ord(ch) in cmap or ch in "\n\t":
            out.append(ch)
        elif ch in _FALLBACK_CHARS:
            out.append(_FALLBACK_CHARS[ch])
        else:
            folded = unicodedata.normalize("NFKD", ch).encode("ascii", "ignore").decode("ascii")
            out.append(folded or "?")
    return "".join(out)


def _esc(text: Any) -> str:
    return (_safe(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace("\n", "<br/>"))


def render_pdf(doc: ReportDoc) -> bytes:
    """Render ``doc`` as an A4 PDF (bytes)."""
    _setup_fonts()
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import (CondPageBreak, KeepTogether, Paragraph, SimpleDocTemplate, Spacer)
    from reportlab.platypus import Table as RLTable
    from reportlab.platypus import TableStyle

    royal, navy, magenta = colors.HexColor(ROYAL), colors.HexColor(NAVY), colors.HexColor(MAGENTA)
    grey, light = colors.HexColor(GREY), colors.HexColor(LIGHT)
    styles = {
        "title": ParagraphStyle("title", fontName=_FONT_BOLD, fontSize=19, leading=23, textColor=navy, spaceAfter=3),
        "subtitle": ParagraphStyle("subtitle", fontName=_FONT, fontSize=10.5, leading=14, textColor=grey),
        "meta": ParagraphStyle("meta", fontName=_FONT, fontSize=8, leading=10, textColor=grey),
        "h2": ParagraphStyle("h2", fontName=_FONT_BOLD, fontSize=12, leading=15, textColor=royal, spaceBefore=10,
                             spaceAfter=4),
        "cell": ParagraphStyle("cell", fontName=_FONT, fontSize=7.6, leading=9.4, textColor=navy, alignment=TA_LEFT),
        "cell_r": ParagraphStyle("cell_r", fontName=_FONT, fontSize=7.6, leading=9.4, textColor=navy,
                                 alignment=TA_RIGHT),
        "head": ParagraphStyle("head", fontName=_FONT_BOLD, fontSize=7.6, leading=9.4, textColor=colors.white),
        "head_r": ParagraphStyle("head_r", fontName=_FONT_BOLD, fontSize=7.6, leading=9.4, textColor=colors.white,
                                 alignment=TA_RIGHT),
        "note": ParagraphStyle("note", fontName=_FONT_ITALIC, fontSize=7.2, leading=9, textColor=grey, spaceBefore=2),
        "kpi_value": ParagraphStyle("kpi_value", fontName=_FONT_BOLD, fontSize=14, leading=17, textColor=magenta),
        "kpi_label": ParagraphStyle("kpi_label", fontName=_FONT_BOLD, fontSize=7.4, leading=9, textColor=navy),
        "kpi_note": ParagraphStyle("kpi_note", fontName=_FONT, fontSize=6.4, leading=8, textColor=grey),
        "fact_k": ParagraphStyle("fact_k", fontName=_FONT_BOLD, fontSize=8, leading=10, textColor=grey),
        "fact_v": ParagraphStyle("fact_v", fontName=_FONT, fontSize=8, leading=10, textColor=navy),
        "foot": ParagraphStyle("foot", fontName=_FONT, fontSize=7.4, leading=9.6, textColor=grey),
    }
    buffer = io.BytesIO()
    page_w, page_h = A4
    margin = 15 * mm
    usable = page_w - 2 * margin
    generated = _generated_label(doc.generated_at)

    def decorate(canvas, document) -> None:
        canvas.saveState()
        canvas.setFillColor(royal)
        canvas.rect(0, page_h - 13 * mm, page_w, 13 * mm, stroke=0, fill=1)
        canvas.setFillColor(colors.white)
        canvas.setFont(_FONT_BOLD, 10)
        canvas.drawString(margin, page_h - 8.4 * mm, PLATFORM.upper())
        canvas.setFont(_FONT, 8)
        canvas.drawRightString(page_w - margin, page_h - 8.4 * mm,
                               _safe(KIND_LABELS.get(doc.kind, f"{doc.kind.title()} report")))
        canvas.setStrokeColor(navy)
        canvas.setLineWidth(0.6)
        canvas.line(margin, 12 * mm, page_w - margin, 12 * mm)
        canvas.setFillColor(grey)
        canvas.setFont(_FONT, 7)
        right = f"Generated {generated}  |  Page {document.page}"
        room = page_w - 2 * margin - canvas.stringWidth(right, _FONT, 7) - 6 * mm
        left = _safe(f"{PLATFORM} - {doc.title}")
        if canvas.stringWidth(left, _FONT, 7) > room:
            while left and canvas.stringWidth(left + "...", _FONT, 7) > room:
                left = left[:-1]
            left = left.rstrip() + "..."
        canvas.drawString(margin, 8 * mm, left)
        canvas.drawRightString(page_w - margin, 8 * mm, right)
        canvas.restoreState()

    story: list = [Paragraph(_esc(doc.title), styles["title"])]
    if doc.subtitle:
        story.append(Paragraph(_esc(doc.subtitle), styles["subtitle"]))
    story.append(Paragraph(_esc(f"Generated {generated} by the {PLATFORM} ({PLATFORM_TAGLINE}). "
                                "Trade values in US$; 'Not available' = no data in the source."), styles["meta"]))
    story.append(Spacer(1, 5 * mm))

    if doc.facts:
        fact_rows = [[Paragraph(_esc(k), styles["fact_k"]), Paragraph(_esc(v), styles["fact_v"])]
                     for k, v in doc.facts]
        facts = RLTable(fact_rows, colWidths=[usable * 0.24, usable * 0.76])
        facts.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, -1), 0.25, light),
            ("TOPPADDING", (0, 0), (-1, -1), 2.2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2.2)]))
        story += [facts, Spacer(1, 4 * mm)]

    if doc.kpis:
        per_row = 4
        tile_w = usable / per_row
        cells, grid = [], []
        for kpi in doc.kpis:
            tile = [Paragraph(_esc(format_value(kpi.value, kpi.kind)), styles["kpi_value"]),
                    Paragraph(_esc(kpi.label), styles["kpi_label"])]
            if kpi.note:
                tile.append(Paragraph(_esc(kpi.note), styles["kpi_note"]))
            cells.append(tile)
        for i in range(0, len(cells), per_row):
            chunk = cells[i:i + per_row]
            grid.append(chunk + [""] * (per_row - len(chunk)))
        kpi_table = RLTable(grid, colWidths=[tile_w] * per_row)
        kpi_style = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 5),
                     ("BOTTOMPADDING", (0, 0), (-1, -1), 6), ("LEFTPADDING", (0, 0), (-1, -1), 6)]
        for r_i, grid_row in enumerate(grid):
            for c_i, cell in enumerate(grid_row):
                if cell != "":
                    kpi_style += [("BACKGROUND", (c_i, r_i), (c_i, r_i), light),
                                  ("LINEBEFORE", (c_i, r_i), (c_i, r_i), 2.2, royal)]
        kpi_table.setStyle(TableStyle(kpi_style))
        story += [Paragraph("Key figures", styles["h2"]), kpi_table]

    for table in doc.tables:
        story.append(CondPageBreak(45 * mm))
        heading = Paragraph(_esc(table.title), styles["h2"])
        if not table.rows:
            story.append(KeepTogether([heading, Paragraph(NOT_AVAILABLE + " - no rows for this table.",
                                                          styles["note"])]))
            continue
        shown = table.rows if table.pdf_limit is None else table.rows[:table.pdf_limit]
        columns = table.columns_for_pdf()
        total_w = sum(c.width for c in columns) or 1.0
        widths = [usable * c.width / total_w for c in columns]
        numeric = [c.kind in ("usd", "pct", "pct_value", "ratio", "num", "int", "year", "qty") for c in columns]
        data = [[Paragraph(_esc(c.label), styles["head_r" if numeric[i] else "head"])
                 for i, c in enumerate(columns)]]
        for r in shown:
            data.append([Paragraph(_esc(format_value(r.get(c.key), c.kind)), styles["cell_r" if numeric[i] else "cell"])
                         for i, c in enumerate(columns)])
        rl = RLTable(data, colWidths=widths, repeatRows=1)
        style = [("BACKGROUND", (0, 0), (-1, 0), navy), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                 ("TOPPADDING", (0, 0), (-1, -1), 2.4), ("BOTTOMPADDING", (0, 0), (-1, -1), 2.4),
                 ("LEFTPADDING", (0, 0), (-1, -1), 3.5), ("RIGHTPADDING", (0, 0), (-1, -1), 3.5),
                 ("LINEBELOW", (0, -1), (-1, -1), 0.6, navy)]
        style += [("BACKGROUND", (0, i), (-1, i), light) for i in range(2, len(data), 2)]
        rl.setStyle(TableStyle(style))
        story += [heading, rl]
        notes = []
        if table.note:
            notes.append(table.note)
        if table.pdf_limit is not None and len(table.rows) > table.pdf_limit:
            notes.append(f"Showing {table.pdf_limit} of {len(table.rows):,} rows - the XLSX / CSV download "
                         "contains all rows.")
        if len(columns) < len(table.columns):
            notes.append("More columns in the XLSX / CSV download.")
        if notes:
            story.append(Paragraph(_esc(" ".join(notes)), styles["note"]))

    story.append(CondPageBreak(40 * mm))
    story.append(Paragraph("Sources and provenance", styles["h2"]))
    for line in doc.provenance or ["Source: India Manufacturing Atlas database."]:
        story.append(Paragraph(_esc(f"- {line}"), styles["foot"]))
    story.append(Paragraph(_esc(
        "Legend: Verified = official / reconciled source (including the DPIIT Guidebook mapping); Not verified = "
        "residual or unlisted mapping, model estimates; Not available = no data. Model scores are estimates - method at "
        "/about#methodology."), styles["foot"]))

    pdf = SimpleDocTemplate(buffer, pagesize=A4, leftMargin=margin, rightMargin=margin, topMargin=20 * mm,
                            bottomMargin=17 * mm, title=_safe(f"{PLATFORM} - {doc.title}"), author=PLATFORM,
                            subject=_safe(doc.subtitle or doc.title), creator=PLATFORM)
    pdf.build(story, onFirstPage=decorate, onLaterPages=decorate)
    return buffer.getvalue()


def _generated_label(iso: str) -> str:
    try:
        return datetime.fromisoformat(iso).astimezone(timezone.utc).strftime("%d %b %Y %H:%M UTC")
    except (TypeError, ValueError):
        return iso


# --------------------------------------------------------------------------- XLSX

_XLSX_FORMATS = {"usd": "#,##0", "pct": "0.00%", "pct_value": "0.00", "ratio": "0.00", "num": "#,##0.0",
                 "int": "#,##0", "year": "0", "qty": "#,##0"}
_INVALID_SHEET_CHARS = re.compile(r"[\[\]:*?/\\]")
_XML_ILLEGAL = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")

# Cell style ids (``cellXfs`` positions) of :data:`_STYLES_XML`.
_S_HEAD, _S_BOLD, _S_GREY, _S_TITLE, _S_ITALIC = 1, 2, 3, 4, 5
_KIND_STYLE = {"usd": 6, "int": 6, "qty": 6, "pct": 7, "pct_value": 8, "ratio": 8, "num": 9, "year": 10, "code": 11}
_MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_PKG_NS = "http://schemas.openxmlformats.org/package/2006"
_XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
_FONT_TAIL = '<sz val="{size}"/>{color}<name val="Calibri"/><family val="2"/>'


def _font(size: int = 11, color: str | None = None, flags: str = "") -> str:
    tail = _FONT_TAIL.format(size=size, color=f'<color rgb="FF{color.lstrip("#")}"/>' if color else "")
    return f"<font>{flags}{tail}</font>"


_STYLES_XML = (
    _XML_DECL + f'<styleSheet xmlns="{_MAIN_NS}">'
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.0"/></numFmts>'
    '<fonts count="6">'
    + _font() + _font(color="#FFFFFF", flags="<b/>") + _font(flags="<b/>") + _font(color=GREY)
    + _font(size=14, color=ROYAL, flags="<b/>") + _font(color=GREY, flags="<i/>") +
    '</fonts>'
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
    f'<fill><patternFill patternType="solid"><fgColor rgb="FF{NAVY.lstrip("#")}"/><bgColor indexed="64"/>'
    '</patternFill></fill></fills>'
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    '<cellXfs count="12">'
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1">'
    '<alignment vertical="top" wrapText="1"/></xf>'
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    '<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    '<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    '<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    '</cellXfs>'
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    '</styleSheet>')


def _sheet_title(title: str, used: set[str]) -> str:
    """A unique, valid sheet name (<= 31 characters, cut at a word boundary) for a table title."""
    text = re.sub(r"\s+", " ", _INVALID_SHEET_CHARS.sub(" ", title.replace("/", "-"))).strip().strip("'")
    if len(text) > 31:
        cut = text[:31]
        text = (cut[:cut.rfind(" ")] if " " in cut[10:] else cut).rstrip(" (-,;")
    base = text or "Sheet"
    name, n = base, 2
    while name.lower() in used:
        suffix = f" ({n})"
        name = base[:31 - len(suffix)] + suffix
        n += 1
    used.add(name.lower())
    return name


def _col_letter(index: int) -> str:
    """1 -> ``A``, 27 -> ``AA``."""
    letters = ""
    while index:
        index, rem = divmod(index - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


#: One ``str.translate`` table escapes the XML specials and drops the characters XML 1.0 forbids (one C-level
#: pass per cell instead of a regex plus four ``replace`` calls - the search export writes ~200 000 cells).
_XML_TABLE = str.maketrans({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
                            **{chr(i): None for i in [*range(0x00, 0x09), 0x0B, 0x0C, *range(0x0E, 0x20)]},
                            "￾": None, "￿": None})


def _xml_text(value: Any) -> str:
    return str(value).translate(_XML_TABLE)


class _Sheet:
    """Streams the XML of one worksheet: rows of ``(value, style_id)`` cells (a ``None`` value = empty cell)."""

    def __init__(self, name: str, widths: list[float], *, freeze_header: bool = False):
        self.name = name
        self.widths = widths
        self.freeze_header = freeze_header
        self.rows: list[str] = []
        self.auto_filter: tuple[int, int] | None = None    # (n_columns, last_row) of the header + data block
        self._letters: list[str] = []

    def _letter(self, i: int) -> str:
        while i >= len(self._letters):
            self._letters.append(_col_letter(len(self._letters) + 1))
        return self._letters[i]

    def append(self, cells: list[tuple[Any, int]]) -> None:
        r = len(self.rows) + 1
        parts = [f'<row r="{r}">']
        letters = self._letters
        while len(letters) < len(cells):
            letters.append(_col_letter(len(letters) + 1))
        for i, (value, style) in enumerate(cells):
            if value is None or value == "":
                continue
            kind = type(value)
            if kind is float or kind is int:
                if value != value or value in (float("inf"), float("-inf")):
                    continue
                parts.append(f'<c r="{letters[i]}{r}" s="{style}"><v>{value!r}</v></c>' if style
                             else f'<c r="{letters[i]}{r}"><v>{value!r}</v></c>')
            elif kind is bool:
                parts.append(f'<c r="{letters[i]}{r}" t="inlineStr"><is><t>{value}</t></is></c>')
            else:
                text = str(value).translate(_XML_TABLE)
                space = ' xml:space="preserve"' if text[:1].isspace() or text[-1:].isspace() else ""
                parts.append(f'<c r="{letters[i]}{r}" s="{style}" t="inlineStr"><is><t{space}>{text}</t></is></c>'
                             if style else
                             f'<c r="{letters[i]}{r}" t="inlineStr"><is><t{space}>{text}</t></is></c>')
        parts.append("</row>")
        self.rows.append("".join(parts))

    def filter_ref(self, absolute: bool = False) -> str | None:
        if not self.auto_filter:
            return None
        n_cols, last_row = self.auto_filter
        if absolute:
            return f"$A$1:${_col_letter(n_cols)}${last_row}"
        return f"A1:{_col_letter(n_cols)}{last_row}"

    def xml(self) -> str:
        view = ('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" '
                'state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>'
                if self.freeze_header else '<sheetViews><sheetView workbookViewId="0"/></sheetViews>')
        cols = "".join(f'<col min="{i}" max="{i}" width="{w:.1f}" customWidth="1"/>'
                       for i, w in enumerate(self.widths, start=1))
        auto_filter = self.filter_ref()
        return (_XML_DECL + f'<worksheet xmlns="{_MAIN_NS}" xmlns:r="{_REL_NS}">{view}'
                '<sheetFormatPr defaultRowHeight="15"/>'
                + (f"<cols>{cols}</cols>" if cols else "")
                + "<sheetData>" + "".join(self.rows) + "</sheetData>"
                + (f'<autoFilter ref="{auto_filter}"/>' if auto_filter else "")
                + "</worksheet>")


def _write_xlsx(sheets: list[_Sheet], title: str) -> bytes:
    """Zip the worksheets into a minimal, valid SpreadsheetML package (workbook, styles, core properties)."""
    import zipfile

    n = len(sheets)
    sheet_entries = "".join(f'<sheet name="{_xml_text(s.name)}" sheetId="{i}" r:id="rId{i}"/>'
                            for i, s in enumerate(sheets, start=1))
    quote = "'"
    names = "".join(
        f'<definedName name="_xlnm._FilterDatabase" localSheetId="{i}" hidden="1">'
        f"{_xml_text(quote + s.name.replace(quote, quote * 2) + quote)}!{s.filter_ref(absolute=True)}</definedName>"
        for i, s in enumerate(sheets) if s.auto_filter)
    workbook = (_XML_DECL + f'<workbook xmlns="{_MAIN_NS}" xmlns:r="{_REL_NS}"><bookViews><workbookView/></bookViews>'
                f"<sheets>{sheet_entries}</sheets>" + (f"<definedNames>{names}</definedNames>" if names else "")
                + "</workbook>")
    rels = "".join(f'<Relationship Id="rId{i}" Type="{_REL_NS}/worksheet" Target="worksheets/sheet{i}.xml"/>'
                   for i in range(1, n + 1))
    rels += f'<Relationship Id="rId{n + 1}" Type="{_REL_NS}/styles" Target="styles.xml"/>'
    sheet_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
    content_types = (
        _XML_DECL + f'<Types xmlns="{_PKG_NS}/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/styles.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        '<Override PartName="/docProps/core.xml" '
        'ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        + "".join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="{sheet_type}"/>'
                  for i in range(1, n + 1))
        + "</Types>")
    root_rels = (_XML_DECL + f'<Relationships xmlns="{_PKG_NS}/relationships">'
                 f'<Relationship Id="rId1" Type="{_REL_NS}/officeDocument" Target="xl/workbook.xml"/>'
                 f'<Relationship Id="rId2" Type="{_PKG_NS}/relationships/metadata/core-properties" '
                 'Target="docProps/core.xml"/></Relationships>')
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    core = (_XML_DECL +
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            f"<dc:title>{_xml_text(title)}</dc:title><dc:creator>{PLATFORM}</dc:creator>"
            f'<dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created></cp:coreProperties>')
    buffer = io.BytesIO()
    # compresslevel 1: ~4x faster than the default on the 13 000-row sheet for a ~15 % larger file
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", root_rels)
        z.writestr("docProps/core.xml", core)
        z.writestr("xl/workbook.xml", workbook)
        z.writestr("xl/_rels/workbook.xml.rels",
                   _XML_DECL + f'<Relationships xmlns="{_PKG_NS}/relationships">{rels}</Relationships>')
        z.writestr("xl/styles.xml", _STYLES_XML)
        for i, sheet in enumerate(sheets, start=1):
            z.writestr(f"xl/worksheets/sheet{i}.xml", sheet.xml())
    return buffer.getvalue()


def render_xlsx(doc: ReportDoc) -> bytes:
    """Render ``doc`` as an XLSX workbook (bytes): a Summary sheet plus one sheet per table.

    The package is written directly (shared styles, inline strings, streamed rows) rather than through
    openpyxl's object model, which needs ~10 s for the 13 000-line search export on the reference machine; the
    tests read every generated workbook back with openpyxl. Number formats: US$ ``#,##0``, shares ``0.00%``,
    tariffs / RCA ``0.00``; codes are text cells (leading zeros intact); header rows are frozen and filtered.
    """
    used = {"summary"}
    sheet_names = [_sheet_title(table.title, used) for table in doc.tables]
    summary = _Sheet("Summary", [34, 60, 48])
    summary.append([(f"{PLATFORM} - {doc.title}", _S_TITLE)])
    if doc.subtitle:
        summary.append([(doc.subtitle, _S_ITALIC)])
    summary.append([(f"Generated {_generated_label(doc.generated_at)}", _S_GREY)])
    summary.append([])
    for key, value in doc.facts:
        summary.append([(key, _S_BOLD), (value, 0)])
    if doc.kpis:
        summary.append([])
        summary.append([(label, _S_HEAD) for label in ("Metric", "Value", "Note")])
        for kpi in doc.kpis:
            summary.append([(kpi.label, 0), (_raw(kpi.value, kpi.kind), _KIND_STYLE.get(kpi.kind, 0)),
                            (kpi.note, 0)])
    summary.append([])
    summary.append([("Sources and provenance", _S_BOLD)])
    for text in doc.provenance:
        summary.append([(text, 0)])
    summary.append([])
    summary.append([("Sheets", _S_BOLD), ("Rows", _S_BOLD), ("Table key (CSV ?table=)", _S_BOLD)])
    for table, name in zip(doc.tables, sheet_names):
        summary.append([(name, 0), (f"{len(table.rows):,} rows", 0), (table.key, 0)])

    sheets = [summary]
    for table, sheet_name in zip(doc.tables, sheet_names):
        widths = []
        for column in table.columns:
            longest = max([len(str(column.label))] + [len(str(r.get(column.key) or "")) for r in table.rows[:300]])
            widths.append(max(10, min(70 if column.kind == "text" else 22, longest + 2)))
        sheet = _Sheet(sheet_name, widths, freeze_header=True)
        sheet.append([(f"{c.label} (US$)" if c.kind == "usd" and "US$" not in c.label else c.label, _S_HEAD)
                      for c in table.columns])
        spec = [(c.key, c.kind, _KIND_STYLE.get(c.kind, 0)) for c in table.columns]
        text_kinds = {"text", "code"}
        append = sheet.append
        for record in table.rows:
            get = record.get
            # text / code cells skip _raw (a str stays a str); numeric kinds still go through it
            append([((get(key) if kind in text_kinds and isinstance(get(key), (str, type(None)))
                      else _raw(get(key), kind)), style) for key, kind, style in spec])
        if table.rows:
            sheet.auto_filter = (len(table.columns), len(table.rows) + 1)
        if table.note:
            sheet.append([])
            sheet.append([(table.note, _S_ITALIC)])
        sheets.append(sheet)
    return _write_xlsx(sheets, f"{PLATFORM} - {doc.title}")


# --------------------------------------------------------------------------- CSV

def _csv_value(value: Any, kind: str) -> Any:
    raw = _raw(value, kind)
    return "" if raw is None else raw


def render_csv(doc: ReportDoc, table_key: str | None = None) -> bytes:
    """Render ``doc`` as CSV: every table as a section, or only ``table_key`` as a plain table.

    Raises ``KeyError`` for an unknown ``table_key``.
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    if table_key:
        table = doc.table(table_key)
        if table is None:
            raise KeyError(table_key)
        writer.writerow([c.label for c in table.columns])
        for r in table.rows:
            writer.writerow([_csv_value(r.get(c.key), c.kind) for c in table.columns])
        return buffer.getvalue().encode("utf-8-sig")
    writer.writerow([f"# {PLATFORM} - {doc.title}"])
    if doc.subtitle:
        writer.writerow([f"# {doc.subtitle}"])
    writer.writerow([f"# Generated {doc.generated_at}; trade values in US$, shares as fractions"])
    for line in doc.provenance:
        writer.writerow([f"# Source: {line}"])
    if doc.facts:
        writer.writerow([])
        writer.writerow(["[Facts]"])
        writer.writerow(["field", "value"])
        for key, value in doc.facts:
            writer.writerow([key, value])
    if doc.kpis:
        writer.writerow([])
        writer.writerow(["[Key figures]"])
        writer.writerow(["metric", "value", "note"])
        for kpi in doc.kpis:
            writer.writerow([kpi.label, _csv_value(kpi.value, kpi.kind), kpi.note or ""])
    for table in doc.tables:
        writer.writerow([])
        writer.writerow([f"[{table.title}]"])
        writer.writerow([c.label for c in table.columns])
        for r in table.rows:
            writer.writerow([_csv_value(r.get(c.key), c.kind) for c in table.columns])
    return buffer.getvalue().encode("utf-8-sig")


MEDIA_TYPES = {
    "pdf": "application/pdf",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "csv": "text/csv; charset=utf-8",
}


def render(doc: ReportDoc, fmt: str, table_key: str | None = None) -> tuple[bytes, str, str]:
    """``(content, media_type, filename)`` of ``doc`` in ``fmt`` (pdf | xlsx | csv)."""
    if fmt == "pdf":
        content = render_pdf(doc)
    elif fmt == "xlsx":
        content = render_xlsx(doc)
    elif fmt == "csv":
        content = render_csv(doc, table_key)
    else:
        raise ValueError(f"unsupported format '{fmt}'")
    suffix = f"_{table_key}" if table_key and fmt == "csv" else ""
    return content, MEDIA_TYPES[fmt], f"{doc.filename_stem}{suffix}.{fmt}"


__all__ = ["Column", "Table", "Kpi", "ReportDoc", "fmt_usd", "fmt_qty", "format_value", "KIND_LABELS", "render_pdf", "render_xlsx",
           "render_csv", "render", "MEDIA_TYPES"]
