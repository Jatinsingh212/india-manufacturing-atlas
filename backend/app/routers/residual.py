"""Residual Workbench (docs/SPEC.md section 6.9): unmapped HSN codes classified as 'Residual Products' still
need clear product ownership.

Endpoints
---------
* ``GET  /api/residual?q=&chapter=&sector_id=&sort=&order=&page=&page_size=`` (GOV) - paginated
  ``ProductSummary`` of the residual lines (``mapping_status = 'residual'``) via ``app.common.search_products``;
  every row adds ``pending_claims`` (int) and ``claimed_by`` (``[ministry_id]`` of the pending claims).
* ``GET  /api/residual/suggest/{hsn8}`` (GOV) - ML owner suggestions ``{hsn8, suggestions: [{ministry, score,
  similar}], ...}`` from :mod:`app.services.suggest` (TF-IDF nearest neighbours, same chapter first). Works for
  any line, so a ministry can also sanity-check an accepted mapping.
* ``POST /api/residual/{hsn8}/claim {ministry_id?, justification}`` - a ministry user claims a residual line for
  its own ministry (``ministry_id`` defaults to it; another id -> 403); an admin may claim for any ministry.
  409 when the line is not residual or the same ministry already has a pending claim on it.
* ``GET  /api/residual/claims?status=&ministry_id=&hsn8=`` (GOV) - ``[{id, hsn8, description, ministry,
  claimed_by_name, justification, status, created_at, reviewed_at, review_note, ...}]``, newest first.
* ``POST /api/residual/claims/{id}/review {decision: "approve"|"reject", note}`` (admin). Approving, in one
  transaction: ``products`` (ministry_id, mapping_status ``accepted``, mapping_source ``manual``, confidence 1.0,
  mapping_rule ``claim:<id>``), ``product_ministries`` (new primary owner; the old primary row is removed),
  ``mapping_changes`` (source ``claim``), the line's ``products_fts`` row, auto-rejection of the other pending
  claims on the same line ("superseded"), and audit rows (``claim.review`` + ``mapping.change``).
  Only a pending claim can be reviewed (409 otherwise).

Shared helpers (also used by ``app.routers.datahub`` when an official mapping upload is applied):
:func:`set_product_owner` and :func:`refresh_fts_rows`.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.common import ministry_ref, ministry_refs, normalize_code, product_summaries, search_products
from app.db import db_path_for, get_db, in_json, json_param, row, rows
from app.security import require_admin, require_gov, require_roles
try:  # scikit-learn is optional: slim deployments (Vercel) serve suggestions precomputed at build time
    from app.services import suggest
except ImportError:  # pragma: no cover - exercised by the deploy build, not the dev environment
    suggest = None  # type: ignore[assignment]
from app.services.audit import log_action, utc_now

router = APIRouter(prefix="/api/residual", tags=["residual"])

ClaimStatus = Literal["pending", "approved", "rejected"]
SortParam = Literal["relevance", "exports", "imports", "rca", "code", "world_trade"]

_CLAIM_SELECT = """
    SELECT c.id, c.hsn8, p.description, p.hs2, p.mapping_status, p.ministry_id AS current_ministry_id,
           c.ministry_id, c.claimed_by, u.name AS claimed_by_name, u.role AS claimed_by_role, c.justification,
           c.status, c.created_at, c.reviewed_by, r.name AS reviewed_by_name, c.reviewed_at, c.review_note
    FROM residual_claims c
    LEFT JOIN products p ON p.hsn8 = c.hsn8
    LEFT JOIN users u ON u.id = c.claimed_by
    LEFT JOIN users r ON r.id = c.reviewed_by"""


class ClaimBody(BaseModel):
    ministry_id: str | None = Field(None, max_length=40,
                                    description="Claiming ministry (defaults to the ministry user's own)")
    justification: str = Field(..., min_length=10, max_length=4000)


class ReviewBody(BaseModel):
    decision: Literal["approve", "reject"]
    note: str | None = Field(None, max_length=2000)


# --------------------------------------------------------------------------- shared mapping helpers

def refresh_fts_rows(conn: sqlite3.Connection, hsn8_list: list[str]) -> int:
    """Rewrite the ``products_fts`` rows (rowid = products.rowid) of the given lines; no commit."""
    codes = [c for c in dict.fromkeys(hsn8_list) if c]
    if not codes:
        return 0
    param = json_param(codes)
    conn.execute(f"DELETE FROM products_fts WHERE rowid IN (SELECT rowid FROM products WHERE {in_json('hsn8')})",
                 (param,))
    cur = conn.execute(f"""
        INSERT INTO products_fts (rowid, hsn8, description, full_description, ministry, sector)
        SELECT p.rowid, p.hsn8, p.description, COALESCE(p.full_description, ''),
               COALESCE(m.short_name || ' ' || m.name, ''), COALESCE(s.name, '')
        FROM products p LEFT JOIN ministries m ON m.id = p.ministry_id LEFT JOIN sectors s ON s.id = p.sector_id
        WHERE {in_json('p.hsn8')}""", (param,))
    return cur.rowcount


def set_product_owner(conn: sqlite3.Connection, hsn8: str, ministry_id: str, *, mapping_source: str,
                      change_source: str, user_id: int | None, note: str | None = None,
                      rule: str | None = None, confidence: float = 1.0) -> dict | None:
    """Make ``ministry_id`` the primary owner of ``hsn8`` (accepted mapping); returns the change or None.

    Updates ``products``, ``product_ministries`` (the previous primary row is dropped; a secondary row of the
    new owner is promoted) and writes a ``mapping_changes`` row. The FTS row is *not* refreshed here - call
    :func:`refresh_fts_rows` once for the batch. Does not commit (the caller owns the transaction).
    Returns ``None`` when the line does not exist; a change with ``changed: False`` when nothing differed.
    """
    product = row(conn, "SELECT hsn8, ministry_id, mapping_status, mapping_source FROM products WHERE hsn8 = ?",
                  (hsn8,))
    if not product:
        return None
    old = product["ministry_id"]
    same = (old == ministry_id and product["mapping_status"] == "accepted"
            and product["mapping_source"] == mapping_source)
    conn.execute("""UPDATE products SET ministry_id = ?, mapping_status = 'accepted', mapping_source = ?,
                           mapping_confidence = ?, mapping_rule = COALESCE(?, mapping_rule) WHERE hsn8 = ?""",
                 (ministry_id, mapping_source, confidence, rule, hsn8))
    conn.execute("DELETE FROM product_ministries WHERE hsn8 = ? AND (role = 'primary' OR ministry_id = ?)",
                 (hsn8, ministry_id))
    conn.execute("INSERT INTO product_ministries (hsn8, ministry_id, role) VALUES (?, ?, 'primary')",
                 (hsn8, ministry_id))
    if same:
        return {"hsn8": hsn8, "old_ministry_id": old, "new_ministry_id": ministry_id, "changed": False}
    cur = conn.execute("INSERT INTO mapping_changes (hsn8, old_ministry_id, new_ministry_id, source, changed_by, "
                       "ts, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
                       (hsn8, old, ministry_id, change_source, user_id, utc_now(), note))
    return {"hsn8": hsn8, "old_ministry_id": old, "new_ministry_id": ministry_id, "changed": True,
            "mapping_change_id": cur.lastrowid}


# --------------------------------------------------------------------------- shapes

def _claim_dict(conn: sqlite3.Connection, r: dict, refs: dict[str, dict] | None = None) -> dict:
    refs = refs if refs is not None else {}
    ministry = refs.get(r["ministry_id"]) or ministry_ref(conn, r["ministry_id"]) or {
        "id": r["ministry_id"], "short_name": r["ministry_id"], "name": r["ministry_id"], "color": None}
    return {
        "id": r["id"], "hsn8": r["hsn8"], "description": r["description"], "hs2": r["hs2"],
        "mapping_status": r["mapping_status"], "current_ministry_id": r["current_ministry_id"],
        "ministry_id": r["ministry_id"], "ministry": ministry,
        "claimed_by": r["claimed_by"], "claimed_by_name": r["claimed_by_name"],
        "claimed_by_role": r["claimed_by_role"], "justification": r["justification"], "status": r["status"],
        "created_at": r["created_at"], "reviewed_by": r["reviewed_by"], "reviewed_by_name": r["reviewed_by_name"],
        "reviewed_at": r["reviewed_at"], "review_note": r["review_note"],
    }


def _claims(conn: sqlite3.Connection, where: str = "1=1", params: tuple = ()) -> list[dict]:
    data = rows(conn, f"{_CLAIM_SELECT} WHERE {where} ORDER BY c.created_at DESC, c.id DESC", params)
    refs = {m["id"]: m for m in ministry_refs(conn, [r["ministry_id"] for r in data])}
    return [_claim_dict(conn, r, refs) for r in data]


def get_claim(conn: sqlite3.Connection, claim_id: int) -> dict | None:
    """One claim in the API shape, or None."""
    found = _claims(conn, "c.id = ?", (claim_id,))
    return found[0] if found else None


def _precomputed_suggestion(conn: sqlite3.Connection, hsn8: str, limit: int) -> dict:
    """Suggestion stored by `scripts.build_deploy_db` (used when scikit-learn is not installed)."""
    code = normalize_code(hsn8)
    try:
        found = row(conn, "SELECT payload_json FROM residual_suggestions WHERE hsn8 = ?", (code,))
    except sqlite3.OperationalError:  # table absent: a full build without the deploy step
        found = None
    if not found:
        if not row(conn, "SELECT 1 AS x FROM products WHERE hsn8 = ?", (code,)):
            raise HTTPException(status_code=404, detail=f"Unknown HSN line '{hsn8}'")
        raise HTTPException(status_code=503, detail="suggestions unavailable on this deployment for this line "
                                                    "(precomputed for residual lines only)")
    result = json.loads(found["payload_json"])
    result["suggestions"] = (result.get("suggestions") or [])[:limit]
    result["precomputed"] = True
    return result


def _warm_suggestions(request: Request, conn: sqlite3.Connection) -> None:
    """Fit the suggestion index in the background so the first 'Suggest owner' click is fast."""
    if suggest is None:
        return
    try:
        if not suggest.is_cached(conn):
            suggest.warm_async(db_path_for(request))
    except sqlite3.Error:  # warming is best effort
        pass


# --------------------------------------------------------------------------- endpoints

@router.get("", summary="Residual (unmapped) lines with pending-claim counts")
def list_residual(
    request: Request,
    q: str | None = Query(None, max_length=200),
    chapter: str | None = Query(None, description="2-digit chapter(s), comma-separated"),
    sector_id: str | None = None,
    sort: SortParam = "code",
    order: Literal["asc", "desc"] | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    conn: sqlite3.Connection = Depends(get_db),
    _user: dict = Depends(require_gov),
) -> dict:
    try:
        result = search_products(conn, q=q, mapping_status="residual", chapter=chapter, sector_id=sector_id,
                                 sort=sort, order=order, page=page, page_size=page_size)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    codes = [item["hsn8"] for item in result["items"]]
    pending: dict[str, list[str]] = {}
    if codes:
        for r in rows(conn, f"""SELECT hsn8, ministry_id FROM residual_claims
                                WHERE status = 'pending' AND {in_json('hsn8')} ORDER BY created_at""",
                      (json_param(codes),)):
            pending.setdefault(r["hsn8"], []).append(r["ministry_id"])
    for item in result["items"]:
        item["pending_claims"] = len(pending.get(item["hsn8"], []))
        item["claimed_by"] = pending.get(item["hsn8"], [])
    result["summary"] = {
        "residual_codes": row(conn, "SELECT COUNT(*) AS n FROM products WHERE mapping_status = 'residual' "
                                    "AND is_current = 1")["n"],
        "pending_claims": row(conn, "SELECT COUNT(*) AS n FROM residual_claims WHERE status = 'pending'")["n"],
        "approved_claims": row(conn, "SELECT COUNT(*) AS n FROM residual_claims WHERE status = 'approved'")["n"],
    }
    _warm_suggestions(request, conn)
    return result


@router.get("/claims", summary="Ministry claims on residual lines (review queue)")
def list_claims(
    request: Request,
    status: ClaimStatus | None = None,
    ministry_id: str | None = None,
    hsn8: str | None = Query(None, max_length=12),
    conn: sqlite3.Connection = Depends(get_db),
    _user: dict = Depends(require_gov),
) -> list[dict]:
    where, params = ["1=1"], []
    if status:
        where.append("c.status = ?")
        params.append(status)
    if ministry_id:
        where.append("c.ministry_id = ?")
        params.append(ministry_id)
    if hsn8:
        where.append("c.hsn8 = ?")
        params.append(normalize_code(hsn8))
    _warm_suggestions(request, conn)
    return _claims(conn, " AND ".join(where), tuple(params))


@router.get("/suggest/{hsn8}", summary="ML-suggested owner ministries for a line (model estimate)")
def suggest_owner(hsn8: str, limit: int = Query(5, ge=1, le=10), conn: sqlite3.Connection = Depends(get_db),
                  _user: dict = Depends(require_gov)) -> dict:
    if suggest is None:
        return _precomputed_suggestion(conn, hsn8, limit)
    try:
        result = suggest.suggest_ministries(conn, hsn8, limit=limit)
    except LookupError as exc:  # no accepted lines to learn from
        raise HTTPException(status_code=503, detail=f"suggestions unavailable: {exc}") from exc
    if result is None:
        raise HTTPException(status_code=404, detail=f"Unknown HSN line '{hsn8}'")
    return result


@router.post("/{hsn8}/claim", status_code=201, summary="Claim a residual line for a ministry")
def create_claim(hsn8: str, body: ClaimBody, conn: sqlite3.Connection = Depends(get_db),
                 user: dict = Depends(require_roles("ministry", "admin"))) -> dict:
    code = normalize_code(hsn8)
    product = row(conn, "SELECT hsn8, description, mapping_status FROM products WHERE hsn8 = ?", (code,))
    if not product:
        raise HTTPException(status_code=404, detail=f"Unknown HSN line '{hsn8}'")
    ministry_id = (body.ministry_id or "").strip() or (user.get("ministry_id") if user["role"] == "ministry" else None)
    if not ministry_id:
        raise HTTPException(status_code=400, detail="ministry_id is required")
    if user["role"] == "ministry" and ministry_id != user.get("ministry_id"):
        raise HTTPException(status_code=403, detail="Ministry users can only claim lines for their own ministry")
    ministry = ministry_ref(conn, ministry_id)
    if not ministry or ministry_id == "residual":
        raise HTTPException(status_code=400, detail=f"Unknown ministry '{ministry_id}'")
    if product["mapping_status"] != "residual":
        raise HTTPException(status_code=409, detail=f"{code} is not a residual line (already mapped)")
    if row(conn, "SELECT id FROM residual_claims WHERE hsn8 = ? AND ministry_id = ? AND status = 'pending'",
           (code, ministry_id)):
        raise HTTPException(status_code=409, detail=f"{ministry['short_name']} already has a pending claim on {code}")
    cur = conn.execute("INSERT INTO residual_claims (hsn8, ministry_id, claimed_by, justification, status, "
                       "created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
                       (code, ministry_id, user["id"], body.justification.strip(), utc_now()))
    log_action(conn, user, "claim.create", "residual_claim", cur.lastrowid,
               {"hsn8": code, "ministry_id": ministry_id}, commit=False)
    conn.commit()
    return get_claim(conn, cur.lastrowid)


@router.post("/claims/{claim_id}/review", summary="Approve or reject a claim (admin)")
def review_claim(claim_id: int, body: ReviewBody, conn: sqlite3.Connection = Depends(get_db),
                 user: dict = Depends(require_admin)) -> dict:
    claim = get_claim(conn, claim_id)
    if not claim:
        raise HTTPException(status_code=404, detail=f"Unknown claim {claim_id}")
    if claim["status"] != "pending":
        raise HTTPException(status_code=409, detail=f"Claim {claim_id} is already {claim['status']}")
    now = utc_now()
    note = (body.note or "").strip() or None
    status = "approved" if body.decision == "approve" else "rejected"
    change = None
    superseded: list[int] = []
    try:
        conn.execute("UPDATE residual_claims SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? "
                     "WHERE id = ?", (status, user["id"], now, note, claim_id))
        if status == "approved":
            change = set_product_owner(
                conn, claim["hsn8"], claim["ministry_id"], mapping_source="manual", change_source="claim",
                user_id=user["id"], rule=f"claim:{claim_id}",
                note=f"Residual claim #{claim_id} approved" + (f": {note}" if note else ""))
            if change is None:
                raise HTTPException(status_code=409, detail=f"Line {claim['hsn8']} no longer exists")
            refresh_fts_rows(conn, [claim["hsn8"]])
            superseded = [r["id"] for r in rows(conn, "SELECT id FROM residual_claims WHERE hsn8 = ? AND "
                                                      "status = 'pending' AND id <> ?", (claim["hsn8"], claim_id))]
            if superseded:
                conn.execute(f"UPDATE residual_claims SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, "
                             f"review_note = ? WHERE {in_json('id')}",
                             (user["id"], now, f"Superseded: claim #{claim_id} was approved", json_param(superseded)))
            log_action(conn, user, "mapping.change", "product", claim["hsn8"],
                       {"old_ministry_id": change["old_ministry_id"], "new_ministry_id": claim["ministry_id"],
                        "source": "claim", "claim_id": claim_id}, commit=False)
        log_action(conn, user, "claim.review", "residual_claim", claim_id,
                   {"decision": body.decision, "hsn8": claim["hsn8"], "ministry_id": claim["ministry_id"],
                    "note": note, "superseded": superseded}, commit=False)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    product = product_summaries(conn, "p.hsn8 = ?", (claim["hsn8"],), limit=1)
    return {"claim": get_claim(conn, claim_id), "product": product[0] if product else None,
            "mapping_change": change, "superseded_claims": superseded}
