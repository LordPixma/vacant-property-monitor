// Fills the support-services directory from OpenStreetMap, one watch area at a time.
import type { Env } from "./env";
import { makeSourceContext } from "./sources/fetch";
import { OVERPASS, osmToRows, overpassQuery, upsertOsmRows, type OsmElement } from "./sources/services";

/** Search radius for an area, by how specific its prefix is. */
export function areaRadius(prefix: string): number {
  if (/^\S+ \d[A-Z]{2}$/.test(prefix)) return 1000; // full postcode
  if (prefix.includes(" ")) return 1500; // sector
  return 3000; // outcode
}

interface AreaRow {
  id: string;
  postcode_prefix: string;
  latitude: number | null;
  longitude: number | null;
}

export async function syncAreaServices(env: Env, area: AreaRow, budgetMs: number): Promise<{ ok: boolean; count?: number; error?: string }> {
  if (area.latitude === null || area.longitude === null) return { ok: false, error: "Area has no location." };
  const ctx = makeSourceContext(env);
  const deadline = Date.now() + budgetMs;
  const body = `data=${encodeURIComponent(overpassQuery(area.latitude, area.longitude, areaRadius(area.postcode_prefix)))}`;
  const errors: string[] = [];
  let elements: OsmElement[] | null = null;
  for (const url of OVERPASS) {
    const remaining = deadline - Date.now();
    if (remaining < 5000) break;
    try {
      const j = await ctx.fetchJson<{ elements: OsmElement[] }>(url, {
        method: "POST",
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        timeoutMs: Math.min(45_000, remaining),
      });
      elements = j.elements ?? [];
      break;
    } catch (err) {
      errors.push(`${new URL(url).hostname}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const t = Date.now();
  if (!elements) {
    const error = errors.join("; ") || "Out of time before any Overpass instance answered.";
    await env.DB.prepare("UPDATE watch_areas SET services_sync_error = ? WHERE id = ?").bind(error.slice(0, 500), area.id).run();
    return { ok: false, error };
  }
  const rows = osmToRows(elements);
  await upsertOsmRows(env, rows, area.id, t);
  // OSM entries for this area that were not in this pull have closed or been removed.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM support_services WHERE source = 'osm' AND watch_area_id = ? AND updated_at < ?").bind(area.id, t),
    env.DB.prepare("UPDATE watch_areas SET services_synced_at = ?, services_sync_error = NULL WHERE id = ?").bind(t, area.id),
  ]);
  return { ok: true, count: rows.length };
}

/** Daily: refresh areas not synced for a week, oldest first, a few per run. */
export async function servicesSweep(env: Env, maxAreas = 3) {
  const weekAgo = Date.now() - 7 * 86_400_000;
  const { results } = await env.DB.prepare(
    `SELECT id, postcode_prefix, latitude, longitude FROM watch_areas
      WHERE active = 1 AND latitude IS NOT NULL AND (services_synced_at IS NULL OR services_synced_at < ?)
      ORDER BY COALESCE(services_synced_at, 0) LIMIT ?`,
  )
    .bind(weekAgo, maxAreas)
    .all<AreaRow>();
  const out: Record<string, unknown> = {};
  for (const a of results) out[a.postcode_prefix] = await syncAreaServices(env, a, 120_000);
  return out;
}
