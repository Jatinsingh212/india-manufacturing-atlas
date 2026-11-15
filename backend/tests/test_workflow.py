"""Product workflow (app.routers.workflow): every chain builds, trade leads with the 8-digit line, flags are right."""
from __future__ import annotations

import pytest

from app.routers.workflow import market_flags

STEPS = ("product", "made_by", "inputs", "competition", "standards", "markets", "watch_outs")


def test_picker_lists_every_chain_with_products(client):
    chains = client.get("/api/workflow").json()
    assert {"sports_goods", "bicycles", "fishing_gear", "sporting_firearms", "tyre"} <= {c["id"] for c in chains}
    assert all(c["products"] for c in chains)


@pytest.mark.parametrize("chain", ["sports_goods", "bicycles", "fishing_gear", "sporting_firearms", "tyre", "steel"])
def test_every_step_is_present(client, chain):
    r = client.get(f"/api/workflow/{chain}")
    assert r.status_code == 200
    body = r.json()
    assert all(k in body for k in STEPS)
    assert body["product"]["hs_code"] in {p["hs_code"] for p in body["products"]}
    assert body["markets"] and all("duty_on_india" in m for m in body["markets"])


def test_cricket_bats_use_the_national_line(client):
    p = client.get("/api/workflow/sports_goods?product=95069920").json()["product"]
    assert p["trade_level"] == "hsn8" and p["exports"] > p["imports"]           # bats: a clear net exporter
    assert p["tax"]["gst"] is None and p["tax"]["import_duty_bcd"] is not None  # GST not guessed


def test_inputs_mark_what_feeds_the_product(client):
    inputs = client.get("/api/workflow/sports_goods?product=95069920").json()["inputs"]
    direct = {i["name"] for s in inputs["stages"] for i in s["items"] if i["feeds_product"] == 1}
    assert "Willow timber" in direct
    assert inputs["summary"]["imported"] >= 1


def test_unknown_product_404(client):
    assert client.get("/api/workflow/sports_goods?product=01012100").status_code == 404
    assert client.get("/api/workflow/no_such_chain").status_code == 404


def test_market_flags():
    us = {"name": "United States"}
    penalty = market_flags({"duty": 16.9, "mfn_rate": 1.9, "india_exports_to_market": 5e6, "rca": 0.7}, us)
    assert [f["kind"] for f in penalty] == ["tariff_penalty", "margin_risk"]
    assert penalty[0]["severity"] == "high"
    assert market_flags({"duty": 0.0, "mfn_rate": 5.0, "rca": 0.5}, {"name": "UAE"}) == []   # agreement advantage
    strong = market_flags({"duty": 12.0, "mfn_rate": 12.0, "rca": 2.5}, {"name": "X"})
    assert strong == []                                       # competitive and no penalty: no margin flag
    assert market_flags({"duty": None, "mfn_rate": None, "rca": None}, us) == []
