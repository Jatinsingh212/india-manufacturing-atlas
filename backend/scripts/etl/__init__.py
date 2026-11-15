"""ETL step modules. Each exposes run(conn) -> dict of stats; see docs/SPEC.md section 3.

Shared filesystem locations used by the step modules are defined here so every step
resolves the same raw/curated folders regardless of the current working directory.
"""
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BACKEND_DIR / "data"
RAW_DIR = DATA_DIR / "raw"
CURATED_DIR = DATA_DIR / "curated"
SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"

LATEST_YEAR = 2024          # meta.latest_year; partner/supplier files are for this year
FIRST_TREND_YEAR = 2018     # trade_hs6 series start (HS2017 files cover 2018-2021)
HS22_FIRST_YEAR = 2022      # from this year on the HS2022 files are used
INDIA = "asind"             # OEC country id of India
CHINA = "aschn"             # OEC country id of China
