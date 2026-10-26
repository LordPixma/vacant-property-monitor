import { Hono } from "hono";
import { z } from "zod";
import { hasRole, requireRole } from "../auth";
import { BUDGET, enrichProperty, rescoreProperty } from "../enrich";
import type { AppBindings } from "../env";
import { normaliseAddress } from "../lib/address";
import { audit, diff } from "../lib/audit";
import { ACTIVE_STATUSES, CATEGORIES, CONDITIONS, LOCATION_SOURCES, PRIORITY_BANDS, PROPERTY_TYPES, SECURITY, SOURCES as PROPERTY_SOURCES, STATUSES } from "../lib/enums";
import { boundingBox, distanceMetres, isUkish } from "../lib/geo";
import { badRequest, conflict, forbidden, notFound, rateLimit, readJson } from "../lib/http";
import { newId } from "../lib/ids";
import { normalisePostcode, bestPrefixMatch } from "../lib/postcode";
import { SOURCE_META } from "../sources";

const props = new Hono<AppBindings>();

const LIST_COLUMNS = `p.id, p.address_line1, p.address_line2, p.town, p.postcode, p.latitude, p.longitude, p.category, p.property_type,
  p.status, p.condition, p.security, p.priority_score, p.priority_band, p.vacancy_likelihood, p.vacant_since, p.watch_area_id,
  p.assigned_to, p.last_visited_at, p.enrichment_status, p.source, p.created_at, p.updated_at,
  a.name AS area_name, u.name AS assignee_name`;

const isoDate = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, "Use YYYY-MM or YYYY-MM-DD");
const optText = (max: number) => z.string().trim().max(max).nullable().optional();

const baseFields = {
  address_line1: z.string().trim().min(1).max(200),
  address_line2: optText(200),
  town: optText(100),
  postcode: z.string().trim().min(5).max(10),
  uprn: z.string().regex(/^\d{1,12}$/).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  location_source: z.enum(LOCATION_SOURCES).nullable().optional(),
  category: z.enum(CATEGORIES).optional(),
  property_type: z.enum(PROPERTY_TYPES).nullable().optional(),
  status: z.enum(STATUSES).optional(),
  condition: z.enum(CONDITIONS).nullable().optional(),
  security: z.enum(SECURITY).nullable().optional(),
  bedrooms: z.number().int().min(0).max(50).nullable().optional(),
  vacant_since: isoDate.nullable().optional(),
  owner_info: optText(2000),
  description: optText(5000),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  source_ref: optText(200),
  assigned_to: z.string().max(40).nullable().optional(),
  watch_area_id: z.string().max(40).nullable().optional(),
};

const createSchema = z.object({
  ...baseFields,
  source: z.enum(PROPERTY_SOURCES).optional(),
  client_id: z.string().min(8).max(64).optional(),
  force: z.boolean().optional(),
});

// PATCH: every key optional, and absent keys stay absent (no defaults to fire).
const patchSchema = z.object(Object.fromEntries(Object.entries(baseFields).map(([k, v]) => [k, v.optional()]))).extend({ archived: z.boolean().optional() }).strict();

/** Fields only a coordinator or admin may set. */
const COORDINATOR_FIELDS = ["owner_info", "assigned_to", "watch_area_id", "archived"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function present(row: any, canSeeOwner: boolean) {
  if (!row) return row;
  const out = { ...row, tags: row.tags ? JSON.parse(row.tags) : [] };
  if ("insights" in out) out.insights = row.insights ? JSON.parse(row.insights) : null;
  if (!canSeeOwner) delete out.owner_info;
  return out;
}

async function activeAreas(db: D1Database) {
  return (await db.prepare("SELECT id, postcode_prefix FROM watch_areas WHERE active = 1").all<{ id: string; postcode_prefix: string }>()).results;
}

props.get("/", async (c) => {
  const q = c.req.query();
  const where: string[] = ["p.archived = 0"];
  const args: unknown[] = [];
  const list = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

  const statuses = list(q.status).filter((s) => (STATUSES as readonly string[]).includes(s));
  if (q.open === "1") statuses.push(...ACTIVE_STATUSES);
  if (statuses.length) {
    where.push(`p.status IN (${statuses.map(() => "?").join(",")})`);
    args.push(...new Set(statuses));
  }
  const cats = list(q.category).filter((s) => (CATEGORIES as readonly string[]).includes(s));
  if (cats.length) {
    where.push(`p.category IN (${cats.map(() => "?").join(",")})`);
    args.push(...cats);
  }
  const bands = list(q.band).filter((s) => (PRIORITY_BANDS as readonly string[]).includes(s));
  if (bands.length) {
    where.push(`p.priority_band IN (${bands.map(() => "?").join(",")})`);
    args.push(...bands);
  }
  if (q.area) {
    where.push("p.watch_area_id = ?");
    args.push(q.area);
  }
  if (q.assigned === "me") {
    where.push("p.assigned_to = ?");
    args.push(c.get("user").id);
  } else if (q.assigned) {
    where.push("p.assigned_to = ?");
    args.push(q.assigned);
  }
  if (q.q) {
    const term = `%${q.q.trim().replace(/[%_]/g, "")}%`;
    where.push("(p.address_line1 LIKE ? OR p.address_line2 LIKE ? OR p.postcode LIKE ? OR p.town LIKE ? OR p.source_ref LIKE ?)");
    args.push(term, term, term.replace(/\s/g, "%"), term, term);
  }
  let near: { lat: number; lng: number; radius: number } | null = null;
  if (q.near) {
    const [lat, lng] = q.near.split(",").map(Number);
    const radius = Math.min(Number(q.radius) || 2000, 50_000);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !isUkish(lat, lng)) throw badRequest("near must be lat,lng in the UK");
    near = { lat, lng, radius };
    const b = boundingBox(lat, lng, radius);
    where.push("p.latitude BETWEEN ? AND ? AND p.longitude BETWEEN ? AND ?");
    args.push(b.minLat, b.maxLat, b.minLng, b.maxLng);
  }
  const sorts: Record<string, string> = {
    priority: "COALESCE(p.priority_score, -1) DESC, p.updated_at DESC",
    updated: "p.updated_at DESC",
    created: "p.created_at DESC",
    visited: "COALESCE(p.last_visited_at, 0) ASC",
    postcode: "p.postcode ASC, p.address_line1 ASC",
  };
  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 1000);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const sql = `SELECT ${LIST_COLUMNS} FROM properties p
    LEFT JOIN watch_areas a ON a.id = p.watch_area_id LEFT JOIN users u ON u.id = p.assigned_to
    WHERE ${where.join(" AND ")} ORDER BY ${sorts[q.sort] ?? sorts.priority} LIMIT ? OFFSET ?`;
  const countSql = `SELECT COUNT(*) AS n FROM properties p WHERE ${where.join(" AND ")}`;
  const [rows, count] = await Promise.all([
    c.env.DB.prepare(sql).bind(...args, near ? 5000 : limit, near ? 0 : offset).all(),
    c.env.DB.prepare(countSql).bind(...args).first<{ n: number }>(),
  ]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let items = rows.results.map((r: any) => present(r, false));
  let total = count?.n ?? 0;
  if (near) {
    items = items
      .map((r) => ({ ...r, distance_m: Math.round(distanceMetres(near!.lat, near!.lng, r.latitude, r.longitude)) }))
      .filter((r) => r.distance_m <= near!.radius)
      .sort((a, b) => a.distance_m - b.distance_m);
    total = items.length;
    items = items.slice(offset, offset + limit);
  }
  return c.json({ items, total, limit, offset });
});

/** Everything the map needs, in one small payload. */
props.get("/map", async (c) => {
  const includeClosed = c.req.query("closed") === "1";
  const { results } = await c.env.DB.prepare(
    `SELECT id, address_line1, postcode, latitude, longitude, status, category, priority_band, priority_score
       FROM properties WHERE archived = 0 AND latitude IS NOT NULL ${includeClosed ? "" : "AND status NOT IN ('occupied', 'brought_back_into_use', 'demolished')"}
      LIMIT 5000`,
  ).all();
  return c.json({ items: results });
});

props.get("/:id", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const row = await c.env.DB.prepare(
    `SELECT p.*, a.name AS area_name, u.name AS assignee_name, cu.name AS created_by_name FROM properties p
       LEFT JOIN watch_areas a ON a.id = p.watch_area_id LEFT JOIN users u ON u.id = p.assigned_to LEFT JOIN users cu ON cu.id = p.created_by
      WHERE p.id = ?`,
  )
    .bind(id)
    .first();
  if (!row) throw notFound("Property");
  const [visits, photos, tasks, enrichment, history] = await Promise.all([
    c.env.DB.prepare(
      "SELECT v.*, u.name AS user_name FROM visits v LEFT JOIN users u ON u.id = v.user_id WHERE v.property_id = ? ORDER BY v.visited_at DESC LIMIT 100",
    )
      .bind(id)
      .all(),
    c.env.DB.prepare("SELECT id, visit_id, caption, content_type, size_bytes, created_at, uploaded_by FROM photos WHERE property_id = ? ORDER BY created_at DESC LIMIT 200")
      .bind(id)
      .all(),
    c.env.DB.prepare(
      "SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to WHERE t.property_id = ? ORDER BY t.status = 'done', t.due_at",
    )
      .bind(id)
      .all(),
    c.env.DB.prepare("SELECT source, status, data, error, fetched_at, duration_ms FROM enrichment WHERE property_id = ?").bind(id).all(),
    c.env.DB.prepare(
      "SELECT l.action, l.detail, l.created_at, u.name AS user_name FROM audit_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.entity = 'property' AND l.entity_id = ? ORDER BY l.created_at DESC LIMIT 50",
    )
      .bind(id)
      .all(),
  ]);
  const meta = Object.fromEntries(SOURCE_META.map((s) => [s.id, s]));
  return c.json({
    property: present(row, hasRole(user, "coordinator")),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    visits: visits.results.map((v: any) => ({ ...v, signals: JSON.parse(v.signals || "[]") })),
    photos: photos.results,
    tasks: tasks.results,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    enrichment: enrichment.results.map((e: any) => ({ ...e, data: e.data ? JSON.parse(e.data) : null, label: meta[e.source]?.label, attribution: meta[e.source]?.attribution })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    history: history.results.map((h: any) => ({ ...h, detail: h.detail ? JSON.parse(h.detail) : null })),
  });
});

props.post("/", requireRole("field_worker"), async (c) => {
  const body = createSchema.parse(await readJson(c));
  const user = c.get("user");
  const postcode = normalisePostcode(body.postcode);
  if (!postcode) throw badRequest("That is not a valid UK postcode.");
  if (body.client_id) {
    const existing = await c.env.DB.prepare("SELECT id FROM properties WHERE client_id = ?").bind(body.client_id).first<{ id: string }>();
    if (existing) return c.json({ id: existing.id, duplicate: true, replay: true });
  }
  if (!body.force) {
    const { results } = await c.env.DB.prepare("SELECT id, address_line1, address_line2 FROM properties WHERE postcode = ? AND archived = 0")
      .bind(postcode)
      .all<{ id: string; address_line1: string; address_line2: string | null }>();
    const ours = normaliseAddress(`${body.address_line1} ${body.address_line2 ?? ""}`);
    const dup = results.find((r) => normaliseAddress(`${r.address_line1} ${r.address_line2 ?? ""}`) === ours);
    if (dup) throw conflict("This property is already on the register.", { id: dup.id });
  }
  if (body.latitude != null && body.longitude != null && !isUkish(body.latitude, body.longitude)) throw badRequest("Location is outside the UK.");
  const isCoord = hasRole(user, "coordinator");
  if (!isCoord && (body.owner_info || body.assigned_to || body.watch_area_id)) throw forbidden("Only coordinators can set owner details, assignee or area.");
  const area = body.watch_area_id ? { id: body.watch_area_id } : bestPrefixMatch(postcode, await activeAreas(c.env.DB));
  const id = newId();
  const t = Date.now();
  const hasPin = body.latitude != null && body.longitude != null;
  const source = body.source ?? (user.role === "field_worker" ? "field" : "admin");
  await c.env.DB.prepare(
    `INSERT INTO properties (id, client_id, address_line1, address_line2, town, postcode, uprn, latitude, longitude, location_source, category, property_type,
       status, condition, security, bedrooms, vacant_since, owner_info, description, tags, source, source_ref, watch_area_id, assigned_to, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      body.client_id ?? null,
      body.address_line1,
      body.address_line2 ?? null,
      body.town ?? null,
      postcode,
      body.uprn ?? null,
      hasPin ? body.latitude : null,
      hasPin ? body.longitude : null,
      hasPin ? body.location_source ?? "gps" : null,
      body.category ?? "unknown",
      body.property_type ?? null,
      body.status ?? "reported",
      body.condition ?? null,
      body.security ?? null,
      body.bedrooms ?? null,
      body.vacant_since ?? null,
      body.owner_info ?? null,
      body.description ?? null,
      JSON.stringify(body.tags ?? []),
      source,
      body.source_ref ?? null,
      area?.id ?? null,
      body.assigned_to ?? null,
      user.id,
      t,
      t,
    )
    .run();
  await audit(c, "create", "property", id, { address: body.address_line1, postcode, status: body.status ?? "reported" });
  c.executionCtx.waitUntil(enrichProperty(c.env, id));
  return c.json({ id }, 201);
});

props.patch("/:id", requireRole("field_worker"), async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const body = patchSchema.parse(await readJson(c)) as Record<string, unknown>;
  if (!hasRole(user, "coordinator") && COORDINATOR_FIELDS.some((f) => f in body)) throw forbidden("Only coordinators can change owner details, assignee, area or archive.");
  const before = await c.env.DB.prepare("SELECT * FROM properties WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!before) throw notFound("Property");
  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    if (k === "postcode") {
      const pc = normalisePostcode(String(v));
      if (!pc) throw badRequest("That is not a valid UK postcode.");
      updates.postcode = pc;
    } else if (k === "tags") updates.tags = JSON.stringify(v);
    else if (k === "archived") updates.archived = v ? 1 : 0;
    else updates[k] = v;
  }
  // Forms send every field; keep only what actually changed so edits do not re-trigger enrichment.
  for (const k of Object.keys(updates)) if (JSON.stringify(updates[k] ?? null) === JSON.stringify(before[k] ?? null)) delete updates[k];
  if (!Object.keys(updates).length) return c.json({ ok: true, changed: {} });
  const locationChanged = "postcode" in updates && updates.postcode !== before.postcode;
  if (locationChanged) {
    updates.enrichment_status = "pending";
    if (!("latitude" in updates) && before.location_source === "postcode") {
      updates.latitude = null;
      updates.longitude = null;
      updates.location_source = null;
    }
    if (!("watch_area_id" in updates)) updates.watch_area_id = bestPrefixMatch(updates.postcode as string, await activeAreas(c.env.DB))?.id ?? null;
  }
  updates.updated_at = Date.now();
  const cols = Object.keys(updates);
  await c.env.DB.prepare(`UPDATE properties SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .bind(...cols.map((k) => updates[k]), id)
    .run();
  const changed = diff(before, updates);
  if ("owner_info" in changed) changed.owner_info = { from: "[redacted]", to: "[redacted]" };
  await audit(c, "update", "property", id, changed);
  const refetch = locationChanged || "address_line1" in updates || "latitude" in updates || "longitude" in updates;
  c.executionCtx.waitUntil(refetch ? enrichProperty(c.env, id) : rescoreProperty(c.env, id).then(() => undefined));
  return c.json({ ok: true, changed });
});

/** Re-fetch every public source now. Coordinators only, rate-limited: it fans out to eight APIs. */
props.post("/:id/enrich", requireRole("coordinator"), async (c) => {
  const id = c.req.param("id");
  await rateLimit(c.env.CACHE, `enrich:${c.get("user").id}`, 30, 3600);
  const exists = await c.env.DB.prepare("SELECT id FROM properties WHERE id = ?").bind(id).first();
  if (!exists) throw notFound("Property");
  const status = await enrichProperty(c.env, id, BUDGET.request);
  await audit(c, "enrich", "property", id, { status });
  return c.json({ status });
});

props.delete("/:id", requireRole("coordinator"), async (c) => {
  const id = c.req.param("id");
  const res = await c.env.DB.prepare("UPDATE properties SET archived = 1, updated_at = ? WHERE id = ? AND archived = 0").bind(Date.now(), id).run();
  if (!res.meta.changes) throw notFound("Property");
  await audit(c, "archive", "property", id);
  return c.json({ ok: true });
});

export default props;
