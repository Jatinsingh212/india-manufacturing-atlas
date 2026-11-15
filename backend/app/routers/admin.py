"""Administration, programme roadmap, risk register and watchlist (docs/SPEC.md section 6.13).

One module serves four URL prefixes, so ``router`` (the object ``app.main`` includes) is a prefix-less
``APIRouter`` that includes four sub-routers:

Admin (``/api/admin``, admin only)
    * ``GET   /api/admin/users?role=&q=`` - users ``{id, email, name, role, ministry_id, ministry, organisation,
      active, is_demo, created_at, last_login}`` (``password_hash`` is never returned).
    * ``POST  /api/admin/users {email, name, password, role, ministry_id?, organisation?}`` -> user (201).
      409 for a duplicate email; a ``ministry`` user needs a valid ``ministry_id``.
    * ``PATCH /api/admin/users/{id} {name?, role?, ministry_id?, organisation?, active?, password?}`` -> user.
      An admin cannot deactivate or demote their own account (400).
    * ``GET   /api/admin/audit?page=&page_size=&action=&user_id=&entity=`` - paginated audit log, newest
      first; ``action`` matches a dotted prefix (``claim`` matches ``claim.create`` and ``claim.review``).
      The envelope adds ``actions`` (distinct actions, for the filter menu).

Roadmap (``/api/roadmap``) - the programme's phased plan (Phase 0: 0-3 months, Phase I: 3-6, Phase II: 6-12)
    * ``GET   /api/roadmap`` (public) -> ``{phases: [{phase, label, months, start_month, end_month, items,
      progress}], progress: {done, in_progress, planned, total, pct}, workstreams: [{workstream, done,
      in_progress, planned, total}]}``. ``pct`` = 100 x done / total (in-progress items count as not done).
    * ``PATCH /api/roadmap/{id} {status?, owner?}`` (admin) -> item.

Risks (``/api/risks``) - the programme risk & mitigation register
    * ``GET   /api/risks`` (public) -> ``[{id, area, risk, mitigation, likelihood, impact, score, level, status,
      owner, platform_control}]``; ``score`` = likelihood x impact (1-25), ``level`` high (>= 15) / medium
      (>= 8) / low.
    * ``PATCH /api/risks/{id} {status?, owner?, likelihood?, impact?, mitigation?, platform_control?}`` (admin).

Watchlist (``/api/watchlist``, any signed-in user)
    * ``GET    /api/watchlist`` -> ``ProductSummary[]`` (+ ``added_at``), most recently added first.
    * ``POST   /api/watchlist/{hsn8}`` / ``DELETE /api/watchlist/{hsn8}`` -> ``{hsn8, watching, count}``.

Every mutation is written to ``audit_log`` (``user.create``, ``user.update``, ``roadmap.update``,
``risk.update``, ``watchlist.add``, ``watchlist.remove``).
"""
from __future__ import annotations

import re
import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from app.common import ministry_ref, ministry_refs, normalize_code, page_window, paginate, parse_json, \
    product_summaries
from app.db import get_db, row, rows
from app.security import USER_ROLES, hash_password, require_admin, require_user
from app.services.audit import log_action, utc_now

router = APIRouter()
admin_router = APIRouter(prefix="/api/admin", tags=["admin"])
roadmap_router = APIRouter(prefix="/api/roadmap", tags=["roadmap"])
risks_router = APIRouter(prefix="/api/risks", tags=["roadmap"])
watchlist_router = APIRouter(prefix="/api/watchlist", tags=["watchlist"])

UserRole = Literal["industry", "analyst", "ministry", "admin"]
RoadmapStatus = Literal["done", "in_progress", "planned"]
RiskStatus = Literal["open", "mitigating", "closed"]

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_USER_SELECT = """
    SELECT u.id, u.email, u.name, u.role, u.ministry_id, u.organisation, u.active, u.is_demo, u.created_at,
           (SELECT MAX(a.ts) FROM audit_log a WHERE a.user_id = u.id AND a.action LIKE 'login%') AS last_login
    FROM users u"""

#: Programme phases and their scope.
PHASES = (
    ("Phase 0", "Platform architecture, HSN digitisation, basic dashboards and trade data", 0, 3),
    ("Phase I", "Pilot 10 sectors; add analytics and value-chain mapping", 3, 6),
    ("Phase II", "Scale to all sectors; AI/ML and predictive features", 6, 12),
)


# --------------------------------------------------------------------------- bodies

def _clean_email(value: str) -> str:
    value = value.strip().lower()
    if not _EMAIL_RE.match(value):
        raise ValueError("not a valid email address")
    return value


class UserCreate(BaseModel):
    email: str = Field(..., min_length=3, max_length=254)
    name: str = Field(..., min_length=1, max_length=120)
    password: str = Field(..., min_length=8, max_length=256)
    role: UserRole
    ministry_id: str | None = Field(None, max_length=40)
    organisation: str | None = Field(None, max_length=200)

    @field_validator("email")
    @classmethod
    def _valid_email(cls, value: str) -> str:
        return _clean_email(value)

    @field_validator("name")
    @classmethod
    def _non_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("name must not be blank")
        return value


class UserPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    role: UserRole | None = None
    ministry_id: str | None = Field(None, max_length=40)
    organisation: str | None = Field(None, max_length=200)
    active: bool | None = None
    password: str | None = Field(None, min_length=8, max_length=256)


class RoadmapPatch(BaseModel):
    status: RoadmapStatus | None = None
    owner: str | None = Field(None, max_length=200)


class RiskPatch(BaseModel):
    status: RiskStatus | None = None
    owner: str | None = Field(None, max_length=200)
    likelihood: int | None = Field(None, ge=1, le=5)
    impact: int | None = Field(None, ge=1, le=5)
    mitigation: str | None = Field(None, min_length=3, max_length=2000)
    platform_control: str | None = Field(None, max_length=2000)


# --------------------------------------------------------------------------- users

def _user_out(conn: sqlite3.Connection, u: dict, refs: dict[str, dict] | None = None) -> dict:
    refs = refs or {}
    return {
        "id": u["id"], "email": u["email"], "name": u["name"], "role": u["role"], "ministry_id": u["ministry_id"],
        "ministry": refs.get(u["ministry_id"]) or (ministry_ref(conn, u["ministry_id"]) if u["ministry_id"] else None),
        "organisation": u["organisation"], "active": bool(u["active"]), "is_demo": bool(u["is_demo"]),
        "created_at": u["created_at"], "last_login": u.get("last_login"),
    }


def _get_user(conn: sqlite3.Connection, user_id: int) -> dict:
    u = row(conn, f"{_USER_SELECT} WHERE u.id = ?", (user_id,))
    if not u:
        raise HTTPException(status_code=404, detail=f"Unknown user {user_id}")
    return u


def _check_ministry(conn: sqlite3.Connection, role: str, ministry_id: str | None) -> str | None:
    """Ministry users need a real ministry; other roles carry none."""
    if role != "ministry":
        return None
    if not ministry_id or ministry_id == "residual" or not ministry_ref(conn, ministry_id):
        raise HTTPException(status_code=400, detail="A ministry user needs a valid ministry_id")
    return ministry_id


@admin_router.get("/users", summary="All users (never includes password hashes)")
def list_users(role: UserRole | None = None, q: str | None = Query(None, max_length=200),
               conn: sqlite3.Connection = Depends(get_db), _admin: dict = Depends(require_admin)) -> list[dict]:
    where, params = ["1=1"], []
    if role:
        where.append("u.role = ?")
        params.append(role)
    if q and q.strip():
        like = f"%{q.strip()}%"
        where.append("(u.email LIKE ? OR u.name LIKE ? OR u.organisation LIKE ?)")
        params += [like, like, like]
    data = rows(conn, f"{_USER_SELECT} WHERE {' AND '.join(where)} ORDER BY u.role, u.name", params)
    refs = {m["id"]: m for m in ministry_refs(conn, [u["ministry_id"] for u in data])}
    return [_user_out(conn, u, refs) for u in data]


@admin_router.post("/users", status_code=201, summary="Create a user")
def create_user(body: UserCreate, conn: sqlite3.Connection = Depends(get_db),
                admin: dict = Depends(require_admin)) -> dict:
    if body.role not in USER_ROLES:
        raise HTTPException(status_code=400, detail=f"role must be one of {', '.join(USER_ROLES)}")
    ministry_id = _check_ministry(conn, body.role, body.ministry_id)
    if row(conn, "SELECT id FROM users WHERE lower(email) = lower(?)", (body.email,)):
        raise HTTPException(status_code=409, detail=f"A user with email {body.email} already exists")
    cur = conn.execute("INSERT INTO users (email, name, password_hash, role, ministry_id, organisation, active, "
                       "is_demo, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)",
                       (body.email, body.name.strip(), hash_password(body.password), body.role, ministry_id,
                        (body.organisation or "").strip() or None, utc_now()))
    log_action(conn, admin, "user.create", "user", cur.lastrowid,
               {"email": body.email, "role": body.role, "ministry_id": ministry_id}, commit=False)
    conn.commit()
    return _user_out(conn, _get_user(conn, cur.lastrowid))


@admin_router.patch("/users/{user_id}", summary="Update a user (role, ministry, active, password ...)")
def update_user(user_id: int, body: UserPatch, conn: sqlite3.Connection = Depends(get_db),
                admin: dict = Depends(require_admin)) -> dict:
    current = _get_user(conn, user_id)
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="Nothing to update")
    if user_id == admin["id"]:
        if fields.get("active") is False:
            raise HTTPException(status_code=400, detail="You cannot deactivate your own account")
        if fields.get("role") not in (None, "admin"):
            raise HTTPException(status_code=400, detail="You cannot remove your own admin role")
    role = fields.get("role") or current["role"]
    ministry_id = fields["ministry_id"] if "ministry_id" in fields else current["ministry_id"]
    sets: dict[str, object] = {}
    if "name" in fields and fields["name"] is not None:
        sets["name"] = fields["name"].strip()
    if "role" in fields and fields["role"] is not None:
        sets["role"] = fields["role"]
    if "role" in fields or "ministry_id" in fields:
        sets["ministry_id"] = _check_ministry(conn, role, ministry_id)
    if "organisation" in fields:
        sets["organisation"] = (fields["organisation"] or "").strip() or None
    if "active" in fields and fields["active"] is not None:
        sets["active"] = 1 if fields["active"] else 0
    if fields.get("password"):
        sets["password_hash"] = hash_password(fields["password"])
    if not sets:
        raise HTTPException(status_code=400, detail="Nothing to update")
    assignments = ", ".join(f"{column} = ?" for column in sets)
    conn.execute(f"UPDATE users SET {assignments} WHERE id = ?", (*sets.values(), user_id))
    changed = {k: v for k, v in sets.items() if k != "password_hash"}
    if "password_hash" in sets:
        changed["password"] = "changed"
    log_action(conn, admin, "user.update", "user", user_id, changed, commit=False)
    conn.commit()
    return _user_out(conn, _get_user(conn, user_id))


@admin_router.get("/audit", summary="Audit log (newest first)")
def audit_log(page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200),
              action: str | None = Query(None, max_length=80), user_id: int | None = None,
              entity: str | None = Query(None, max_length=80), conn: sqlite3.Connection = Depends(get_db),
              _admin: dict = Depends(require_admin)) -> dict:
    where, params = ["1=1"], []
    if action:
        where.append("(a.action = ? OR a.action LIKE ?)")
        params += [action, f"{action}.%"]
    if user_id is not None:
        where.append("a.user_id = ?")
        params.append(user_id)
    if entity:
        where.append("a.entity = ?")
        params.append(entity)
    clause = " AND ".join(where)
    page, size, offset = page_window(page, page_size)
    total = row(conn, f"SELECT COUNT(*) AS n FROM audit_log a WHERE {clause}", params)["n"]
    data = rows(conn, f"""SELECT a.id, a.ts, a.user_id, a.user_email, u.name AS user_name, a.action, a.entity,
                                 a.entity_id, a.details_json
                          FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
                          WHERE {clause} ORDER BY a.ts DESC, a.id DESC LIMIT ? OFFSET ?""", [*params, size, offset])
    for r in data:
        r["details"] = parse_json(r.pop("details_json"), None)
    out = paginate(data, total, page, size)
    out["actions"] = [r["action"] for r in rows(conn, "SELECT DISTINCT action FROM audit_log ORDER BY action")]
    return out


# --------------------------------------------------------------------------- roadmap

def _progress(items: list[dict]) -> dict:
    counts = {s: sum(1 for i in items if i["status"] == s) for s in ("done", "in_progress", "planned")}
    total = len(items)
    return {**counts, "total": total, "pct": round(100.0 * counts["done"] / total, 1) if total else 0.0}


@roadmap_router.get("", summary="Phase 0 / I / II roadmap with progress")
def roadmap(conn: sqlite3.Connection = Depends(get_db)) -> dict:
    items = rows(conn, "SELECT id, phase, workstream, title, description, start_month, end_month, status, owner, "
                       "platform_route, sort_order FROM roadmap_items ORDER BY sort_order, start_month, id")
    phases = []
    known = {p[0] for p in PHASES}
    extra = [p for p in dict.fromkeys(i["phase"] for i in items) if p not in known]
    for name, label, start, end in [*PHASES, *[(p, p, None, None) for p in extra]]:
        phase_items = [i for i in items if i["phase"] == name]
        starts = [i["start_month"] for i in phase_items if i["start_month"] is not None]
        ends = [i["end_month"] for i in phase_items if i["end_month"] is not None]
        start = start if start is not None else (min(starts) if starts else None)
        end = end if end is not None else (max(ends) if ends else None)
        phases.append({"phase": name, "label": label, "start_month": start, "end_month": end,
                       "months": f"{start}-{end} months" if start is not None and end is not None else None,
                       "items": phase_items, "progress": _progress(phase_items)})
    workstreams = []
    for ws in dict.fromkeys(i["workstream"] for i in items if i["workstream"]):
        ws_items = [i for i in items if i["workstream"] == ws]
        p = _progress(ws_items)
        workstreams.append({"workstream": ws, **{k: p[k] for k in ("done", "in_progress", "planned", "total")}})
    return {"phases": phases, "progress": _progress(items), "workstreams": workstreams,
            "source": "Programme office roadmap (phases and the 8 workstreams); statuses maintained by "
                      "the programme office"}


@roadmap_router.patch("/{item_id}", summary="Update a roadmap item's status / owner (admin)")
def update_roadmap(item_id: str, body: RoadmapPatch, conn: sqlite3.Connection = Depends(get_db),
                   admin: dict = Depends(require_admin)) -> dict:
    current = row(conn, "SELECT * FROM roadmap_items WHERE id = ?", (item_id,))
    if not current:
        raise HTTPException(status_code=404, detail=f"Unknown roadmap item '{item_id}'")
    fields = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="Nothing to update")
    conn.execute(f"UPDATE roadmap_items SET {', '.join(f'{k} = ?' for k in fields)} WHERE id = ?",
                 (*fields.values(), item_id))
    log_action(conn, admin, "roadmap.update", "roadmap_item", item_id,
               {k: {"from": current[k], "to": v} for k, v in fields.items()}, commit=False)
    conn.commit()
    return row(conn, "SELECT * FROM roadmap_items WHERE id = ?", (item_id,))


# --------------------------------------------------------------------------- risks

def _risk_out(r: dict) -> dict:
    score = (r["likelihood"] or 0) * (r["impact"] or 0) if r["likelihood"] and r["impact"] else None
    level = None if score is None else ("high" if score >= 15 else "medium" if score >= 8 else "low")
    return {**r, "score": score, "level": level}


@risks_router.get("", summary="Risk & mitigation register")
def list_risks(conn: sqlite3.Connection = Depends(get_db)) -> list[dict]:
    return [_risk_out(r) for r in rows(conn, "SELECT id, area, risk, mitigation, likelihood, impact, status, owner, "
                                             "platform_control FROM risks ORDER BY id")]


@risks_router.patch("/{risk_id}", summary="Update a risk (admin)")
def update_risk(risk_id: int, body: RiskPatch, conn: sqlite3.Connection = Depends(get_db),
                admin: dict = Depends(require_admin)) -> dict:
    current = row(conn, "SELECT * FROM risks WHERE id = ?", (risk_id,))
    if not current:
        raise HTTPException(status_code=404, detail=f"Unknown risk {risk_id}")
    fields = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="Nothing to update")
    conn.execute(f"UPDATE risks SET {', '.join(f'{k} = ?' for k in fields)} WHERE id = ?", (*fields.values(), risk_id))
    log_action(conn, admin, "risk.update", "risk", risk_id,
               {k: {"from": current[k], "to": v} for k, v in fields.items()}, commit=False)
    conn.commit()
    return _risk_out(row(conn, "SELECT id, area, risk, mitigation, likelihood, impact, status, owner, "
                               "platform_control FROM risks WHERE id = ?", (risk_id,)))


# --------------------------------------------------------------------------- watchlist

def _watch_count(conn: sqlite3.Connection, user_id: int) -> int:
    return row(conn, "SELECT COUNT(*) AS n FROM watchlist WHERE user_id = ?", (user_id,))["n"]


@watchlist_router.get("", summary="The signed-in user's watched lines")
def get_watchlist(conn: sqlite3.Connection = Depends(get_db), user: dict = Depends(require_user)) -> list[dict]:
    return product_summaries(conn, "w.user_id = ?", (user["id"],), "w.created_at DESC, p.hsn8", limit=None,
                             extra_select="w.created_at AS added_at",
                             join_sql="JOIN watchlist w ON w.hsn8 = p.hsn8")


@watchlist_router.post("/{hsn8}", status_code=201, summary="Watch a line")
def watch(hsn8: str, conn: sqlite3.Connection = Depends(get_db), user: dict = Depends(require_user)) -> dict:
    code = normalize_code(hsn8)
    if not row(conn, "SELECT hsn8 FROM products WHERE hsn8 = ?", (code,)):
        raise HTTPException(status_code=404, detail=f"Unknown HSN line '{hsn8}'")
    cur = conn.execute("INSERT OR IGNORE INTO watchlist (user_id, hsn8, created_at) VALUES (?, ?, ?)",
                       (user["id"], code, utc_now()))
    if cur.rowcount:
        log_action(conn, user, "watchlist.add", "product", code, None, commit=False)
    conn.commit()
    return {"hsn8": code, "watching": True, "count": _watch_count(conn, user["id"])}


@watchlist_router.delete("/{hsn8}", summary="Stop watching a line")
def unwatch(hsn8: str, conn: sqlite3.Connection = Depends(get_db), user: dict = Depends(require_user)) -> dict:
    code = normalize_code(hsn8)
    cur = conn.execute("DELETE FROM watchlist WHERE user_id = ? AND hsn8 = ?", (user["id"], code))
    if cur.rowcount:
        log_action(conn, user, "watchlist.remove", "product", code, None, commit=False)
    conn.commit()
    return {"hsn8": code, "watching": False, "count": _watch_count(conn, user["id"])}


router.include_router(admin_router)
router.include_router(roadmap_router)
router.include_router(risks_router)
router.include_router(watchlist_router)
