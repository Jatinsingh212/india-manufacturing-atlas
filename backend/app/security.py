"""Authentication and role-based access control (docs/SPEC.md section 5).

* Passwords: ``pbkdf2_sha256$<iterations>$<salt_hex>$<hash_hex>`` - ``hashlib.pbkdf2_hmac('sha256', ...)``,
  200 000 iterations, 16-byte random salt (the same format ``scripts/etl/seed_ops.py`` writes).
* Tokens: HS256 JWT built with ``hmac`` / ``hashlib`` / ``base64`` only (PyJWT is not usable on this machine).
  Header ``{"alg":"HS256","typ":"JWT"}``; claims ``sub`` (user id as str), ``email``, ``role``, ``ministry_id``,
  ``name``, ``iat``, ``exp`` (12 h). Secret = ``ATLAS_JWT_SECRET`` (development default + warning).
* Roles: ``public`` (anonymous), ``industry``, ``analyst``, ``ministry`` (scoped to ``users.ministry_id``), ``admin``.

FastAPI dependencies
--------------------
``current_user``         the signed-in user as a ``User`` dict, or :data:`PUBLIC_USER` when there is no (valid)
                         token. Never raises: a public endpoint keeps working with a stale token. The token is
                         re-checked against ``users`` (must exist and be active) and role / ministry come from
                         the database, so deactivating a user or changing a role takes effect immediately.
``require_user``         any signed-in user; 401 otherwise (detail says whether the token expired / is invalid).
``require_roles(*roles)`` 401 when anonymous, 403 when the role is not listed. ``admin`` always passes
                         ("admin: everything", SPEC section 5).
``require_gov``          shorthand for ``require_roles(*GOV_ROLES)``.

``can_access_ministry(user, ministry_id)`` answers ministry-scoped *write* checks (claims, ticket replies, uploads):
admin -> any ministry; ministry user -> only ``users.ministry_id``; everyone else -> no.

The returned user dict always has the SPEC ``User`` keys ``{id, email, name, role, ministry_id, organisation}``.

``RateLimiter`` is the in-process sliding-window limiter shared by the login endpoint (failed attempts per
account and per client address -> 429) and the assistant (requests per client); ``client_ip(request)`` is the
key it uses for a client.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sqlite3
import threading
import time
from collections import deque
from collections.abc import Callable
from typing import Any

from fastapi import Depends, HTTPException, Request

from app.config import get_settings
from app.db import get_db, row

PBKDF2_ITERATIONS = 200_000
SALT_BYTES = 16
ROLES = ("public", "industry", "analyst", "ministry", "admin")
USER_ROLES = ("industry", "analyst", "ministry", "admin")
GOV_ROLES = ("analyst", "ministry", "admin")


class RateLimiter:
    """Sliding one-minute window per key (in-process; enough for a single API worker).

    ``check(key, limit)`` records a hit and returns None when allowed, else the seconds until a slot frees;
    ``peek(key, limit)`` answers the same question without recording; ``record(key)`` records a hit (used to
    count only *failed* logins); ``reset()`` forgets everything (tests).
    """

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _prune(self, key: str, now: float, window_s: float) -> deque:
        hits = self._hits.setdefault(key, deque())
        while hits and now - hits[0] >= window_s:
            hits.popleft()
        return hits

    def _forget_idle(self, now: float, window_s: float) -> None:
        if len(self._hits) > 10_000:  # forget idle clients so the table cannot grow without bound
            for stale in [k for k, v in self._hits.items() if not v or now - v[-1] >= window_s]:
                self._hits.pop(stale, None)

    def peek(self, key: str, limit: int, window_s: float = 60.0) -> float | None:
        if limit <= 0:
            return None
        now = time.monotonic()
        with self._lock:
            hits = self._prune(key, now, window_s)
            if len(hits) >= limit:
                return max(1.0, window_s - (now - hits[0]))
            return None

    def record(self, key: str, window_s: float = 60.0) -> None:
        now = time.monotonic()
        with self._lock:
            self._prune(key, now, window_s).append(now)
            self._forget_idle(now, window_s)

    def check(self, key: str, limit: int, window_s: float = 60.0) -> float | None:
        """Record a hit for ``key``; return None when allowed, else the seconds until the next free slot."""
        if limit <= 0:
            return None
        now = time.monotonic()
        with self._lock:
            hits = self._prune(key, now, window_s)
            if len(hits) >= limit:
                return max(1.0, window_s - (now - hits[0]))
            hits.append(now)
            self._forget_idle(now, window_s)
            return None

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


def client_ip(request: Request) -> str:
    """The client address a limiter keys on (the direct peer; proxies are not trusted for X-Forwarded-For)."""
    client = getattr(request, "client", None)
    return (client.host if client and client.host else None) or "unknown"

PUBLIC_USER: dict[str, Any] = {
    "id": None, "email": None, "name": None, "role": "public", "ministry_id": None, "organisation": None,
}

_JWT_HEADER = {"alg": "HS256", "typ": "JWT"}


class TokenError(ValueError):
    """A JWT could not be verified (bad format, bad signature, expired)."""


# --------------------------------------------------------------------------- passwords

def hash_password(password: str, *, iterations: int = PBKDF2_ITERATIONS, salt_hex: str | None = None) -> str:
    """Hash ``password`` as ``pbkdf2_sha256$<iterations>$<salt_hex>$<hash_hex>``."""
    salt_hex = salt_hex or os.urandom(SALT_BYTES).hex()
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), iterations).hex()
    return f"pbkdf2_sha256${iterations}${salt_hex}${digest}"


def verify_password(password: str, stored: str | None) -> bool:
    """Constant-time check of ``password`` against a :func:`hash_password` string (False on any malformed hash)."""
    if not stored or not isinstance(password, str):
        return False
    try:
        algo, iterations, salt_hex, digest = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        candidate = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt_hex),
                                        int(iterations)).hex()
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(candidate, digest)


# --------------------------------------------------------------------------- JWT (HS256)

def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def _sign(signing_input: bytes, secret: str) -> str:
    return _b64url_encode(hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest())


def encode_jwt(claims: dict, secret: str | None = None) -> str:
    """Encode ``claims`` as a compact HS256 JWT."""
    secret = secret or get_settings().jwt_secret
    header = _b64url_encode(json.dumps(_JWT_HEADER, separators=(",", ":")).encode())
    payload = _b64url_encode(json.dumps(claims, separators=(",", ":"), default=str).encode())
    signing_input = f"{header}.{payload}".encode("ascii")
    return f"{header}.{payload}.{_sign(signing_input, secret)}"


def decode_jwt(token: str, secret: str | None = None, *, now: float | None = None) -> dict:
    """Verify signature, algorithm and ``exp``; return the claims. Raises :class:`TokenError`."""
    secret = secret or get_settings().jwt_secret
    try:
        header_b64, payload_b64, signature = token.split(".")
        header = json.loads(_b64url_decode(header_b64))
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise TokenError("malformed token") from exc
    if not isinstance(header, dict) or header.get("alg") != "HS256":
        raise TokenError("unsupported token algorithm")
    expected = _sign(f"{header_b64}.{payload_b64}".encode("ascii"), secret)
    if not hmac.compare_digest(expected, signature):
        raise TokenError("invalid token signature")
    try:
        claims = json.loads(_b64url_decode(payload_b64))
    except (ValueError, json.JSONDecodeError) as exc:
        raise TokenError("malformed token payload") from exc
    if not isinstance(claims, dict):
        raise TokenError("malformed token payload")
    exp = claims.get("exp")
    if not isinstance(exp, (int, float)):
        raise TokenError("token has no expiry")
    if (now if now is not None else time.time()) >= exp:
        raise TokenError("token expired")
    return claims


def create_access_token(user: dict, *, expires_in_s: int | None = None) -> str:
    """Token for a user dict (``id``, ``email``, ``role``, ``ministry_id``, ``name``); 12 h by default."""
    settings = get_settings()
    now = int(time.time())
    ttl = expires_in_s if expires_in_s is not None else settings.jwt_expiry_hours * 3600
    claims = {
        "sub": str(user["id"]),
        "email": user.get("email"),
        "role": user.get("role"),
        "ministry_id": user.get("ministry_id"),
        "name": user.get("name"),
        "iat": now,
        "exp": now + ttl,
    }
    return encode_jwt(claims, settings.jwt_secret)


# --------------------------------------------------------------------------- user dicts

def user_public(user_row: dict | None) -> dict:
    """The SPEC ``User`` shape for a ``users`` row (never includes ``password_hash``); public user for None."""
    if not user_row:
        return dict(PUBLIC_USER)
    return {
        "id": user_row.get("id"),
        "email": user_row.get("email"),
        "name": user_row.get("name"),
        "role": user_row.get("role") or "public",
        "ministry_id": user_row.get("ministry_id"),
        "organisation": user_row.get("organisation"),
    }


def auth_response(user_row: dict) -> dict:
    """``{access_token, token_type: "bearer", user: User}`` for a ``users`` row."""
    user = user_public(user_row)
    return {"access_token": create_access_token(user), "token_type": "bearer", "user": user}


def _bearer_token(request: Request) -> str | None:
    header = request.headers.get("authorization") or ""
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None
    return token.strip()


def user_from_token(conn: sqlite3.Connection, token: str) -> dict:
    """Resolve a bearer token to an active user (``User`` dict). Raises :class:`TokenError`."""
    claims = decode_jwt(token)
    try:
        user_id = int(claims.get("sub"))
    except (TypeError, ValueError) as exc:
        raise TokenError("token has no valid subject") from exc
    db_user = row(conn, "SELECT id, email, name, role, ministry_id, organisation, active FROM users WHERE id = ?",
                  (user_id,))
    if not db_user:
        raise TokenError("user no longer exists")
    if not db_user.get("active"):
        raise TokenError("user is deactivated")
    return user_public(db_user)


# --------------------------------------------------------------------------- dependencies

def current_user(request: Request, conn: sqlite3.Connection = Depends(get_db)) -> dict:
    """Signed-in user or :data:`PUBLIC_USER` (never raises; the token problem is kept for ``require_user``)."""
    token = _bearer_token(request)
    request.state.auth_error = None
    if not token:
        return dict(PUBLIC_USER)
    try:
        return user_from_token(conn, token)
    except TokenError as exc:
        request.state.auth_error = str(exc)
        return dict(PUBLIC_USER)


def _unauthorized(request: Request) -> HTTPException:
    reason = getattr(request.state, "auth_error", None)
    detail = f"Not authenticated: {reason}" if reason else "Not authenticated - sign in first"
    return HTTPException(status_code=401, detail=detail, headers={"WWW-Authenticate": "Bearer"})


def require_user(request: Request, user: dict = Depends(current_user)) -> dict:
    """Any signed-in user; 401 for anonymous callers or invalid / expired tokens."""
    if user.get("role") == "public" or user.get("id") is None:
        raise _unauthorized(request)
    return user


def require_roles(*roles: str) -> Callable[..., dict]:
    """Dependency factory: 401 when anonymous, 403 when the user's role is not in ``roles`` (admin always passes).

    Example: ``@router.get(..., dependencies=[Depends(require_roles(*GOV_ROLES))])`` or
    ``user: dict = Depends(require_roles("ministry", "admin"))``.
    """
    allowed = frozenset(roles) | {"admin"}
    unknown = set(roles) - set(ROLES)
    if unknown:
        raise ValueError(f"unknown role(s) {sorted(unknown)}; roles are {ROLES}")

    def dependency(request: Request, user: dict = Depends(current_user)) -> dict:
        if user.get("role") == "public" or user.get("id") is None:
            raise _unauthorized(request)
        if user.get("role") not in allowed:
            raise HTTPException(status_code=403,
                                detail=f"Forbidden - requires role: {', '.join(sorted(allowed))}")
        return user

    dependency.__name__ = f"require_roles_{'_'.join(sorted(allowed))}"
    return dependency


#: Shorthand dependency for government-only endpoints (analyst, ministry, admin).
require_gov = require_roles(*GOV_ROLES)
#: Shorthand dependency for admin-only endpoints.
require_admin = require_roles("admin")


def is_gov(user: dict | None) -> bool:
    """True for analyst / ministry / admin users."""
    return bool(user) and user.get("role") in GOV_ROLES


def can_access_ministry(user: dict | None, ministry_id: str | None) -> bool:
    """Ministry-scoped write access: admin -> any ministry; ministry user -> own ministry only; else False."""
    if not user or not ministry_id:
        return False
    role = user.get("role")
    if role == "admin":
        return True
    return role == "ministry" and user.get("ministry_id") == ministry_id
