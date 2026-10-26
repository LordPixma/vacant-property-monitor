import { distanceMetres } from "../lib/geo";
import type { SourceDef } from "./types";

const BASE = "https://www.planning.data.gov.uk/entity.json";

/** Designations that apply when the property's point falls inside them. */
const AREA_DATASETS = [
  "conservation-area",
  "article-4-direction-area",
  "flood-risk-zone",
  "tree-preservation-zone",
  "green-belt",
  "listed-building-outline",
  "brownfield-land",
  "scheduled-monument",
  "world-heritage-site",
  "local-planning-authority",
];

/** Point datasets worth listing nearby. */
const NEARBY_DATASETS = ["listed-building", "brownfield-land"];

export function boxWkt(lat: number, lng: number, radiusM: number): string {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  const [w, e, s, n] = [lng - dLng, lng + dLng, lat - dLat, lat + dLat].map((v) => v.toFixed(6));
  return `POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`;
}

function parsePoint(wkt: unknown): { lat: number; lng: number } | null {
  const m = /POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/.exec(String(wkt ?? ""));
  return m ? { lng: Number(m[1]), lat: Number(m[2]) } : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Entity = Record<string, any>;

export const planningSource: SourceDef = {
  id: "planning",
  label: "Planning designations",
  attribution: "planning.data.gov.uk, MHCLG — Open Government Licence v3.0. Coverage varies by council.",
  needs: ["latlng"],
  async run(input, ctx) {
    const lat = input.latitude!;
    const lng = input.longitude!;
    const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    const at = await ctx.cached<Entity[]>(`planning:at:${key}`, 30 * 86_400, async () => {
      const qs = new URLSearchParams({ latitude: String(lat), longitude: String(lng), limit: "100", exclude_field: "geometry,point" });
      for (const d of AREA_DATASETS) qs.append("dataset", d);
      const j = await ctx.fetchJson<{ entities: Entity[] }>(`${BASE}?${qs}`, { timeoutMs: 20_000 });
      return j.entities ?? [];
    });
    const nearby = await ctx.cached<Entity[]>(`planning:near:${key}`, 30 * 86_400, async () => {
      const qs = new URLSearchParams({ geometry: boxWkt(lat, lng, 250), geometry_relation: "intersects", limit: "100", exclude_field: "geometry" });
      for (const d of NEARBY_DATASETS) qs.append("dataset", d);
      const j = await ctx.fetchJson<{ entities: Entity[] }>(`${BASE}?${qs}`, { timeoutMs: 20_000 });
      return j.entities ?? [];
    });
    const has = (d: string) => at.filter((e) => e.dataset === d).map((e) => ({ name: e.name || e.reference || null, reference: e.reference ?? null, entity: e.entity }));
    const withDistance = nearby
      .map((e) => {
        const p = parsePoint(e.point);
        return {
          dataset: e.dataset as string,
          name: (e.name || e.reference || "Unnamed") as string,
          grade: e["listed-building-grade"] ?? null,
          hectares: e.hectares ?? null,
          planning_permission_status: e["planning-permission-status"] ?? null,
          entity: e.entity,
          distance_m: p ? Math.round(distanceMetres(lat, lng, p.lat, p.lng)) : null,
        };
      })
      .sort((a, b) => (a.distance_m ?? 9e9) - (b.distance_m ?? 9e9));
    const listedNearby = withDistance.filter((e) => e.dataset === "listed-building");
    return {
      status: "ok",
      data: {
        local_planning_authority: has("local-planning-authority")[0]?.name ?? null,
        conservation_area: has("conservation-area"),
        article_4: has("article-4-direction-area"),
        flood_risk_zone: at.filter((e) => e.dataset === "flood-risk-zone").map((e) => ({ name: e.name || null, level: e["flood-risk-level"] ?? null })),
        tree_preservation_zone: has("tree-preservation-zone"),
        green_belt: has("green-belt").length > 0,
        listed_building_on_site: has("listed-building-outline"),
        scheduled_monument: has("scheduled-monument"),
        world_heritage_site: has("world-heritage-site"),
        on_brownfield_register: has("brownfield-land"),
        listed_buildings_within_250m: listedNearby.length,
        possibly_listed: listedNearby.some((e) => (e.distance_m ?? 999) <= 15),
        nearest_listed: listedNearby.slice(0, 5),
        brownfield_sites_within_250m: withDistance.filter((e) => e.dataset === "brownfield-land").slice(0, 10),
        entity_link_base: "https://www.planning.data.gov.uk/entity/",
      },
    };
  },
};
