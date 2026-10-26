import type { Context } from "hono";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, "bad_request", message, details);
export const unauthorized = (message = "Sign in required.") => new HttpError(401, "unauthorized", message);
export const forbidden = (message = "You do not have permission to do that.") => new HttpError(403, "forbidden", message);
export const notFound = (what = "Resource") => new HttpError(404, "not_found", `${what} not found.`);
export const conflict = (message: string, details?: unknown) => new HttpError(409, "conflict", message, details);
export const tooMany = (message = "Too many attempts. Try again later.") => new HttpError(429, "rate_limited", message);

export function errorResponse(c: Context, err: unknown) {
  if (err instanceof HttpError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
  }
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return c.json({ error: { code: "validation", message: "Some fields are invalid.", details } }, 400);
  }
  console.error("unhandled", err);
  return c.json({ error: { code: "internal", message: "Something went wrong." } }, 500);
}

export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw badRequest("Body must be JSON.");
  }
}

export function clientIp(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

/** Fixed-window counter in KV. A miss costs a few extra attempts, never a lockout. */
export async function rateLimit(kv: KVNamespace, key: string, max: number, windowSeconds: number) {
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const k = `rl:${key}:${bucket}`;
  const current = Number((await kv.get(k)) ?? "0");
  if (current >= max) throw tooMany();
  await kv.put(k, String(current + 1), { expirationTtl: Math.max(60, windowSeconds * 2) });
}
