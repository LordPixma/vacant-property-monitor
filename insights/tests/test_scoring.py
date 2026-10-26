from insights.area import area_profile, crime_level, deprivation
from insights.scoring import _parse_date_ms, assess, band_for, recent_signals

DAY = 86_400_000
NOW = _parse_date_ms("2026-10-26")


def payload(**over):
    base = {
        "property": {"status": "reported", "category": "unknown", "created_at": NOW - 10 * DAY, "last_visited_at": NOW - 2 * DAY},
        "visits": [],
        "enrichment": {},
        "now": NOW,
        "settings": {"revisit_after_days": 28},
    }
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            base[k] = {**base[k], **v}
        else:
            base[k] = v
    return base


def test_parse_date_matches_epoch():
    assert _parse_date_ms("1970-01-01") == 0
    assert _parse_date_ms("2000-03-01") == 951868800000
    assert _parse_date_ms("2024-02") == _parse_date_ms("2024-02-01")
    assert _parse_date_ms("garbage") is None
    assert _parse_date_ms(None) is None


def test_bands():
    assert band_for(85) == "critical"
    assert band_for(50) == "high"
    assert band_for(30) == "medium"
    assert band_for(0) == "low"


def test_rough_sleeping_is_critical_and_first_action():
    visits = [{"visited_at": NOW - DAY, "signals": ["signs_of_rough_sleeping", "open_or_unsecured", "boarded_windows"]}]
    a = assess(payload(property={"status": "derelict", "security": "partially_open", "vacant_since": "2023-01"}, visits=visits))
    assert a.priority_band == "critical"
    assert a.recommended_actions[0]["type"] == "refer_streetlink"
    assert a.recommended_actions[0]["urgency"] == "now"
    assert any(x["type"] == "report_unsafe" for x in a.recommended_actions)
    assert a.reasons[0]["factor"] == "rough_sleeping"


def test_occupation_signal_lowers_likelihood():
    vacant = assess(payload(property={"status": "suspected_vacant"}, visits=[{"visited_at": NOW, "signals": ["mail_piling_up"]}]))
    lived_in = assess(payload(property={"status": "suspected_vacant"}, visits=[{"visited_at": NOW, "signals": ["signs_of_occupation"]}]))
    assert vacant.vacancy_likelihood > 0.7
    assert lived_in.vacancy_likelihood < 0.3


def test_older_occupation_does_not_override_latest_vacancy():
    visits = [
        {"visited_at": NOW - 5 * DAY, "signals": ["boarded_windows"]},
        {"visited_at": NOW - 40 * DAY, "signals": ["signs_of_occupation"]},
    ]
    assert "signs_of_occupation" not in recent_signals(visits, NOW)


def test_closed_case_is_capped_and_has_no_actions():
    a = assess(payload(property={"status": "occupied"}, visits=[{"visited_at": NOW, "signals": ["signs_of_rough_sleeping"]}]))
    assert a.priority_score <= 10
    assert a.recommended_actions == []


def test_long_term_private_empty_gets_edmo_and_council_referral():
    a = assess(payload(property={"status": "confirmed_vacant", "category": "private", "vacant_since": "2023-06-01"}))
    titles = [x["title"] for x in a.recommended_actions]
    assert any("Empty Homes Officer" in t for t in titles)
    assert any("Empty Dwelling Management Order" in t for t in titles)
    assert a.months_vacant and a.months_vacant > 24


def test_social_landlord_boost():
    private = assess(payload(property={"status": "confirmed_vacant", "category": "private"}))
    council = assess(payload(property={"status": "confirmed_vacant", "category": "council"}))
    assert council.priority_score - private.priority_score == 10


def test_never_visited_and_stale():
    never = assess(payload(property={"last_visited_at": None}))
    stale = assess(payload(property={"last_visited_at": NOW - 60 * DAY}))
    assert any(r["factor"] == "never_visited" for r in never.reasons)
    assert any(r["factor"] == "stale" for r in stale.reasons)


def test_deprivation_and_asb_add_points():
    base = assess(payload(property={"status": "confirmed_vacant"}))
    needy = assess(payload(property={"status": "confirmed_vacant"}, enrichment={
        "postcode": {"imd_decile": 1},
        "crime": {"anti_social_behaviour": 12, "criminal_damage_arson": 5, "latest_total": 80, "monthly_average": 75, "radius_m": 500},
    }))
    assert needy.priority_score == base.priority_score + 8 + 4


def test_empty_enrichment_is_tolerated():
    a = assess({"property": {}, "now": NOW})
    assert 0 <= a.priority_score <= 100
    assert a.area_profile["headline"] == []


def test_deprivation_labels():
    assert deprivation({"imd_decile": 1})["label"].startswith("Among the 10% most")
    assert "least" in deprivation({"imd_decile": 9})["label"]
    assert deprivation({}) is None


def test_crime_level_density_and_trend():
    c = crime_level({"radius_m": 500, "monthly_average": 200, "latest_total": 220, "months": [{"month": "2026-08", "total": 220}, {"month": "2026-07", "total": 190}, {"month": "2026-06", "total": 150}]})
    assert c["level"] == "very high"
    assert c["trend"] == "rising"


def test_area_profile_headline_reads_well():
    p = area_profile({
        "postcode": {"ward": "Moss Side", "local_authority": "Manchester", "imd_decile": 2},
        "price_paid": {"transactions_in_postcode": 12, "median_price_5y": 185000, "sales_last_5y": 6, "yearly_median": []},
        "census": {"tenure_headline": {"owned": 17.5, "social_rented": 29.4, "private_rented": 52.3}},
        "services": {"radius_m": 1000, "groups": {"shelter": {"count": 0, "nearest": []}, "food_bank": {"count": 0, "nearest": []}}},
        "flood": {"within_flood_area": True, "live_warnings": []},
    })
    text = " ".join(p["headline"])
    assert "Moss Side ward, Manchester." in text
    assert "£185,000" in text
    assert "social housing" in text
    assert "No shelter, food bank or outreach service" in text
    assert "flood" in text


def test_unpublished_force_is_not_called_low_crime():
    c = crime_level({"radius_m": 500, "monthly_average": 0.3, "latest_total": 0, "months": [], "coverage_warning": "GMP does not publish."})
    assert c["level"] == "unknown"
    p = area_profile({"crime": {"radius_m": 500, "monthly_average": 0.3, "latest_total": 0, "months": [], "coverage_warning": "x"}})
    assert "not published" in " ".join(p["headline"])
    assert "low" not in " ".join(p["headline"]).lower()
