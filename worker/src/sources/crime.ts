import type { SourceDef } from "./types";
import { UpstreamError } from "./types";

interface Crime {
  category: string;
  month: string;
  location?: { street?: { name?: string } };
  outcome_status?: { category?: string } | null;
}

export const CRIME_LABELS: Record<string, string> = {
  "anti-social-behaviour": "Anti-social behaviour",
  "bicycle-theft": "Bicycle theft",
  burglary: "Burglary",
  "criminal-damage-arson": "Criminal damage & arson",
  drugs: "Drugs",
  "other-theft": "Other theft",
  "possession-of-weapons": "Possession of weapons",
  "public-order": "Public order",
  robbery: "Robbery",
  shoplifting: "Shoplifting",
  "theft-from-the-person": "Theft from the person",
  "vehicle-crime": "Vehicle crime",
  "violent-crime": "Violence & sexual offences",
  "other-crime": "Other crime",
};

/**
 * Forces that do not publish street-level crime to police.uk, so a near-zero count there means
 * "no data", not "no crime". Greater Manchester Police stopped after its 2019 systems change.
 */
export const FORCES_NOT_PUBLISHING: Record<string, string> = {
  "greater-manchester": "Greater Manchester Police does not publish street-level crime to police.uk, so these counts are not meaningful. Use GMP's own crime map.",
};

/** Polygon approximating a circle, in police.uk's "lat,lng:lat,lng" form. */
export function circlePoly(lat: number, lng: number, radiusM: number, points = 12): string {
  const out: string[] = [];
  for (let i = 0; i < points; i++) {
    const a = (2 * Math.PI * i) / points;
    const dLat = (radiusM * Math.cos(a)) / 111_320;
    const dLng = (radiusM * Math.sin(a)) / (111_320 * Math.cos((lat * Math.PI) / 180));
    out.push(`${(lat + dLat).toFixed(5)},${(lng + dLng).toFixed(5)}`);
  }
  return out.join(":");
}

export function previousMonths(latest: string, n: number): string[] {
  const [y, m] = latest.split("-").map(Number);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

export function summariseCrimes(byMonth: Record<string, Crime[]>, radiusM: number) {
  const months = Object.keys(byMonth).sort().reverse();
  const latest = months[0];
  const latestCrimes = byMonth[latest] ?? [];
  const categories: Record<string, number> = {};
  const streets: Record<string, number> = {};
  const outcomes: Record<string, number> = {};
  for (const c of latestCrimes) {
    categories[c.category] = (categories[c.category] ?? 0) + 1;
    const s = c.location?.street?.name;
    if (s) streets[s] = (streets[s] ?? 0) + 1;
    const o = c.outcome_status?.category ?? "No outcome recorded";
    outcomes[o] = (outcomes[o] ?? 0) + 1;
  }
  const sortDesc = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]);
  const total3 = months.reduce((n, m) => n + (byMonth[m]?.length ?? 0), 0);
  return {
    radius_m: radiusM,
    latest_month: latest,
    months: months.map((m) => ({ month: m, total: byMonth[m]?.length ?? 0 })),
    latest_total: latestCrimes.length,
    monthly_average: months.length ? Math.round((total3 / months.length) * 10) / 10 : 0,
    anti_social_behaviour: categories["anti-social-behaviour"] ?? 0,
    criminal_damage_arson: categories["criminal-damage-arson"] ?? 0,
    burglary: categories["burglary"] ?? 0,
    categories: sortDesc(categories).map(([k, v]) => ({ category: k, label: CRIME_LABELS[k] ?? k, count: v })),
    top_streets: sortDesc(streets).slice(0, 5).map(([k, v]) => ({ street: k, count: v })),
    outcomes: sortDesc(outcomes).slice(0, 6).map(([k, v]) => ({ outcome: k, count: v })),
  };
}

export const crimeSource: SourceDef = {
  id: "crime",
  label: "Street-level crime & policing",
  attribution: "data.police.uk — Open Government Licence v3.0. Locations are approximate (anonymised to a nearby point).",
  needs: ["latlng"],
  async run(input, ctx) {
    const lat = input.latitude!;
    const lng = input.longitude!;
    const { date } = await ctx.cached("police:last-updated", 12 * 3600, () =>
      ctx.fetchJson<{ date: string }>("https://data.police.uk/api/crime-last-updated"),
    );
    const latest = date.slice(0, 7);
    const poly = circlePoly(lat, lng, input.radiusM);
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}:${input.radiusM}`;
    const byMonth: Record<string, Crime[]> = {};
    for (const month of previousMonths(latest, 3)) {
      byMonth[month] = await ctx.cached(`police:crimes:${key}:${month}`, 14 * 86_400, async () => {
        try {
          return await ctx.fetchJson<Crime[]>(`https://data.police.uk/api/crimes-street/all-crime?poly=${encodeURIComponent(poly)}&date=${month}`, {
            timeoutMs: 15_000,
          });
        } catch (err) {
          // police.uk 404s a month it has no data for in this area.
          if (err instanceof UpstreamError && err.status === 404) return [];
          throw err;
        }
      });
    }
    const summary = summariseCrimes(byMonth, input.radiusM);

    let neighbourhood: unknown = null;
    try {
      neighbourhood = await ctx.cached(`police:nbhd:${lat.toFixed(3)},${lng.toFixed(3)}`, 30 * 86_400, async () => {
        const loc = await ctx.fetchJson<{ force: string; neighbourhood: string }>(`https://data.police.uk/api/locate-neighbourhood?q=${lat},${lng}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const team = await ctx.fetchJson<any>(`https://data.police.uk/api/${loc.force}/${encodeURIComponent(loc.neighbourhood)}`);
        return {
          force: loc.force,
          id: loc.neighbourhood,
          name: team.name ?? null,
          url: team.url_force ?? null,
          email: team.contact_details?.email ?? null,
          telephone: team.contact_details?.telephone ?? null,
        };
      });
    } catch (err) {
      console.warn("neighbourhood lookup failed", err);
    }
    const force = (neighbourhood as { force?: string } | null)?.force ?? null;
    const coverage_warning = force ? FORCES_NOT_PUBLISHING[force] ?? null : null;
    return { status: "ok", data: { ...summary, neighbourhood, coverage_warning } };
  },
};
