import type { SourceDef } from "./types";

const BASE = "https://environment.data.gov.uk/flood-monitoring";

export const floodSource: SourceDef = {
  id: "flood",
  label: "Flood warning areas & live warnings",
  attribution: "Environment Agency real-time flood-monitoring API — Open Government Licence v3.0. England only.",
  needs: ["latlng"],
  async run(input, ctx) {
    const lat = input.latitude!.toFixed(4);
    const lng = input.longitude!.toFixed(4);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const areas = await ctx.cached<any[]>(`flood:areas:${lat},${lng}`, 30 * 86_400, async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const j = await ctx.fetchJson<any>(`${BASE}/id/floodAreas?lat=${lat}&long=${lng}&dist=1`, { timeoutMs: 20_000 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (j.items ?? []).map((a: any) => ({
        label: a.label ?? a.description ?? null,
        notation: a.notation ?? null,
        water_body: a.riverOrSea ?? null,
        kind: String(a.notation ?? "").includes("FWF") ? "Flood warning area" : "Flood alert area",
      }));
    });
    // Live warnings change by the hour: short cache.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const warnings = await ctx.cached<any[]>(`flood:live:${lat},${lng}`, 900, async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const j = await ctx.fetchJson<any>(`${BASE}/id/floods?lat=${lat}&long=${lng}&dist=2`, { timeoutMs: 20_000 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (j.items ?? []).map((w: any) => ({
        severity: w.severity ?? null,
        severity_level: w.severityLevel ?? null,
        area: w.description ?? w.eaAreaName ?? null,
        message: (w.message ?? "").slice(0, 400),
        raised: w.timeRaised ?? null,
      }));
    });
    return {
      status: "ok",
      data: { within_flood_area: areas.length > 0, areas: areas.slice(0, 10), live_warnings: warnings },
    };
  },
};
