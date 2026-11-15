"""Helpdesk - the industry and government interface (docs/SPEC.md section 6.10).

Industry (or any visitor) raises a query about an HSN line; the platform routes it automatically to the line's
owning ministry so that the right desk answers it.

Endpoints
---------
* ``POST /api/tickets {hsn8?, subject, body, category, submitter_name?, submitter_org?, submitter_email?}`` -
  public (guests allowed). Routing: the line's primary ministry (``products.ministry_id``); a residual line, an
  unknown owner or no code -> DPIIT (the nodal department for unmapped lines). A signed-in submitter is linked
  (``submitted_by``) and their name / organisation / email fill the blanks. -> ``{ticket, routed_ministry,
  routing: {ministry_id, reason}}`` (201).
* ``GET  /api/tickets/route?hsn8=`` - public routing preview ``{routed_ministry, reason, product}`` (the
  helpdesk form shows it before submitting).
* ``GET  /api/tickets?status=&category=&ministry_id=&q=&page=&page_size=`` - signed in. Scope by role:
  industry -> own tickets; ministry -> tickets routed to its ministry; analyst / admin -> all
  (``ministry_id`` filters). Paginated ``{items: [Ticket], total, page, page_size}``.
* ``GET  /api/tickets/stats`` (GOV) - ``{by_status, by_ministry, by_category, avg_resolution_hours, total, open}``.
  ``avg_resolution_hours`` = mean of ``updated_at - created_at`` over resolved tickets (``updated_at`` is the
  last activity, i.e. the resolution for a resolved ticket).
* ``GET  /api/tickets/{id}`` - ``{ticket, messages, product: ProductSummary | null}``; visible to the submitter,
  the routed ministry, analysts and admins.
* ``POST /api/tickets/{id}/messages {body}`` - the submitter, the routed ministry or an admin. A government
  reply on an ``open`` ticket moves it to ``in_progress``; a submitter's reply on a ``resolved`` ticket
  re-opens it.
* ``POST /api/tickets/{id}/status {status, routed_ministry_id?}`` - the routed ministry or an admin;
  ``routed_ministry_id`` forwards the ticket to another ministry (recorded as a system message).

``Ticket`` = ``{id, hsn8, product_description, subject, body, category, submitter_name, submitter_org,
submitter_email, submitted_by, routed_ministry_id, routed_ministry: MinistryRef | null, status, created_at,
updated_at, n_messages, last_message_at}``. ``submitter_email`` is shown only to government users and the
submitter (privacy). Every write is audited (``ticket.create``, ``ticket.message``, ``ticket.status``).
"""
from __future__ import annotations

import re
import sqlite3
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from app.common import ministry_ref, ministry_refs, normalize_code, page_window, paginate, product_summaries
from app.db import get_db, row, rows
from app.security import GOV_ROLES, current_user, require_gov, require_user
from app.services.audit import log_action, utc_now

router = APIRouter(prefix="/api/tickets", tags=["helpdesk"])

CATEGORIES = ("classification", "tariff", "policy_support", "trade_remedy", "other")
STATUSES = ("open", "in_progress", "resolved")
DEFAULT_MINISTRY = "dpiit"
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

Category = Literal["classification", "tariff", "policy_support", "trade_remedy", "other"]
Status = Literal["open", "in_progress", "resolved"]

_TICKET_SELECT = """
    SELECT t.*, p.description AS product_description,
           (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS n_messages,
           (SELECT MAX(m.ts) FROM ticket_messages m WHERE m.ticket_id = t.id) AS last_message_at
    FROM tickets t LEFT JOIN products p ON p.hsn8 = t.hsn8"""


class TicketBody(BaseModel):
    hsn8: str | None = Field(None, max_length=20, description="8-digit line the query is about (optional)")
    subject: str = Field(..., min_length=3, max_length=200)
    body: str = Field(..., min_length=10, max_length=5000)
    category: Category = "other"
    submitter_name: str | None = Field(None, max_length=120)
    submitter_org: str | None = Field(None, max_length=200)
    submitter_email: str | None = Field(None, max_length=254)

    @field_validator("subject", "body")
    @classmethod
    def _strip(cls, value: str) -> str:
        value = value.strip()
        if len(value) < 3:
            raise ValueError("must not be blank")
        return value

    @field_validator("submitter_email")
    @classmethod
    def _email(cls, value: str | None) -> str | None:
        value = (value or "").strip().lower()
        if not value:
            return None
        if not _EMAIL_RE.match(value):
            raise ValueError("not a valid email address")
        return value


class MessageBody(BaseModel):
    body: str = Field(..., min_length=1, max_length=5000)


class StatusBody(BaseModel):
    status: Status
    routed_ministry_id: str | None = Field(None, max_length=40, description="Forward to another ministry")


# --------------------------------------------------------------------------- helpers

def route_for(conn: sqlite3.Connection, hsn8: str | None) -> dict:
    """``{ministry_id, reason, product}`` - where a query about ``hsn8`` is routed (SPEC 6.10)."""
    code = normalize_code(hsn8) if hsn8 else ""
    if not code:
        return {"ministry_id": DEFAULT_MINISTRY, "reason": "No HSN code given - routed to DPIIT (nodal department)",
                "product": None}
    product = row(conn, "SELECT hsn8, description, ministry_id, mapping_status FROM products WHERE hsn8 = ?",
                  (code,))
    if not product:
        raise HTTPException(status_code=400, detail=f"Unknown 8-digit HSN line '{hsn8}'")
    if product["mapping_status"] == "residual" or product["ministry_id"] in (None, "", "residual"):
        return {"ministry_id": DEFAULT_MINISTRY, "product": product,
                "reason": f"{code} is a residual line (no owning ministry yet) - routed to DPIIT"}
    ref = ministry_ref(conn, product["ministry_id"])
    if not ref:
        return {"ministry_id": DEFAULT_MINISTRY, "product": product,
                "reason": f"Owner of {code} is unknown - routed to DPIIT"}
    return {"ministry_id": ref["id"], "product": product,
            "reason": f"{code} is mapped to {ref['name']} ({ref['short_name']}), its primary ministry"}


def _can_view(user: dict, ticket: dict) -> bool:
    role = user.get("role")
    if role in ("admin", "analyst"):
        return True
    if role == "ministry":
        return ticket["routed_ministry_id"] == user.get("ministry_id")
    return user.get("id") is not None and ticket["submitted_by"] == user.get("id")


def _can_manage(user: dict, ticket: dict) -> bool:
    """Reply as government / change status: the routed ministry or an admin."""
    role = user.get("role")
    return role == "admin" or (role == "ministry" and ticket["routed_ministry_id"] == user.get("ministry_id"))


def _ticket_dict(t: dict, viewer: dict, refs: dict[str, dict]) -> dict:
    show_email = viewer.get("role") in GOV_ROLES or (viewer.get("id") is not None
                                                     and viewer.get("id") == t["submitted_by"])
    return {
        "id": t["id"], "hsn8": t["hsn8"], "product_description": t.get("product_description"),
        "subject": t["subject"], "body": t["body"], "category": t["category"],
        "submitter_name": t["submitter_name"], "submitter_org": t["submitter_org"],
        "submitter_email": t["submitter_email"] if show_email else None,
        "submitted_by": t["submitted_by"], "routed_ministry_id": t["routed_ministry_id"],
        "routed_ministry": refs.get(t["routed_ministry_id"]), "status": t["status"],
        "created_at": t["created_at"], "updated_at": t["updated_at"],
        "n_messages": t.get("n_messages") or 0, "last_message_at": t.get("last_message_at"),
    }


def _tickets(conn: sqlite3.Connection, viewer: dict, where: str, params: list, *, limit: int | None = None,
             offset: int = 0) -> list[dict]:
    sql = f"{_TICKET_SELECT} WHERE {where} ORDER BY t.updated_at DESC, t.id DESC"
    args = list(params)
    if limit is not None:
        sql += " LIMIT ? OFFSET ?"
        args += [limit, offset]
    data = rows(conn, sql, args)
    refs = {m["id"]: m for m in ministry_refs(conn, [t["routed_ministry_id"] for t in data])}
    return [_ticket_dict(t, viewer, refs) for t in data]


def _load(conn: sqlite3.Connection, ticket_id: int) -> dict:
    t = row(conn, f"{_TICKET_SELECT} WHERE t.id = ?", (ticket_id,))
    if not t:
        raise HTTPException(status_code=404, detail=f"Unknown ticket {ticket_id}")
    return t


def _messages(conn: sqlite3.Connection, ticket_id: int) -> list[dict]:
    return rows(conn, "SELECT id, ticket_id, author_id, author_name, author_role, body, ts FROM ticket_messages "
                      "WHERE ticket_id = ? ORDER BY ts, id", (ticket_id,))


def _hours_between(start: str, end: str) -> float | None:
    try:
        return (datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds() / 3600.0
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------- endpoints

@router.post("", status_code=201, summary="Raise a query (public); auto-routed to the owning ministry")
def create_ticket(body: TicketBody, conn: sqlite3.Connection = Depends(get_db),
                  user: dict = Depends(current_user)) -> dict:
    routing = route_for(conn, body.hsn8)
    signed_in = user.get("id") is not None
    name = (body.submitter_name or "").strip() or (user.get("name") if signed_in else None)
    org = (body.submitter_org or "").strip() or (user.get("organisation") if signed_in else None)
    email = body.submitter_email or (user.get("email") if signed_in else None)
    if not signed_in and not name:
        raise HTTPException(status_code=422, detail="submitter_name is required for guest queries")
    now = utc_now()
    product = routing["product"]
    cur = conn.execute(
        "INSERT INTO tickets (hsn8, subject, body, category, submitter_name, submitter_org, submitter_email, "
        "submitted_by, routed_ministry_id, status, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)",
        (product["hsn8"] if product else None, body.subject, body.body, body.category, name, org, email,
         user.get("id"), routing["ministry_id"], now, now))
    ticket_id = cur.lastrowid
    log_action(conn, user if signed_in else None, "ticket.create", "ticket", ticket_id,
               {"hsn8": product["hsn8"] if product else None, "routed_ministry_id": routing["ministry_id"],
                "category": body.category, "guest": not signed_in}, commit=False)
    conn.commit()
    ticket = _tickets(conn, user, "t.id = ?", [ticket_id])[0]
    if not signed_in:  # a guest cannot read the ticket back later; show what was recorded once
        ticket["submitter_email"] = email
    return {"ticket": ticket, "routed_ministry": ticket["routed_ministry"],
            "routing": {"ministry_id": routing["ministry_id"], "reason": routing["reason"]}}


@router.get("/route", summary="Routing preview: which ministry a query about a line goes to")
def route_preview(hsn8: str | None = Query(None, max_length=20), conn: sqlite3.Connection = Depends(get_db)) -> dict:
    routing = route_for(conn, hsn8)
    product = None
    if routing["product"]:
        found = product_summaries(conn, "p.hsn8 = ?", (routing["product"]["hsn8"],), limit=1)
        product = found[0] if found else None
    return {"routed_ministry": ministry_ref(conn, routing["ministry_id"]), "reason": routing["reason"],
            "product": product}


@router.get("", summary="Tickets visible to the caller (own / routed to own ministry / all)")
def list_tickets(
    status: Status | None = None,
    category: Category | None = None,
    ministry_id: str | None = None,
    q: str | None = Query(None, max_length=200),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(require_user),
) -> dict:
    where, params = ["1=1"], []
    role = user["role"]
    if role == "industry":
        where.append("t.submitted_by = ?")
        params.append(user["id"])
    elif role == "ministry":
        where.append("t.routed_ministry_id = ?")
        params.append(user.get("ministry_id"))
    elif ministry_id:
        where.append("t.routed_ministry_id = ?")
        params.append(ministry_id)
    if status:
        where.append("t.status = ?")
        params.append(status)
    if category:
        where.append("t.category = ?")
        params.append(category)
    if q and q.strip():
        like = f"%{q.strip()}%"
        where.append("(t.subject LIKE ? OR t.body LIKE ? OR t.hsn8 LIKE ? OR t.submitter_org LIKE ?)")
        params += [like, like, like, like]
    page, size, offset = page_window(page, page_size)
    clause = " AND ".join(where)
    total = row(conn, f"SELECT COUNT(*) AS n FROM tickets t WHERE {clause}", params)["n"]
    items = _tickets(conn, user, clause, params, limit=size, offset=offset)
    return paginate(items, total, page, size)


@router.get("/stats", summary="Helpdesk statistics (government)")
def ticket_stats(conn: sqlite3.Connection = Depends(get_db), _user: dict = Depends(require_gov)) -> dict:
    by_status_raw = {r["status"]: r["n"] for r in rows(conn, "SELECT status, COUNT(*) AS n FROM tickets GROUP BY status")}
    # ``n`` is the contract field (frontend types.ts TicketStats); ``count`` is kept as an alias.
    by_status = [{"status": s, "n": by_status_raw.get(s, 0), "count": by_status_raw.get(s, 0)} for s in STATUSES]
    by_status += [{"status": s, "n": n, "count": n} for s, n in by_status_raw.items() if s not in STATUSES]
    by_category_raw = {r["category"]: r["n"] for r in rows(conn, "SELECT category, COUNT(*) AS n FROM tickets "
                                                                "GROUP BY category")}
    by_category = [{"category": c, "n": by_category_raw.get(c, 0), "count": by_category_raw.get(c, 0)}
                   for c in CATEGORIES]
    ministry_rows = rows(conn, """
        SELECT t.routed_ministry_id AS ministry_id, mi.short_name, mi.name, mi.color, COUNT(*) AS total,
               SUM(t.status = 'open') AS open, SUM(t.status = 'in_progress') AS in_progress,
               SUM(t.status = 'resolved') AS resolved
        FROM tickets t LEFT JOIN ministries mi ON mi.id = t.routed_ministry_id
        GROUP BY t.routed_ministry_id ORDER BY total DESC, mi.short_name""")
    durations: dict[str, list[float]] = {}
    all_hours: list[float] = []
    for t in rows(conn, "SELECT routed_ministry_id, created_at, updated_at FROM tickets WHERE status = 'resolved'"):
        hours = _hours_between(t["created_at"], t["updated_at"])
        if hours is not None and hours >= 0:
            durations.setdefault(t["routed_ministry_id"], []).append(hours)
            all_hours.append(hours)
    for m in ministry_rows:
        m["n"] = m["total"]
        hours = durations.get(m["ministry_id"]) or []
        m["avg_resolution_hours"] = round(sum(hours) / len(hours), 1) if hours else None
    total = sum(by_status_raw.values())
    return {
        "total": total,
        "open": by_status_raw.get("open", 0) + by_status_raw.get("in_progress", 0),
        "by_status": by_status,
        "by_ministry": ministry_rows,
        "by_category": by_category,
        "avg_resolution_hours": round(sum(all_hours) / len(all_hours), 1) if all_hours else None,
        "resolved_count": len(all_hours),
    }


@router.get("/{ticket_id}", summary="Ticket with its message thread")
def get_ticket(ticket_id: int, conn: sqlite3.Connection = Depends(get_db),
               user: dict = Depends(require_user)) -> dict:
    t = _load(conn, ticket_id)
    if not _can_view(user, t):
        raise HTTPException(status_code=403, detail="You cannot view this ticket")
    refs = {m["id"]: m for m in ministry_refs(conn, [t["routed_ministry_id"]])}
    product = product_summaries(conn, "p.hsn8 = ?", (t["hsn8"],), limit=1) if t["hsn8"] else []
    return {"ticket": _ticket_dict(t, user, refs), "messages": _messages(conn, ticket_id),
            "product": product[0] if product else None,
            "can_reply": _can_manage(user, t) or t["submitted_by"] == user.get("id"),
            "can_manage": _can_manage(user, t)}


@router.post("/{ticket_id}/messages", status_code=201, summary="Reply on a ticket")
def add_message(ticket_id: int, body: MessageBody, conn: sqlite3.Connection = Depends(get_db),
                user: dict = Depends(require_user)) -> dict:
    t = _load(conn, ticket_id)
    is_submitter = t["submitted_by"] is not None and t["submitted_by"] == user.get("id")
    manages = _can_manage(user, t)
    if not (manages or is_submitter):
        raise HTTPException(status_code=403, detail="Only the submitter, the routed ministry or an admin can reply")
    text = body.body.strip()
    if not text:
        raise HTTPException(status_code=422, detail="Message must not be blank")
    now = utc_now()
    new_status = t["status"]
    if manages and t["status"] == "open":
        new_status = "in_progress"
    elif is_submitter and not manages and t["status"] == "resolved":
        new_status = "open"
    cur = conn.execute("INSERT INTO ticket_messages (ticket_id, author_id, author_name, author_role, body, ts) "
                       "VALUES (?, ?, ?, ?, ?, ?)", (ticket_id, user["id"], user.get("name"), user["role"], text, now))
    conn.execute("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?", (new_status, now, ticket_id))
    log_action(conn, user, "ticket.message", "ticket", ticket_id,
               {"message_id": cur.lastrowid, "status": new_status}, commit=False)
    conn.commit()
    message = row(conn, "SELECT id, ticket_id, author_id, author_name, author_role, body, ts FROM ticket_messages "
                        "WHERE id = ?", (cur.lastrowid,))
    return {"message": message, "ticket": _tickets(conn, user, "t.id = ?", [ticket_id])[0]}


@router.post("/{ticket_id}/status", summary="Change status / forward a ticket (routed ministry or admin)")
def set_status(ticket_id: int, body: StatusBody, conn: sqlite3.Connection = Depends(get_db),
               user: dict = Depends(require_user)) -> dict:
    t = _load(conn, ticket_id)
    if not _can_manage(user, t):
        raise HTTPException(status_code=403, detail="Only the routed ministry or an admin can update this ticket")
    now = utc_now()
    routed = t["routed_ministry_id"]
    forward = (body.routed_ministry_id or "").strip() or None
    if forward and forward != routed:
        ref = ministry_ref(conn, forward)
        if not ref or forward == "residual":
            raise HTTPException(status_code=400, detail=f"Unknown ministry '{forward}'")
        old_ref = ministry_ref(conn, routed)
        conn.execute("INSERT INTO ticket_messages (ticket_id, author_id, author_name, author_role, body, ts) "
                     "VALUES (?, ?, ?, ?, ?, ?)",
                     (ticket_id, user["id"], user.get("name"), user["role"],
                      f"Forwarded from {old_ref['short_name'] if old_ref else routed} to {ref['short_name']}.", now))
        routed = forward
    conn.execute("UPDATE tickets SET status = ?, routed_ministry_id = ?, updated_at = ? WHERE id = ?",
                 (body.status, routed, now, ticket_id))
    log_action(conn, user, "ticket.status", "ticket", ticket_id,
               {"from": t["status"], "to": body.status, "routed_ministry_id": routed,
                "forwarded": routed != t["routed_ministry_id"]}, commit=False)
    conn.commit()
    return {"ticket": _tickets(conn, user, "t.id = ?", [ticket_id])[0]}
