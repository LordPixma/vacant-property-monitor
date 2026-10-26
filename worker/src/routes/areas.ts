// Watch areas, postcode area reports, postcode lookups and dashboard statistics.
import { Hono } from "hono";
import { z } from "zod";
import { requireRole } from "../auth";
import { callInsights, runSources } from "../enrich";
import type { AppBindings } from "../env";
import { audit } from "../lib/audit";
import { ACTIVE_STATUSES } from "../lib/enums";
import { isUkish } from "../lib/geo";
import { badRequest, conflict, notFound, rateLimit, readJson } from "../lib/http";
import { newId } from "../lib/ids";
import { normalisePostcode, normalisePrefix, postcodeInPrefix } from "../lib/postcode";
import { loadSettings } from "../lib/settings";
import { SOURCE_META } from "../sources";
import { makeSourceContext } from "../sources/fetch";
import { lookupPostcode } from "../sources/postcodes";
import { GROUP_LABELS, groupNearby, servicesNear } from "../sources/services";
import { syncAreaServices } from "../servicesSync";
import { SERVICE_GROUPS } from "../lib/enums";

const areas = new Hono<AppBindings>();

const areaSchema = z.object({
  name: z.string().trim().min(1).max(100),
  postcode_prefix: z.string().trim().min(2).max(10),
  notes: z.string().trim().max(2000).nullable().optional(),
  active: z.boolean().optional(),
});

areas.get("/areas", async (c) => {
  const open = ACTIVE_STATUSES.map(() => "?").join(",");
  const { results } = await c.env.DB.prepare(
    `SELECT a.*, COUNT(p.id) AS property_count,
            SUM(CASE WHEN p.status IN (${open}) THEN 1 ELSE 0 END) AS open_count,
            SUM(CASE WHEN p.priority_band IN ('critical', 'high') AND p.status IN (${open}) THEN 1 ELSE 0 END) AS urgent_count,
            (SELECT COUNT(*) FROM support_services s WHERE s.watch_area_id = a.id AND s.active = 1) AS service_count
       FROM watch_areas a LEFT JOIN properties p ON p.watch_area_id = a.id AND p.archived = 0
      GROUP BY a.id ORDER BY a.active DESC, a.name`,
  )
    .bind(...ACTIVE_STATUSES, ...ACTIVE_STATUSES)
    .all();
  return c.json({ items: results });
});

/** Geocode a prefix: a full postcode directly, an outcode via postcodes.io's outcode endpoint. */
async function locatePrefix(c: { env: AppBindings["Bindings"] }, prefix: string) {
  const ctx = makeSourceContext(c.env);
  try {
    const full = normalisePostcode(prefix);
    if (full) {
      const pc = await lookupPostcode(full, ctx.fetchJson);
      return pc ? { latitude: pc.latitude, longitude: pc.longitude, local_authority: pc.local_authority } : null;
    }
    const outcode = prefix.split(" ")[0];
    const j = await ctx.fetchJson<{ result: { latitude: number; longitude: number; admin_district: string[] } }>(
      `https://api.postcodes.io/outcodes/${encodeURIComponent(outcode)}`,
    );
    return { latitude: j.result.latitude, longitude: j.result.longitude, local_authority: j.result.admin_district?.join(", ") ?? null };
  } catch (err) {
    console.warn("could not locate area", prefix, err);
    return null;
  }
}

areas.post("/areas", requireRole("coordinator"), async (c) => {
  const body = areaSchema.parse(await readJson(c));
  const p = normalisePrefix(body.postcode_prefix);
  if (!p) throw badRequest("Use an outcode (M14), a sector (M14 5) or a full postcode.");
  const dup = await c.env.DB.prepare("SELECT id FROM watch_areas WHERE postcode_prefix = ?").bind(p.prefix).first();
  if (dup) throw conflict("That area is already watched.");
  const loc = await locatePrefix(c, p.prefix);
  const id = newId();
  const t = Date.now();
  await c.env.DB.prepare(
    "INSERT INTO watch_areas (id, name, postcode_prefix, latitude, longitude, local_authority, notes, active, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, body.name, p.prefix, loc?.latitude ?? null, loc?.longitude ?? null, loc?.local_authority ?? null, body.notes ?? null, body.active === false ? 0 : 1, c.get("user").id, t, t)
    .run();
  // Adopt existing properties that fall inside the new area and have none, or a less specific one.
  const { results } = await c.env.DB.prepare(
    "SELECT p.id, p.postcode, a.postcode_prefix FROM properties p LEFT JOIN watch_areas a ON a.id = p.watch_area_id WHERE p.archived = 0",
  ).all<{ id: string; postcode: string; postcode_prefix: string | null }>();
  const adopt = results.filter((r) => postcodeInPrefix(r.postcode, p.prefix) && (!r.postcode_prefix || r.postcode_prefix.length < p.prefix.length));
  for (let i = 0; i < adopt.length; i += 50) {
    await c.env.DB.batch(adopt.slice(i, i + 50).map((r) => c.env.DB.prepare("UPDATE properties SET watch_area_id = ? WHERE id = ?").bind(id, r.id)));
  }
  await audit(c, "create", "watch_area", id, { prefix: p.prefix, adopted: adopt.length });
  // First try now; the daily cron retries with more time if Overpass is slow.
  if (loc?.latitude != null) {
    c.executionCtx.waitUntil(
      syncAreaServices(c.env, { id, postcode_prefix: p.prefix, latitude: loc.latitude, longitude: loc.longitude ?? null }, 25_000).then(() => undefined),
    );
  }
  return c.json({ id, prefix: p.prefix, adopted: adopt.length }, 201);
});

areas.patch("/areas/:id", requireRole("coordinator"), async (c) => {
  const id = c.req.param("id");
  const body = areaSchema.pick({ name: true, notes: true, active: true }).partial().strict().parse(await readJson(c));
  const updates: Record<string, unknown> = { updated_at: Date.now() };
  if (body.name !== undefined) updates.name = body.name;
  if (body.notes !== undefined) updates.notes = body.notes;
  if (body.active !== undefined) updates.active = body.active ? 1 : 0;
  const cols = Object.keys(updates);
  const res = await c.env.DB.prepare(`UPDATE watch_areas SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .bind(...cols.map((k) => updates[k]), id)
    .run();
  if (!res.meta.changes) throw notFound("Area");
  await audit(c, "update", "watch_area", id, body);
  return c.json({ ok: true });
});

areas.delete("/areas/:id", requireRole("admin"), async (c) => {
  const id = c.req.param("id");
  const res = await c.env.DB.prepare("DELETE FROM watch_areas WHERE id = ?").bind(id).run();
  if (!res.meta.changes) throw notFound("Area");
  await audit(c, "delete", "watch_area", id);
  return c.json({ ok: true });
});

areas.post("/areas/:id/sync-services", requireRole("coordinator"), async (c) => {
  const area = await c.env.DB.prepare("SELECT id, postcode_prefix, latitude, longitude FROM watch_areas WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ id: string; postcode_prefix: string; latitude: number | null; longitude: number | null }>();
  if (!area) throw notFound("Area");
  await rateLimit(c.env.CACHE, `svcsync:${area.id}`, 6, 3600);
  const result = await syncAreaServices(c.env, area, 100_000);
  await audit(c, "sync_services", "watch_area", area.id, result);
  return c.json(result);
});

// ---------- support services directory ----------

areas.get("/services", async (c) => {
  const q = c.req.query();
  if (q.near) {
    const [lat, lng] = q.near.split(",").map(Number);
    if (!isUkish(lat, lng)) throw badRequest("near must be lat,lng in the UK");
    const radius = Math.min(Number(q.radius) || 1500, 10_000);
    const rows = await servicesNear(c.env, lat, lng, radius);
    return c.json({ radius_m: radius, groups: groupNearby(rows, lat, lng, radius) });
  }
  const where = ["1 = 1"];
  const args: unknown[] = [];
  if (q.area) {
    where.push("watch_area_id = ?");
    args.push(q.area);
  }
  if (q.group) {
    where.push("group_key = ?");
    args.push(q.group);
  }
  if (q.source === "manual" || q.source === "osm") {
    where.push("source = ?");
    args.push(q.source);
  }
  if (q.q) {
    where.push("(name LIKE ? OR address LIKE ? OR notes LIKE ?)");
    const t = `%${q.q.replace(/[%_]/g, "")}%`;
    args.push(t, t, t);
  }
  if (q.transport !== "1" && !q.group) where.push("group_key != 'transport'");
  const { results } = await c.env.DB.prepare(
    `SELECT s.*, a.name AS area_name FROM support_services s LEFT JOIN watch_areas a ON a.id = s.watch_area_id WHERE ${where.join(" AND ")}
      ORDER BY s.source = 'manual' DESC, s.group_key, s.name LIMIT 1000`,
  )
    .bind(...args)
    .all();
  return c.json({ items: results, labels: GROUP_LABELS });
});

const serviceSchema = z.object({
  name: z.string().trim().min(1).max(200),
  group_key: z.enum(SERVICE_GROUPS),
  kind: z.string().trim().max(60).nullable().optional(),
  postcode: z.string().trim().max(10).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  website: z.string().trim().url().max(300).nullable().optional(),
  opening_hours: z.string().trim().max(300).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

areas.post("/services", requireRole("coordinator"), async (c) => {
  const body = serviceSchema.parse(await readJson(c));
  let lat = body.latitude ?? null;
  let lng = body.longitude ?? null;
  if (lat === null || lng === null) {
    const pc = body.postcode ? normalisePostcode(body.postcode) : null;
    if (!pc) throw badRequest("Give a postcode or a map location.");
    const ctx = makeSourceContext(c.env);
    const found = await ctx.cached(`postcode:${pc}`, 30 * 86_400, () => lookupPostcode(pc, ctx.fetchJson));
    if (!found?.latitude) throw badRequest("Postcode not found.");
    lat = found.latitude;
    lng = found.longitude;
  }
  const id = newId();
  const t = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO support_services (id, source, group_key, name, kind, latitude, longitude, address, phone, website, opening_hours, notes, created_by, created_at, updated_at)
     VALUES (?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, body.group_key, body.name, body.kind ?? null, lat, lng, body.address ?? (body.postcode ? normalisePostcode(body.postcode) : null), body.phone ?? null, body.website ?? null, body.opening_hours ?? null, body.notes ?? null, c.get("user").id, t, t)
    .run();
  await audit(c, "create", "support_service", id, { name: body.name, group: body.group_key });
  return c.json({ id }, 201);
});

areas.patch("/services/:id", requireRole("coordinator"), async (c) => {
  const id = c.req.param("id");
  const body = z.object({ active: z.boolean().optional(), notes: z.string().trim().max(2000).nullable().optional(), phone: z.string().trim().max(40).nullable().optional(), opening_hours: z.string().trim().max(300).nullable().optional() }).strict().parse(await readJson(c));
  const updates: Record<string, unknown> = { updated_at: Date.now() };
  for (const [k, v] of Object.entries(body)) if (v !== undefined) updates[k] = k === "active" ? (v ? 1 : 0) : v;
  const cols = Object.keys(updates);
  const res = await c.env.DB.prepare(`UPDATE support_services SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).bind(...cols.map((k) => updates[k]), id).run();
  if (!res.meta.changes) throw notFound("Service");
  await audit(c, "update", "support_service", id, body);
  return c.json({ ok: true });
});

areas.delete("/services/:id", requireRole("coordinator"), async (c) => {
  const id = c.req.param("id");
  // OpenStreetMap entries come back on the next sync, so they are hidden rather than deleted.
  const res = await c.env.DB.prepare("DELETE FROM support_services WHERE id = ? AND source = 'manual'").bind(id).run();
  if (!res.meta.changes) throw badRequest("Only services added by hand can be deleted. Hide OpenStreetMap entries instead.");
  await audit(c, "delete", "support_service", id);
  return c.json({ ok: true });
});

/** Full public-data report for any postcode, whether or not a property is recorded there. */
areas.get("/area-report", async (c) => {
  const postcode = normalisePostcode(c.req.query("postcode") ?? "");
  if (!postcode) throw badRequest("Enter a full UK postcode.");
  await rateLimit(c.env.CACHE, `report:${c.get("user").id}`, 60, 3600);
  const settings = await loadSettings(c.env);
  const { runs, postcode: pc } = await runSources(c.env, { postcode, addressLine1: null, latitude: null, longitude: null }, settings);
  if (!pc) throw notFound("Postcode");
  const enrichment: Record<string, unknown> = {};
  for (const r of runs) if (r.status === "ok" || r.status === "empty") enrichment[r.source] = r.data;
  const insights = await callInsights(c.env, "/v1/area", { enrichment });
  const meta = Object.fromEntries(SOURCE_META.map((s) => [s.id, s]));
  const { results: properties } = await c.env.DB.prepare(
    "SELECT id, address_line1, status, priority_band, category FROM properties WHERE postcode = ? AND archived = 0 ORDER BY address_line1",
  )
    .bind(postcode)
    .all();
  return c.json({
    postcode,
    location: { latitude: pc.latitude, longitude: pc.longitude },
    sources: runs.map((r) => ({ ...r, label: meta[r.source]?.label, attribution: meta[r.source]?.attribution })),
    area_profile: insights?.area_profile ?? null,
    properties,
  });
});

/** Lightweight lookup for forms: validate and geocode a postcode. */
areas.get("/lookup/postcode/:pc", async (c) => {
  const postcode = normalisePostcode(c.req.param("pc"));
  if (!postcode) throw badRequest("That is not a valid UK postcode.");
  const ctx = makeSourceContext(c.env);
  const pc = await ctx.cached(`postcode:${postcode}`, 30 * 86_400, () => lookupPostcode(postcode, ctx.fetchJson));
  if (!pc) throw notFound("Postcode");
  return c.json(pc);
});

/** Nearest postcode to a GPS fix, so a field worker does not have to type one. */
areas.get("/lookup/reverse", async (c) => {
  const lat = Number(c.req.query("lat"));
  const lng = Number(c.req.query("lng"));
  if (!isUkish(lat, lng)) throw badRequest("Location is outside the UK.");
  const ctx = makeSourceContext(c.env);
  const j = await ctx.fetchJson<{ result: { postcode: string; distance: number; admin_district: string; admin_ward: string }[] | null }>(
    `https://api.postcodes.io/postcodes?lon=${lng}&lat=${lat}&radius=300&limit=5`,
  );
  return c.json({ items: (j.result ?? []).map((r) => ({ postcode: r.postcode, distance_m: Math.round(r.distance), local_authority: r.admin_district, ward: r.admin_ward })) });
});

areas.get("/stats", async (c) => {
  const db = c.env.DB;
  const monthAgo = Date.now() - 30 * 86_400_000;
  const open = ACTIVE_STATUSES.map(() => "?").join(",");
  const [byStatus, byBand, byCategory, recent, visits30, tasks, monthsVacant, enrichment, timeline] = await Promise.all([
    db.prepare("SELECT status, COUNT(*) AS n FROM properties WHERE archived = 0 GROUP BY status").all<{ status: string; n: number }>(),
    db.prepare(`SELECT priority_band AS band, COUNT(*) AS n FROM properties WHERE archived = 0 AND status IN (${open}) GROUP BY priority_band`).bind(...ACTIVE_STATUSES).all(),
    db.prepare(`SELECT category, COUNT(*) AS n FROM properties WHERE archived = 0 AND status IN (${open}) GROUP BY category`).bind(...ACTIVE_STATUSES).all(),
    db.prepare("SELECT COUNT(*) AS n FROM properties WHERE archived = 0 AND created_at > ?").bind(monthAgo).first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS workers FROM visits WHERE visited_at > ?").bind(monthAgo).first<{ n: number; workers: number }>(),
    db
      .prepare(
        "SELECT SUM(CASE WHEN status IN ('open','in_progress') THEN 1 ELSE 0 END) AS open, SUM(CASE WHEN status IN ('open','in_progress') AND due_at < ? THEN 1 ELSE 0 END) AS overdue FROM tasks",
      )
      .bind(Date.now())
      .first<{ open: number; overdue: number }>(),
    db
      .prepare(`SELECT AVG(json_extract(insights, '$.months_vacant')) AS avg FROM properties WHERE archived = 0 AND status IN (${open}) AND json_extract(insights, '$.months_vacant') IS NOT NULL`)
      .bind(...ACTIVE_STATUSES)
      .first<{ avg: number | null }>(),
    db.prepare("SELECT enrichment_status AS status, COUNT(*) AS n FROM properties WHERE archived = 0 GROUP BY enrichment_status").all(),
    db
      .prepare(
        "SELECT strftime('%Y-%m', created_at / 1000, 'unixepoch') AS month, COUNT(*) AS n FROM properties WHERE archived = 0 AND created_at > ? GROUP BY month ORDER BY month",
      )
      .bind(Date.now() - 365 * 86_400_000)
      .all(),
  ]);
  const statusCounts = Object.fromEntries(byStatus.results.map((r) => [r.status, r.n]));
  const openTotal = ACTIVE_STATUSES.reduce((n, s) => n + (statusCounts[s] ?? 0), 0);
  const backInUse = await db
    .prepare("SELECT COUNT(*) AS n FROM properties WHERE archived = 0 AND status = 'brought_back_into_use' AND updated_at > ?")
    .bind(monthAgo)
    .first<{ n: number }>();
  return c.json({
    open_cases: openTotal,
    by_status: statusCounts,
    by_band: byBand.results,
    by_category: byCategory.results,
    new_last_30_days: recent?.n ?? 0,
    brought_back_last_30_days: backInUse?.n ?? 0,
    visits_last_30_days: visits30?.n ?? 0,
    active_workers_last_30_days: visits30?.workers ?? 0,
    open_tasks: tasks?.open ?? 0,
    overdue_tasks: tasks?.overdue ?? 0,
    avg_months_vacant: monthsVacant?.avg ? Math.round(monthsVacant.avg * 10) / 10 : null,
    enrichment: enrichment.results,
    new_by_month: timeline.results,
  });
});

export default areas;
