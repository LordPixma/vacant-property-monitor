import { Hono } from "hono";
import { z } from "zod";
import { createSession, destroySession, requireAuth, revokeUserSessions } from "../auth";
import type { AppBindings } from "../env";
import { audit } from "../lib/audit";
import { hashPassword, passwordProblem, sha256Hex, timingSafeEqualHex, verifyPassword } from "../lib/crypto";
import { badRequest, clientIp, forbidden, rateLimit, readJson, unauthorized } from "../lib/http";
import { newId } from "../lib/ids";

const auth = new Hono<AppBindings>();

const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60_000;

async function userCount(db: D1Database) {
  return (await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())?.n ?? 0;
}

auth.get("/setup-status", async (c) => {
  return c.json({ needsSetup: (await userCount(c.env.DB)) === 0, setupTokenConfigured: Boolean(c.env.SETUP_TOKEN) });
});

const setupSchema = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string(),
});

/** Creates the first admin. Works once, and only with the SETUP_TOKEN secret. */
auth.post("/setup", async (c) => {
  await rateLimit(c.env.CACHE, `setup:${clientIp(c)}`, 10, 3600);
  const body = setupSchema.parse(await readJson(c));
  if (!c.env.SETUP_TOKEN) throw forbidden("Setup is disabled: SETUP_TOKEN is not configured.");
  const [a, b] = await Promise.all([sha256Hex(body.token), sha256Hex(c.env.SETUP_TOKEN)]);
  if (!timingSafeEqualHex(a, b)) throw forbidden("Setup token is incorrect.");
  const problem = passwordProblem(body.password);
  if (problem) throw badRequest(problem);
  const { hash, salt, iterations } = await hashPassword(body.password);
  const id = newId();
  const t = Date.now();
  // The WHERE NOT EXISTS makes this race-safe: two concurrent setups cannot both create an admin.
  const res = await c.env.DB.prepare(
    `INSERT INTO users (id, email, name, role, password_hash, password_salt, password_iters, created_at, updated_at)
     SELECT ?, ?, ?, 'admin', ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
  )
    .bind(id, body.email, body.name, hash, salt, iterations, t, t)
    .run();
  if (!res.meta.changes) throw forbidden("Setup has already been completed.");
  await createSession(c, id);
  c.set("user", { id, email: body.email, name: body.name, role: "admin", mustChangePassword: false });
  await audit(c, "setup", "user", id, { email: body.email });
  return c.json({ ok: true });
});

const loginSchema = z.object({ email: z.string().trim().toLowerCase().max(200), password: z.string().max(200) });

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  password_hash: string;
  password_salt: string;
  password_iters: number;
  active: number;
  failed_logins: number;
  locked_until: number | null;
  must_change_password: number;
}

auth.post("/login", async (c) => {
  await rateLimit(c.env.CACHE, `login:${clientIp(c)}`, 30, 900);
  const body = loginSchema.parse(await readJson(c));
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(body.email).first<UserRow>();
  const t = Date.now();
  if (!user || !user.active) {
    // Same work as a real check, so timing does not reveal which emails exist.
    await hashPassword(body.password);
    throw unauthorized("Email or password is incorrect.");
  }
  if (user.locked_until && user.locked_until > t) throw unauthorized("Too many failed attempts. Try again in 15 minutes.");
  const ok = await verifyPassword(body.password, user.password_hash, user.password_salt, user.password_iters);
  if (!ok) {
    const fails = user.failed_logins + 1;
    await c.env.DB.prepare("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?")
      .bind(fails >= LOCK_AFTER ? 0 : fails, fails >= LOCK_AFTER ? t + LOCK_MS : null, user.id)
      .run();
    throw unauthorized("Email or password is incorrect.");
  }
  await c.env.DB.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?").bind(t, user.id).run();
  await createSession(c, user.id);
  c.set("user", { id: user.id, email: user.email, name: user.name, role: user.role as never, mustChangePassword: user.must_change_password === 1 });
  await audit(c, "login", "user", user.id);
  return c.json({ ok: true });
});

auth.post("/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

auth.get("/me", requireAuth, (c) => c.json({ user: c.get("user") }));

const changeSchema = z.object({ current: z.string().max(200), next: z.string() });

auth.post("/change-password", requireAuth, async (c) => {
  const body = changeSchema.parse(await readJson(c));
  const me = c.get("user");
  const row = await c.env.DB.prepare("SELECT password_hash, password_salt, password_iters FROM users WHERE id = ?")
    .bind(me.id)
    .first<{ password_hash: string; password_salt: string; password_iters: number }>();
  if (!row || !(await verifyPassword(body.current, row.password_hash, row.password_salt, row.password_iters))) {
    throw badRequest("Current password is incorrect.");
  }
  const problem = passwordProblem(body.next);
  if (problem) throw badRequest(problem);
  const { hash, salt, iterations } = await hashPassword(body.next);
  await c.env.DB.prepare(
    "UPDATE users SET password_hash = ?, password_salt = ?, password_iters = ?, must_change_password = 0, updated_at = ? WHERE id = ?",
  )
    .bind(hash, salt, iterations, Date.now(), me.id)
    .run();
  // Sign out every other device.
  await revokeUserSessions(c.env, me.id, c.get("sessionHash"));
  await audit(c, "change_password", "user", me.id);
  return c.json({ ok: true });
});

export default auth;
