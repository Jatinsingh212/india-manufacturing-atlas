"""Run Data Hub connectors from the command line (daily sync, cron / Windows Task Scheduler).

Usage (run from ``backend/``)::

    python -m scripts.refresh_sources                          # cluster_observatory + market_tariffs + iilb
    python -m scripts.refresh_sources cluster_observatory wits
    python -m scripts.refresh_sources --db C:/tmp/atlas.db --all

Each connector runs as a normal refresh job (``refresh_jobs`` row, ``data_sources`` status, audit log), exactly as
when an admin presses Refresh in the Data Hub, and writes its raw cache under ``data/raw`` so the next full
``python -m scripts.build_db`` keeps the data. A not-configured connector (IILB without a token) is reported and
skipped. Exit code 1 when any job failed.
"""
from __future__ import annotations

import argparse
import sys

from app.db import connect
from app.services import connectors
from app.services.audit import utc_now
from scripts.build_db import default_db_path

DAILY = ("cluster_observatory", "market_tariffs", "iilb")


def refresh(db_path, names) -> int:
    failed = 0
    for name in names:
        connector = connectors.REGISTRY.get(name) or connectors.connector_for(name)
        if connector is None:
            print(f"{name}: unknown connector (known: {', '.join(connectors.REGISTRY)})")
            failed += 1
            continue
        configured, message = connector.is_configured()
        if not configured:
            print(f"{connector.name}: not configured - {message}")
            continue
        conn = connect(db_path)
        try:
            cur = conn.execute("INSERT INTO refresh_jobs (source_id, started_at, status, records, message, "
                               "triggered_by) VALUES (?, ?, 'running', NULL, 'scheduled refresh', NULL)",
                               (connector.source_id, utc_now()))
            conn.commit()
            job_id = cur.lastrowid
        finally:
            conn.close()
        print(f"{connector.name}: running (job {job_id}) ...", flush=True)
        result = connectors.run_job(db_path, job_id, connector.name, {"id": None, "email": "scheduler"})
        if result is None:
            conn = connect(db_path)
            try:
                print(f"{connector.name}: FAILED - {connectors.get_job(conn, job_id)['message']}")
            finally:
                conn.close()
            failed += 1
        else:
            print(f"{connector.name}: {result.status} - {result.message}")
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("connectors", nargs="*", help=f"connector names (default: {' '.join(DAILY)})")
    parser.add_argument("--all", action="store_true", help="every registered connector")
    parser.add_argument("--db", default=None, help="database path (default: data/atlas.db)")
    args = parser.parse_args(argv)
    names = list(connectors.REGISTRY) if args.all else (args.connectors or list(DAILY))
    return refresh(args.db or default_db_path(), names)


if __name__ == "__main__":
    sys.exit(main())
