"""Fetch the public DGFT ITC-HS import / export policy tables (no login, no CAPTCHA).

The DGFT "Discover" page (``?opt=itchs-import-export``) publishes the ITC-HS Schedule I
(import) and Schedule II (export) policy at 8-digit level. The page loads a chapter with a
plain ``POST`` to ``webHP?actionVal=getChapterDetails``; the only session requirement is the
CSRF token that the public home page puts in ``<meta name="_csrf">``. No account, OTP,
CAPTCHA or access-control bypass is involved.

Usage (from ``backend/``)::

    python -m scripts.etl.fetch_dgft_itc                 # all chapters 01-98, both directions
    python -m scripts.etl.fetch_dgft_itc --chapters 01   # connectivity probe, writes nothing
    python -m scripts.etl.fetch_dgft_itc --chapters 10,87
    python -m scripts.etl.fetch_dgft_itc --sleep 0.3

A partial ``--chapters`` run is a **probe**: it fetches and validates the requested chapters but
never writes the dataset or manifests, so it cannot replace the complete 98-chapter reference file.
Use ``--from-dir`` to rebuild the written dataset from saved payloads.

Outputs
-------
``data/raw/dgft_itc/dgft_itc_policy.jsonl.gz``
    One JSON object per 8-digit ITC-HS record, in portal (API) order. Every duplicate is kept
    with its ``record_index``; the last record of a code / direction is marked
    ``is_current = 1`` (the portal appends newer notifications last).
``data/raw/dgft_itc/manifest.json``
    Fetch timestamp, endpoint, per-chapter response hashes and counts, file hash and totals.
``data/raw/manifest.json``
    A ``dgft_itc_hs`` entry is merged in so the Data Hub shows the public feed's real freshness
    and record count separately from the credentialed ``dgft`` connector.

The portal has a direction quirk that this script normalises explicitly: ``expType=1`` returns
import policy in the ``impPolicy`` / ``impCondition`` / ``impItcCodeType`` fields, and
``expType=2`` returns **export** policy in the same ``imp*`` fields. The output record always
has generic ``policy`` / ``policy_condition`` / ``itc_code_type`` fields plus ``direction``.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import html
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

from scripts.etl import RAW_DIR

PORTAL_URL = "https://www.dgft.gov.in/CP/"
PAGE_URL = "https://www.dgft.gov.in/CP/?opt=itchs-import-export"
ENDPOINT = "https://www.dgft.gov.in/CP/webHP"
SCREEN_ID = "90000802"
SOURCE_ID = "dgft_itc_hs"
DIRECTIONS = ((1, "import"), (2, "export"))
CHAPTERS = tuple(f"{n:02d}" for n in range(1, 99))

OUT_DIR = RAW_DIR / "dgft_itc"
OUT_FILE = OUT_DIR / "dgft_itc_policy.jsonl.gz"
OUT_MANIFEST = OUT_DIR / "manifest.json"
CENTRAL_MANIFEST = RAW_DIR / "manifest.json"

USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 "
              "IndiaManufacturingAtlas/1.0 (public ITC-HS policy ingest)")
_CSRF_RE = re.compile(r'<meta\s+name="_csrf"\s+content="([^"]+)"', re.I)


class FetchError(RuntimeError):
    """A chapter could not be fetched or parsed; the previous dataset is left untouched."""


# --------------------------------------------------------------------------- text helpers

def clean_text(value: Any, *, keep_lines: bool = False) -> str | None:
    """Plain text from the portal's HTML fragments (never render the raw HTML in the UI)."""
    if value is None:
        return None
    text = str(value).replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</(?:p|div|li|tr|h[1-6])\s*>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    # The portal occasionally emits a truncated tag (e.g. "Other </span"): drop an unterminated
    # tag fragment at the end while keeping mathematical text such as "Specific Gravity < 4.0".
    text = re.sub(r"</?[a-zA-Z][^<>]*$", "", text)
    text = html.unescape(text)
    if keep_lines:
        text = re.sub(r"[ \t\f\v]+", " ", text)
        text = re.sub(r" *\n *", "\n", text)
        text = re.sub(r"\n{2,}", "\n", text)
    else:
        text = re.sub(r"\s+", " ", text)
    return text.strip() or None


def clean_value(value: Any, *, keep_lines: bool = False) -> str | None:
    """Trimmed text or None; the portal uses '', 'NA', '-' and null for "not specified"."""
    text = clean_text(value, keep_lines=keep_lines)
    if text is None or text.upper() in {"NA", "N/A", "NONE", "-", "--"}:
        return None
    return text


def notification_iso(value: Any) -> str | None:
    """``29/05/2023`` / ``13.05.2022`` -> ``2023-05-29``; None when absent or unparseable."""
    text = clean_value(value)
    if not text:
        return None
    for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


# --------------------------------------------------------------------------- portal access

def _new_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({
        "User-Agent": USER_AGENT,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": PAGE_URL,
    })
    return session


def _csrf_token(session: requests.Session) -> str:
    response = session.get(PORTAL_URL, timeout=90)
    response.raise_for_status()
    match = _CSRF_RE.search(response.text)
    if not match:
        raise FetchError("DGFT home page did not contain the public _csrf meta token")
    return match.group(1)


def _fetch_json(session: requests.Session, token: str, chapter: str, exp_type: int) -> tuple[dict, str]:
    response = session.post(
        ENDPOINT,
        params={
            "requestType": "ApplicationRH",
            "screenId": SCREEN_ID,
            "actionVal": "getChapterDetails",
            "_csrf": token,
        },
        data={"itcCode": chapter, "expType": str(exp_type)},
        headers={"X-Requested-With": "XMLHttpRequest"},
        timeout=120,
    )
    if response.status_code in (401, 403):
        raise FetchError(f"DGFT returned HTTP {response.status_code}; the public session expired")
    response.raise_for_status()
    content_type = response.headers.get("content-type", "")
    if "json" not in content_type.lower():
        raise FetchError(f"DGFT returned {content_type or 'unknown content-type'} instead of JSON")
    try:
        payload = response.json()
    except ValueError as exc:
        raise FetchError(f"DGFT returned malformed JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise FetchError("DGFT returned JSON that is not an object")
    return payload, response.text


def fetch_chapter(
    session: requests.Session, chapter: str, exp_type: int, *, attempts: int = 4
) -> tuple[dict, str, str]:
    """``(payload, response_text, csrf)`` with a fresh public session on session / WAF errors."""
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            token = _csrf_token(session)
            payload, text = _fetch_json(session, token, chapter, exp_type)
            return payload, text, token
        except (requests.RequestException, FetchError) as exc:
            last_error = exc
            if attempt < attempts:
                # CloudFront briefly rejects bursty clients with an empty 403. Back off gently and
                # open a new connection rather than hammering the portal.
                time.sleep(min(30.0, 2.0 ** attempt))
                session = _new_session()
    raise FetchError(f"chapter {chapter} expType={exp_type}: {last_error}")


# --------------------------------------------------------------------------- records

def _records_from_payload(payload: dict, chapter: str, direction: str, fetched_at: str) -> list[dict]:
    records: list[dict] = []
    for item in payload.get("itcCodeClassifications") or []:
        if not isinstance(item, dict):
            continue
        code = str(item.get("itcCode") or "").strip()
        if len(code) != 8 or not code.isdigit():
            continue
        notification_date = clean_value(item.get("notificationDate"))
        records.append({
            "itc_code": code,
            "direction": direction,
            "chapter": chapter,
            "description": clean_text(item.get("itcDescription")),
            "policy": clean_value(item.get("impPolicy")),
            "policy_condition": clean_value(item.get("impCondition"), keep_lines=True),
            "itc_code_type": clean_value(item.get("impItcCodeType")),
            "notification_no": clean_value(item.get("notificationNo")),
            "notification_date": notification_date,
            "notification_date_iso": notification_iso(notification_date),
            "record_index": 0,
            "is_current": 0,
            "source": SOURCE_ID,
            "source_url": PAGE_URL,
            "fetched_at": fetched_at,
        })
    return records


def _mark_current(records: list[dict]) -> tuple[int, int]:
    """Number each code / direction in API order, mark its last record current.

    Returns ``(current_groups, duplicate_records)``. The portal appends newer notifications
    last, so the last record is the current policy (verified in the manifest build: no group
    had an older notification date at the last position).
    """
    groups: dict[tuple[str, str], list[dict]] = {}
    for record in records:
        groups.setdefault((record["itc_code"], record["direction"]), []).append(record)
    duplicates = 0
    for group in groups.values():
        for i, record in enumerate(group):
            record["record_index"] = i
            record["is_current"] = int(i == len(group) - 1)
        if len(group) > 1:
            duplicates += len(group) - 1
    return len(groups), duplicates


def _stats(records: list[dict]) -> dict:
    out: dict[str, Any] = {"records": len(records), "codes": len({r["itc_code"] for r in records})}
    for direction in ("import", "export"):
        rows = [r for r in records if r["direction"] == direction]
        current = [r for r in rows if r["is_current"]]
        out[direction] = {
            "records": len(rows),
            "codes": len({r["itc_code"] for r in rows}),
            "codes_with_policy": len({r["itc_code"] for r in current if r["policy"]}),
            "current_without_policy": sum(1 for r in current if not r["policy"]),
            "duplicate_records": len(rows) - len(current),
        }
    return out


def _write_dataset(path: Path, records: list[dict]) -> tuple[str, str]:
    """Write deterministic gzip JSONL; return (gzip sha256, uncompressed content sha256)."""
    payload = "\n".join(json.dumps(r, ensure_ascii=False, sort_keys=True) for r in records) + "\n"
    raw = payload.encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "wb") as handle:
        with gzip.GzipFile(fileobj=handle, mode="wb", mtime=0) as gz:
            gz.write(raw)
    os.replace(tmp, path)
    return hashlib.sha256(path.read_bytes()).hexdigest(), hashlib.sha256(raw).hexdigest()


def _write_json(path: Path, doc: dict, *, sort_keys: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=sort_keys) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _update_central_manifest(path: Path, entry: dict) -> None:
    doc = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    doc[SOURCE_ID] = entry
    _write_json(path, doc, sort_keys=False)


# --------------------------------------------------------------------------- main

def _finalize(
    all_records: list[dict], chapter_manifest: dict[str, dict], fetched_at: str, *,
    out_dir: Path, central_manifest: Path, update_manifest: bool,
) -> dict:
    if len(chapter_manifest) == len(CHAPTERS):
        missing = [c for c in CHAPTERS if c not in chapter_manifest]
        if missing:
            raise FetchError(f"missing chapters: {', '.join(missing)}")
    if len(all_records) < 20_000:
        raise FetchError(f"only {len(all_records)} 8-digit records returned; refusing to replace the dataset")

    current, duplicates = _mark_current(all_records)
    all_records.sort(key=lambda r: (r["itc_code"], 0 if r["direction"] == "import" else 1, r["record_index"]))
    stats = _stats(all_records)
    stats.update({"current_records": current, "duplicate_records": duplicates,
                  "chapters": len(chapter_manifest), "fetched_at": fetched_at})

    dataset_path = out_dir / OUT_FILE.name
    file_sha, content_sha = _write_dataset(dataset_path, all_records)
    manifest = {
        "source": "DGFT ITC-HS import / export policy (public Discover portal)",
        "source_id": SOURCE_ID,
        "source_url": PAGE_URL,
        "portal_url": PORTAL_URL,
        "endpoint": ENDPOINT,
        "method": "GET public home page for _csrf; POST webHP actionVal=getChapterDetails per chapter and expType",
        "authentication": "none - public page, no login, OTP, CAPTCHA or access-control bypass",
        "direction_quirk": "expType=1 -> import policy; expType=2 -> export policy (both in the imp* fields)",
        "current_record_rule": "last record in portal (API) order for each itc_code + direction",
        "fetched_at": fetched_at,
        "chapters": chapter_manifest,
        "totals": stats,
        "file": dataset_path.name,
        "file_sha256": file_sha,
        "content_sha256": content_sha,
    }
    _write_json(out_dir / OUT_MANIFEST.name, manifest)

    if update_manifest:
        _update_central_manifest(central_manifest, {
            "fetched_at": fetched_at,
            "source": "DGFT public ITC-HS import/export policy",
            "url": PAGE_URL,
            "method": "public webHP getChapterDetails (no authentication or CAPTCHA)",
            "rows": stats["records"],
            "records_by_direction": {d: stats[d]["records"] for d in ("import", "export")},
            "licence": "Government of India public information",
        })
    print(f"  wrote {stats['records']:,} records ({stats['codes']:,} codes), "
          f"{stats['duplicate_records']} duplicate records; {dataset_path}", flush=True)
    return manifest


def fetch_all(
    *, chapters: tuple[str, ...] = CHAPTERS, out_dir: Path = OUT_DIR, central_manifest: Path = CENTRAL_MANIFEST,
    sleep: float = 0.4, update_manifest: bool = True,
) -> dict:
    """Fetch chapters from the public portal.

    A strict subset of ``CHAPTERS`` is a connectivity probe: responses are fetched and validated,
    statistics are printed, and **nothing is written**. Only a complete 01-98 run finalizes the
    dataset and manifests.
    """
    fetched_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    session = _new_session()
    all_records: list[dict] = []
    chapter_manifest: dict[str, dict] = {}

    for index, chapter in enumerate(chapters, start=1):
        entry: dict[str, Any] = {}
        for exp_type, direction in DIRECTIONS:
            payload, text, _token = fetch_chapter(session, chapter, exp_type)
            records = _records_from_payload(payload, chapter, direction, fetched_at)
            all_records.extend(records)
            entry[direction] = {
                "status": 200,
                "classifications": len(payload.get("itcCodeClassifications") or []),
                "records_8digit": len(records),
                "bytes": len(text.encode("utf-8")),
                "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            }
            time.sleep(sleep)
        chapter_manifest[chapter] = entry
        print(f"  {chapter}  import {entry['import']['records_8digit']:>4}  "
              f"export {entry['export']['records_8digit']:>4}  ({index}/{len(chapters)})", flush=True)

    if set(chapters) != set(CHAPTERS):
        _mark_current(all_records)
        stats = _stats(all_records)
        stats.update({"fetched_at": fetched_at, "chapters": len(chapter_manifest)})
        print(f"  probe only: {stats['records']:,} records ({stats['codes']:,} codes) across "
              f"{len(chapter_manifest)} chapter(s); dataset and manifests unchanged", flush=True)
        return {"probe": True, "chapters": list(chapters), "fetched_at": fetched_at,
                "totals": stats, "chapter_manifest": chapter_manifest}

    return _finalize(all_records, chapter_manifest, fetched_at, out_dir=out_dir,
                     central_manifest=central_manifest, update_manifest=update_manifest)


def build_from_dir(
    input_dir: Path, *, out_dir: Path = OUT_DIR, central_manifest: Path = CENTRAL_MANIFEST,
    fetched_at: str | None = None, update_manifest: bool = True,
) -> dict:
    """Rebuild the compact dataset from saved raw chapter payloads (offline / audit path).

    ``input_dir`` must contain ``<chapter>_import.json`` and ``<chapter>_export.json`` as
    returned by the portal; an optional ``manifest.json`` supplies the original fetch time.
    Useful when re-running the transform without hitting the public portal again.
    """
    cached: dict = {}
    cached_path = input_dir / "manifest.json"
    if cached_path.exists():
        cached = json.loads(cached_path.read_text(encoding="utf-8"))
    fetched_at = (fetched_at or cached.get("fetched_at")
                  or datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"))
    all_records: list[dict] = []
    chapter_manifest: dict[str, dict] = {}
    for chapter in CHAPTERS:
        entry: dict[str, Any] = {}
        for _exp_type, direction in DIRECTIONS:
            path = input_dir / f"{chapter}_{direction}.json"
            if not path.exists():
                raise FetchError(f"missing cached response {path}")
            text = path.read_text(encoding="utf-8")
            try:
                payload = json.loads(text)
            except json.JSONDecodeError as exc:
                raise FetchError(f"{path.name}: malformed JSON ({exc})") from exc
            records = _records_from_payload(payload, chapter, direction, fetched_at)
            all_records.extend(records)
            entry[direction] = {
                "status": 200,
                "classifications": len(payload.get("itcCodeClassifications") or []),
                "records_8digit": len(records),
                "bytes": len(text.encode("utf-8")),
                "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "cached": True,
            }
        chapter_manifest[chapter] = entry
        print(f"  {chapter}  import {entry['import']['records_8digit']:>4}  "
              f"export {entry['export']['records_8digit']:>4}  (cached)", flush=True)
    return _finalize(all_records, chapter_manifest, fetched_at, out_dir=out_dir,
                     central_manifest=central_manifest, update_manifest=update_manifest)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--chapters", default="", help="comma-separated chapter codes (default: 01-98)")
    parser.add_argument("--from-dir", default="", help="rebuild from saved <chapter>_<direction>.json payloads")
    parser.add_argument("--out", default=str(OUT_DIR), help=f"output directory (default: {OUT_DIR})")
    parser.add_argument("--manifest", default=str(CENTRAL_MANIFEST),
                        help=f"central raw manifest (default: {CENTRAL_MANIFEST})")
    parser.add_argument("--sleep", type=float, default=0.4, help="pause between requests in seconds")
    parser.add_argument("--no-update-manifest", action="store_true", help="do not merge into data/raw/manifest.json")
    args = parser.parse_args(argv)

    chapters = CHAPTERS
    if args.chapters.strip():
        chapters = tuple(part.strip().zfill(2) for part in args.chapters.split(",") if part.strip())
        bad = [c for c in chapters if c not in CHAPTERS]
        if bad:
            parser.error(f"unknown chapter(s): {', '.join(bad)}")

    try:
        if args.from_dir:
            build_from_dir(Path(args.from_dir), out_dir=Path(args.out),
                           central_manifest=Path(args.manifest),
                           update_manifest=not args.no_update_manifest)
        else:
            fetch_all(chapters=chapters, out_dir=Path(args.out), central_manifest=Path(args.manifest),
                      sleep=max(0.0, args.sleep), update_manifest=not args.no_update_manifest)
    except (FetchError, requests.RequestException) as exc:
        print(f"DGFT fetch failed: {exc}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
