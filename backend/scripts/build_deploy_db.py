"""Build the slim database bundled with the serverless deployment (Vercel).

``python -m scripts.build_deploy_db`` (from backend/, after ``python -m scripts.build_db``) writes
``data/deploy/atlas.db``:

1. a copy of ``data/atlas.db`` made with the SQLite backup API;
2. **precomputed residual suggestions** - the TF-IDF ministry suggestion for every residual line is stored in
   ``residual_suggestions`` so the deployed API does not need scikit-learn / scipy (about 140 MB of wheels);
3. **pruned partner tables** - ``world_suppliers``, ``world_markets`` and ``india_partners`` keep every row a page
   reads: the top :data:`KEEP_RANK` countries of each product, India's own row, every row of the countries in
   India's trade agreements (negotiation analysis) and every row of the products in the curated value chains
   (sector KPIs aggregate all countries). Dropped rows are the long tail of small flows;
4. no audit log, then ``VACUUM`` and a rebuild of the full-text index (``products`` has implicit rowids, which
   VACUUM may renumber).

The local full database is untouched.
"""
from __future__ import annotations

import gzip
import json
import shutil
import sqlite3
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
SRC = BACKEND / "data" / "atlas.db"
DST = BACKEND / "data" / "deploy" / "atlas.db"
KEEP_RANK = 25
SUGGESTION_LIMIT = 10


def _partner_countries(conn: sqlite3.Connection) -> set[str]:
    out: set[str] = set()
    for (partners,) in conn.execute("SELECT partners_json FROM trade_agreements"):
        out.update(json.loads(partners or "[]"))
    for (ids,) in conn.execute("SELECT country_ids_json FROM markets"):   # deep-dive export markets
        out.update(json.loads(ids or "[]"))
    return out


def _chain_hs6(conn: sqlite3.Connection) -> set[str]:
    prefixes = {r[0] for r in conn.execute("SELECT anchor_hs FROM value_chains")}
    prefixes |= {r[0] for r in conn.execute("SELECT hs_code FROM vc_items WHERE hs_code IS NOT NULL")}
    hs6 = [r[0] for r in conn.execute("SELECT hs6 FROM hs6_products")]
    return {h for h in hs6 if any(h.startswith(p[:6]) for p in prefixes if p)}


def _precompute_suggestions(conn: sqlite3.Connection) -> int:
    from app.db import _dict_factory
    from app.services import suggest  # needs scikit-learn: only on the build machine

    conn.row_factory = _dict_factory  # the app's helpers expect dict rows
    conn.execute("DROP TABLE IF EXISTS residual_suggestions")
    conn.execute("CREATE TABLE residual_suggestions (hsn8 TEXT PRIMARY KEY, payload_json TEXT NOT NULL)")
    codes = [r["hsn8"] for r in conn.execute(
        "SELECT hsn8 FROM products WHERE mapping_status = 'residual' ORDER BY hsn8")]
    done = 0
    for code in codes:
        result = suggest.suggest_ministries(conn, code, limit=SUGGESTION_LIMIT)
        if result is not None:
            conn.execute("INSERT INTO residual_suggestions VALUES (?, ?)",
                         (code, json.dumps(result, ensure_ascii=False, default=str)))
            done += 1
    conn.commit()
    conn.row_factory = None
    return done


def _prune(conn: sqlite3.Connection, keep_countries: set[str], keep_hs6: set[str]) -> dict:
    conn.execute("CREATE TEMP TABLE keep_c (id TEXT PRIMARY KEY)")
    conn.executemany("INSERT INTO keep_c VALUES (?)", [(c,) for c in keep_countries | {"asind"}])
    conn.execute("CREATE TEMP TABLE keep_h (hs6 TEXT PRIMARY KEY)")
    conn.executemany("INSERT INTO keep_h VALUES (?)", [(h,) for h in keep_hs6])
    stats = {}
    for table in ("world_suppliers", "world_markets", "india_partners"):
        before = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        conn.execute(f"""DELETE FROM {table}
                         WHERE rank > ? AND country_id NOT IN (SELECT id FROM keep_c)
                           AND hs6 NOT IN (SELECT hs6 FROM keep_h)""", (KEEP_RANK,))
        stats[table] = (before, conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
    conn.execute("DELETE FROM audit_log")
    conn.commit()
    return stats


def main() -> int:
    if not SRC.is_file():
        print(f"missing {SRC} - run python -m scripts.build_db first")
        return 1
    sys.path.insert(0, str(BACKEND))
    DST.parent.mkdir(parents=True, exist_ok=True)
    tmp = DST.with_suffix(".db.tmp")
    tmp.unlink(missing_ok=True)
    t0 = time.time()
    src = sqlite3.connect(SRC)
    dst = sqlite3.connect(tmp)
    src.backup(dst)
    src.close()
    dst.execute("PRAGMA journal_mode=DELETE")
    n_sugg = _precompute_suggestions(dst)
    stats = _prune(dst, _partner_countries(dst), _chain_hs6(dst))
    dst.execute("VACUUM")
    from scripts.etl.nomenclature import rebuild_fts
    rebuild_fts(dst)
    dst.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('deploy_build', ?)",
                (json.dumps({"built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "keep_rank": KEEP_RANK,
                             "residual_suggestions": n_sugg, "pruned": stats}),))
    dst.commit()
    n_fts = dst.execute("SELECT COUNT(*) FROM products_fts").fetchone()[0]
    n_products = dst.execute("SELECT COUNT(*) FROM products").fetchone()[0]
    dst.close()
    if n_fts != n_products:
        print(f"FTS rows {n_fts} != products {n_products}")
        return 1
    tmp.replace(DST)
    # The function bundle ships the gzip (about a third of the size); api/index.py unpacks it to /tmp on cold start.
    gz = DST.with_suffix(".db.gz")
    with open(DST, "rb") as f, gzip.open(gz, "wb", compresslevel=6) as g:
        shutil.copyfileobj(f, g, 1 << 20)
    print(f"residual suggestions precomputed: {n_sugg}")
    for table, (before, after) in stats.items():
        print(f"{table:16s} {before:>8,} -> {after:>8,} rows")
    print(f"wrote {DST} ({DST.stat().st_size / 1e6:.1f} MB) and {gz.name} ({gz.stat().st_size / 1e6:.1f} MB) "
          f"in {time.time() - t0:.0f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
