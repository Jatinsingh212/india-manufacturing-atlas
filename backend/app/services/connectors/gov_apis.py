"""``cbic``, ``gstn`` and ``dgft`` connectors - credentialed Government of India data feeds.

None of these feeds is public: each needs an access arrangement with the owning organisation and credentials
issued to the platform. Until those exist the connectors are registered but **not configured** - a refresh ends
immediately with job status ``not_configured`` and a message naming the environment variables to set:

=========  ==================================  =====================================================================
Connector  Environment variables               What the feed provides once onboarded
=========  ==================================  =====================================================================
cbic       ``ATLAS_CBIC_API_KEY``,             Basic Customs Duty, AIDC / SWS and duty notifications per 8-digit
           ``ATLAS_CBIC_API_URL``              tariff line (CBIC Customs Tariff / ICEGATE)
gstn       ``ATLAS_GSTN_API_KEY``,             Aggregated HSN-wise outward supplies from GST returns (a domestic
           ``ATLAS_GSTN_API_URL``              production / consumption signal; aggregated, non-identifiable)
dgft       ``ATLAS_DGFT_API_KEY``,             Official trade data and authenticated DGFT feeds (the public
           ``ATLAS_DGFT_API_URL``              ITC-HS policy pages are ingested separately, see below)
=========  ==================================  =====================================================================

The public DGFT ITC-HS import / export policy tables are **not** fetched through this connector. They are
public web pages with no login or CAPTCHA; ``scripts/etl/fetch_dgft_itc.py`` retrieves them with the page's
own CSRF token and they are loaded into ``dgft_itc_policy`` as the separate ``dgft_itc_hs`` source.

When both variables are set the refresh performs an authenticated **connectivity probe** (``GET <url>`` with
``Authorization: Bearer <key>``; the key is never logged or stored) and reports whether the endpoint answered.
No records are ingested: the field mapping of each feed is agreed during onboarding, and the Atlas never invents
a schema for it. Nothing from the Atlas database is sent in the probe.
"""
from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass

from app.services.connectors import base
from app.services.connectors.base import ConnectorError, ConnectorResult, Progress


@dataclass(frozen=True)
class GovApiConnector:
    """A credentialed feed that stays ``not_configured`` until its env vars are set."""

    name: str
    source_id: str
    title: str
    owner: str
    provides: str

    @property
    def key_var(self) -> str:
        return f"ATLAS_{self.name.upper()}_API_KEY"

    @property
    def url_var(self) -> str:
        return f"ATLAS_{self.name.upper()}_API_URL"

    def required_env(self) -> list[str]:
        return [self.key_var, self.url_var]

    def is_configured(self) -> tuple[bool, str]:
        missing = [v for v in self.required_env() if not (os.environ.get(v) or "").strip()]
        if missing:
            return False, (f"{self.title} is not configured. It needs an access arrangement with {self.owner} and "
                           f"API credentials: set {' and '.join(missing)} on the server, then refresh again. "
                           f"Once onboarded it provides {self.provides}.")
        return True, "credentials present"

    def run(self, conn: sqlite3.Connection, progress: Progress) -> ConnectorResult:  # noqa: ARG002 - interface
        configured, message = self.is_configured()
        if not configured:
            return ConnectorResult(records=0, message=message, status="not_configured",
                                   source_status="not_configured",
                                   details={"required_env": self.required_env()})
        url = os.environ[self.url_var].strip()
        progress(f"probing {self.title} endpoint")
        try:
            response = base.http_get(url, headers={"Authorization": f"Bearer {os.environ[self.key_var].strip()}"},
                                     timeout=30, tries=2)
        except ConnectorError as exc:
            raise ConnectorError(f"{self.title}: credentials are set but the endpoint probe failed ({exc}). "
                                 "Check the URL / key with the data owner.") from exc
        return ConnectorResult(
            records=0, source_status="connected",
            message=(f"{self.title}: endpoint reachable with the configured credentials (HTTP "
                     f"{response.status_code}). No records ingested - the feed's field mapping is set up during "
                     f"onboarding with {self.owner}."),
            details={"http_status": response.status_code})


cbic = GovApiConnector(
    name="cbic", source_id="cbic", title="CBIC Customs Tariff / ICEGATE",
    owner="the Central Board of Indirect Taxes and Customs (CBIC / ICEGATE)",
    provides="Basic Customs Duty, AIDC / SWS and duty notifications per 8-digit tariff line")
gstn = GovApiConnector(
    name="gstn", source_id="gstn", title="GSTN HSN-wise supply data",
    owner="the Goods and Services Tax Network (GSTN)",
    provides="aggregated, non-identifiable HSN-wise outward supplies from GST returns")
dgft = GovApiConnector(
    name="dgft", source_id="dgft", title="DGFT credentialed trade API",
    owner="the Directorate General of Foreign Trade (DGFT)",
    provides=("official 8-digit trade data and authenticated DGFT feeds (the public ITC-HS policy tables "
              "are ingested separately as dgft_itc_hs)"))

CONNECTORS = (cbic, gstn, dgft)
