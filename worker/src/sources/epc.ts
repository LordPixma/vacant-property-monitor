import { addressMatchScore } from "../lib/address";
import type { SourceDef } from "./types";
import { UpstreamError } from "./types";

const BASE = "https://api.get-energy-performance-data.communities.gov.uk";

interface EpcSummary {
  certificateNumber: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  postcode?: string;
  currentEnergyEfficiencyBand?: string;
  registrationDate?: string;
  uprn?: number | string | null;
}

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Depth-first search for the first key matching any of `names` (case and separator insensitive). */
export function deepPick(obj: unknown, names: string[], depth = 0): unknown {
  if (!obj || typeof obj !== "object" || depth > 6) return undefined;
  const wanted = new Set(names.map(norm));
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (wanted.has(norm(k)) && v !== null && v !== "" && typeof v !== "object") return v;
  }
  for (const v of Object.values(obj as Record<string, unknown>)) {
    if (v && typeof v === "object") {
      const found = deepPick(v, names, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** The register's response shape has changed before, so read it defensively. */
export function certificateDetails(json: unknown) {
  const p = (...n: string[]) => deepPick(json, n) ?? null;
  return {
    current_band: p("currentEnergyEfficiencyBand", "currentEnergyRating", "current_energy_rating"),
    current_score: p("currentEnergyEfficiencyRating", "current_energy_efficiency"),
    potential_band: p("potentialEnergyEfficiencyBand", "potentialEnergyRating", "potential_energy_rating"),
    property_type: p("propertyType", "property_type"),
    built_form: p("builtForm", "built_form"),
    floor_area_m2: p("totalFloorArea", "total_floor_area"),
    construction_age: p("constructionAgeBand", "construction_age_band"),
    tenure: p("tenure"),
    transaction_type: p("transactionType", "transaction_type"),
    habitable_rooms: p("numberHabitableRooms", "number_habitable_rooms"),
    main_fuel: p("mainFuel", "main_fuel", "mainFuelType"),
    heating: p("mainheatDescription", "mainheat_description", "mainHeatingDescription"),
    inspection_date: p("inspectionDate", "inspection_date"),
    registration_date: p("registrationDate", "lodgementDate", "lodgement_date"),
  };
}

function findArray(json: unknown): EpcSummary[] {
  if (Array.isArray(json)) return json as EpcSummary[];
  if (json && typeof json === "object") {
    for (const v of Object.values(json as Record<string, unknown>)) {
      const a = findArray(v);
      if (a.length) return a;
    }
  }
  return [];
}

export const epcSource: SourceDef = {
  id: "epc",
  label: "Energy Performance Certificates",
  attribution: "Energy Performance of Buildings Register, MHCLG — Open Government Licence v3.0 (address data subject to Royal Mail and OS terms).",
  needs: [],
  async run(input, ctx) {
    const token = ctx.env.EPC_API_TOKEN;
    if (!token) return { status: "skipped", error: "EPC_API_TOKEN is not configured. Register free at get-energy-performance-data.communities.gov.uk." };
    const headers = { authorization: `Bearer ${token}` };
    const certs = await ctx.cached(`epc:search:${input.postcode}`, 14 * 86_400, async () => {
      try {
        return findArray(await ctx.fetchJson(`${BASE}/api/domestic/search?postcode=${encodeURIComponent(input.postcode)}&page_size=500`, { headers }));
      } catch (err) {
        if (err instanceof UpstreamError && err.status === 404) return [];
        throw err;
      }
    });
    const bands: Record<string, number> = {};
    for (const c of certs) if (c.currentEnergyEfficiencyBand) bands[c.currentEnergyEfficiencyBand] = (bands[c.currentEnergyEfficiencyBand] ?? 0) + 1;

    let match: EpcSummary | null = null;
    if (input.addressLine1) {
      const scored = certs
        .map((c) => ({ c, score: addressMatchScore(input.addressLine1!, { line: [c.addressLine1, c.addressLine2].filter(Boolean).join(" ") }) }))
        .filter((s) => s.score >= 0.6)
        .sort((a, b) => b.score - a.score || String(b.c.registrationDate).localeCompare(String(a.c.registrationDate)));
      match = scored[0]?.c ?? null;
    }
    let details: ReturnType<typeof certificateDetails> | null = null;
    if (match) {
      try {
        const json = await ctx.cached(`epc:cert:${match.certificateNumber}`, 30 * 86_400, () =>
          ctx.fetchJson(`${BASE}/api/certificate?certificate_number=${encodeURIComponent(match!.certificateNumber)}`, { headers }),
        );
        details = certificateDetails(json);
      } catch (err) {
        console.warn("epc certificate fetch failed", err);
      }
    }
    const data = {
      certificates_in_postcode: certs.length,
      bands_in_postcode: bands,
      this_property: match
        ? {
            matched: true,
            certificate_number: match.certificateNumber,
            uprn: match.uprn ? String(match.uprn) : null,
            band: match.currentEnergyEfficiencyBand ?? details?.current_band ?? null,
            registration_date: match.registrationDate ?? details?.registration_date ?? null,
            ...details,
          }
        : { matched: false },
    };
    return { status: certs.length ? "ok" : "empty", data };
  },
};
