"""ETL step 12 - operational seed data: demo users, data-source registry, sample helpdesk tickets,
sample residual claims and the real, sourced production figures.

Reads ``data/curated/ops_seed.json`` (owner: B2) and writes

* ``users``            - one demo account per role (admin, ministry x2 [mot, dpiit], analyst, industry), all
                         ``is_demo=1``. Passwords are hashed exactly as docs/SPEC.md section 5 requires:
                         ``pbkdf2_sha256$200000$<salt_hex>$<hash_hex>`` with a 16-byte random salt and
                         ``hashlib.pbkdf2_hmac('sha256', pw.encode(), bytes.fromhex(salt_hex), 200000).hex()``.
                         (Implemented locally on purpose - the ETL must not import ``app.*``.)
* ``data_sources``     - the connector registry shown in the Data Hub. ``last_refreshed`` / ``records`` are
                         computed at seed time from ``data/raw/manifest.json`` (by key list or key prefix);
                         sources missing from the manifest fall back to the source file's modification time
                         and a ``COUNT(*)`` over the table the ETL loaded from it. ``not_configured`` sources
                         (CBIC, GSTN and the credentialed DGFT connector) get no refresh time or record count;
                         the public DGFT ITC-HS feed (``dgft_itc_hs``) is a separate connected source. A source
                         seeded as ``connected`` that has no refresh time and no records (a live connector that has
                         never run, e.g. UN Comtrade before its first refresh job) is stored as
                         ``not_refreshed`` - the status is derived from the evidence, never a constant.
* ``tickets`` / ``ticket_messages`` - sample industry queries on real 8-digit codes. ``routed_ministry_id`` is
                         the product's primary ministry from ``products`` (``residual`` -> ``dpiit``, as the
                         helpdesk API routes it); tickets on codes missing from ``products`` are skipped.
* ``residual_claims``  - 2-3 *pending* claims on actual residual products chosen at run time: the plausible
                         owner is the most common primary ministry among accepted lines of the same HS4
                         heading (else HS2 chapter); chapters 98/99 are excluded.
* ``production``       - real chain-level production figures from UNIDO INDSTAT 2026, the Rubber Board
                         and ATMA (``data/curated/production.json``). A row is skipped when the same
                         scope/key/label or the same value already exists.

``run(conn) -> dict`` is idempotent: users are matched by email (existing password hashes are kept),
data sources are upserted by id, tickets are matched by (hsn8, subject), claims by (hsn8, ministry_id)
and production rows as described above.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parents[2]
SEED_PATH = BACKEND_DIR / "data" / "curated" / "ops_seed.json"
PRODUCTION_PATH = BACKEND_DIR / "data" / "curated" / "production.json"
MANIFEST_PATH = BACKEND_DIR / "data" / "raw" / "manifest.json"

PBKDF2_ITERATIONS = 200_000
SALT_BYTES = 16
ROLES = ("admin", "ministry", "analyst", "industry")
SOURCE_KINDS = ("api", "file", "manual")
SOURCE_STATUSES = ("connected", "not_refreshed", "not_configured", "error")
TICKET_CATEGORIES = ("classification", "tariff", "policy_support", "trade_remedy", "other")
TICKET_STATUSES = ("open", "in_progress", "resolved")
_IDENT_RE = re.compile(r"^[a-z_][a-z0-9_]*$")
_COUNT_SQL_RE = re.compile(r"^\s*SELECT\s+(COUNT|MAX)\s*\(", re.IGNORECASE)


# --------------------------------------------------------------------------- password hashing

def hash_password(password: str, salt_hex: str | None = None, iterations: int = PBKDF2_ITERATIONS) -> str:
    """Return ``pbkdf2_sha256$<iterations>$<salt_hex>$<hash_hex>`` (SPEC section 5)."""
    salt_hex = salt_hex or os.urandom(SALT_BYTES).hex()
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), iterations).hex()
    return f"pbkdf2_sha256${iterations}${salt_hex}${digest}"


def verify_password(password: str, stored: str) -> bool:
    """Check ``password`` against a hash produced by :func:`hash_password` (used by the tests)."""
    try:
        algo, iterations, salt_hex, digest = stored.split("$")
    except ValueError:
        return False
    if algo != "pbkdf2_sha256":
        return False
    candidate = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), int(iterations)).hex()
    return hmac.compare_digest(candidate, digest)


# --------------------------------------------------------------------------- small helpers

def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _scalar(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> Any:
    row = conn.execute(sql, params).fetchone()
    return None if row is None else row[0]


class _SafeDict(dict):
    """``str.format_map`` mapping that leaves unknown placeholders untouched."""

    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


def _fill(template: str, values: dict) -> str:
    return template.format_map(_SafeDict(values))


def _load_manifest(path: Path) -> dict:
    if path.exists():
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return {}


# --------------------------------------------------------------------------- users

def _seed_users(conn: sqlite3.Connection, users: list[dict], password: str, ministry_ids: set[str]) -> dict:
    inserted = updated = 0
    errors = []
    for u in users:
        if u.get("role") not in ROLES:
            errors.append(f"user {u.get('email')}: role {u.get('role')!r} not in {ROLES}")
        mid = u.get("ministry_id")
        if u.get("role") == "ministry" and mid not in ministry_ids:
            errors.append(f"user {u.get('email')}: ministry user needs a known ministry_id, got {mid!r}")
        elif mid is not None and mid not in ministry_ids:
            errors.append(f"user {u.get('email')}: unknown ministry_id {mid!r}")
    if errors:
        raise ValueError("seed_ops: invalid users:\n  - " + "\n  - ".join(errors))

    for u in users:
        email = u["email"].strip().lower()
        existing = _scalar(conn, "SELECT id FROM users WHERE lower(email) = ?", (email,))
        if existing is None:
            conn.execute(
                "INSERT INTO users (email, name, password_hash, role, ministry_id, organisation, active, is_demo, "
                "created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
                (email, u["name"], hash_password(password), u["role"], u.get("ministry_id"), u.get("organisation"),
                 int(u.get("is_demo", 1)), _now()),
            )
            inserted += 1
        else:  # keep the stored password hash; refresh the descriptive fields
            conn.execute(
                "UPDATE users SET name = ?, role = ?, ministry_id = ?, organisation = ?, is_demo = ?, active = 1 "
                "WHERE id = ?",
                (u["name"], u["role"], u.get("ministry_id"), u.get("organisation"), int(u.get("is_demo", 1)),
                 existing),
            )
            updated += 1
    return {"users_inserted": inserted, "users_updated": updated}


def _user_ids(conn: sqlite3.Connection) -> tuple[dict, dict, int | None]:
    """Return ({email: (id, name, role)}, {ministry_id: (id, name, role)} for ministry users, admin id)."""
    by_email: dict[str, tuple] = {}
    by_ministry: dict[str, tuple] = {}
    admin = None
    for uid, email, name, role, mid in conn.execute(
            "SELECT id, lower(email), name, role, ministry_id FROM users WHERE active = 1 "
            "ORDER BY is_demo DESC, id"):
        by_email[email] = (uid, name, role)
        if role == "ministry" and mid and mid not in by_ministry:
            by_ministry[mid] = (uid, name, role)
        if role == "admin" and admin is None:
            admin = (uid, name, role)
    return by_email, by_ministry, admin


# --------------------------------------------------------------------------- data sources

def _source_stats(conn: sqlite3.Connection, src: dict, manifest: dict) -> tuple[str | None, int | None]:
    """Compute (last_refreshed, records) for one registry row (see module docstring)."""
    if src.get("status") not in ("connected", "not_refreshed"):
        return None, None

    keys = list(src.get("manifest_keys") or [])
    prefix = src.get("manifest_prefix")
    if prefix:
        keys += [k for k in manifest if k.startswith(prefix)]
    entries = [manifest[k] for k in dict.fromkeys(keys) if k in manifest]

    last_refreshed = max((e["fetched_at"] for e in entries if e.get("fetched_at")), default=None)
    rows = [int(e["rows"]) for e in entries if isinstance(e.get("rows"), (int, float))]
    records: int | None = sum(rows) if rows else None

    if last_refreshed is None and src.get("refreshed_sql"):
        if not _COUNT_SQL_RE.match(src["refreshed_sql"]):
            raise ValueError(f"seed_ops: refreshed_sql of {src['id']} must be a SELECT MAX(...) query")
        last_refreshed = _scalar(conn, src["refreshed_sql"])
    if last_refreshed is None and src.get("file"):
        path = (BACKEND_DIR / src["file"]).resolve()
        if path.exists():
            last_refreshed = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")

    if records is None:
        count = None
        if src.get("records_sql"):
            if not _COUNT_SQL_RE.match(src["records_sql"]):
                raise ValueError(f"seed_ops: records_sql of {src['id']} must be a SELECT COUNT(...) query")
            count = _scalar(conn, src["records_sql"])
        elif src.get("records_table"):
            table = src["records_table"]
            if not _IDENT_RE.match(table):
                raise ValueError(f"seed_ops: bad records_table {table!r}")
            count = _scalar(conn, f"SELECT COUNT(*) FROM {table}")  # noqa: S608 - validated identifier
        records = int(count) if count else None
    return last_refreshed, records


def _seed_sources(conn: sqlite3.Connection, sources: list[dict], manifest: dict) -> int:
    for s in sources:
        if s.get("kind") not in SOURCE_KINDS or s.get("status") not in SOURCE_STATUSES:
            raise ValueError(f"seed_ops: data source {s.get('id')}: bad kind/status {s.get('kind')}/{s.get('status')}")
        last_refreshed, records = _source_stats(conn, s, manifest)
        status = s["status"]
        if status in ("connected", "not_refreshed"):
            status = "connected" if last_refreshed else "not_refreshed"
        conn.execute(
            "INSERT INTO data_sources (id, name, owner, kind, status, last_refreshed, records, url, licence, "
            "description, refresh_cron) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET name=excluded.name, owner=excluded.owner, kind=excluded.kind, "
            "status=excluded.status, last_refreshed=excluded.last_refreshed, records=excluded.records, "
            "url=excluded.url, licence=excluded.licence, description=excluded.description, "
            "refresh_cron=excluded.refresh_cron",
            (s["id"], s["name"], s.get("owner"), s["kind"], status, last_refreshed, records, s.get("url"),
             s.get("licence"), s.get("description"), s.get("refresh_cron")),
        )
    return len(sources)


# --------------------------------------------------------------------------- tickets

def _ministry_names(conn: sqlite3.Connection) -> dict[str, tuple[str, str]]:
    return {mid: (short, name) for mid, short, name in conn.execute("SELECT id, short_name, name FROM ministries")}


def _seed_tickets(conn: sqlite3.Connection, tickets: list[dict]) -> dict:
    by_email, by_ministry, admin = _user_ids(conn)
    ministries = _ministry_names(conn)
    stats = {"tickets_inserted": 0, "tickets_existing": 0, "tickets_skipped_missing_code": 0, "ticket_messages": 0}

    for t in tickets:
        if t.get("category") not in TICKET_CATEGORIES or t.get("status") not in TICKET_STATUSES:
            raise ValueError(f"seed_ops: ticket {t.get('subject')!r}: bad category/status")
        row = conn.execute("SELECT ministry_id, description FROM products WHERE hsn8 = ?", (t["hsn8"],)).fetchone()
        if row is None:
            stats["tickets_skipped_missing_code"] += 1
            continue
        if _scalar(conn, "SELECT id FROM tickets WHERE hsn8 = ? AND subject = ?", (t["hsn8"], t["subject"])):
            stats["tickets_existing"] += 1
            continue

        owner, description = row
        routed = owner if owner and owner != "residual" else "dpiit"
        short, name = ministries.get(routed, (routed, routed))
        values = {"hsn8": t["hsn8"], "description": description, "ministry_short": short, "ministry_name": name}

        submitter = by_email.get((t.get("submitter") or "").lower())
        cur = conn.execute(
            "INSERT INTO tickets (hsn8, subject, body, category, submitter_name, submitter_org, submitter_email, "
            "submitted_by, routed_ministry_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (t["hsn8"], t["subject"], _fill(t["body"], values), t["category"], t.get("submitter_name"),
             t.get("submitter_org"), t.get("submitter_email"), submitter[0] if submitter else None, routed,
             t["status"], t["created_at"], t.get("updated_at") or t["created_at"]),
        )
        ticket_id = cur.lastrowid
        stats["tickets_inserted"] += 1

        for m in t.get("messages") or []:
            kind = m.get("author", "submitter")
            if kind == "submitter":
                author = submitter
                author_name = t.get("submitter_name") or (submitter[1] if submitter else "Guest")
                author_role = submitter[2] if submitter else "public"
            elif kind == "routed_ministry":
                author = by_ministry.get(routed) or admin
                author_name = author[1] if author else f"{short} helpdesk"
                author_role = author[2] if author else "ministry"
            elif kind == "admin":
                author = admin
                author_name = admin[1] if admin else "Atlas helpdesk"
                author_role = "admin"
            else:
                raise ValueError(f"seed_ops: ticket {t['subject']!r}: unknown message author {kind!r}")
            conn.execute(
                "INSERT INTO ticket_messages (ticket_id, author_id, author_name, author_role, body, ts) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (ticket_id, author[0] if author else None, author_name, author_role, _fill(m["body"], values), m["ts"]),
            )
            stats["ticket_messages"] += 1
    return stats


# --------------------------------------------------------------------------- residual claims

def _plausible_owner(conn: sqlite3.Connection, hs4: str, hs2: str) -> tuple[str, int] | None:
    """Most common primary ministry among accepted lines of the same heading (else chapter)."""
    for col, code in (("hs4", hs4), ("hs2", hs2)):
        row = conn.execute(
            f"SELECT ministry_id, COUNT(*) AS n FROM products WHERE {col} = ? AND mapping_status = 'accepted' "  # noqa: S608
            "AND ministry_id <> 'residual' GROUP BY ministry_id ORDER BY n DESC, ministry_id LIMIT 1",
            (code,),
        ).fetchone()
        if row:
            return row[0], int(row[1])
    return None


def _seed_claims(conn: sqlite3.Connection, cfg: dict) -> dict:
    count = int(cfg.get("count", 3))
    exclude = tuple(cfg.get("exclude_chapters") or ())
    prefer = list(cfg.get("prefer_ministries") or [])
    dates = list(cfg.get("created_at") or [])
    template = cfg.get("justification_template") or "{ministry_name} requests ownership of {hsn8}."
    status = cfg.get("status", "pending")

    candidates = []  # (hsn8, hs4, hs2, description, owner, n_siblings) in hsn8 order
    for hsn8, hs4, hs2, description in conn.execute(
            "SELECT hsn8, hs4, hs2, description FROM products WHERE mapping_status = 'residual' ORDER BY hsn8"):
        if hs2 in exclude:
            continue
        owner = _plausible_owner(conn, hs4, hs2)
        if owner:
            candidates.append((hsn8, hs4, hs2, description, owner[0], owner[1]))

    chosen: list[tuple] = []
    for mid in prefer:  # one claim per preferred ministry (these have demo ministry users)
        pick = next((c for c in candidates if c[4] == mid and c not in chosen), None)
        if pick and len(chosen) < count:
            chosen.append(pick)
    for c in candidates:  # top up with other ministries, one claim each
        if len(chosen) >= count:
            break
        if c[4] not in {x[4] for x in chosen}:
            chosen.append(c)
    for c in candidates:  # still short (few owners): any remaining candidate
        if len(chosen) >= count:
            break
        if c not in chosen:
            chosen.append(c)

    _, by_ministry, admin = _user_ids(conn)
    ministries = _ministry_names(conn)
    inserted = existing = 0
    for i, (hsn8, hs4, hs2, description, mid, n_siblings) in enumerate(chosen):
        if _scalar(conn, "SELECT id FROM residual_claims WHERE hsn8 = ? AND ministry_id = ?", (hsn8, mid)):
            existing += 1
            continue
        short, name = ministries.get(mid, (mid, mid))
        hs4_desc = _scalar(conn, "SELECT description FROM hs_nodes WHERE code = ?", (hs4,)) or ""
        justification = _fill(template, {"ministry_name": name, "ministry_short": short, "n_siblings": n_siblings,
                                         "hs4": hs4, "hs4_description": hs4_desc, "hsn8": hsn8,
                                         "description": description}).replace(" ()", "")
        claimant = by_ministry.get(mid) or admin
        conn.execute(
            "INSERT INTO residual_claims (hsn8, ministry_id, claimed_by, justification, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (hsn8, mid, claimant[0] if claimant else None, justification, status,
             dates[i] if i < len(dates) else _now()),
        )
        inserted += 1
    return {"residual_claims_inserted": inserted, "residual_claims_existing": existing,
            "residual_claim_codes": [c[0] for c in chosen]}


# --------------------------------------------------------------------------- production

def _seed_production(conn: sqlite3.Connection, rows: list[dict]) -> dict:
    inserted = skipped = 0
    for r in rows:
        value = r.get("value")
        dup = conn.execute(
            "SELECT id FROM production WHERE scope = ? AND key = ? AND (lower(coalesce(label, '')) = lower(?) "
            "OR (? IS NOT NULL AND value IS NOT NULL AND abs(value - ?) <= 1e-6 * abs(?)))",
            (r["scope"], r["key"], r.get("label") or "", value, value, value),
        ).fetchone()
        if dup:
            skipped += 1
            continue
        conn.execute(
            "INSERT INTO production (scope, key, label, year, value, unit, source, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (r["scope"], r["key"], r.get("label"), r.get("year"), value, r.get("unit"), r["source"], r["status"]),
        )
        inserted += 1
    return {"production_inserted": inserted, "production_skipped_existing": skipped}


# --------------------------------------------------------------------------- entry point

def run(conn: sqlite3.Connection, seed_path: Path | str | None = None, manifest_path: Path | str | None = None) -> dict:
    """Seed users, data sources, tickets, residual claims and real production figures; returns stats.

    ``seed_path`` / ``manifest_path`` default to the curated seed file and ``data/raw/manifest.json``.
    """
    with open(Path(seed_path) if seed_path else SEED_PATH, encoding="utf-8") as f:
        seed = json.load(f)
    manifest = _load_manifest(Path(manifest_path) if manifest_path else MANIFEST_PATH)
    ministry_ids = {r[0] for r in conn.execute("SELECT id FROM ministries")}
    password = seed.get("demo_password")
    if not password:
        raise ValueError("seed_ops: ops_seed.json has no demo_password")

    stats: dict[str, Any] = {}
    with conn:  # one transaction for the whole seed
        stats.update(_seed_users(conn, seed.get("users", []), password, ministry_ids))
        stats["data_sources"] = _seed_sources(conn, seed.get("data_sources", []), manifest)
        stats.update(_seed_tickets(conn, seed.get("tickets", [])))
        stats.update(_seed_claims(conn, seed.get("residual_claims") or {}))
        # Real production figures live in production.json.
        if not PRODUCTION_PATH.exists():
            raise FileNotFoundError(f"seed_ops: {PRODUCTION_PATH} is missing")
        production_doc = json.loads(PRODUCTION_PATH.read_text(encoding="utf-8"))
        production_rows = production_doc.get("rows") or []
        conn.execute("DELETE FROM production WHERE source = 'playbook'")  # legacy cleanup only
        stats.update(_seed_production(conn, production_rows))
    return stats


if __name__ == "__main__":  # manual run against an existing database: python -m scripts.etl.seed_ops [db]
    import sys

    db = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("ATLAS_DB", str(BACKEND_DIR / "data" / "atlas.db"))
    c = sqlite3.connect(db)
    try:
        print(run(c))
    finally:
        c.close()
