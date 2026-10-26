"""Turns the raw public-data results for a postcode into a readable area profile.

Input is the ``enrichment`` map the API Worker stores: one entry per source id
(postcode, crime, price_paid, epc, flood, planning, census, services). Any entry
may be missing or empty; every function here tolerates that.
"""

from __future__ import annotations

import math
from typing import Any

# Census 2021, England: share of households by tenure (ONS TS054).
ENGLAND_TENURE = {"owned": 61.3, "social_rented": 17.1, "private_rented": 20.5}

# Indicative bands for recorded crime per square kilometre per month. They are a
# rough guide for comparing streets, not a published standard.
CRIME_DENSITY_BANDS = [(40, "low"), (120, "moderate"), (250, "high")]


def deprivation(pc: dict[str, Any]) -> dict[str, Any] | None:
    decile = pc.get("imd_decile")
    if not isinstance(decile, int):
        return None
    if decile <= 1:
        label = "Among the 10% most deprived neighbourhoods in England"
    elif decile <= 3:
        label = f"Among the {decile * 10}% most deprived neighbourhoods in England"
    elif decile >= 8:
        label = f"Among the {(11 - decile) * 10}% least deprived neighbourhoods in England"
    else:
        label = "Around the middle for deprivation in England"
    return {"decile": decile, "rank": pc.get("imd_rank"), "of": pc.get("imd_of"), "label": label, "measure": "English Indices of Deprivation 2019"}


def crime_level(crime: dict[str, Any]) -> dict[str, Any] | None:
    if not crime or "latest_total" not in crime:
        return None
    radius_km = (crime.get("radius_m") or 500) / 1000
    area = math.pi * radius_km**2
    avg = crime.get("monthly_average") or crime.get("latest_total") or 0
    density = round(avg / area, 1) if area else 0
    level = "very high"
    for limit, name in CRIME_DENSITY_BANDS:
        if density < limit:
            level = name
            break
    months = crime.get("months") or []
    trend = None
    if len(months) >= 2 and months[-1].get("total"):
        newest, oldest = months[0]["total"], months[-1]["total"]
        change = (newest - oldest) / oldest
        trend = "rising" if change > 0.15 else "falling" if change < -0.15 else "steady"
    top = [c["label"] for c in (crime.get("categories") or [])[:3]]
    if crime.get("coverage_warning"):
        # The force does not publish: a low count means no data, never "low crime".
        return {"level": "unknown", "per_km2_per_month": None, "monthly_average": None, "latest_month": crime.get("latest_month"),
                "trend": None, "top_categories": [], "note": crime["coverage_warning"]}
    return {
        "level": level,
        "per_km2_per_month": density,
        "monthly_average": avg,
        "latest_month": crime.get("latest_month"),
        "trend": trend,
        "top_categories": top,
        "note": "Indicative band from police.uk street-level data, which is anonymised to nearby points.",
    }


def market(pp: dict[str, Any]) -> dict[str, Any] | None:
    if not pp or not pp.get("transactions_in_postcode"):
        return None
    yearly = pp.get("yearly_median") or []
    trend = None
    if len(yearly) >= 4:
        recent = [y["median"] for y in yearly[-2:] if y.get("median")]
        earlier = [y["median"] for y in yearly[-5:-2] if y.get("median")]
        if recent and earlier:
            r, e = sum(recent) / len(recent), sum(earlier) / len(earlier)
            trend = round((r - e) / e * 100, 1)
    return {
        "median_price_5y": pp.get("median_price_5y"),
        "sales_last_5y": pp.get("sales_last_5y"),
        "transactions_on_record": pp.get("transactions_in_postcode"),
        "price_change_pct": trend,
        "activity": "active" if (pp.get("sales_last_5y") or 0) >= 5 else "quiet",
    }


def tenure(census: dict[str, Any]) -> dict[str, Any] | None:
    head = (census or {}).get("tenure_headline")
    if not head:
        return None
    out: dict[str, Any] = {"shares": head, "england": ENGLAND_TENURE, "notes": []}
    social = head.get("social_rented")
    private = head.get("private_rented")
    if isinstance(social, (int, float)) and social >= ENGLAND_TENURE["social_rented"] * 1.5:
        out["notes"].append(f"High share of social housing ({social:.0f}% of households vs {ENGLAND_TENURE['social_rented']}% in England).")
    if isinstance(private, (int, float)) and private >= ENGLAND_TENURE["private_rented"] * 1.5:
        out["notes"].append(f"High share of private renting ({private:.0f}% vs {ENGLAND_TENURE['private_rented']}% in England).")
    return out


def support_access(services: dict[str, Any]) -> dict[str, Any] | None:
    groups = (services or {}).get("groups")
    if not groups:
        return None

    def nearest(key: str) -> dict[str, Any] | None:
        items = (groups.get(key) or {}).get("nearest") or []
        return items[0] if items else None

    out = {
        "radius_m": services.get("radius_m"),
        "counts": {k: v.get("count", 0) for k, v in groups.items()},
        "nearest_shelter": nearest("shelter"),
        "nearest_food_bank": nearest("food_bank"),
        "nearest_health": nearest("health"),
        "nearest_pharmacy": nearest("pharmacy"),
    }
    homeless_services = sum((groups.get(k) or {}).get("count", 0) for k in ("shelter", "food_bank", "social_support"))
    out["homelessness_services"] = homeless_services
    # With an empty directory (area never synced) "no services" means "no data", not a gap.
    out["gap"] = homeless_services == 0 and not services.get("note")
    return out


def risks(enrichment: dict[str, Any]) -> list[str]:
    out: list[str] = []
    flood = enrichment.get("flood") or {}
    if flood.get("live_warnings"):
        out.append(f"{len(flood['live_warnings'])} live flood warning(s) nearby.")
    elif flood.get("within_flood_area"):
        out.append("Inside an Environment Agency flood alert or warning area.")
    planning = enrichment.get("planning") or {}
    for z in planning.get("flood_risk_zone") or []:
        if z.get("level"):
            out.append(f"In planning flood risk zone {z['level']}.")
            break
    if planning.get("conservation_area"):
        out.append("In a conservation area: external changes need consent.")
    if planning.get("listed_building_on_site") or planning.get("possibly_listed"):
        out.append("Listed building on or next to the site.")
    if planning.get("article_4"):
        out.append("Article 4 direction: some permitted development rights removed (often HMO conversions).")
    return out


def area_profile(enrichment: dict[str, Any]) -> dict[str, Any]:
    pc = enrichment.get("postcode") or {}
    prof: dict[str, Any] = {
        "location": {
            k: pc.get(k)
            for k in ("postcode", "local_authority", "ward", "constituency", "lsoa", "lsoa_code", "region", "rural_urban", "police_force_area")
        },
        "deprivation": deprivation(pc),
        "crime": crime_level(enrichment.get("crime") or {}),
        "market": market(enrichment.get("price_paid") or {}),
        "tenure": tenure(enrichment.get("census") or {}),
        "support": support_access(enrichment.get("services") or {}),
        "risks": risks(enrichment),
    }
    prof["headline"] = headline(prof)
    return prof


def _money(n: Any) -> str:
    return f"£{int(n):,}" if isinstance(n, (int, float)) else "n/a"


def headline(p: dict[str, Any]) -> list[str]:
    lines: list[str] = []
    loc = p["location"]
    if loc.get("ward") and loc.get("local_authority"):
        lines.append(f"{loc['ward']} ward, {loc['local_authority']}.")
    if p["deprivation"]:
        lines.append(p["deprivation"]["label"] + ".")
    if p["crime"] and p["crime"]["level"] == "unknown":
        lines.append("Street-level crime is not published for this police force.")
    elif p["crime"]:
        c = p["crime"]
        trend = f", {c['trend']}" if c.get("trend") else ""
        lines.append(f"Recorded crime is {c['level']} ({c['monthly_average']} a month nearby{trend}).")
    if p["market"] and p["market"].get("median_price_5y"):
        lines.append(f"Median sale price in the postcode over five years: {_money(p['market']['median_price_5y'])}.")
    if p["tenure"]:
        lines.extend(p["tenure"]["notes"])
    s = p["support"]
    if s:
        if s["gap"]:
            lines.append(f"No shelter, food bank or outreach service in the directory within {s['radius_m']} m.")
        else:
            near = s.get("nearest_shelter") or s.get("nearest_food_bank")
            if near:
                kind = str(near.get("kind") or "service").replace("_", " ")
                lines.append(f"Nearest support service: {near.get('name') or kind.capitalize()} ({near['distance_m']} m).")
    lines.extend(p["risks"])
    return lines
