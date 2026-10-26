import type { Context } from "hono";
import type { AppBindings } from "../env";
import { newId } from "./ids";

/** Every create/update/delete goes through here. Failures are logged, never thrown into the request. */
export async function audit(
  c: Context<AppBindings>,
  action: string,
  entity: string,
  entityId: string | null,
  detail?: Record<string, unknown>,
) {
  const user = c.get("user");
  try {
    await c.env.DB.prepare(
      "INSERT INTO audit_log (id, user_id, action, entity, entity_id, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(newId(), user?.id ?? null, action, entity, entityId, detail ? JSON.stringify(detail) : null, c.req.header("cf-connecting-ip") ?? null, Date.now())
      .run();
  } catch (err) {
    console.error("audit write failed", err);
  }
}

/** Fields that changed between two rows, for the audit detail. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(after)) {
    if (k === "updated_at") continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out[k] = { from: before[k], to: after[k] };
  }
  return out;
}
