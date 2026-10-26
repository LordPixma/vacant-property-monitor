import type { Env } from "./env";
import { loadSettings, type AppSettings } from "./lib/settings";
import { makeSourceContext } from "./sources/fetch";
import type { PostcodeData } from "./sources/postcodes";
import { SOURCES } from "./sources";
import type { SourceContext, SourceInput, SourceResult } from "./sources/types";

/**
 * Time budgets for one enrichment. waitUntil work is cut off about 30 s after the response,
 * so a property saved through the API gets 20 s; the cron has minutes to spare.
 */
export const BUDGET = { background: 20_000, request: 40_000, cron: 60_000 };

export interface SourceRun extends SourceResult {
  source: string;
  duration_ms: number;
}

/**
 * Run every public-data source for a postcode (and optionally one address in it).
 * The postcode source runs first because it supplies coordinates and the LSOA;
 * the rest run in parallel and fail independently.
 */
export async function runSources(
  env: Env,
  base: { postcode: string; addressLine1: string | null; latitude: number | null; longitude: number | null },
  settings: AppSettings,
  { budgetMs = BUDGET.request, ctx = makeSourceContext(env) }: { budgetMs?: number; ctx?: SourceContext } = {},
): Promise<{ runs: SourceRun[]; postcode: PostcodeData | null }> {
  const deadline = Date.now() + budgetMs;
  const input: SourceInput = { ...base, lsoaCode: null, radiusM: settings.area_radius_m };
  const runs: SourceRun[] = [];

  const timed = async (def: (typeof SOURCES)[number]): Promise<SourceRun> => {
    const missing = def.needs.find((n) => (n === "latlng" && (input.latitude === null || input.longitude === null)) || (n === "lsoa" && !input.lsoaCode));
    if (missing) return { source: def.id, status: "skipped", error: `Needs ${missing}, which is not known.`, duration_ms: 0 };
    const t = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Whatever has not answered by the deadline is recorded as an error and retried by the sweep.
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out; will retry on the next sweep.")), Math.max(1000, deadline - Date.now()));
      });
      const r = await Promise.race([def.run(input, ctx), expired]);
      return { source: def.id, ...r, duration_ms: Date.now() - t };
    } catch (err) {
      return { source: def.id, status: "error", error: err instanceof Error ? err.message : String(err), duration_ms: Date.now() - t };
    } finally {
      clearTimeout(timer);
    }
  };

  const [first, ...rest] = SOURCES;
  const pcRun = await timed(first);
  runs.push(pcRun);
  const postcode = pcRun.status === "ok" ? (pcRun.data as PostcodeData) : null;
  if (postcode) {
    if (input.latitude === null || input.longitude === null) {
      input.latitude = postcode.latitude;
      input.longitude = postcode.longitude;
    }
    input.lsoaCode = postcode.lsoa_code;
  }
  runs.push(...(await Promise.all(rest.map(timed))));
  return { runs, postcode };
}

export function enrichmentMap(rows: { source: string; status: string; data: string | null }[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of rows) if ((r.status === "ok" || r.status === "empty") && r.data) out[r.source] = JSON.parse(r.data);
  return out;
}

/** Ask the Python insights Worker for a score. Returns null (and logs) when it is unreachable. */
export async function callInsights(env: Env, path: "/v1/assess" | "/v1/area", payload: unknown): Promise<Record<string, unknown> | null> {
  if (!env.INSIGHTS) return null;
  try {
    const res = await env.INSIGHTS.fetch(`https://insights${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error("insights returned", res.status, (await res.text()).slice(0, 300));
      return null;
    }
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.error("insights unreachable", err);
    return null;
  }
}

interface PropertyRow {
  id: string;
  address_line1: string;
  postcode: string;
  latitude: number | null;
  longitude: number | null;
  location_source: string | null;
  status: string;
  category: string;
  condition: string | null;
  security: string | null;
  vacant_since: string | null;
  property_type: string | null;
  created_at: number;
  last_visited_at: number | null;
}

/** Recompute priority from stored enrichment and visits. Cheap: no public API calls. */
export async function rescoreProperty(env: Env, propertyId: string, settings?: AppSettings): Promise<boolean> {
  const s = settings ?? (await loadSettings(env));
  const prop = await env.DB.prepare("SELECT * FROM properties WHERE id = ?").bind(propertyId).first<PropertyRow>();
  if (!prop) return false;
  const [{ results: enr }, { results: visits }] = await Promise.all([
    env.DB.prepare("SELECT source, status, data FROM enrichment WHERE property_id = ?").bind(propertyId).all<{ source: string; status: string; data: string | null }>(),
    env.DB.prepare("SELECT visited_at, observed_status, condition, security, signals FROM visits WHERE property_id = ? ORDER BY visited_at DESC LIMIT 10")
      .bind(propertyId)
      .all<{ visited_at: number; observed_status: string | null; condition: string | null; security: string | null; signals: string }>(),
  ]);
  const result = await callInsights(env, "/v1/assess", {
    property: {
      status: prop.status,
      category: prop.category,
      condition: prop.condition,
      security: prop.security,
      vacant_since: prop.vacant_since,
      property_type: prop.property_type,
      created_at: prop.created_at,
      last_visited_at: prop.last_visited_at,
    },
    visits: visits.map((v) => ({ ...v, signals: JSON.parse(v.signals || "[]") })),
    enrichment: enrichmentMap(enr),
    settings: { revisit_after_days: s.revisit_after_days },
    now: Date.now(),
  });
  if (!result) return false;
  await env.DB.prepare("UPDATE properties SET priority_score = ?, priority_band = ?, vacancy_likelihood = ?, insights = ? WHERE id = ?")
    .bind(result.priority_score ?? null, result.priority_band ?? null, result.vacancy_likelihood ?? null, JSON.stringify(result), propertyId)
    .run();
  return true;
}

/** Fetch all public data for one property, store it, then rescore. Never throws. */
export async function enrichProperty(env: Env, propertyId: string, budgetMs = BUDGET.background): Promise<"complete" | "partial" | "failed" | "missing"> {
  try {
    const settings = await loadSettings(env);
    const prop = await env.DB.prepare("SELECT * FROM properties WHERE id = ?").bind(propertyId).first<PropertyRow>();
    if (!prop) return "missing";
    await env.DB.prepare("UPDATE properties SET enrichment_status = 'running', last_enriched_at = ? WHERE id = ?").bind(Date.now(), propertyId).run();

    const { runs, postcode } = await runSources(
      env,
      { postcode: prop.postcode, addressLine1: prop.address_line1, latitude: prop.latitude, longitude: prop.longitude },
      settings,
      { budgetMs },
    );
    const t = Date.now();
    const stmts = runs.map((r) =>
      env.DB.prepare(
        `INSERT INTO enrichment (property_id, source, status, data, error, fetched_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (property_id, source) DO UPDATE SET status = excluded.status, data = excluded.data, error = excluded.error,
           fetched_at = excluded.fetched_at, duration_ms = excluded.duration_ms`,
      ).bind(propertyId, r.source, r.status, r.data === undefined ? null : JSON.stringify(r.data), r.error ?? null, t, r.duration_ms),
    );
    const errors = runs.filter((r) => r.status === "error").length;
    const status = !postcode ? "failed" : errors ? "partial" : "complete";
    // Fill in coordinates from the postcode centroid only when nobody has pinned the property.
    if (postcode && (prop.latitude === null || prop.longitude === null) && postcode.latitude !== null) {
      stmts.push(
        env.DB.prepare("UPDATE properties SET latitude = ?, longitude = ?, location_source = 'postcode' WHERE id = ? AND latitude IS NULL").bind(
          postcode.latitude,
          postcode.longitude,
          propertyId,
        ),
      );
    }
    stmts.push(env.DB.prepare("UPDATE properties SET enrichment_status = ?, last_enriched_at = ? WHERE id = ?").bind(status, t, propertyId));
    await env.DB.batch(stmts);
    await rescoreProperty(env, propertyId, settings);
    return status;
  } catch (err) {
    console.error("enrichment failed", propertyId, err);
    try {
      await env.DB.prepare("UPDATE properties SET enrichment_status = 'failed', last_enriched_at = ? WHERE id = ?").bind(Date.now(), propertyId).run();
    } catch {
      /* already logged */
    }
    return "failed";
  }
}

/** Cron: enrich new properties and refresh stale ones, a bounded batch at a time. */
export async function enrichmentSweep(env: Env, batch = 10) {
  const settings = await loadSettings(env);
  const staleBefore = Date.now() - settings.enrichment_stale_days * 86_400_000;
  // 'running' for over ten minutes means a Worker was cut off mid-run; pick it up again.
  // 'partial' and 'failed' are retried after an hour, which covers a flaky upstream.
  const { results } = await env.DB.prepare(
    `SELECT id FROM properties
      WHERE archived = 0 AND (
        enrichment_status = 'pending'
        OR (enrichment_status IN ('failed', 'partial') AND (last_enriched_at IS NULL OR last_enriched_at < ?))
        OR (enrichment_status = 'running' AND (last_enriched_at IS NULL OR last_enriched_at < ?))
        OR last_enriched_at < ?)
      ORDER BY CASE enrichment_status WHEN 'pending' THEN 0 ELSE 1 END, COALESCE(last_enriched_at, 0)
      LIMIT ?`,
  )
    .bind(Date.now() - 3_600_000, Date.now() - 600_000, staleBefore, batch)
    .all<{ id: string }>();
  const outcome: Record<string, number> = {};
  for (const r of results) {
    const s = await enrichProperty(env, r.id, BUDGET.cron);
    outcome[s] = (outcome[s] ?? 0) + 1;
  }
  return { processed: results.length, outcome };
}
