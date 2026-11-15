"""Shared plumbing for the Data Hub refresh connectors (docs/SPEC.md section 6.11): integrate APIs from CBIC, GSTN, DGFT
and trade databases, with automated refresh cycles.

A connector is a small object with

* ``name``       connector id (``oec``, ``comtrade``, ``wits``, ``cbic``, ``gstn``, ``dgft``),
* ``source_id``  the ``data_sources.id`` row it refreshes (``oec_baci``, ``un_comtrade``, ``wits_trains`` ...),
* ``title``      human-readable name,
* ``is_configured() -> (bool, message)`` - False when credentials / env vars are missing (the refresh then ends
  immediately with status ``not_configured`` and the message names what is needed),
* ``run(conn, progress) -> ConnectorResult`` - does the work on a connection owned by the refresh thread;
  ``progress(text)`` records a status line on the job row. It raises :class:`ConnectorError` (or any exception)
  on failure; the caller marks the job ``failed`` and never commits a half-written refresh.

HTTP goes through :func:`http_get` / :func:`http_get_json` only (retries with exponential backoff, a descriptive
User-Agent, explicit timeouts) - tests replace these two functions to keep the suite offline. Connectors only
ever *download* public data; nothing from the Atlas database is sent anywhere.
"""
from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

import requests

log = logging.getLogger("atlas.connectors")

USER_AGENT = "IndiaManufacturingAtlas/1.0 (Data Hub refresh connector; contact: platform admin)"
DEFAULT_TIMEOUT_S = 120
DEFAULT_TRIES = 4

Progress = Callable[[str], None]


class ConnectorError(RuntimeError):
    """A refresh failed (bad response, unexpected payload, sanity check failed)."""


@dataclass
class ConnectorResult:
    """Outcome of a successful (or not-configured) refresh."""

    records: int
    message: str
    status: str = "success"                 # 'success' | 'not_configured'
    source_records: int | None = None       # new ``data_sources.records`` (None = keep the current value)
    source_status: str | None = None        # new ``data_sources.status`` (None = 'connected' on success)
    details: dict[str, Any] = field(default_factory=dict)


class Connector(Protocol):
    """Interface every connector module implements (see module docstring)."""

    name: str
    source_id: str
    title: str

    def is_configured(self) -> tuple[bool, str]: ...

    def run(self, conn, progress: Progress) -> ConnectorResult: ...


def http_get(url: str, params: dict | None = None, *, timeout: float = DEFAULT_TIMEOUT_S,
             tries: int = DEFAULT_TRIES, headers: dict | None = None) -> requests.Response:
    """GET with retries on network errors, HTTP 429 and 5xx (exponential backoff: 1, 2, 4 ... s).

    Raises :class:`ConnectorError` after the last attempt or immediately on another 4xx.
    """
    merged = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    merged.update(headers or {})
    last: Exception | None = None
    for attempt in range(max(1, tries)):
        try:
            response = requests.get(url, params=params, headers=merged, timeout=timeout)
        except requests.RequestException as exc:
            last = exc
        else:
            if response.status_code == 200:
                return response
            if response.status_code != 429 and response.status_code < 500:
                raise ConnectorError(f"HTTP {response.status_code} from {url}: {response.text[:300]}")
            last = ConnectorError(f"HTTP {response.status_code} from {url}: {response.text[:200]}")
            retry_after = response.headers.get("retry-after")
            if retry_after and retry_after.isdigit():
                time.sleep(min(int(retry_after), 30))
                continue
        if attempt < tries - 1:
            time.sleep(2 ** attempt)
    raise ConnectorError(f"GET {url} failed after {tries} attempts: {last}")


def http_get_json(url: str, params: dict | None = None, *, timeout: float = DEFAULT_TIMEOUT_S,
                  tries: int = DEFAULT_TRIES, headers: dict | None = None) -> Any:
    """:func:`http_get` + JSON decoding (a non-JSON body raises :class:`ConnectorError`)."""
    response = http_get(url, params, timeout=timeout, tries=tries, headers=headers)
    try:
        return response.json()
    except ValueError as exc:
        raise ConnectorError(f"{url} did not return JSON: {response.text[:200]}") from exc


def fmt_usd(value: float | None) -> str:
    """Compact US$ for job messages (``$454.8 bn``)."""
    if value is None:
        return "n/a"
    for div, unit in ((1e12, "tn"), (1e9, "bn"), (1e6, "mn")):
        if abs(value) >= div:
            return f"${value / div:.1f} {unit}"
    return f"${value:,.0f}"


def no_progress(_text: str) -> None:
    """Progress callback that ignores updates (direct / test runs)."""


__all__ = ["Connector", "ConnectorError", "ConnectorResult", "Progress", "USER_AGENT", "http_get",
           "http_get_json", "fmt_usd", "no_progress"]
