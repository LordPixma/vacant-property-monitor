import type { SourceDef } from "./types";

/** Census 2021 tables published by ONS via Nomis, by 2021 LSOA. */
const TABLES = [
  { key: "tenure", id: "NM_2072_1", title: "Tenure (TS054)" },
  { key: "accommodation_type", id: "NM_2062_1", title: "Accommodation type (TS044)" },
  { key: "household_deprivation", id: "NM_2031_1", title: "Household deprivation dimensions (TS011)" },
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseNomis(json: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obs: any[] = json?.obs ?? [];
  const rows = obs.map((o) => {
    const dim = Object.keys(o).find((k) => k.startsWith("c2021_"));
    return { label: dim ? String(o[dim].description) : "?", percent: Number(o.obs_value?.value) };
  });
  // The first row is the total (100%), and tenure includes sub-totals; keep top-level rows only.
  return rows.filter((r) => !/^Total/.test(r.label));
}

export function headlineTenure(rows: { label: string; percent: number }[]) {
  const get = (l: string) => rows.find((r) => r.label === l)?.percent ?? null;
  return {
    owned: get("Owned"),
    social_rented: get("Social rented"),
    council_rented: get("Social rented: Rents from council or Local Authority"),
    other_social_rented: get("Social rented: Other social rented"),
    private_rented: get("Private rented"),
  };
}

export const censusSource: SourceDef = {
  id: "census",
  label: "Census 2021 neighbourhood profile",
  attribution: "Office for National Statistics, Census 2021, via Nomis — Open Government Licence v3.0. England & Wales, by Lower Layer Super Output Area.",
  needs: ["lsoa"],
  async run(input, ctx) {
    const lsoa = input.lsoaCode!;
    if (!/^[EW]01\d{6}$/.test(lsoa)) return { status: "skipped", error: "Census 2021 covers England and Wales only." };
    const out: Record<string, unknown> = { lsoa_code: lsoa };
    for (const t of TABLES) {
      const rows = await ctx.cached(`nomis:${t.id}:${lsoa}`, 90 * 86_400, async () =>
        parseNomis(await ctx.fetchJson(`https://www.nomisweb.co.uk/api/v01/dataset/${t.id}.data.json?geography=${lsoa}&measures=20301`)),
      );
      // TS054 also publishes overlapping aggregates ("Private rented or lives rent free"); drop them.
      out[t.key] = { title: t.title, rows: t.key === "tenure" ? rows.filter((r) => r.label.includes(":") || !/ or /.test(r.label)) : rows };
    }
    out.tenure_headline = headlineTenure((out.tenure as { rows: { label: string; percent: number }[] }).rows);
    return { status: "ok", data: out };
  },
};
