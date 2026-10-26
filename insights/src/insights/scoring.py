"""Priority scoring for a monitored property.

Two numbers come out of here, and they answer different questions:

* ``vacancy_likelihood`` (0..1): how sure are we the building is actually empty?
  Built from the case status as a prior, moved by what field workers saw.
* ``priority_score`` (0..100): how urgently should the charity act on it?
  Welfare first (someone may be sleeping inside an unsafe building), then how long
  it has stood empty, who owns it, and how much need there is in the area.

Every point added is recorded as a reason, so a coordinator can see why a property
ranks where it does. Pure Python, no I/O: the Worker entrypoint feeds it JSON.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from .area import area_profile

MODEL_VERSION = "2026.10.1"

DAY_MS = 86_400_000

# Prior probability that a property is empty, by case status.
STATUS_PRIOR: dict[str, float] = {
    "reported": 0.45,
    "suspected_vacant": 0.65,
    "confirmed_vacant": 0.92,
    "derelict": 0.96,
    "abandoned": 0.96,
    "referred": 0.88,
    "brought_back_into_use": 0.05,
    "occupied": 0.04,
    "demolished": 0.0,
}

# Log-odds moved by each signal seen on the most recent visits.
SIGNAL_WEIGHTS: dict[str, float] = {
    "boarded_windows": 1.4,
    "boarded_doors": 1.4,
    "mail_piling_up": 1.0,
    "no_curtains_or_furniture": 1.0,
    "utilities_disconnected": 1.2,
    "overgrown_garden": 0.5,
    "broken_windows": 0.6,
    "structural_damage": 0.6,
    "roof_damage": 0.4,
    "fire_damage": 0.9,
    "fly_tipping": 0.3,
    "pest_infestation": 0.4,
    "auction_sign": 0.5,
    "council_notice": 0.5,
    "for_sale_sign": 0.2,
    "to_let_sign": 0.2,
    "signs_of_occupation": -2.2,
    "scaffolding_or_works": -0.4,
}

CLOSED_STATUSES = {"brought_back_into_use", "occupied", "demolished"}


@dataclass
class Assessment:
    priority_score: int
    priority_band: str
    vacancy_likelihood: float
    months_vacant: float | None
    reasons: list[dict[str, Any]] = field(default_factory=list)
    recommended_actions: list[dict[str, Any]] = field(default_factory=list)
    area_profile: dict[str, Any] = field(default_factory=dict)
    model_version: str = MODEL_VERSION

    def to_dict(self) -> dict[str, Any]:
        return {
            "priority_score": self.priority_score,
            "priority_band": self.priority_band,
            "vacancy_likelihood": self.vacancy_likelihood,
            "months_vacant": self.months_vacant,
            "reasons": self.reasons,
            "recommended_actions": self.recommended_actions,
            "area_profile": self.area_profile,
            "model_version": self.model_version,
        }


def band_for(score: int) -> str:
    if score >= 70:
        return "critical"
    if score >= 50:
        return "high"
    if score >= 30:
        return "medium"
    return "low"


def _logit(p: float) -> float:
    p = min(max(p, 0.001), 0.999)
    return math.log(p / (1 - p))


def _sigmoid(x: float) -> float:
    return 1 / (1 + math.exp(-x))


def _parse_date_ms(value: Any) -> int | None:
    """Accept unix ms or an ISO date string (YYYY-MM or YYYY-MM-DD)."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return int(value)
    s = str(value)
    try:
        parts = [int(p) for p in s[:10].split("-")]
    except ValueError:
        return None
    if len(parts) == 2:
        parts.append(1)
    if len(parts) != 3:
        return None
    y, m, d = parts
    # Days from civil, so this needs no datetime/timezone handling.
    y -= m <= 2
    era = (y if y >= 0 else y - 399) // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return (era * 146097 + doe - 719468) * DAY_MS


def recent_signals(visits: list[dict[str, Any]], now_ms: int, window_days: int = 120) -> set[str]:
    """Signals from the latest visit, plus any seen on visits in the window before it."""
    if not visits:
        return set()
    ordered = sorted(visits, key=lambda v: v.get("visited_at") or 0, reverse=True)
    latest = ordered[0]
    cutoff = (latest.get("visited_at") or now_ms) - window_days * DAY_MS
    seen: set[str] = set(latest.get("signals") or [])
    for v in ordered[1:]:
        if (v.get("visited_at") or 0) >= cutoff:
            seen.update(v.get("signals") or [])
    # Occupation seen on the latest visit overrides older vacancy evidence, not the reverse.
    if "signs_of_occupation" not in (latest.get("signals") or []):
        seen.discard("signs_of_occupation")
    return seen


def vacancy_likelihood(status: str, signals: set[str], enrichment: dict[str, Any], reasons: list[dict[str, Any]]) -> float:
    prior = STATUS_PRIOR.get(status, 0.45)
    if status == "demolished":
        return 0.0
    x = _logit(prior)
    for s in sorted(signals):
        w = SIGNAL_WEIGHTS.get(s)
        if w:
            x += w
    pp = (enrichment.get("price_paid") or {}).get("this_property") or {}
    years = pp.get("years_since_last_sale")
    if isinstance(years, (int, float)) and years >= 15:
        x += 0.2
        reasons.append({"factor": "no_recent_sale", "impact": 0, "detail": f"Last recorded sale was {years:.0f} years ago."})
    return round(_sigmoid(x), 3)


def months_between(start_ms: int | None, now_ms: int) -> float | None:
    if start_ms is None or start_ms > now_ms:
        return None
    return round((now_ms - start_ms) / (30.44 * DAY_MS), 1)


def assess(payload: dict[str, Any]) -> Assessment:
    prop: dict[str, Any] = payload.get("property") or {}
    visits: list[dict[str, Any]] = payload.get("visits") or []
    enrichment: dict[str, Any] = payload.get("enrichment") or {}
    now_ms = int(payload.get("now") or 0)
    settings: dict[str, Any] = payload.get("settings") or {}
    revisit_days = int(settings.get("revisit_after_days") or 28)

    status = prop.get("status") or "reported"
    reasons: list[dict[str, Any]] = []
    actions: list[dict[str, Any]] = []
    signals = recent_signals(visits, now_ms)
    likelihood = vacancy_likelihood(status, signals, enrichment, reasons)
    profile = area_profile(enrichment)

    score = 0.0

    def add(points: float, factor: str, detail: str) -> None:
        nonlocal score
        score += points
        reasons.append({"factor": factor, "impact": round(points), "detail": detail})

    # 1. Welfare: a person may be at risk right now.
    if "signs_of_rough_sleeping" in signals:
        add(35, "rough_sleeping", "Signs that someone may be sleeping at or in the property.")
        actions.append({
            "type": "refer_streetlink",
            "urgency": "now",
            "title": "Refer to StreetLink or the local outreach team today",
            "detail": "Give the exact location and time seen. Do not enter the building. Call 999 if anyone is in immediate danger.",
        })
        live = ((enrichment.get("flood") or {}).get("live_warnings")) or []
        if live:
            add(5, "flood_warning_and_rough_sleeping", "A live flood warning is in force nearby.")
    unsafe = signals & {"open_or_unsecured", "structural_damage", "fire_damage", "roof_damage"}
    if "open_or_unsecured" in signals or prop.get("security") in ("open", "partially_open"):
        add(15, "unsecured", "The building is open or not secured.")
    if unsafe - {"open_or_unsecured"}:
        add(10, "dangerous_structure", "Visible structural, roof or fire damage: " + ", ".join(sorted(s.replace("_", " ") for s in unsafe - {"open_or_unsecured"})) + ".")
    if unsafe or prop.get("security") in ("open", "partially_open"):
        actions.append({
            "type": "report_unsafe",
            "urgency": "this_week",
            "title": "Report the unsafe or unsecured building to the council",
            "detail": "Building control handles dangerous structures and environmental health handles open or verminous empty buildings.",
        })

    # 2. How sure are we it is empty?
    add(likelihood * 25, "vacancy_likelihood", f"Estimated {likelihood:.0%} likely to be vacant.")

    # 3. How long has it stood empty?
    start = _parse_date_ms(prop.get("vacant_since"))
    if start is None and status in ("confirmed_vacant", "derelict", "abandoned", "referred"):
        start = _parse_date_ms(prop.get("created_at"))
    months = months_between(start, now_ms) if likelihood >= 0.5 else None
    if months is not None:
        if months >= 24:
            add(15, "long_term_empty", f"Empty for about {months:.0f} months (over two years).")
        elif months >= 12:
            add(12, "long_term_empty", f"Empty for about {months:.0f} months.")
        elif months >= 6:
            add(8, "long_term_empty", f"Empty for about {months:.0f} months (councils treat six months as long-term empty).")
        elif months >= 2:
            add(4, "empty_months", f"Empty for about {months:.0f} months.")

    # 4. Who can bring it back into use?
    category = prop.get("category") or "unknown"
    if category in ("council", "housing_association"):
        add(10, "social_landlord", "Owned by a social landlord, so a void can be raised directly with them.")
        if likelihood >= 0.6:
            actions.append({
                "type": "refer_council",
                "urgency": "this_month",
                "title": "Ask the landlord about the void and its re-let date",
                "detail": "Social landlords track voids; ask for the reason it is empty and the target re-let date.",
            })
    elif likelihood >= 0.6 and (months or 0) >= 6:
        actions.append({
            "type": "refer_council",
            "urgency": "this_month",
            "title": "Refer to the council's Empty Homes Officer",
            "detail": "Long-term empty private homes can be brought back with council help, grants or leasing schemes.",
        })
        if (months or 0) >= 24 and category == "private":
            add(5, "edmo_eligible", "Empty over two years: may meet the threshold for an Empty Dwelling Management Order.")
            actions.append({
                "type": "refer_council",
                "urgency": "this_month",
                "title": "Ask the council whether an Empty Dwelling Management Order applies",
                "detail": "An EDMO can apply to a dwelling empty for two years or more, subject to the statutory tests.",
            })

    # 5. Need and risk in the area.
    imd = (enrichment.get("postcode") or {}).get("imd_decile")
    if isinstance(imd, int):
        if imd <= 2:
            add(8, "deprivation", f"In the {imd * 10}% most deprived neighbourhoods in England.")
        elif imd <= 4:
            add(5, "deprivation", f"In the {imd * 10}% most deprived neighbourhoods in England.")
    crime = enrichment.get("crime") or {}
    asb = crime.get("anti_social_behaviour") or 0
    damage = crime.get("criminal_damage_arson") or 0
    if asb + damage >= 15 and not crime.get("coverage_warning"):
        add(4, "asb_hotspot", f"{asb} anti-social behaviour and {damage} criminal damage reports nearby last month.")

    # 6. Freshness: an old observation is a weak one.
    last_visit = prop.get("last_visited_at")
    if status not in CLOSED_STATUSES:
        if not last_visit:
            add(5, "never_visited", "No one has visited yet.")
            actions.append({"type": "revisit", "urgency": "this_week", "title": "Visit to confirm the property's status", "detail": "Observe from the street only."})
        elif now_ms - int(last_visit) > revisit_days * DAY_MS:
            days = int((now_ms - int(last_visit)) / DAY_MS)
            add(5, "stale", f"Last visited {days} days ago.")
            actions.append({"type": "revisit", "urgency": "this_month", "title": "Revisit to refresh the observation", "detail": f"Last seen {days} days ago."})

    # 7. Ownership research when the public registers say nothing.
    pp = (enrichment.get("price_paid") or {}).get("this_property") or {}
    epc = (enrichment.get("epc") or {}).get("this_property") or {}
    if likelihood >= 0.6 and not pp.get("matched") and not epc.get("matched") and category in ("private", "unknown"):
        actions.append({
            "type": "research",
            "urgency": "this_month",
            "title": "Find the owner through HM Land Registry",
            "detail": "No sale or EPC is on record for this address. A title register search (GOV.UK, small fee) names the owner.",
        })

    planning = enrichment.get("planning") or {}
    if planning.get("conservation_area") or planning.get("listed_building_on_site") or planning.get("possibly_listed"):
        reasons.append({"factor": "heritage", "impact": 0, "detail": "Heritage designation: works may need consent, which can explain a long void."})

    # Closed cases drop to the bottom whatever else is true.
    if status in CLOSED_STATUSES:
        score = min(score, 10)
        reasons.append({"factor": "closed", "impact": 0, "detail": f"Case status is {status.replace('_', ' ')}."})
        actions = []

    final = int(round(min(max(score, 0), 100)))
    return Assessment(
        priority_score=final,
        priority_band=band_for(final),
        vacancy_likelihood=likelihood,
        months_vacant=months,
        reasons=sorted(reasons, key=lambda r: -r["impact"]),
        recommended_actions=_dedupe(actions),
        area_profile=profile,
    )


_URGENCY = {"now": 0, "this_week": 1, "this_month": 2}


def _dedupe(actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out = []
    for a in sorted(actions, key=lambda a: _URGENCY.get(a["urgency"], 3)):
        if a["title"] in seen:
            continue
        seen.add(a["title"])
        out.append(a)
    return out
