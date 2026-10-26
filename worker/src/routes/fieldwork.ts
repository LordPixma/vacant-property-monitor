// Visits, photos and tasks: everything a field worker writes on the ground.
import { Hono } from "hono";
import { z } from "zod";
import { hasRole, requireRole } from "../auth";
import { rescoreProperty } from "../enrich";
import type { AppBindings } from "../env";
import { audit } from "../lib/audit";
import { CONDITIONS, SECURITY, SIGNALS, STATUSES, TASK_STATUSES, TASK_TYPES } from "../lib/enums";
import { badRequest, forbidden, notFound, readJson } from "../lib/http";
import { newId } from "../lib/ids";

const fieldwork = new Hono<AppBindings>();

const DAY = 86_400_000;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

const visitSchema = z.object({
  client_id: z.string().min(8).max(64).optional(),
  visited_at: z.number().int().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  gps_accuracy_m: z.number().min(0).max(100_000).nullable().optional(),
  observed_status: z.enum(STATUSES).nullable().optional(),
  condition: z.enum(CONDITIONS).nullable().optional(),
  security: z.enum(SECURITY).nullable().optional(),
  signals: z.array(z.enum(SIGNALS)).max(SIGNALS.length).optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
});

/** Signals that should put a task in front of a coordinator straight away. */
const AUTO_TASKS: { signal: string; type: (typeof TASK_TYPES)[number]; title: string }[] = [
  { signal: "signs_of_rough_sleeping", type: "refer_streetlink", title: "Signs of rough sleeping: refer to StreetLink / outreach" },
  { signal: "open_or_unsecured", type: "report_unsafe", title: "Building open or unsecured: report to the council" },
  { signal: "structural_damage", type: "report_unsafe", title: "Structural damage seen: report to building control" },
  { signal: "fire_damage", type: "report_unsafe", title: "Fire damage seen: report to building control" },
];

fieldwork.post("/properties/:id/visits", requireRole("field_worker"), async (c) => {
  const propertyId = c.req.param("id");
  const body = visitSchema.parse(await readJson(c));
  const user = c.get("user");
  const t = Date.now();
  const visitedAt = body.visited_at ?? t;
  // Offline replays can be days old, but not from the future or the distant past.
  if (visitedAt > t + 5 * 60_000 || visitedAt < t - 60 * DAY) throw badRequest("Visit time is out of range.");

  if (body.client_id) {
    const replay = await c.env.DB.prepare("SELECT id FROM visits WHERE client_id = ?").bind(body.client_id).first<{ id: string }>();
    if (replay) return c.json({ id: replay.id, replay: true });
  }
  const prop = await c.env.DB.prepare("SELECT id, status, last_visited_at FROM properties WHERE id = ? AND archived = 0")
    .bind(propertyId)
    .first<{ id: string; status: string; last_visited_at: number | null }>();
  if (!prop) throw notFound("Property");

  const id = newId();
  const signals = [...new Set(body.signals ?? [])];
  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO visits (id, client_id, property_id, user_id, visited_at, latitude, longitude, gps_accuracy_m, observed_status, condition, security, signals, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      body.client_id ?? null,
      propertyId,
      user.id,
      visitedAt,
      body.latitude ?? null,
      body.longitude ?? null,
      body.gps_accuracy_m ?? null,
      body.observed_status ?? null,
      body.condition ?? null,
      body.security ?? null,
      JSON.stringify(signals),
      body.notes ?? null,
      t,
    ),
  ];
  // Only the newest observation moves the property's current state.
  const isLatest = !prop.last_visited_at || visitedAt >= prop.last_visited_at;
  if (isLatest) {
    stmts.push(
      c.env.DB.prepare(
        `UPDATE properties SET last_visited_at = ?, updated_at = ?,
           status = COALESCE(?, status), condition = COALESCE(?, condition), security = COALESCE(?, security)
         WHERE id = ?`,
      ).bind(visitedAt, t, body.observed_status ?? null, body.condition ?? null, body.security ?? null, propertyId),
    );
  }
  for (const a of AUTO_TASKS) {
    if (!signals.includes(a.signal as never)) continue;
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO tasks (id, property_id, type, title, notes, status, due_at, created_by, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, 'open', ?, ?, ?, ? WHERE NOT EXISTS
           (SELECT 1 FROM tasks WHERE property_id = ? AND type = ? AND status IN ('open', 'in_progress'))`,
      ).bind(newId(), propertyId, a.type, a.title, `Raised automatically from a visit by ${user.name}.`, t + DAY, user.id, t, t, propertyId, a.type),
    );
  }
  await c.env.DB.batch(stmts);
  await audit(c, "visit", "property", propertyId, { visit_id: id, observed_status: body.observed_status ?? null, signals });
  c.executionCtx.waitUntil(rescoreProperty(c.env, propertyId).then(() => undefined));
  return c.json({ id }, 201);
});

fieldwork.get("/visits", async (c) => {
  const user = c.get("user");
  const mine = c.req.query("mine") === "1" || !hasRole(user, "coordinator");
  const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
  const { results } = await c.env.DB.prepare(
    `SELECT v.id, v.property_id, v.visited_at, v.observed_status, v.signals, v.notes, u.name AS user_name, p.address_line1, p.postcode
       FROM visits v JOIN properties p ON p.id = v.property_id LEFT JOIN users u ON u.id = v.user_id
      ${mine ? "WHERE v.user_id = ?" : ""} ORDER BY v.visited_at DESC LIMIT ?`,
  )
    .bind(...(mine ? [user.id, limit] : [limit]))
    .all();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return c.json({ items: results.map((v: any) => ({ ...v, signals: JSON.parse(v.signals || "[]") })) });
});

/** Magic bytes, so a renamed file cannot pass as an image. */
export function sniffImage(bytes: Uint8Array): { type: string; ext: string } | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { type: "image/jpeg", ext: "jpg" };
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { type: "image/png", ext: "png" };
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return { type: "image/webp", ext: "webp" };
  return null;
}

fieldwork.post("/properties/:id/photos", requireRole("field_worker"), async (c) => {
  const propertyId = c.req.param("id");
  const user = c.get("user");
  const len = Number(c.req.header("content-length") || 0);
  if (len > MAX_PHOTO_BYTES + 64 * 1024) throw badRequest("Photo is too large (10 MB maximum).");
  const form = await c.req.formData().catch(() => {
    throw badRequest("Expected a multipart form.");
  });
  const file = form.get("file");
  if (!file || typeof file === "string") throw badRequest("No file attached.");
  if (file.size > MAX_PHOTO_BYTES) throw badRequest("Photo is too large (10 MB maximum).");
  const clientId = String(form.get("client_id") ?? "") || null;
  if (clientId) {
    const replay = await c.env.DB.prepare("SELECT id FROM photos WHERE client_id = ?").bind(clientId).first<{ id: string }>();
    if (replay) return c.json({ id: replay.id, replay: true });
  }
  const prop = await c.env.DB.prepare("SELECT id FROM properties WHERE id = ? AND archived = 0").bind(propertyId).first();
  if (!prop) throw notFound("Property");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) throw badRequest("Only JPEG, PNG or WebP photos are accepted.");

  let visitId = String(form.get("visit_id") ?? "") || null;
  const visitClientId = String(form.get("visit_client_id") ?? "") || null;
  if (!visitId && visitClientId) {
    visitId = (await c.env.DB.prepare("SELECT id FROM visits WHERE client_id = ? AND property_id = ?").bind(visitClientId, propertyId).first<{ id: string }>())?.id ?? null;
  }
  const caption = (String(form.get("caption") ?? "").trim() || null)?.slice(0, 500) ?? null;
  const id = newId();
  const key = `properties/${propertyId}/${id}.${kind.ext}`;
  await c.env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: kind.type }, customMetadata: { propertyId, uploadedBy: user.id } });
  try {
    await c.env.DB.prepare(
      "INSERT INTO photos (id, client_id, property_id, visit_id, r2_key, content_type, size_bytes, caption, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(id, clientId, propertyId, visitId, key, kind.type, bytes.byteLength, caption, user.id, Date.now())
      .run();
  } catch (err) {
    // Do not leave an orphaned object behind a failed row.
    await c.env.PHOTOS.delete(key).catch(() => undefined);
    throw err;
  }
  await audit(c, "photo_upload", "property", propertyId, { photo_id: id, bytes: bytes.byteLength });
  return c.json({ id }, 201);
});

fieldwork.get("/photos/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT r2_key, content_type FROM photos WHERE id = ?").bind(c.req.param("id")).first<{ r2_key: string; content_type: string }>();
  if (!row) throw notFound("Photo");
  const obj = await c.env.PHOTOS.get(row.r2_key);
  if (!obj) throw notFound("Photo");
  return new Response(obj.body, {
    headers: {
      "content-type": row.content_type,
      "cache-control": "private, max-age=86400, immutable",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
    },
  });
});

fieldwork.delete("/photos/:id", requireRole("coordinator"), async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT r2_key, property_id FROM photos WHERE id = ?").bind(id).first<{ r2_key: string; property_id: string }>();
  if (!row) throw notFound("Photo");
  await c.env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(id).run();
  await c.env.PHOTOS.delete(row.r2_key);
  await audit(c, "photo_delete", "property", row.property_id, { photo_id: id });
  return c.json({ ok: true });
});

const taskSchema = z.object({
  property_id: z.string().max(40).nullable().optional(),
  type: z.enum(TASK_TYPES),
  title: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(5000).nullable().optional(),
  due_at: z.number().int().nullable().optional(),
  assigned_to: z.string().max(40).nullable().optional(),
});
const taskPatch = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
    status: z.enum(TASK_STATUSES).optional(),
    due_at: z.number().int().nullable().optional(),
    assigned_to: z.string().max(40).nullable().optional(),
  })
  .strict();

fieldwork.get("/tasks", async (c) => {
  const q = c.req.query();
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.mine === "1") {
    where.push("t.assigned_to = ?");
    args.push(c.get("user").id);
  }
  if (q.status === "active") where.push("t.status IN ('open', 'in_progress')");
  else if (q.status && (TASK_STATUSES as readonly string[]).includes(q.status)) {
    where.push("t.status = ?");
    args.push(q.status);
  }
  if (q.property) {
    where.push("t.property_id = ?");
    args.push(q.property);
  }
  if (q.unassigned === "1") where.push("t.assigned_to IS NULL");
  const { results } = await c.env.DB.prepare(
    `SELECT t.*, u.name AS assignee_name, p.address_line1, p.postcode, p.priority_band
       FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to LEFT JOIN properties p ON p.id = t.property_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 0 ELSE 1 END, COALESCE(t.due_at, 9e15), t.created_at DESC LIMIT 500`,
  )
    .bind(...args)
    .all();
  return c.json({ items: results });
});

fieldwork.post("/tasks", requireRole("field_worker"), async (c) => {
  const body = taskSchema.parse(await readJson(c));
  const user = c.get("user");
  if (body.assigned_to && body.assigned_to !== user.id && !hasRole(user, "coordinator")) throw forbidden("Only coordinators can assign tasks to others.");
  if (body.property_id) {
    const p = await c.env.DB.prepare("SELECT id FROM properties WHERE id = ?").bind(body.property_id).first();
    if (!p) throw notFound("Property");
  }
  const id = newId();
  const t = Date.now();
  await c.env.DB.prepare(
    "INSERT INTO tasks (id, property_id, type, title, notes, status, due_at, assigned_to, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)",
  )
    .bind(id, body.property_id ?? null, body.type, body.title, body.notes ?? null, body.due_at ?? null, body.assigned_to ?? null, user.id, t, t)
    .run();
  await audit(c, "create", "task", id, { type: body.type, property_id: body.property_id ?? null });
  return c.json({ id }, 201);
});

fieldwork.patch("/tasks/:id", requireRole("field_worker"), async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const body = taskPatch.parse(await readJson(c));
  const task = await c.env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<{ assigned_to: string | null; created_by: string | null; status: string }>();
  if (!task) throw notFound("Task");
  const isCoord = hasRole(user, "coordinator");
  if (!isCoord && task.assigned_to !== user.id && task.created_by !== user.id) throw forbidden("You can only update your own tasks.");
  if (!isCoord && body.assigned_to !== undefined && body.assigned_to !== user.id) throw forbidden("Only coordinators can reassign tasks.");
  const updates: Record<string, unknown> = { ...body, updated_at: Date.now() };
  if (body.status === "done" && task.status !== "done") updates.completed_at = Date.now();
  if (body.status && body.status !== "done") updates.completed_at = null;
  const cols = Object.keys(updates).filter((k) => updates[k] !== undefined);
  await c.env.DB.prepare(`UPDATE tasks SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .bind(...cols.map((k) => updates[k]), id)
    .run();
  await audit(c, "update", "task", id, body);
  return c.json({ ok: true });
});

export default fieldwork;
