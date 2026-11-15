"""Regression checks for the official DPIIT Guidebook extraction (16.12.2025 revision)."""
from __future__ import annotations

import json
import re
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
MAPPING = BACKEND_DIR / "data" / "curated" / "ministry_mapping.json"


def _load() -> dict:
    return json.loads(MAPPING.read_text(encoding="utf-8"))


def test_published_counts_and_page_coverage() -> None:
    data = _load()
    counts = data["counts"]
    assert counts == {
        "accepted_unique_codes": 11_679,
        "acceptances": 12_912,
        "multi_owner_codes": 1_217,
        "residual_codes": 495,
    }

    accepted = data["accepted"]
    residual = data["residual"]
    assert (min(r["page"] for r in accepted), max(r["page"] for r in accepted)) == (24, 429)
    assert (min(r["page"] for r in residual), max(r["page"] for r in residual)) == (430, 459)
    assert any(r["page"] == 24 for r in accepted)
    assert any(r["page"] == 450 for r in residual)
    assert data["_source"]["page_ranges"] == {"accepted": [24, 429], "residual": [430, 459]}


def test_residual_description_and_probable_ministry_are_separate() -> None:
    residual = _load()["residual"]
    assert len({r["hsn8"] for r in residual}) == len(residual) == 495

    for row in residual:
        assert row["description"].strip(), row
        assert row["probable_ministry"].strip(), row
        assert not re.search(r"\b(?:D/o|M/o)\b", row["description"], re.I), row
        assert not row["probable_ministry"].upper().startswith(("MENT", "MINISTRY", "PROBABLE")), row

    by_code = {r["hsn8"]: r for r in residual}
    assert by_code["09030000"] == {
        "hsn8": "09030000",
        "description": "MATE",
        "probable_ministry": "D/o Commerce",
        "page": 430,
    }
    assert by_code["12116000"]["description"] == "BARK OF AFRICAN CHERRY (PRUNUSAFRICANA)"
    assert by_code["12116000"]["probable_ministry"] == "M/o Ayush"
    assert by_code["12119015"]["probable_ministry"] == "D/o Agriculture and Farmers Welfare"
