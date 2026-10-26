import type { Env } from "../env";
import { SERVICE_GROUPS as GROUP_KEYS } from "../lib/enums";
import { boundingBox, distanceMetres } from "../lib/geo";
import { newId } from "../lib/ids";
import type { SourceDef } from "./types";

type GroupKey = (typeof GROUP_KEYS)[number];

export const SERVICE_GROUPS: { key: GroupKey; label: string; match: (t: Record<string, string>) => boolean }[] = [
  { key: "shelter", label: "Shelters & hostels", match: (t) => t.social_facility === "shelter" || (t.amenity === "shelter" && t.shelter_type === "homeless") },
  { key: "food_bank", label: "Food banks & soup kitchens", match: (t) => ["food_bank", "soup_kitchen"].includes(t.social_facility ?? "") || t.amenity === "food_bank" },
  {
    key: "social_support",
    label: "Outreach & social support",
    match: (t) => (t.amenity === "social_facility" && !["shelter", "food_bank", "soup_kitchen", "nursing_home", "assisted_living"].includes(t.social_facility ?? "")) || t.amenity === "social_centre",
  },
  { key: "health", label: "GP, clinics & hospitals", match: (t) => ["doctors", "clinic", "hospital"].includes(t.amenity ?? "") || t.healthcare === "doctor" },
  { key: "pharmacy", label: "Pharmacies", match: (t) => t.amenity === "pharmacy" || t.healthcare === "pharmacy" },
  { key: "community", label: "Community centres & libraries", match: (t) => ["community_centre", "library"].includes(t.amenity ?? "") },
  { key: "facilities", label: "Toilets, showers & drinking water", match: (t) => ["toilets", "shower", "drinking_water"].includes(t.amenity ?? "") },
  { key: "police", label: "Police stations", match: (t) => t.amenity === "police" },
  { key: "transport", label: "Bus stops & stations", match: (t) => t.highway === "bus_stop" || t.railway === "station" || t.public_transport === "station" },
];

export const GROUP_LABELS = Object.fromEntries(SERVICE_GROUPS.map((g) => [g.key, g.label])) as Record<GroupKey, string>;

export function classify(tags: Record<string, string>): GroupKey | null {
  return SERVICE_GROUPS.find((g) => g.match(tags))?.key ?? null;
}

// Public Overpass instances. From Cloudflare's shared egress the main one refuses (521) and
// others rate-limit, so the sync tries each in turn with a long timeout, from the cron.
export const OVERPASS = [
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

export function overpassQuery(lat: number, lng: number, radiusM: number): string {
  const a = `around:${radiusM},${lat},${lng}`;
  return `[out:json][timeout:60];
(
  nwr(${a})[amenity=social_facility];
  nwr(${a})[social_facility];
  nwr(${a})[amenity~"^(food_bank|social_centre|doctors|clinic|hospital|pharmacy|community_centre|library|toilets|shower|drinking_water|police)$"];
  nwr(${a})[amenity=shelter][shelter_type=homeless];
  nwr(${a})[healthcare~"^(doctor|pharmacy)$"];
  node(${a})[highway=bus_stop];
  nwr(${a})[railway=station];
);
out center tags 3000;`;
}

export interface OsmElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface ServiceRow {
  osm_ref: string;
  group_key: GroupKey;
  name: string | null;
  kind: string | null;
  latitude: number;
  longitude: number;
  address: string | null;
  phone: string | null;
  website: string | null;
  opening_hours: string | null;
}

/** OSM elements to directory rows: classified, located and deduplicated. */
export function osmToRows(elements: OsmElement[]): ServiceRow[] {
  const seen = new Set<string>();
  const out: ServiceRow[] = [];
  for (const e of elements) {
    const ref = `${e.type}/${e.id}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const p = e.center ?? (e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : null);
    const t = e.tags ?? {};
    const group = classify(t);
    if (!p || !group) continue;
    const addr = [t["addr:housenumber"], t["addr:street"], t["addr:postcode"]].filter(Boolean).join(" ");
    out.push({
      osm_ref: ref,
      group_key: group,
      name: t.name ?? t.operator ?? t["name:en"] ?? null,
      kind: t.social_facility ?? t.amenity ?? t.healthcare ?? t.highway ?? t.railway ?? null,
      latitude: p.lat,
      longitude: p.lon,
      address: addr || null,
      phone: t.phone ?? t["contact:phone"] ?? null,
      website: t.website ?? t["contact:website"] ?? null,
      opening_hours: t.opening_hours ?? null,
    });
  }
  return out;
}

export interface DirectoryRow extends ServiceRow {
  id: string;
  source: "osm" | "manual";
  notes: string | null;
}

/** Group directory rows around a point: count per group and the five nearest of each. */
export function groupNearby(rows: DirectoryRow[], lat: number, lng: number, radiusM: number) {
  const groups: Record<string, { label: string; count: number; nearest: unknown[] }> = {};
  for (const g of SERVICE_GROUPS) groups[g.key] = { label: g.label, count: 0, nearest: [] };
  const withDistance = rows
    .map((r) => ({ r, d: Math.round(distanceMetres(lat, lng, r.latitude, r.longitude)) }))
    .filter((x) => x.d <= radiusM)
    .sort((a, b) => a.d - b.d);
  for (const { r, d } of withDistance) {
    const bucket = groups[r.group_key];
    if (!bucket) continue;
    bucket.count++;
    if (bucket.nearest.length < 5) {
      bucket.nearest.push({
        id: r.id,
        name: r.name,
        kind: r.kind,
        source: r.source,
        distance_m: d,
        lat: r.latitude,
        lng: r.longitude,
        address: r.address,
        phone: r.phone,
        website: r.website,
        opening_hours: r.opening_hours,
        notes: r.notes,
        osm: r.osm_ref ? `https://www.openstreetmap.org/${r.osm_ref}` : null,
      });
    }
  }
  return groups;
}

export async function servicesNear(env: Env, lat: number, lng: number, radiusM: number): Promise<DirectoryRow[]> {
  const b = boundingBox(lat, lng, radiusM);
  const { results } = await env.DB.prepare(
    `SELECT id, source, osm_ref, group_key, name, kind, latitude, longitude, address, phone, website, opening_hours, notes
       FROM support_services WHERE active = 1 AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ? LIMIT 3000`,
  )
    .bind(b.minLat, b.maxLat, b.minLng, b.maxLng)
    .all<DirectoryRow>();
  return results;
}

export async function upsertOsmRows(env: Env, rows: ServiceRow[], areaId: string, at: number) {
  const stmts = rows.map((r) =>
    env.DB.prepare(
      `INSERT INTO support_services (id, source, osm_ref, group_key, name, kind, latitude, longitude, address, phone, website, opening_hours, watch_area_id, created_at, updated_at)
       VALUES (?, 'osm', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (osm_ref) DO UPDATE SET group_key = excluded.group_key, name = excluded.name, kind = excluded.kind, latitude = excluded.latitude,
         longitude = excluded.longitude, address = excluded.address, phone = excluded.phone, website = excluded.website,
         opening_hours = excluded.opening_hours, watch_area_id = excluded.watch_area_id, updated_at = excluded.updated_at`,
    ).bind(newId(), r.osm_ref, r.group_key, r.name, r.kind, r.latitude, r.longitude, r.address, r.phone, r.website, r.opening_hours, areaId, at, at),
  );
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

export const servicesSource: SourceDef = {
  id: "services",
  label: "Nearby support services & amenities",
  attribution: "Support services directory: © OpenStreetMap contributors (ODbL), synced daily per watch area, plus services your team has added.",
  needs: ["latlng"],
  async run(input, ctx) {
    const lat = input.latitude!;
    const lng = input.longitude!;
    const radius = Math.max(1000, input.radiusM * 2);
    const rows = await servicesNear(ctx.env, lat, lng, radius);
    const groups = groupNearby(rows, lat, lng, radius);
    const total = Object.values(groups).reduce((n, g) => n + g.count, 0);
    if (!total) {
      return {
        status: "empty",
        data: { radius_m: radius, groups, note: "No services in the directory near here yet. The directory fills from OpenStreetMap for watched areas, or can be added to by hand." },
      };
    }
    return { status: "ok", data: { radius_m: radius, groups } };
  },
};
