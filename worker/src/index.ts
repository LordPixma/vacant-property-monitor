import { Hono } from "hono";
import { requireAuth, sameOrigin } from "./auth";
import { CRON_DAILY, CRON_ENRICH, dailyMaintenance } from "./cron";
import { enrichmentSweep } from "./enrich";
import type { AppBindings, Env } from "./env";
import { CATEGORIES, CONDITIONS, PROPERTY_TYPES, ROLES, SECURITY, SIGNALS, STATUSES, TASK_STATUSES, TASK_TYPES } from "./lib/enums";
import { errorResponse } from "./lib/http";
import { loadSettings } from "./lib/settings";
import adminRoutes from "./routes/admin";
import areaRoutes from "./routes/areas";
import authRoutes from "./routes/auth";
import fieldworkRoutes from "./routes/fieldwork";
import propertyRoutes from "./routes/properties";
import { SOURCE_META } from "./sources";

const app = new Hono<AppBindings>();

app.onError((err, c) => errorResponse(c, err));

app.use("/api/*", async (c, next) => {
  await next();
  c.header("cache-control", c.res.headers.get("cache-control") ?? "no-store");
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "same-origin");
});
app.use("/api/*", sameOrigin);

app.get("/api/health", (c) => c.json({ ok: true, environment: c.env.ENVIRONMENT }));

app.route("/api/auth", authRoutes);

// Everything below needs a session.
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth/") || c.req.path === "/api/health") return next();
  return requireAuth(c, next);
});

app.get("/api/meta", async (c) => {
  const settings = await loadSettings(c.env);
  return c.json({
    org_name: settings.org_name,
    outreach_contact: settings.outreach_contact,
    council_empty_homes_contact: settings.council_empty_homes_contact,
    revisit_after_days: settings.revisit_after_days,
    enums: {
      roles: ROLES,
      categories: CATEGORIES,
      property_types: PROPERTY_TYPES,
      statuses: STATUSES,
      conditions: CONDITIONS,
      security: SECURITY,
      signals: SIGNALS,
      task_types: TASK_TYPES,
      task_statuses: TASK_STATUSES,
    },
    sources: SOURCE_META,
  });
});

app.route("/api/properties", propertyRoutes);
app.route("/api", fieldworkRoutes);
app.route("/api", areaRoutes);
app.route("/api/admin", adminRoutes);

app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "No such endpoint." } }, 404));

// Anything else is a static file (dashboard, field PWA).
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const job = async () => {
      if (controller.cron === CRON_ENRICH) console.log("enrichment sweep", JSON.stringify(await enrichmentSweep(env, 10)));
      else if (controller.cron === CRON_DAILY) console.log("daily maintenance", JSON.stringify(await dailyMaintenance(env)));
      else console.warn("unknown cron", controller.cron);
    };
    ctx.waitUntil(job().catch((err) => console.error("cron failed", controller.cron, err)));
  },
} satisfies ExportedHandler<Env>;
