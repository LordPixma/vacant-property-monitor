import type { SourceDef } from "./types";
import { UpstreamError } from "./types";

// IMD 2019 ranks LSOAs in England from 1 (most deprived) to 32,844.
const IMD_LSOAS = 32_844;

export interface PostcodeData {
  postcode: string;
  terminated: boolean;
  latitude: number | null;
  longitude: number | null;
  country: string | null;
  region: string | null;
  local_authority: string | null;
  local_authority_code: string | null;
  ward: string | null;
  ward_code: string | null;
  parish: string | null;
  constituency: string | null;
  police_force_area: string | null;
  lsoa: string | null;
  lsoa_code: string | null;
  msoa: string | null;
  msoa_code: string | null;
  output_area: string | null;
  rural_urban: string | null;
  built_up_area: string | null;
  imd_rank: number | null;
  imd_decile: number | null;
  imd_of: number | null;
}

export function imdDecile(rank: number | null | undefined): number | null {
  if (!rank || rank < 1) return null;
  return Math.min(10, Math.ceil((rank / IMD_LSOAS) * 10));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapPostcodesIo(r: any, terminated = false): PostcodeData {
  const codes = r.codes ?? {};
  const england = r.country === "England";
  const rank = england && typeof r.index_of_multiple_deprivation === "number" ? r.index_of_multiple_deprivation : null;
  return {
    postcode: r.postcode,
    terminated,
    latitude: r.latitude ?? null,
    longitude: r.longitude ?? null,
    country: r.country ?? null,
    region: r.region ?? null,
    local_authority: r.admin_district ?? null,
    local_authority_code: codes.admin_district ?? null,
    ward: r.admin_ward ?? null,
    ward_code: codes.admin_ward ?? null,
    parish: r.parish ?? null,
    constituency: r.parliamentary_constituency_2024 ?? r.parliamentary_constituency ?? null,
    police_force_area: r.pfa ?? null,
    lsoa: r.lsoa21 ?? r.lsoa ?? null,
    lsoa_code: codes.lsoa21 ?? codes.lsoa ?? null,
    msoa: r.msoa21 ?? r.msoa ?? null,
    msoa_code: codes.msoa21 ?? codes.msoa ?? null,
    output_area: r.oa21 ?? null,
    rural_urban: r.ruc21 ?? r.ruc11 ?? null,
    built_up_area: r.bua ?? null,
    imd_rank: rank,
    imd_decile: imdDecile(rank),
    imd_of: rank ? IMD_LSOAS : null,
  };
}

export async function lookupPostcode(postcode: string, fetchJson: <T>(u: string) => Promise<T>): Promise<PostcodeData | null> {
  const enc = encodeURIComponent(postcode);
  try {
    const { result } = await fetchJson<{ result: unknown }>(`https://api.postcodes.io/postcodes/${enc}`);
    return mapPostcodesIo(result);
  } catch (err) {
    if (!(err instanceof UpstreamError) || err.status !== 404) throw err;
  }
  try {
    const { result } = await fetchJson<{ result: { postcode: string; latitude: number; longitude: number } }>(
      `https://api.postcodes.io/terminated_postcodes/${enc}`,
    );
    return { ...mapPostcodesIo({}, true), postcode: result.postcode, latitude: result.latitude, longitude: result.longitude };
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 404) return null;
    throw err;
  }
}

export const postcodesSource: SourceDef = {
  id: "postcode",
  label: "Location & administrative areas",
  attribution: "postcodes.io — ONS Postcode Directory, Open Government Licence. Contains OS data © Crown copyright.",
  needs: [],
  async run(input, ctx) {
    const data = await ctx.cached(`postcode:${input.postcode}`, 30 * 86_400, () => lookupPostcode(input.postcode, ctx.fetchJson));
    if (!data) return { status: "empty", error: "Postcode not found in the ONS directory." };
    return { status: "ok", data };
  },
};
