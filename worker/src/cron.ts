// Scheduled work. Kept out of index.ts: every named export of the entry module is treated
// as a Worker entrypoint, so constants and helpers cannot live there.
import { rescoreProperty } from "./enrich";
import type { Env } from "./env";
import { newId } from "./lib/ids";
import { loadSettings } from "./lib/settings";
import { servicesSweep } from "./servicesSync";

/** Must match "triggers.crons" in wrangler.jsonc (test/wiring.test.ts checks). */
export const CRON_ENRICH = "15 * * * *";
export const CRON_DAILY = "40 3 * * *";

/** Daily housekeeping: expired sessions, overdue revisits, and a rescore so time-based factors move. */
export async function dailyMaintenance(env: Env) {
  const t = Date.now();
  const settings = await loadSettings(env);
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(t).run();
  const due = t - settings.revisit_after_days * 86_400_000;
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.assigned_to FROM properties p
      WHERE p.archived = 0 AND p.status IN ('suspected_vacant', 'confirmed_vacant', 'derelict', 'abandoned', 'referred')
        AND COALESCE(p.last_visited_at, p.created_at) < ?
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.property_id = p.id AND t.type = 'revisit' AND t.status IN ('open', 'in_progress'))
      LIMIT 200`,
  )
    .bind(due)
    .all<{ id: string; assigned_to: string | null }>();
  const stmts = results.map((p) =>
    env.DB.prepare(
      "INSERT INTO tasks (id, property_id, type, title, notes, status, due_at, assigned_to, created_at, updated_at) VALUES (?, ?, 'revisit', ?, ?, 'open', ?, ?, ?, ?)",
    ).bind(newId(), p.id, "Revisit: observation is out of date", `Not seen for over ${settings.revisit_after_days} days.`, t + 7 * 86_400_000, p.assigned_to, t, t),
  );
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  const { results: toScore } = await env.DB.prepare(
    "SELECT id FROM properties WHERE archived = 0 AND enrichment_status IN ('complete', 'partial') ORDER BY updated_at DESC LIMIT 300",
  ).all<{ id: string }>();
  let rescored = 0;
  for (const p of toScore) if (await rescoreProperty(env, p.id, settings)) rescored++;
  const services = await servicesSweep(env);
  return { revisit_tasks: results.length, rescored, services };
}

