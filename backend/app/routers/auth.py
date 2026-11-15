"""Auth endpoints (docs/SPEC.md sections 5 and 6.1).

* ``POST /api/auth/login {email, password}`` -> ``{access_token, token_type: "bearer", user}``; 401 on bad
  credentials or a deactivated account (same message, so the endpoint does not reveal which emails exist).
  Failed attempts are throttled in-process: after :data:`LOGIN_FAILURES_PER_MINUTE` failures for one email
  (or :data:`LOGIN_FAILURES_PER_IP` for one client address) within a minute the endpoint answers 429 with a
  ``Retry-After`` header *before* the PBKDF2 check runs, so a public client cannot pin a worker thread
  (``ATLAS_LOGIN_RATE_PER_MINUTE`` overrides the per-email limit; 0 disables the throttle).
* ``POST /api/auth/demo-login {role, ministry_id?}`` -> same, for the seeded demo user of that role
  (``users.is_demo = 1``). 404 when ``ATLAS_DEMO_MODE`` is off or no demo user has the role. Two demo ministry
  users exist (``mot`` and ``dpiit``); the optional ``ministry_id`` picks one, otherwise the first seeded
  (Ministry of Textiles) is used.
* ``POST /api/auth/register {email, password, name, organisation}`` -> same; creates an ``industry`` user.
  400 when the email is already registered; 422 for an invalid email or a password shorter than 8 characters.
* ``GET /api/auth/me`` -> ``User``; anonymous callers get ``{id: null, role: "public", ...}``.

Successful logins and registrations are written to ``audit_log`` (``login``, ``login.demo``, ``user.register``).
"""
from __future__ import annotations

import logging
import os
import re
import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from app.config import get_settings
from app.db import execute, get_db, row
from app.security import RateLimiter, auth_response, client_ip, current_user, hash_password, verify_password
from app.services.audit import log_action, utc_now

router = APIRouter(prefix="/api/auth", tags=["auth"])
log = logging.getLogger("atlas.auth")

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_USER_COLUMNS = "id, email, name, role, ministry_id, organisation, active, is_demo, password_hash"

LOGIN_FAILURES_PER_MINUTE = 5     # per email address
LOGIN_FAILURES_PER_IP = 20        # per client address (several accounts tried from one place)
login_limiter = RateLimiter()


def _login_limit() -> int:
    raw = os.environ.get("ATLAS_LOGIN_RATE_PER_MINUTE")
    if raw is None or not raw.strip():
        return LOGIN_FAILURES_PER_MINUTE
    try:
        return max(0, int(raw))
    except ValueError:
        log.warning("ATLAS_LOGIN_RATE_PER_MINUTE=%r is not an integer - using %d", raw, LOGIN_FAILURES_PER_MINUTE)
        return LOGIN_FAILURES_PER_MINUTE


def _throttled(email: str, ip: str) -> float | None:
    limit = _login_limit()
    if limit <= 0:
        return None
    per_ip = max(limit, LOGIN_FAILURES_PER_IP)
    return login_limiter.peek(f"email:{email}", limit) or login_limiter.peek(f"ip:{ip}", per_ip)


class LoginBody(BaseModel):
    email: str = Field(..., min_length=3, max_length=254)
    password: str = Field(..., min_length=1, max_length=256)


class DemoLoginBody(BaseModel):
    role: Literal["admin", "ministry", "analyst", "industry"]
    ministry_id: str | None = Field(None, description="Pick a demo ministry user (e.g. 'mot' or 'dpiit').")


class RegisterBody(BaseModel):
    email: str = Field(..., min_length=3, max_length=254)
    password: str = Field(..., min_length=8, max_length=256)
    name: str = Field(..., min_length=1, max_length=120)
    organisation: str | None = Field(None, max_length=200)

    @field_validator("email")
    @classmethod
    def _valid_email(cls, value: str) -> str:
        value = value.strip().lower()
        if not _EMAIL_RE.match(value):
            raise ValueError("not a valid email address")
        return value

    @field_validator("name")
    @classmethod
    def _non_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("name must not be blank")
        return value


def _user_by_email(conn: sqlite3.Connection, email: str) -> dict | None:
    return row(conn, f"SELECT {_USER_COLUMNS} FROM users WHERE lower(email) = lower(?)", (email.strip(),))


@router.post("/login", summary="Sign in with email and password")
def login(body: LoginBody, request: Request, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    email = body.email.strip().lower()
    ip = client_ip(request)
    wait = _throttled(email, ip)
    if wait is not None:
        raise HTTPException(status_code=429, detail="Too many failed sign-in attempts - try again in a minute",
                            headers={"Retry-After": str(int(wait + 0.999))})
    user = _user_by_email(conn, body.email)
    if not user or not user["active"] or not verify_password(body.password, user["password_hash"]):
        if _login_limit() > 0:
            login_limiter.record(f"email:{email}")
            login_limiter.record(f"ip:{ip}")
        raise HTTPException(status_code=401, detail="Invalid email or password",
                            headers={"WWW-Authenticate": "Bearer"})
    response = auth_response(user)
    log_action(conn, response["user"], "login", "user", user["id"])
    return response


@router.post("/demo-login", summary="Sign in as a seeded demo user (demo mode only)")
def demo_login(body: DemoLoginBody, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    if not get_settings().demo_mode:
        raise HTTPException(status_code=404, detail="Demo mode is disabled")
    sql = f"SELECT {_USER_COLUMNS} FROM users WHERE is_demo = 1 AND active = 1 AND role = ?"
    params: list = [body.role]
    if body.ministry_id:
        sql += " AND ministry_id = ?"
        params.append(body.ministry_id)
    user = row(conn, sql + " ORDER BY id LIMIT 1", params)
    if not user:
        raise HTTPException(status_code=404, detail=f"No demo user for role '{body.role}'"
                                                    + (f" and ministry '{body.ministry_id}'" if body.ministry_id else ""))
    response = auth_response(user)
    log_action(conn, response["user"], "login.demo", "user", user["id"], {"role": body.role})
    return response


@router.post("/register", summary="Create an industry account")
def register(body: RegisterBody, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    if _user_by_email(conn, body.email):
        raise HTTPException(status_code=400, detail="An account with this email already exists")
    organisation = (body.organisation or "").strip() or None
    try:
        cur = execute(conn, "INSERT INTO users (email, name, password_hash, role, ministry_id, organisation, "
                            "active, is_demo, created_at) VALUES (?, ?, ?, 'industry', NULL, ?, 1, 0, ?)",
                      (body.email, body.name, hash_password(body.password), organisation, utc_now()))
    except sqlite3.IntegrityError as exc:  # concurrent registration of the same email
        raise HTTPException(status_code=400, detail="An account with this email already exists") from exc
    user = row(conn, f"SELECT {_USER_COLUMNS} FROM users WHERE id = ?", (cur.lastrowid,))
    response = auth_response(user)
    log_action(conn, response["user"], "user.register", "user", user["id"], {"organisation": organisation})
    return response


@router.get("/me", summary="The signed-in user (or the public user)")
def me(user: dict = Depends(current_user)) -> dict:
    return user
