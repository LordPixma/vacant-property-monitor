// Admin backend: users, settings, audit log, data-source health, bulk import and export.
import { Hono } from "hono";
import { z } from "zod";
import { requireRole, revokeUserSessions } from "../auth";
import { enrichmentSweep } from "../enrich";
import type { AppBindings } from "../env";
import { normaliseAddress } from "../lib/address";
import { audit } from "../lib/audit";
import { hashPassword, passwordProblem, randomHex } from "../lib/crypto";
import { csvToObjects, toCsv } from "../lib/csv";
import { CATEGORIES, PROPERTY_TYPES, ROLES, STATUSES } from "../lib/enums";
import { badRequest, conflict, forbidden, notFound, readJson } from "../lib/http";
import { newId } from "../lib/ids";
import { bestPrefixMatch, normalisePostcode } from "../lib/postcode";
import { DEFAULT_SETTINGS, loadSettings } from "../lib/settings";
import { SOURCE_META } from "../sources";

const admin = new Hono<AppBindings>();

// ---------- users (admin only) ----------

const USER_COLUMNS = "id, email, name, role, active, phone, must_change_password, created_at, last_login_at, locked_until";

admin.get("/users", requireRole("admin"), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT ${USER_COLUMNS}, (SELECT COUNT(*) FROM visits v WHERE v.user_id = users.id) AS visit_count FROM users ORDER BY active DESC, name`,
  ).all();
  return c.json({ items: results });
});

/** Readable one-time password: four groups, ~80 bits. */
function tempPassword() {
  return randomHex(10).match(/.{5}/g)!.join("-");
}

const userCreate = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().min(1).max(100),
  role: z.enum(ROLES),
  phone: z.string().trim().max(30).nullable().optional(),
  password: z.string().optional(),
});

admin.post("/users", requireRole("admin"), async (c) => {
  const body = userCreate.parse(await readJson(c));
  const exists = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(body.email).first();
  if (exists) throw conflict("A user with that email already exists.");
  const password = body.password || tempPassword();
  const problem = passwordProblem(password);
  if (problem) throw badRequest(problem);
  const { hash, salt, iterations } = await hashPassword(password);
  const id = newId();
  const t = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO users (id, email, name, role, password_hash, password_salt, password_iters, must_change_password, phone, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  )
    .bind(id, body.email, body.name, body.role, hash, salt, iterations, body.phone ?? null, t, t)
    .run();
  await audit(c, "create", "user", id, { email: body.email, role: body.role });
  // The temporary password is shown once, to the admin, and must be changed at first sign-in.
  return c.json({ id, temporary_password: body.password ? undefined : password }, 201);
});

const userPatch = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    role: z.enum(ROLES).optional(),
    active: z.boolean().optional(),
    phone: z.string().trim().max(30).nullable().optional(),
  })
  .strict();

admin.patch("/users/:id", requireRole("admin"), async (c) => {
  const id = c.req.param("id");
  const body = userPatch.parse(await readJson(c));
  const me = c.get("user");
  if (id === me.id && (body.role && body.role !== "admin" || body.active === false)) throw forbidden("You cannot demote or deactivate yourself.");
  const updates: Record<string, unknown> = { updated_at: Date.now() };
  if (body.name !== undefined) updates.name = body.name;
  if (body.role !== undefined) updates.role = body.role;
  if (body.phone !== undefined) updates.phone = body.phone;
  if (body.active !== undefined) updates.active = body.active ? 1 : 0;
  const cols = Object.keys(updates);
  const res = await c.env.DB.prepare(`UPDATE users SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .bind(...cols.map((k) => updates[k]), id)
    .run();
  if (!res.meta.changes) throw notFound("User");
  if (body.active === false || body.role) await revokeUserSessions(c.env, id);
  await audit(c, "update", "user", id, body);
  return c.json({ ok: true });
});

admin.post("/users/:id/reset-password", requireRole("admin"), async (c) => {
  const id = c.req.param("id");
  const password = tempPassword();
  const { hash, salt, iterations } = await hashPassword(password);
  const res = await c.env.DB.prepare(
    "UPDATE users SET password_hash = ?, password_salt = ?, password_iters = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?",
  )
    .bind(hash, salt, iterations, Date.now(), id)
    .run();
  if (!res.meta.changes) throw notFound("User");
  await revokeUserSessions(c.env, id);
  await audit(c, "reset_password", "user", id);
  return c.json({ temporary_password: password });
});

// ---------- settings ----------

admin.get("/settings", requireRole("coordinator"), async (c) => {
  return c.json({ settings: await loadSettings(c.env), epc_configured: Boolean(c.env.EPC_API_TOKEN), insights_bound: Boolean(c.env.INSIGHTS) });
});

const settingsSchema = z
  .object({
    org_name: z.string().trim().min(1).max(100),
    enrichment_stale_days: z.number().int().min(1).max(365),
    area_radius_m: z.number().int().min(100).max(2000),
    revisit_after_days: z.number().int().min(1).max(365),
    outreach_contact: z.string().trim().max(500),
    council_empty_homes_contact: z.string().trim().max(500),
  })
  .partial()
  .strict();

admin.put("/settings", requireRole("admin"), async (c) => {
  const body = settingsSchema.parse(await readJson(c));
  const t = Date.now();
  const user = c.get("user");
  const stmts = Object.entries(body)
    .filter(([k, v]) => v !== undefined && k in DEFAULT_SETTINGS)
    .map(([k, v]) =>
      c.env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
      ).bind(k, String(v), t, user.id),
    );
  if (stmts.length) await c.env.DB.batch(stmts);
  await audit(c, "update", "settings", null, body);
  return c.json({ settings: await loadSettings(c.env) });
});

// ---------- audit log ----------

admin.get("/audit", requireRole("admin"), async (c) => {
  const q = c.req.query();
  const limit = Math.min(Number(q.limit) || 100, 500);
  const before = Number(q.before) || Date.now() + 1;
  const where = ["l.created_at < ?"];
  const args: unknown[] = [before];
  if (q.entity) {
    where.push("l.entity = ?");
    args.push(q.entity);
  }
  if (q.user) {
    where.push("l.user_id = ?");
    args.push(q.user);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT l.*, u.name AS user_name FROM audit_log l LEFT JOIN users u ON u.id = l.user_id WHERE ${where.join(" AND ")} ORDER BY l.created_at DESC LIMIT ?`,
  )
    .bind(...args, limit)
    .all();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return c.json({ items: results.map((r: any) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })) });
});

// ---------- data sources ----------

admin.get("/sources", requireRole("coordinator"), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT source, status, COUNT(*) AS n, MAX(fetched_at) AS last_fetched, AVG(duration_ms) AS avg_ms FROM enrichment GROUP BY source, status`,
  ).all<{ source: string; status: string; n: number; last_fetched: number; avg_ms: number }>();
  const { results: errors } = await c.env.DB.prepare(
    `SELECT source, error, MAX(fetched_at) AS at, COUNT(*) AS n FROM enrichment WHERE status = 'error' GROUP BY source, error ORDER BY at DESC LIMIT 30`,
  ).all();
  let insights: unknown = null;
  if (c.env.INSIGHTS) {
    try {
      insights = await (await c.env.INSIGHTS.fetch("https://insights/health")).json();
    } catch (err) {
      insights = { ok: false, error: String(err) };
    }
  }
  return c.json({
    sources: SOURCE_META.map((m) => ({
      ...m,
      counts: Object.fromEntries(results.filter((r) => r.source === m.id).map((r) => [r.status, r.n])),
      last_fetched: Math.max(0, ...results.filter((r) => r.source === m.id).map((r) => r.last_fetched)) || null,
      avg_ms: Math.round(results.filter((r) => r.source === m.id && r.status === "ok")[0]?.avg_ms ?? 0) || null,
      configured: m.id === "epc" ? Boolean(c.env.EPC_API_TOKEN) : true,
    })),
    recent_errors: errors,
    insights,
  });
});

admin.post("/sources/sweep", requireRole("admin"), async (c) => {
  const result = await enrichmentSweep(c.env, 5);
  await audit(c, "enrichment_sweep", "property", null, result);
  return c.json(result);
});

// ---------- import / export ----------

const IMPORT_MAX_ROWS = 2000;

/** Header aliases seen in council empty-property and business-rates lists. */
const ALIASES: Record<string, string[]> = {
  address_line1: ["address_line1", "address", "address_1", "address1", "property_address", "street_address", "first_line"],
  address_line2: ["address_line2", "address_2", "address2", "locality"],
  town: ["town", "city", "post_town"],
  postcode: ["postcode", "post_code", "postal_code", "pcode"],
  category: ["category", "ownership", "owner_type", "tenure"],
  property_type: ["property_type", "type", "dwelling_type"],
  status: ["status"],
  vacant_since: ["vacant_since", "empty_since", "void_date", "date_empty", "empty_date"],
  source_ref: ["source_ref", "reference", "ref", "property_reference", "uprn_ref", "account_reference"],
  uprn: ["uprn"],
  description: ["description", "notes", "comments"],
  bedrooms: ["bedrooms", "beds"],
};

function pick(row: Record<string, string>, field: string): string {
  for (const k of ALIASES[field] ?? [field]) if (row[k]) return row[k];
  return "";
}

function mapCategory(v: string): string {
  const s = v.toLowerCase();
  if (!s) return "unknown";
  if ((CATEGORIES as readonly string[]).includes(s)) return s;
  if (/council|local authority|\bla\b/.test(s)) return "council";
  if (/housing association|registered provider|\brp\b|\bha\b|social/.test(s)) return "housing_association";
  if (/private|owner|landlord/.test(s)) return "private";
  if (/commercial|shop|office|retail/.test(s)) return "commercial";
  return "unknown";
}

function mapDate(v: string): string | null {
  if (!v) return null;
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(v)) return v;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

admin.post("/import", requireRole("coordinator"), async (c) => {
  const body = z
    .object({
      csv: z.string().min(1).max(5_000_000),
      source: z.enum(["import", "council_list"]).default("import"),
      default_category: z.enum(CATEGORIES).optional(),
      dry_run: z.boolean().optional(),
    })
    .parse(await readJson(c));
  const rows = csvToObjects(body.csv);
  if (!rows.length) throw badRequest("The CSV has no data rows.");
  if (rows.length > IMPORT_MAX_ROWS) throw badRequest(`Import at most ${IMPORT_MAX_ROWS} rows at a time.`);
  const user = c.get("user");
  const areas = (await c.env.DB.prepare("SELECT id, postcode_prefix FROM watch_areas WHERE active = 1").all<{ id: string; postcode_prefix: string }>()).results;
  const existing = new Set(
    (await c.env.DB.prepare("SELECT postcode, address_line1, address_line2 FROM properties WHERE archived = 0").all<{ postcode: string; address_line1: string; address_line2: string | null }>()).results.map(
      (r) => `${r.postcode}|${normaliseAddress(`${r.address_line1} ${r.address_line2 ?? ""}`)}`,
    ),
  );
  const errors: { row: number; message: string }[] = [];
  let duplicates = 0;
  const t = Date.now();
  const inserts: D1PreparedStatement[] = [];
  rows.forEach((r, i) => {
    const line = i + 2; // header is line 1
    const address = pick(r, "address_line1");
    const postcode = normalisePostcode(pick(r, "postcode"));
    if (!address) return errors.push({ row: line, message: "Missing address." });
    if (!postcode) return errors.push({ row: line, message: `Invalid postcode "${pick(r, "postcode")}".` });
    const line2 = pick(r, "address_line2") || null;
    const key = `${postcode}|${normaliseAddress(`${address} ${line2 ?? ""}`)}`;
    if (existing.has(key)) {
      duplicates++;
      return;
    }
    existing.add(key);
    const status = (STATUSES as readonly string[]).includes(pick(r, "status").toLowerCase()) ? pick(r, "status").toLowerCase() : "reported";
    const ptype = pick(r, "property_type").toLowerCase();
    const beds = Number(pick(r, "bedrooms"));
    const uprn = pick(r, "uprn").replace(/\D/g, "").slice(0, 12) || null;
    inserts.push(
      c.env.DB.prepare(
        `INSERT INTO properties (id, address_line1, address_line2, town, postcode, uprn, category, property_type, status, vacant_since, description, source, source_ref, watch_area_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        newId(),
        address.slice(0, 200),
        line2?.slice(0, 200) ?? null,
        pick(r, "town").slice(0, 100) || null,
        postcode,
        uprn,
        pick(r, "category") ? mapCategory(pick(r, "category")) : body.default_category ?? "unknown",
        (PROPERTY_TYPES as readonly string[]).includes(ptype) ? ptype : null,
        status,
        mapDate(pick(r, "vacant_since")),
        pick(r, "description").slice(0, 5000) || null,
        body.source,
        pick(r, "source_ref").slice(0, 200) || null,
        bestPrefixMatch(postcode, areas)?.id ?? null,
        user.id,
        t,
        t,
      ),
    );
  });
  if (!body.dry_run) {
    for (let i = 0; i < inserts.length; i += 50) await c.env.DB.batch(inserts.slice(i, i + 50));
    await audit(c, "import", "property", null, { rows: rows.length, imported: inserts.length, duplicates, errors: errors.length });
  }
  // New rows are 'pending': the hourly sweep enriches them in batches.
  return c.json({ rows: rows.length, imported: body.dry_run ? 0 : inserts.length, would_import: inserts.length, duplicates, errors: errors.slice(0, 100) });
});

const EXPORT_COLUMNS = [
  "id",
  "address_line1",
  "address_line2",
  "town",
  "postcode",
  "uprn",
  "latitude",
  "longitude",
  "category",
  "property_type",
  "status",
  "condition",
  "security",
  "bedrooms",
  "vacant_since",
  "priority_score",
  "priority_band",
  "vacancy_likelihood",
  "area_name",
  "assignee_name",
  "last_visited_at",
  "source",
  "source_ref",
  "created_at",
  "updated_at",
];

admin.get("/export", requireRole("coordinator"), async (c) => {
  const format = c.req.query("format") === "geojson" ? "geojson" : "csv";
  const { results } = await c.env.DB.prepare(
    `SELECT p.*, a.name AS area_name, u.name AS assignee_name FROM properties p
       LEFT JOIN watch_areas a ON a.id = p.watch_area_id LEFT JOIN users u ON u.id = p.assigned_to
      WHERE p.archived = 0 ORDER BY p.postcode, p.address_line1`,
  ).all<Record<string, unknown>>();
  await audit(c, "export", "property", null, { format, rows: results.length });
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "geojson") {
    const fc = {
      type: "FeatureCollection",
      features: results
        .filter((r) => r.latitude !== null)
        .map((r) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [r.longitude, r.latitude] },
          properties: Object.fromEntries(EXPORT_COLUMNS.filter((k) => !["latitude", "longitude"].includes(k)).map((k) => [k, r[k]])),
        })),
    };
    return new Response(JSON.stringify(fc), {
      headers: { "content-type": "application/geo+json", "content-disposition": `attachment; filename="vacantwatch-${stamp}.geojson"` },
    });
  }
  const rows = results.map((r) => ({
    ...r,
    last_visited_at: r.last_visited_at ? new Date(r.last_visited_at as number).toISOString() : "",
    created_at: new Date(r.created_at as number).toISOString(),
    updated_at: new Date(r.updated_at as number).toISOString(),
  }));
  return new Response(toCsv(rows, EXPORT_COLUMNS), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="vacantwatch-${stamp}.csv"` },
  });
});

/** Field workers and coordinators: the people a property or task can be assigned to. */
admin.get("/people", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, name, role FROM users WHERE active = 1 AND role != 'viewer' ORDER BY name").all();
  return c.json({ items: results });
});

export default admin;
