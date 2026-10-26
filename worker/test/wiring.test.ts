import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as enums from "../src/lib/enums";

const dir = new URL("../migrations/", import.meta.url);
const migration = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(new URL(f, dir), "utf8"))
  .join("\n");
const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const cron = readFileSync(new URL("../src/cron.ts", import.meta.url), "utf8");
const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

/** The values of `column IN (...)` in a table's CHECK constraint. */
function checkValues(table: string, column: string): string[] {
  const body = new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`).exec(migration)?.[1] ?? "";
  const m = new RegExp(`\\b${column}\\b[^\\n]*?(?:\\n\\s+)?CHECK \\(${column} IN \\(([^)]*)\\)`).exec(body);
  if (!m) throw new Error(`no CHECK for ${table}.${column}`);
  return m[1].split(",").map((s) => s.trim().replace(/'/g, ""));
}

describe("enums mirror the CHECK constraints", () => {
  const cases: [string, string, readonly string[]][] = [
    ["users", "role", enums.ROLES],
    ["properties", "category", enums.CATEGORIES],
    ["properties", "property_type", enums.PROPERTY_TYPES],
    ["properties", "status", enums.STATUSES],
    ["properties", "condition", enums.CONDITIONS],
    ["properties", "security", enums.SECURITY],
    ["properties", "source", enums.SOURCES],
    ["properties", "location_source", enums.LOCATION_SOURCES],
    ["properties", "priority_band", enums.PRIORITY_BANDS],
    ["properties", "enrichment_status", enums.ENRICHMENT_STATUSES],
    ["visits", "observed_status", enums.STATUSES],
    ["tasks", "type", enums.TASK_TYPES],
    ["tasks", "status", enums.TASK_STATUSES],
    ["support_services", "group_key", enums.SERVICE_GROUPS],
    ["support_services", "source", enums.SERVICE_SOURCES],
  ];
  it.each(cases)("%s.%s", (table, column, values) => {
    expect(checkValues(table, column)).toEqual([...values]);
  });
});

describe("migrations", () => {
  it("never put a semicolon inside a string literal (the D1 runner splits on them)", () => {
    const literals = migration.replace(/--.*$/gm, "").match(/'[^']*'/g) ?? [];
    expect(literals.filter((l) => l.includes(";"))).toEqual([]);
  });
});

describe("cron wiring", () => {
  it("every wrangler cron has a dispatch branch and vice versa", () => {
    const crons = JSON.parse(/"crons":\s*(\[[^\]]*\])/.exec(wrangler)![1]) as string[];
    const declared = [...cron.matchAll(/export const CRON_\w+ = "([^"]+)"/g)].map((m) => m[1]);
    expect(crons.sort()).toEqual(declared.sort());
    for (const c of crons) expect(c.split(" ")[0]).toMatch(/^\d+$/);
    for (const name of ["CRON_ENRICH", "CRON_DAILY"]) expect(index).toContain(`controller.cron === ${name}`);
  });
});
