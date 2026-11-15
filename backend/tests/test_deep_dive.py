"""Product deep-dive: Cluster Observatory parsing, cluster HS mapping, markets and export-readiness scoring.

Offline parser tests use a fixture shaped like ``gl_sme.php`` output; API tests run on the built database and
check the 9506 (sports goods) pilot: 6-digit subheadings, 8-digit lines, clusters, standards and readiness.
"""
from __future__ import annotations

import json

from app.services.connectors import deep_dive as dd

PAGE = """<div id="list_detail">
<div class="row" id="head"><div class="srno1">Sr No.</div><div class="cl_name">Cluster Name</div></div>
<div class="row" id="">
        <div class="srno1">1</div>
        <div class="cl_name">Anantnag Cricket Bats </div>
        <div class="locationid">Jammu &amp; Kashmir</div>
        <div class="locationid">Sports Goods</div>
        <div class="detail"><a href="cluster/0283%20-%20Anantnag%20Cricket%20Bats.pdf" download>Download PDF</a></div></div>
<div class="row" id="">
        <div class="srno1">2</div>
        <div class="cl_name">Jalandhar Sports Goods </div>
        <div class="locationid">Punjab</div>
        <div class="locationid">Sports Goods</div>
        <div class="detail"><span style="color:#6c757d">N/A</span></div></div>
</div>"""


def test_parse_cluster_page():
    rows = dd.parse_cluster_page(PAGE, "industrial")
    assert [r["name"] for r in rows] == ["Anantnag Cricket Bats", "Jalandhar Sports Goods"]
    assert rows[0]["state"] == "Jammu & Kashmir" and rows[0]["products"] == "Sports Goods"
    assert rows[0]["profile_url"] == "https://www.clusterobservatory.in/cluster/0283%20-%20Anantnag%20Cricket%20Bats.pdf"
    assert rows[1]["profile_url"] is None


def test_cluster_hs_mapping_refines_by_name():
    curated = dd.load_curated()
    rows = {r[1]: r for r in dd.cluster_rows(dd.parse_cluster_page(PAGE, "industrial"), curated, "2026-11-04")}
    assert json.loads(rows["Anantnag Cricket Bats"][8]) == ["95069920"]       # name keyword beats the label
    assert json.loads(rows["Jalandhar Sports Goods"][8]) == ["9506"]
    assert rows["Jalandhar Sports Goods"][9] is not None                       # curated coordinates


def test_iilb_uses_public_report_without_token(monkeypatch):
    monkeypatch.delenv("ATLAS_IILB_ACCESS_TOKEN", raising=False)
    assert not dd.iilb.api_configured()
    ok, message = dd.iilb.is_configured()
    assert ok == ("park report" in message)                      # Playwright present -> public park report mode
    assert dd.iilb_hmac("tok", "21") == __import__("hashlib").sha256(b"tok21").hexdigest()
    row = dd.report_park_row({"park_id": "7", "park_name": "Meerut IMLC", "state": "UTTAR PRADESH", "district": "Meerut",
                              "sector": "Mixed", "total_area_ha": "300.0", "available_area_ha": "213.895"}, "2026-11-04")
    assert row[0] == "7" and row[3] == "Uttar Pradesh" and row[7] == 213.895


def test_overview_9506(client):
    d = client.get("/api/deep-dive/9506").json()
    assert d["heading"]["code"] == "9506" and d["kpis"]["n_subheadings"] == 17 and d["kpis"]["n_lines"] == 34
    assert {s["hs6"] for s in d["subheadings"]} >= {"950662", "950669", "950699"}
    assert sum(len(s["lines"]) for s in d["subheadings"]) == 34
    assert {"QCO", "ISI", "Hallmark"} <= {s["scheme"] for s in d["standards"] if s["market_id"] == "in"}
    assert d["value_chains"] and d["value_chains"][0]["id"] == "sports_goods"
    names = [c["name"] for c in d["clusters"]]
    assert len(names) == len(set(n.split()[0] for n in names))                  # no curated duplicates
    assert d["land"]["status"] in ("not_configured", "connected", "not_refreshed", "error")


def test_readiness_scores_and_what_if(client):
    base = client.get("/api/deep-dive/9506/readiness", params={"market": "us"}).json()
    hike = client.get("/api/deep-dive/9506/readiness", params={"market": "us", "extra_duty": 50}).json()
    assert {c["market_id"] for c in base["cells"]} == {"us"} and len(base["cells"]) == 17
    by = {c["hs6"]: c for c in base["cells"]}
    for c in base["cells"]:
        if c["score"] is not None:
            assert 0 <= c["score"] <= 100
        if c["capped"]:
            assert c["band"] == "not_ready" and c["rca"] < 0.1
    tariffs_known = [h for h in hike["cells"] if h["duty"] is not None and by[h["hs6"]]["duty"] is not None]
    for h in tariffs_known:
        assert h["duty"] >= by[h["hs6"]]["duty"] and h["score"] <= by[h["hs6"]]["score"]


def test_unknown_heading_404(client):
    assert client.get("/api/deep-dive/0000").status_code == 404
    assert client.get("/api/deep-dive/95").status_code == 422


def test_market_update_requires_admin(module_mutable_client, admin_headers):
    body = {"agreement": None, "pref_rate_pct": None, "extra_duty_pct": 25, "extra_duty_status": "verified",
            "extra_duty_basis": "test", "source": "test", "as_of": "2026-11-04", "note": None}
    assert module_mutable_client.patch("/api/deep-dive/markets/us", json=body).status_code == 401
    r = module_mutable_client.patch("/api/deep-dive/markets/us", json=body, headers=admin_headers)
    assert r.status_code == 200 and r.json()["market"]["extra_duty_pct"] == 25


STUDY_CODES = ("950691 871200 950699 950639 950629 950631 950662 930400 950790 950710 950730 950611 950632 950659 "
               "930330 950670 930320 950669 950420 950612 950619 950640 950661 950720 950651 950810 950621 950890").split()


def test_sports_equipment_basket_matches_study(client):
    d = client.get("/api/deep-dive/sports_equipment").json()
    assert d["kind"] == "basket" and [s["hs6"] for s in d["subheadings"]] == STUDY_CODES
    assert d["kpis"]["n_headings"] == 7
    assert abs(d["kpis"]["study_world_exports"] - 52.3e9) < 0.1e9                # the study's US$ 52 bn total
    old = next(s for s in d["subheadings"] if s["hs6"] == "950890")
    assert old["note"] and old.get("world_trade") is None and old["lines"] == []   # HS 2017 code: no data, no guess
    assert {"9303", "871200"} <= {s["hs_prefix"] for s in d["standards"]}


def test_basket_readiness_skips_codes_without_trade(client):
    r = client.get("/api/deep-dive/sports_equipment/readiness", params={"market": "eu"}).json()
    cells = {c["hs6"]: c for c in r["cells"]}
    assert len(cells) == 28 and cells["950890"]["score"] is None
    assert cells["871200"]["duty"] is not None and cells["871200"]["duty"] > 10   # EU bicycle MFN is double-digit


def test_basket_clusters_cover_new_headings(client):
    d = client.get("/api/deep-dive/sports_equipment").json()
    prefixes = {c["name"]: c["hs_prefixes"] for c in d["clusters"]}
    assert "871200" in prefixes["Ludhiana Bicycle"] and prefixes["Barjora Fishing Hooks"] == ["950720"]
    assert prefixes["Munger Gun"] == ["9303"]
    linked = {s["hs6"] for s in d["subheadings"] if s["clusters"]}
    assert {"871200", "950720"} <= linked


def test_infer_district_from_name():
    assert dd.infer_district("Munger Gun", ["Mung", "Munger"]) == "Munger"
    assert dd.infer_district("South Andaman Coir", ["Andaman"]) is None


def test_clusters_have_districts_and_input_neighbours(client):
    d = client.get("/api/deep-dive/sports_equipment").json()
    by = {c["name"]: c for c in d["clusters"]}
    assert by["Jalandhar Sports Goods"]["district"] == "Jalandhar"
    assert by["Barjora Fishing Hooks"]["district"] == "Bankura"
    jal_inputs = {n["name"] for n in by["Jalandhar Sports Goods"]["nearby"] if n["inputs"]}
    assert {"Jalandhar Rubber", "Jalandhar Leather"} <= jal_inputs


def test_new_chains_and_scoped_inputs(client):
    d = client.get("/api/deep-dive/sports_equipment").json()
    assert {"sports_goods", "bicycles", "fishing_gear", "sporting_firearms"} <= {v["id"] for v in d["value_chains"]}
    by = {c["name"]: c for c in d["clusters"]}
    ludhiana = {n["name"] for n in by["Ludhiana Bicycle"]["nearby"] if n["inputs"]}
    assert "Ludhiana Industrial Fastners" in ludhiana
    shuttle_items = {i["item"] for n in by["Uluberia Shuttlecock"]["nearby"] for i in n["inputs"]}
    assert not any("ycle" in i or "steel" in i.lower() for i in shuttle_items)   # no bicycle / gun inputs
    for cid in ("bicycles", "fishing_gear", "sporting_firearms"):
        assert client.get(f"/api/valuechains/{cid}").status_code == 200


def test_land_near_clusters(client):
    land = client.get("/api/deep-dive/sports_equipment").json()["land"]
    if land["status"] != "connected":
        return                                                   # park report not refreshed in this database
    by = {d["district"]: d for d in land["by_district"]}
    assert {"Jalandhar", "Meerut", "Ludhiana"} <= set(by)
    assert by["Meerut"]["parks"] >= 1 and all(p["name"] for p in by["Meerut"]["top_parks"])
    assert sum(s["parks"] for s in land["by_state"]) >= sum(d["parks"] for d in land["by_district"])


def test_district_pass_is_incremental(monkeypatch):
    def row(name, state="Punjab"):
        return (f'<div class="row" id=""><div class="srno1">1</div><div class="cl_name">{name}</div>'
                f'<div class="locationid">{state}</div><div class="locationid">Sports Goods</div>'
                f'<div class="detail">N/A</div></div>')
    calls = []

    def fake_get(params, **_kw):
        calls.append(dict(params))
        if params.get("f"):
            return '<select id="district"><option value="">All</option><option value="Jalandhar">J</option>' \
                   '<option value="Meerut">M</option></select>'
        if "district" in params:
            return {"Jalandhar": row("Jalandhar Sports Goods"), "Meerut": row("Meerut Sports Goods", "Uttar Pradesh")}[params["district"]]
        return row("Jalandhar Sports Goods") + row("Meerut Sports Goods", "Uttar Pradesh") if params["sid"] == 1 else ""

    monkeypatch.setattr(dd.cluster_observatory, "_get", staticmethod(fake_get))
    monkeypatch.setattr(dd, "CO_TYPES", {1: "industrial"})
    # budget 0: no district query at all - districts come from the previous snapshot or the name
    previous = {"clusters": [{"cluster_type": "industrial", "name": "Meerut Sports Goods", "state": "Uttar Pradesh",
                              "district": "Meerut", "district_source": "observatory"}],
                "district_state": {"cursor": 1}}
    clusters, state = dd.cluster_observatory.fetch(previous=previous, budget_s=0)
    by = {c["name"]: c for c in clusters}
    assert by["Meerut Sports Goods"]["district_source"] == "observatory"          # kept from the previous run
    assert by["Jalandhar Sports Goods"]["district_source"] == "name"              # inferred until confirmed
    assert state["queried"] == 0 and state["cursor"] == 1
    # unlimited budget: one pass over every district, starting at the cursor
    calls.clear()
    clusters, state = dd.cluster_observatory.fetch(previous=previous)
    assert [c["district"] for c in calls if "district" in c] == ["Meerut", "Jalandhar"]
    assert state["full_pass"] and all(c["district_source"] == "observatory" for c in clusters)
