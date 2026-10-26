import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppBindings, Env, Role, SessionUser } from "./env";
import { randomHex, sha256Hex } from "./lib/crypto";
import { forbidden, unauthorized } from "./lib/http";

export const SESSION_COOKIE = "vw_session";
export const SESSION_DAYS = 14;
const DAY = 86_400_000;
/** Only push the expiry forward once an hour, to keep session reads from turning into writes. */
const TOUCH_EVERY = 3_600_000;

export async function createSession(c: Context<AppBindings>, userId: string) {
  const token = randomHex(32);
  const hash = await sha256Hex(token);
  const t = Date.now();
  await c.env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(hash, userId, t, t + SESSION_DAYS * DAY, t, (c.req.header("user-agent") ?? "").slice(0, 200), c.req.header("cf-connecting-ip") ?? null)
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

export async function destroySession(c: Context<AppBindings>) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
}

export async function revokeUserSessions(env: Env, userId: string, exceptHash?: string) {
  if (exceptHash) await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(userId, exceptHash).run();
  else await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
}

interface SessionRow {
  token_hash: string;
  expires_at: number;
  last_seen_at: number;
  id: string;
  email: string;
  name: string;
  role: Role;
  must_change_password: number;
}

/** Resolves the session cookie to a user, or 401. */
export const requireAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) throw unauthorized();
  const hash = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    `SELECT s.token_hash, s.expires_at, s.last_seen_at, u.id, u.email, u.name, u.role, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND u.active = 1`,
  )
    .bind(hash)
    .first<SessionRow>();
  const t = Date.now();
  if (!row || row.expires_at < t) {
    if (row) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run();
    throw unauthorized("Your session has expired. Please sign in again.");
  }
  if (t - row.last_seen_at > TOUCH_EVERY) {
    c.executionCtx.waitUntil(
      c.env.DB.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?")
        .bind(t, t + SESSION_DAYS * DAY, hash)
        .run()
        .catch((e) => console.error("session touch failed", e)),
    );
  }
  const user: SessionUser = { id: row.id, email: row.email, name: row.name, role: row.role, mustChangePassword: row.must_change_password === 1 };
  // A temporary password opens nothing but the auth endpoints until it is changed.
  if (user.mustChangePassword && !c.req.path.startsWith("/api/auth/")) throw forbidden("Choose a new password before continuing.");
  c.set("user", user);
  c.set("sessionHash", hash);
  await next();
};

/** Browsers always send Origin on cross-site writes; refuse one that is not ours. */
export const sameOrigin: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) throw forbidden("Cross-site request refused.");
    if (c.req.header("sec-fetch-site") === "cross-site") throw forbidden("Cross-site request refused.");
  }
  await next();
};

const RANK: Record<Role, number> = { viewer: 0, field_worker: 1, coordinator: 2, admin: 3 };

export function hasRole(user: SessionUser, min: Role) {
  return RANK[user.role] >= RANK[min];
}

/** Roles are ordered: viewer < field_worker < coordinator < admin. */
export function requireRole(min: Role): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    if (!hasRole(c.get("user"), min)) throw forbidden();
    await next();
  };
}
