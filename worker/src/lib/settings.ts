import type { Env } from "../env";

export interface AppSettings {
  org_name: string;
  /** Re-fetch public data for a property after this many days. */
  enrichment_stale_days: number;
  /** Radius for crime and nearby-services lookups. */
  area_radius_m: number;
  /** Suggest a revisit when a live case has not been seen for this many days. */
  revisit_after_days: number;
  /** Contact details shown to field workers for urgent welfare concerns. */
  outreach_contact: string;
  council_empty_homes_contact: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  org_name: "VacantWatch",
  enrichment_stale_days: 30,
  area_radius_m: 500,
  revisit_after_days: 28,
  outreach_contact: "StreetLink: thestreetlink.org.uk or 0300 500 0914 (England & Wales). Call 999 if someone is in danger.",
  council_empty_homes_contact: "",
};

const NUMERIC: (keyof AppSettings)[] = ["enrichment_stale_days", "area_radius_m", "revisit_after_days"];

export async function loadSettings(env: Env): Promise<AppSettings> {
  const out: AppSettings = { ...DEFAULT_SETTINGS, org_name: env.ORG_NAME || DEFAULT_SETTINGS.org_name };
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  for (const r of results) {
    if (!(r.key in out)) continue;
    (out as unknown as Record<string, unknown>)[r.key] = NUMERIC.includes(r.key as keyof AppSettings) ? Number(r.value) : r.value;
  }
  return out;
}
