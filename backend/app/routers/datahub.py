"""Data Hub - sources, refresh connectors, official uploads and data quality (docs/SPEC.md section 6.11;
integrated APIs from CBIC, GSTN, DGFT and trade databases, automated refresh cycles and data ownership).

Sources and refresh jobs
------------------------
* ``GET  /api/datahub/sources`` (public) - the ``data_sources`` registry ``[{id, name, owner, kind, status,
  last_refreshed, records, url, licence, description, refresh_cron, connector: {name, refreshable, configured,
  message, required_env}, last_job}]``. ``status`` is ``connected`` | ``not_refreshed`` (a live connector that
  needs no credentials but has never run successfully, e.g. UN Comtrade before its first refresh) |
  ``not_configured`` | ``error``; a stored ``connected`` without ``last_refreshed`` is reported as
  ``not_refreshed`` so the badge never contradicts the card.
* ``POST /api/datahub/sources/{id}/refresh`` (admin) -> ``{job}``. Runs the source's connector
  (:mod:`app.services.connectors`) in a background thread on its own connection; poll ``GET /jobs/{id}``.
  ``cbic`` / ``gstn`` / ``dgft`` finish at once with status ``not_configured`` and a message naming the env
  vars they need. 400 for file / manual sources (refreshed by re-running the ETL), 409 while a job runs.
* ``GET  /api/datahub/jobs?source_id=&limit=`` (GOV) - recent jobs; ``GET /api/datahub/jobs/{id}`` - one job.

Official uploads (data ownership per ministry)
----------------------------------------------
* ``POST /api/datahub/upload`` multipart ``kind`` + ``file`` (.csv / .xlsx, <= 10 MB, <= 50 000 rows) (ministry,
  admin) -> ``{upload, columns, preview: [{row, valid, errors, values}] (first 10 data rows),
  errors: [{row, error}]}``. The file is stored under the upload directory (``ATLAS_UPLOAD_DIR``, default
  ``uploads/`` next to the database, i.e. ``backend/data/uploads/``). ``row`` is the spreadsheet row number
  (header = row 1). Blank rows and rows whose first cell starts with ``#`` (template comments) are skipped.
  Status ``validated`` when at least one row is valid, else ``rejected``.
* ``POST /api/datahub/uploads/{id}/apply`` (admin) - re-reads the stored file, re-validates it against the
  current database (as the uploader) and applies the valid rows in one transaction. Applied uploads are part
  of the analytics cache fingerprint (``app.services.scoring.data_fingerprint``) and the cache is cleared on
  apply, so the network, value-chain, simulator and demand-supply pages reflect the rows at once:

  ``ministry_mapping``  columns ``hsn8``, ``ministry_id`` *or* ``ministry`` (id, short name or full name),
                        optional ``role`` (``primary`` default | ``secondary``), ``note``. Primary rows set the
                        owner with ``mapping_source = 'official_upload'`` (a verified mapping), confidence 1.0,
                        ``mapping_rule = 'upload:<id>'``, a ``mapping_changes`` row (source
                        ``official_upload``) and the FTS row; pending residual claims on those lines are closed
                        (approved when the official owner is the claiming ministry, rejected otherwise).
                        Ministry users may only upload rows for their own ministry.
  ``production``        columns ``scope`` (hsn8 | hs6 | hs4 | chain), ``key``, ``year``, ``value``, ``unit``,
                        ``source`` (citation, stored in ``production.source``), optional ``label`` (for chain
                        scope ``india_production`` (default) | ``global_production``), ``status`` (``verified``
                        default | ``not_verified``). A row replaces an earlier row with the same scope, key,
                        year and label.
  ``value_chain_edges`` columns ``src``, ``dst`` (4/6/8-digit codes), ``relation`` (input_to | component_of |
                        parts_of), optional ``chain_id``, ``weight``; stored with ``vc_edges.source =
                        'official_upload'``.
* ``GET  /api/datahub/uploads`` (GOV), ``GET /api/datahub/uploads/{id}`` (GOV, with errors + preview).
* ``GET  /api/datahub/templates`` (column documentation) and ``GET /api/datahub/templates/{kind}`` (CSV).

Spreadsheet cells holding codes as numbers lose leading zeros (``1012100``); an odd-length numeric code is
left-padded with one zero (7 -> 8, 5 -> 6, 3 -> 4 digits) before validation.

Quality
-------
* ``GET /api/datahub/quality`` (GOV) - ``{coverage, by_ministry, cross_checks, cross_check_summary,
  quality_histogram}``; the per-line data-quality score is ``app.common.quality_score`` (SPEC section 4), over
  current lines. ``cross_checks`` are the UN Comtrade vs BACI comparisons written by the ``comtrade`` connector;
  while none exist ``cross_check_summary.action`` names the connector to run (``{source_id, status,
  refreshable, configured, message}``).
"""
from __future__ import annotations

import csv
import io
import json
import logging
import os
import re
import sqlite3
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response

from app.common import VERIFIED_MAPPING_SOURCES, normalize_code, parse_json, quality_score
from app.db import db_path_for, get_db, row, rows
from app.routers.residual import refresh_fts_rows, set_product_owner
from app.security import require_admin, require_gov, require_roles
from app.services import connectors, scoring
from app.services.audit import log_action, utc_now

router = APIRouter(prefix="/api/datahub", tags=["datahub"])

UploadKind = Literal["ministry_mapping", "production", "value_chain_edges"]
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_UPLOAD_ROWS = 50_000
PREVIEW_ROWS = 10
MAX_STORED_ERRORS = 1000
ALLOWED_EXTENSIONS = (".csv", ".xlsx")
RELATIONS = ("input_to", "component_of", "parts_of")
PRODUCTION_SCOPES = ("hsn8", "hs6", "hs4", "chain")
CHAIN_LABELS = ("india_production", "global_production")

#: Column documentation per upload kind (also served by ``GET /templates``).
UPLOAD_SPECS: dict[str, dict] = {
    "ministry_mapping": {
        "title": "Official ministry mapping (HSN line -> ministry)",
        "columns": [
            {"name": "hsn8", "required": True, "description": "8-digit ITC-HS / GST HSN line"},
            {"name": "ministry_id", "required": False,
             "description": "Ministry id from /api/meta/ministries (or give 'ministry' instead)"},
            {"name": "ministry", "required": False, "description": "Ministry short name or full name"},
            {"name": "role", "required": False, "description": "primary (default) or secondary"},
            {"name": "note", "required": False, "description": "Free-text note kept in the mapping history"},
        ],
    },
    "production": {
        "title": "Domestic production figures",
        "columns": [
            {"name": "scope", "required": True, "description": "hsn8 | hs6 | hs4 | chain"},
            {"name": "key", "required": True, "description": "The code (or value-chain id for scope chain)"},
            {"name": "year", "required": True, "description": "Reference year, e.g. 2024"},
            {"name": "value", "required": True, "description": "Production quantity / value (number >= 0)"},
            {"name": "unit", "required": True, "description": "tonnes | units | usd | ..."},
            {"name": "source", "required": True, "description": "Citation, e.g. the ministry's annual report"},
            {"name": "label", "required": False,
             "description": "For scope chain: india_production (default) or global_production"},
            {"name": "status", "required": False, "description": "verified (default) or not_verified"},
        ],
    },
    "value_chain_edges": {
        "title": "Value-chain interlinkages (input -> output)",
        "columns": [
            {"name": "src", "required": True, "description": "Input HS code (4, 6 or 8 digits)"},
            {"name": "dst", "required": True, "description": "Output HS code (4, 6 or 8 digits)"},
            {"name": "relation", "required": True, "description": "input_to | component_of | parts_of"},
            {"name": "chain_id", "required": False, "description": "Value-chain id from /api/valuechains"},
            {"name": "weight", "required": False, "description": "Optional weight (> 0, default 1)"},
        ],
    },
}

_HEADER_ALIASES = {
    "hsn": "hsn8", "hsn_code": "hsn8", "hs_code": "hsn8", "hsn8_code": "hsn8", "code": "hsn8", "tariff_line": "hsn8",
    "ministry_name": "ministry", "ministry_short_name": "ministry", "department": "ministry",
    "source_code": "src", "from": "src", "input": "src", "target": "dst", "to": "dst", "output": "dst",
    "chain": "chain_id", "value_chain": "chain_id",
}


# --------------------------------------------------------------------------- parsing

class UploadError(ValueError):
    """The file cannot be read at all (bad format / encoding / size)."""


@dataclass
class ParsedRow:
    row: int
    values: dict[str, Any]
    errors: list[str] = field(default_factory=list)

    @property
    def valid(self) -> bool:
        return not self.errors


@dataclass
class Validation:
    columns: list[str]
    rows: list[ParsedRow]
    file_errors: list[dict] = field(default_factory=list)   # header-level problems ({row: 1, error})

    @property
    def valid_rows(self) -> list[ParsedRow]:
        return [] if self.file_errors else [r for r in self.rows if r.valid]

    def error_list(self) -> list[dict]:
        out = list(self.file_errors)
        for r in self.rows:
            out.extend({"row": r.row, "error": e} for e in r.errors)
        return out


def _norm_header(name: Any) -> str:
    text = re.sub(r"[^a-z0-9]+", "_", str(name or "").strip().lower()).strip("_")
    return _HEADER_ALIASES.get(text, text)


def _cell_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _read_table(filename: str, content: bytes) -> list[tuple[int, list[str]]]:
    """``[(row_number, cells)]`` of a CSV / XLSX file (header included, comment / blank rows dropped)."""
    ext = Path(filename).suffix.lower()
    out: list[tuple[int, list[str]]] = []
    if ext == ".csv":
        text = None
        for encoding in ("utf-8-sig", "cp1252"):
            try:
                text = content.decode(encoding)
                break
            except UnicodeDecodeError:
                continue
        if text is None:
            raise UploadError("cannot decode the CSV file (use UTF-8)")
        sample = text[:4096]
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t") if sample.strip() else csv.excel
        except csv.Error:
            dialect = csv.excel
        for number, cells in enumerate(csv.reader(io.StringIO(text), dialect), start=1):
            out.append((number, [c.strip() for c in cells]))
    elif ext == ".xlsx":
        try:
            from openpyxl import load_workbook
            workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        except Exception as exc:  # noqa: BLE001 - any parser failure means "not a readable workbook"
            raise UploadError(f"cannot read the Excel workbook: {exc.__class__.__name__}") from exc
        try:
            sheet = workbook.worksheets[0]
            for number, values in enumerate(sheet.iter_rows(values_only=True), start=1):
                out.append((number, [_cell_text(v) for v in values]))
                if len(out) > MAX_UPLOAD_ROWS + 1:
                    break
        finally:
            workbook.close()
    else:
        raise UploadError(f"unsupported file type '{ext or filename}' - upload a .csv or .xlsx file")
    return [(n, cells) for n, cells in out
            if any(c for c in cells) and not (cells and cells[0].startswith("#"))]


def _code(value: str, lengths: tuple[int, ...]) -> str:
    """Digits of a code cell, re-padding a leading zero lost by a numeric spreadsheet cell."""
    code = normalize_code(value)
    if code.isdigit() and len(code) % 2 == 1 and len(code) + 1 in lengths:
        code = code.zfill(len(code) + 1)
    return code


def _number(value: str) -> float | None:
    text = (value or "").replace(",", "").strip()
    if not text:
        return None
    try:
        number = float(text)
    except ValueError:
        return None
    return number if number == number else None  # NaN -> None


class _Lookups:
    """Reference data used by the validators (loaded once per validation)."""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn
        self.ministries: dict[str, dict] = {}
        for m in rows(conn, "SELECT id, short_name, name FROM ministries WHERE id <> 'residual'"):
            for key in (m["id"], m["short_name"], m["name"]):
                if key:
                    self.ministries.setdefault(key.strip().lower(), m)
        self.chains = {r["id"] for r in rows(conn, "SELECT id FROM value_chains")}

    def ministry(self, text: str) -> dict | None:
        return self.ministries.get((text or "").strip().lower())

    def product(self, hsn8: str) -> dict | None:
        return row(self.conn, "SELECT hsn8, ministry_id, mapping_status FROM products WHERE hsn8 = ?", (hsn8,))

    def node_exists(self, code: str) -> bool:
        if len(code) == 8:
            return self.product(code) is not None
        return row(self.conn, "SELECT 1 AS x FROM hs_nodes WHERE code = ? UNION SELECT 1 FROM hs6_products "
                              "WHERE hs6 = ? LIMIT 1", (code, code)) is not None


def _validate_mapping(r: ParsedRow, cells: dict[str, str], lk: _Lookups, uploader: dict,
                      seen: dict[tuple, int]) -> None:
    hsn8 = _code(cells.get("hsn8", ""), (8,))
    r.values["hsn8"] = hsn8
    if not (hsn8.isdigit() and len(hsn8) == 8):
        r.errors.append(f"hsn8 '{cells.get('hsn8', '')}' is not an 8-digit code")
    elif not lk.product(hsn8):
        r.errors.append(f"hsn8 {hsn8} is not a line in the Atlas")
    ministry_text = cells.get("ministry_id") or cells.get("ministry") or ""
    ministry = lk.ministry(ministry_text)
    if not ministry_text:
        r.errors.append("ministry_id (or ministry) is required")
    elif not ministry:
        r.errors.append(f"unknown ministry '{ministry_text}'")
    else:
        r.values["ministry_id"] = ministry["id"]
        r.values["ministry_name"] = ministry["name"]
        if uploader.get("role") == "ministry" and ministry["id"] != uploader.get("ministry_id"):
            r.errors.append("ministry users can only upload mappings for their own ministry")
    role = (cells.get("role") or "primary").strip().lower()
    r.values["role"] = role
    if role not in ("primary", "secondary"):
        r.errors.append(f"role must be primary or secondary, not '{role}'")
    r.values["note"] = (cells.get("note") or "").strip()[:500] or None
    if r.valid:
        key = (hsn8, "primary") if role == "primary" else (hsn8, role, r.values["ministry_id"])
        if key in seen:
            r.errors.append(f"duplicate of row {seen[key]} ({hsn8} {role})")
        else:
            seen[key] = r.row


def _validate_production(r: ParsedRow, cells: dict[str, str], lk: _Lookups, uploader: dict,
                         seen: dict[tuple, int]) -> None:
    scope = (cells.get("scope") or "").strip().lower()
    r.values["scope"] = scope
    raw_key = (cells.get("key") or "").strip()
    if scope not in PRODUCTION_SCOPES:
        r.errors.append(f"scope must be one of {', '.join(PRODUCTION_SCOPES)}")
    elif scope == "chain":
        r.values["key"] = raw_key.lower()
        if raw_key.lower() not in lk.chains:
            r.errors.append(f"unknown value chain '{raw_key}'")
    else:
        length = {"hsn8": 8, "hs6": 6, "hs4": 4}[scope]
        key = _code(raw_key, (length,))
        r.values["key"] = key
        if not (key.isdigit() and len(key) == length):
            r.errors.append(f"key '{raw_key}' is not a {length}-digit code")
        elif not lk.node_exists(key):
            r.errors.append(f"code {key} does not exist")
    year = _number(cells.get("year", ""))
    if year is None or not year.is_integer() or not 1990 <= year <= 2035:
        r.errors.append(f"year '{cells.get('year', '')}' must be a year between 1990 and 2035")
    else:
        r.values["year"] = int(year)
    value = _number(cells.get("value", ""))
    if value is None or value < 0:
        r.errors.append(f"value '{cells.get('value', '')}' must be a number >= 0")
    else:
        r.values["value"] = value
    unit = (cells.get("unit") or "").strip()
    source = (cells.get("source") or "").strip()
    if not unit or len(unit) > 40:
        r.errors.append("unit is required (max 40 characters)")
    if not source or len(source) > 300:
        r.errors.append("source is required (max 300 characters)")
    r.values["unit"], r.values["source"] = unit, source
    label = (cells.get("label") or "").strip() or None
    if scope == "chain":
        label = (label or "india_production").lower()
        if label not in CHAIN_LABELS:
            r.errors.append(f"label for scope chain must be one of {', '.join(CHAIN_LABELS)}")
    r.values["label"] = label
    status = (cells.get("status") or "verified").strip().lower()
    r.values["status"] = status
    if status not in ("verified", "not_verified"):
        r.errors.append("status must be verified or not_verified")
    if r.valid:
        key = (scope, r.values["key"], r.values["year"], label or "")
        if key in seen:
            r.errors.append(f"duplicate of row {seen[key]}")
        else:
            seen[key] = r.row


def _validate_edge(r: ParsedRow, cells: dict[str, str], lk: _Lookups, uploader: dict,
                   seen: dict[tuple, int]) -> None:
    for column in ("src", "dst"):
        raw = cells.get(column, "")
        code = _code(raw, (4, 6, 8))
        r.values[column] = code
        if not (code.isdigit() and len(code) in (4, 6, 8)):
            r.errors.append(f"{column} '{raw}' must be a 4, 6 or 8-digit HS code")
        elif not lk.node_exists(code):
            r.errors.append(f"{column} {code} does not exist")
    if r.values.get("src") and r.values.get("src") == r.values.get("dst"):
        r.errors.append("src and dst must differ")
    relation = (cells.get("relation") or "").strip().lower()
    r.values["relation"] = relation
    if relation not in RELATIONS:
        r.errors.append(f"relation must be one of {', '.join(RELATIONS)}")
    chain_id = (cells.get("chain_id") or "").strip().lower() or None
    r.values["chain_id"] = chain_id
    if chain_id and chain_id not in lk.chains:
        r.errors.append(f"unknown value chain '{chain_id}'")
    weight_text = cells.get("weight") or ""
    weight = _number(weight_text) if weight_text else 1.0
    if weight is None or weight <= 0:
        r.errors.append(f"weight '{weight_text}' must be a number > 0")
    r.values["weight"] = weight
    if r.valid:
        key = (r.values["src"], r.values["dst"], relation)
        if key in seen:
            r.errors.append(f"duplicate of row {seen[key]}")
        else:
            seen[key] = r.row


_VALIDATORS = {"ministry_mapping": _validate_mapping, "production": _validate_production,
               "value_chain_edges": _validate_edge}


def validate_upload(conn: sqlite3.Connection, kind: str, filename: str, content: bytes, uploader: dict) -> Validation:
    """Parse and validate an upload (raises :class:`UploadError` when the file is unreadable)."""
    table = _read_table(filename, content)
    if not table:
        raise UploadError("the file is empty")
    header_row, header_cells = table[0]
    columns = [_norm_header(c) for c in header_cells]
    spec = UPLOAD_SPECS[kind]
    file_errors: list[dict] = []
    required = [c["name"] for c in spec["columns"] if c["required"]]
    missing = [c for c in required if c not in columns]
    if kind == "ministry_mapping" and "ministry_id" not in columns and "ministry" not in columns:
        missing.append("ministry_id (or ministry)")
    if missing:
        file_errors.append({"row": header_row, "error": f"missing column(s): {', '.join(missing)}; "
                                                        f"found: {', '.join(c for c in columns if c) or 'none'}"})
    data = table[1:]
    if len(data) > MAX_UPLOAD_ROWS:
        raise UploadError(f"too many rows ({len(data)}); the limit is {MAX_UPLOAD_ROWS}")
    lookups = _Lookups(conn)
    validator = _VALIDATORS[kind]
    seen: dict[tuple, int] = {}
    parsed: list[ParsedRow] = []
    for number, cells in data:
        record = {col: (cells[i] if i < len(cells) else "") for i, col in enumerate(columns) if col}
        item = ParsedRow(row=number, values={})
        if not file_errors:
            validator(item, record, lookups, uploader, seen)
        else:
            item.values = record
        parsed.append(item)
    return Validation(columns=[c for c in columns if c], rows=parsed, file_errors=file_errors)


# --------------------------------------------------------------------------- storage / shapes

def json_dumps(value: Any) -> str:
    """Compact JSON for ``uploads.errors_json``."""
    return json.dumps(value, ensure_ascii=False, default=str)


def upload_dir(request: Request) -> Path:
    """Folder for stored uploads: ``ATLAS_UPLOAD_DIR`` or ``uploads/`` next to the database file."""
    configured = os.environ.get("ATLAS_UPLOAD_DIR")
    path = Path(configured).expanduser() if configured else db_path_for(request).parent / "uploads"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _safe_name(filename: str) -> str:
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(filename).name).strip("._") or "upload"
    return stem[-80:]


def _upload_out(u: dict) -> dict:
    errors = parse_json(u.get("errors_json"), []) or []
    return {"id": u["id"], "kind": u["kind"], "filename": u["filename"], "uploaded_by": u["uploaded_by"],
            "uploaded_by_name": u.get("uploaded_by_name"), "ts": u["ts"], "status": u["status"],
            "rows_total": u["rows_total"], "rows_valid": u["rows_valid"], "n_errors": len(errors),
            "applied_at": u["applied_at"]}


def _get_upload(conn: sqlite3.Connection, upload_id: int) -> dict:
    u = row(conn, "SELECT up.*, us.name AS uploaded_by_name FROM uploads up LEFT JOIN users us "
                  "ON us.id = up.uploaded_by WHERE up.id = ?", (upload_id,))
    if not u:
        raise HTTPException(status_code=404, detail=f"Unknown upload {upload_id}")
    return u


def _preview(validation: Validation) -> list[dict]:
    return [{"row": r.row, "valid": r.valid and not validation.file_errors, "errors": r.errors, "values": r.values}
            for r in validation.rows[:PREVIEW_ROWS]]


def _stored_content(request: Request, u: dict) -> bytes:
    name = u.get("stored_path")
    path = upload_dir(request) / name if name else None
    if not path or not path.is_file():
        raise HTTPException(status_code=409, detail=f"The stored file of upload {u['id']} is missing")
    return path.read_bytes()


# --------------------------------------------------------------------------- apply

def _apply_mapping(conn: sqlite3.Connection, upload_id: int, valid: list[ParsedRow], user: dict) -> dict:
    changed, unchanged, secondary = 0, 0, 0
    touched: list[str] = []
    closed_claims = {"approved": 0, "rejected": 0}
    now = utc_now()
    for r in valid:
        v = r.values
        if v["role"] == "primary":
            change = set_product_owner(conn, v["hsn8"], v["ministry_id"], mapping_source="official_upload",
                                       change_source="official_upload", user_id=user["id"],
                                       rule=f"upload:{upload_id}",
                                       note=v["note"] or f"Official mapping upload #{upload_id}")
            if change and change["changed"]:
                changed += 1
            else:
                unchanged += 1
            touched.append(v["hsn8"])
            for claim in rows(conn, "SELECT id, ministry_id FROM residual_claims WHERE hsn8 = ? AND status = 'pending'",
                              (v["hsn8"],)):
                approved = claim["ministry_id"] == v["ministry_id"]
                conn.execute("UPDATE residual_claims SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? "
                             "WHERE id = ?",
                             ("approved" if approved else "rejected", user["id"], now,
                              f"{'Confirmed' if approved else 'Superseded'} by official mapping upload #{upload_id}",
                              claim["id"]))
                closed_claims["approved" if approved else "rejected"] += 1
        else:
            primary = row(conn, "SELECT ministry_id FROM products WHERE hsn8 = ?", (v["hsn8"],))
            if primary and primary["ministry_id"] != v["ministry_id"]:
                cur = conn.execute("INSERT OR IGNORE INTO product_ministries (hsn8, ministry_id, role) "
                                   "VALUES (?, ?, 'secondary')", (v["hsn8"], v["ministry_id"]))
                secondary += cur.rowcount
    refresh_fts_rows(conn, touched)
    return {"rows": len(valid), "owners_changed": changed, "owners_confirmed": unchanged,
            "secondary_added": secondary, "claims_closed": closed_claims}


def _apply_production(conn: sqlite3.Connection, valid: list[ParsedRow]) -> dict:
    replaced = 0
    for r in valid:
        v = r.values
        cur = conn.execute("DELETE FROM production WHERE scope = ? AND key = ? AND year = ? "
                           "AND COALESCE(label, '') = ?", (v["scope"], v["key"], v["year"], v["label"] or ""))
        replaced += cur.rowcount
        conn.execute("INSERT INTO production (scope, key, label, year, value, unit, source, status) "
                     "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                     (v["scope"], v["key"], v["label"], v["year"], v["value"], v["unit"], v["source"], v["status"]))
    return {"rows": len(valid), "replaced": replaced}


def _apply_edges(conn: sqlite3.Connection, valid: list[ParsedRow]) -> dict:
    for r in valid:
        v = r.values
        conn.execute("INSERT OR REPLACE INTO vc_edges (src, dst, relation, chain_id, weight, source) "
                     "VALUES (?, ?, ?, ?, ?, 'official_upload')",
                     (v["src"], v["dst"], v["relation"], v["chain_id"], v["weight"]))
    return {"rows": len(valid)}


# --------------------------------------------------------------------------- endpoints: sources / jobs

@router.get("/sources", summary="Data source registry with connector status")
def list_sources(conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
    sources = rows(conn, "SELECT id, name, owner, kind, status, last_refreshed, records, url, licence, description, "
                         "refresh_cron FROM data_sources ORDER BY kind = 'manual', kind = 'file', id")
    last_jobs = {r["source_id"]: r for r in rows(conn, """
        SELECT j.* FROM refresh_jobs j
        JOIN (SELECT source_id, MAX(id) AS id FROM refresh_jobs GROUP BY source_id) x ON x.id = j.id""")}
    for s in sources:
        s["connector"] = connectors.connector_info(s["id"])
        s["last_job"] = connectors.job_dict(last_jobs.get(s["id"]))
        s["status"] = connectors.effective_status(s)
    return sources


@router.post("/sources/{source_id}/refresh", summary="Run a source's refresh connector (admin)")
def refresh_source(source_id: str, request: Request, conn: sqlite3.Connection = Depends(get_db),
                   user: dict = Depends(require_admin)) -> dict:
    known = row(conn, "SELECT id FROM data_sources WHERE id = ?", (source_id,))
    connector = connectors.connector_for(source_id)
    if connector is None:
        if not known:
            raise HTTPException(status_code=404, detail=f"Unknown data source '{source_id}'")
        raise HTTPException(status_code=400, detail=f"'{source_id}' has no live connector: "
                                                    f"{connectors.connector_info(source_id)['message']}")
    try:
        job = connectors.start_refresh(conn, db_path_for(request), source_id, user)
    except connectors.RefreshInProgress as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    log_action(conn, user, "source.refresh", "data_source", connector.source_id,
               {"job_id": job["id"], "connector": connector.name, "status": job["status"]})
    return {"job": job}


@router.get("/jobs", summary="Recent refresh jobs")
def list_jobs(source_id: str | None = None, limit: int = Query(50, ge=1, le=500),
              conn: sqlite3.Connection = Depends(get_db), _user: dict = Depends(require_gov)) -> list[dict]:
    where, params = "1=1", []
    if source_id:
        connector = connectors.connector_for(source_id)
        where, params = "j.source_id = ?", [connector.source_id if connector else source_id]
    data = rows(conn, f"""SELECT j.*, ds.name AS source_name, u.name AS triggered_by_name
                          FROM refresh_jobs j LEFT JOIN data_sources ds ON ds.id = j.source_id
                          LEFT JOIN users u ON u.id = j.triggered_by
                          WHERE {where} ORDER BY j.id DESC LIMIT ?""", [*params, limit])
    return [connectors.job_dict(j) for j in data]


@router.get("/jobs/{job_id}", summary="One refresh job (poll while running)")
def get_job(job_id: int, conn: sqlite3.Connection = Depends(get_db), _user: dict = Depends(require_gov)) -> dict:
    job = connectors.get_job(conn, job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Unknown job {job_id}")
    return job


# --------------------------------------------------------------------------- endpoints: uploads

@router.get("/templates", summary="Upload kinds and their columns")
def templates() -> list[dict]:
    return [{"kind": kind, **spec, "template_url": f"/api/datahub/templates/{kind}"}
            for kind, spec in UPLOAD_SPECS.items()]


@router.get("/templates/{kind}", summary="CSV template for an upload kind")
def template_csv(kind: UploadKind) -> Response:
    spec = UPLOAD_SPECS[kind]
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow([c["name"] for c in spec["columns"]])
    for c in spec["columns"]:
        writer.writerow([f"# {c['name']}{' (required)' if c['required'] else ''}: {c['description']}"])
    writer.writerow(["# Lines starting with # are ignored on upload. Delete them or keep them."])
    return Response(content=buffer.getvalue().encode("utf-8-sig"), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="atlas_template_{kind}.csv"'})


@router.post("/upload", status_code=201, summary="Upload and validate a CSV / XLSX file (ministry, admin)")
def upload(request: Request, kind: UploadKind = Form(...), file: UploadFile = File(...),
           conn: sqlite3.Connection = Depends(get_db),
           user: dict = Depends(require_roles("ministry", "admin"))) -> dict:
    filename = Path(file.filename or "upload").name
    if Path(filename).suffix.lower() not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Upload a .csv or .xlsx file")
    content = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail=f"File too large (limit {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)")
    if not content:
        raise HTTPException(status_code=400, detail="The file is empty")
    try:
        validation = validate_upload(conn, kind, filename, content, user)
    except UploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    stored = f"{utc_now()[:19].replace(':', '').replace('-', '')}_{uuid.uuid4().hex[:8]}_{_safe_name(filename)}"
    (upload_dir(request) / stored).write_bytes(content)
    errors = validation.error_list()
    n_valid = len(validation.valid_rows)
    status = "validated" if n_valid else "rejected"
    cur = conn.execute("INSERT INTO uploads (kind, filename, stored_path, uploaded_by, ts, status, rows_total, "
                       "rows_valid, errors_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                       (kind, filename, stored, user["id"], utc_now(), status, len(validation.rows), n_valid,
                        json_dumps(errors[:MAX_STORED_ERRORS])))
    log_action(conn, user, "upload.create", "upload", cur.lastrowid,
               {"kind": kind, "filename": filename, "rows_total": len(validation.rows), "rows_valid": n_valid,
                "status": status}, commit=False)
    conn.commit()
    return {"upload": _upload_out(_get_upload(conn, cur.lastrowid)), "columns": validation.columns,
            "preview": _preview(validation), "errors": errors[:MAX_STORED_ERRORS]}


@router.get("/uploads", summary="Uploaded files")
def list_uploads(kind: UploadKind | None = None, status: str | None = None,
                 conn: sqlite3.Connection = Depends(get_db), _user: dict = Depends(require_gov)) -> list[dict]:
    where, params = ["1=1"], []
    if kind:
        where.append("up.kind = ?")
        params.append(kind)
    if status:
        where.append("up.status = ?")
        params.append(status)
    data = rows(conn, f"""SELECT up.*, us.name AS uploaded_by_name FROM uploads up
                          LEFT JOIN users us ON us.id = up.uploaded_by
                          WHERE {' AND '.join(where)} ORDER BY up.id DESC""", params)
    return [_upload_out(u) for u in data]


@router.get("/uploads/{upload_id}", summary="One upload with its errors and a preview")
def get_upload(upload_id: int, request: Request, conn: sqlite3.Connection = Depends(get_db),
               _user: dict = Depends(require_gov)) -> dict:
    u = _get_upload(conn, upload_id)
    preview: list[dict] = []
    columns: list[str] = []
    try:
        uploader = row(conn, "SELECT id, role, ministry_id FROM users WHERE id = ?", (u["uploaded_by"],)) or {}
        validation = validate_upload(conn, u["kind"], u["filename"], _stored_content(request, u), uploader)
        preview, columns = _preview(validation), validation.columns
    except (HTTPException, UploadError):
        pass  # file gone or unreadable: the stored errors are still shown
    return {"upload": _upload_out(u), "columns": columns, "preview": preview,
            "errors": parse_json(u.get("errors_json"), []) or []}


@router.post("/uploads/{upload_id}/apply", summary="Apply the valid rows of an upload (admin)")
def apply_upload(upload_id: int, request: Request, conn: sqlite3.Connection = Depends(get_db),
                 user: dict = Depends(require_admin)) -> dict:
    u = _get_upload(conn, upload_id)
    if u["status"] != "validated":
        raise HTTPException(status_code=409, detail=f"Upload {upload_id} is {u['status']}; only a validated upload "
                                                    "can be applied")
    uploader = row(conn, "SELECT id, role, ministry_id FROM users WHERE id = ?", (u["uploaded_by"],)) or user
    try:
        validation = validate_upload(conn, u["kind"], u["filename"], _stored_content(request, u), uploader)
    except UploadError as exc:
        raise HTTPException(status_code=409, detail=f"The stored file cannot be read any more: {exc}") from exc
    valid = validation.valid_rows
    if not valid:
        raise HTTPException(status_code=409, detail="No valid rows left to apply (the data changed since upload)")
    errors = validation.error_list()
    try:
        if u["kind"] == "ministry_mapping":
            stats = _apply_mapping(conn, upload_id, valid, user)
        elif u["kind"] == "production":
            stats = _apply_production(conn, valid)
        else:
            stats = _apply_edges(conn, valid)
        conn.execute("UPDATE uploads SET status = 'applied', applied_at = ?, rows_valid = ?, errors_json = ? "
                     "WHERE id = ?", (utc_now(), len(valid), json_dumps(errors[:MAX_STORED_ERRORS]), upload_id))
        log_action(conn, user, "upload.apply", "upload", upload_id, {"kind": u["kind"], **stats}, commit=False)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    scoring.clear_cache()  # the fingerprint changes too (applied uploads); clearing frees the stale objects now
    _rewarm_exports(request)
    return {"upload": _upload_out(_get_upload(conn, upload_id)), "applied": stats,
            "errors": errors[:MAX_STORED_ERRORS]}


def _rewarm_exports(request: Request) -> None:
    """Re-render the whole-catalogue search export in the background after an apply (its cache key changed), so
    the next download stays within the response budget; skipped when ``ATLAS_WARM_MODELS=0`` (tests)."""
    from app.config import get_settings

    if not get_settings().warm_models:
        return
    try:
        from app.routers import reports

        reports.warm_export_async(db_path_for(request))
    except Exception as exc:  # noqa: BLE001 - a warm-up problem must never fail the apply
        logging.getLogger("atlas.datahub").warning("search export re-warm not started: %s", exc)


# --------------------------------------------------------------------------- endpoints: quality

def _bucket(score: int) -> str:
    lo = min(80, (score // 20) * 20)
    return f"{lo}-{lo + 19 if lo < 80 else 100}"


@router.get("/quality", summary="Data coverage, verification and quality scores")
def quality(conn: sqlite3.Connection = Depends(get_db), _user: dict = Depends(require_gov)) -> dict:
    lines = rows(conn, """
        SELECT p.hsn8, p.ministry_id, p.mapping_status, p.mapping_source,
               (m.metric_hs6 IS NOT NULL AND (m.india_exports IS NOT NULL OR m.india_imports IS NOT NULL
                                              OR m.world_trade IS NOT NULL)) AS has_trade,
               (t.mfn_avg IS NOT NULL) AS has_tariff,
               EXISTS (SELECT 1 FROM production pr WHERE (pr.scope = 'hsn8' AND pr.key = p.hsn8)
                       OR (pr.scope = 'hs6' AND pr.key = p.hs6) OR (pr.scope = 'hs4' AND pr.key = p.hs4))
                 AS has_production
        FROM products p
        LEFT JOIN v_product_trade m ON m.hsn8 = p.hsn8
        LEFT JOIN tariffs t ON t.hs6 = p.hs6
        WHERE p.is_current = 1""")
    histogram: dict[str, int] = {_bucket(s): 0 for s in (0, 20, 40, 60, 80)}
    per_ministry: dict[str, dict] = {}
    totals = {"trade": 0, "tariff": 0, "production": 0, "quality": 0}
    sources = {"dpiit_guidebook": 0, "rule": 0, "official_upload": 0, "manual": 0, "unmapped": 0}
    residual = 0
    guidebook_residual = 0
    unmapped = 0
    for p in lines:
        score = quality_score(p["mapping_status"], p["mapping_source"], bool(p["has_trade"]), bool(p["has_tariff"]),
                              bool(p["has_production"]))
        histogram[_bucket(score)] += 1
        totals["trade"] += bool(p["has_trade"])
        totals["tariff"] += bool(p["has_tariff"])
        totals["production"] += bool(p["has_production"])
        totals["quality"] += score
        if p["mapping_status"] == "residual":
            residual += 1
            if p["mapping_source"] == "dpiit_guidebook":
                guidebook_residual += 1
            elif p["mapping_source"] == "unmapped":
                unmapped += 1
        elif p["mapping_source"] in sources:
            sources[p["mapping_source"]] += 1
        m = per_ministry.setdefault(p["ministry_id"], {"codes": 0, "trade": 0, "verified": 0, "quality": 0})
        m["codes"] += 1
        m["trade"] += bool(p["has_trade"])
        m["verified"] += p["mapping_status"] != "residual" and p["mapping_source"] in VERIFIED_MAPPING_SOURCES
        m["quality"] += score
    n = len(lines)
    refs = {r["id"]: r for r in rows(conn, "SELECT id, short_name, name, color FROM ministries")}
    by_ministry = []
    for ministry_id, m in per_ministry.items():
        ref = refs.get(ministry_id, {})
        by_ministry.append({
            "ministry_id": ministry_id, "short_name": ref.get("short_name", ministry_id), "name": ref.get("name"),
            "color": ref.get("color"), "codes": m["codes"],
            "with_trade_pct": round(m["trade"] / m["codes"], 4) if m["codes"] else None,
            "verified_pct": round(m["verified"] / m["codes"], 4) if m["codes"] else None,
            "avg_quality": round(m["quality"] / m["codes"], 1) if m["codes"] else None})
    by_ministry.sort(key=lambda x: (x["ministry_id"] == "residual", -x["codes"], x["short_name"] or ""))
    checks = rows(conn, """
        SELECT c.hs6, h.description, c.year, c.flow, c.comtrade_value, c.baci_value, c.diff_pct, c.checked_at
        FROM comtrade_checks c LEFT JOIN hs6_products h ON h.hs6 = c.hs6
        ORDER BY ABS(COALESCE(c.diff_pct, 0)) DESC, c.hs6, c.flow LIMIT 500""")
    diffs = sorted(abs(c["diff_pct"]) for c in checks if c["diff_pct"] is not None)
    verified = sources["dpiit_guidebook"] + sources["official_upload"] + sources["manual"]
    action = None
    if not checks:
        comtrade = row(conn, "SELECT id, status, last_refreshed FROM data_sources WHERE id = 'un_comtrade'")
        info = connectors.connector_info("un_comtrade")
        action = {"source_id": "un_comtrade", "status": connectors.effective_status(comtrade) if comtrade else None,
                  "last_refreshed": (comtrade or {}).get("last_refreshed"),
                  "refreshable": info["refreshable"], "configured": info["configured"],
                  "message": ("No cross-checks yet: run the UN Comtrade connector (Sources tab > Refresh now) to "
                              "compare India's reported 2023 trade of the value-chain HS6 codes with BACI."
                              if info["configured"] else f"The UN Comtrade connector cannot run: {info['message']}")}
    return {
        "coverage": {
            "products": n, "with_trade": totals["trade"], "with_tariff": totals["tariff"],
            "with_production": totals["production"],
            "mapping_guidebook": sources["dpiit_guidebook"], "mapping_official": sources["official_upload"],
            "mapping_manual": sources["manual"], "mapping_rule": sources["rule"],
            "mapping_guidebook_residual": guidebook_residual, "mapping_unmapped": unmapped,
            "residual": residual, "mapping_verified": verified,
            "avg_quality": round(totals["quality"] / n, 1) if n else None,
        },
        "by_ministry": by_ministry,
        "cross_checks": checks,
        "cross_check_summary": {
            "n": len(checks), "median_abs_diff": diffs[len(diffs) // 2] if diffs else None,
            "within_10pct": sum(1 for d in diffs if d <= 0.10),
            "last_checked": max((c["checked_at"] for c in checks), default=None),
            "action": action,
        },
        "quality_histogram": [{"bucket": b, "count": c} for b, c in histogram.items()],
        "method": "Data-quality score per line (SPEC section 4): 30 verified mapping (DPIIT Guidebook / upload / "
                  "approved claim), 0 for a residual or Guidebook-unlisted line, + 30 trade + 20 tariff + 20 "
                  "production, capped at 100.",
    }
