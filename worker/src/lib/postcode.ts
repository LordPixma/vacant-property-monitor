// UK postcode handling. Full postcodes are stored in canonical form: upper case, one space
// before the three-character inward code ("M14 5TP").

const FULL = /^([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})$/;
const OUTCODE = /^[A-Z]{1,2}\d[A-Z\d]?$/;
const SECTOR = /^([A-Z]{1,2}\d[A-Z\d]?)\s*(\d)$/;

export function normalisePostcode(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const m = FULL.exec(s);
  return m ? `${m[1]} ${m[2]}` : null;
}

export function outcodeOf(postcode: string): string {
  return postcode.split(" ")[0];
}

/**
 * A watch-area prefix: an outcode ("M14"), a sector ("M14 5", the space is required because
 * "M145" is ambiguous) or a full postcode.
 */
export function normalisePrefix(raw: string): { prefix: string; kind: "outcode" | "sector" | "postcode" } | null {
  const full = normalisePostcode(raw);
  if (full) return { prefix: full, kind: "postcode" };
  const s = raw.toUpperCase().trim().replace(/\s+/g, " ");
  const sector = SECTOR.exec(s);
  if (sector && s.includes(" ")) return { prefix: `${sector[1]} ${sector[2]}`, kind: "sector" };
  if (OUTCODE.test(s)) return { prefix: s, kind: "outcode" };
  return null;
}

/** Does a canonical full postcode fall inside a canonical prefix? */
export function postcodeInPrefix(postcode: string, prefix: string): boolean {
  if (prefix.includes(" ")) return postcode === prefix || postcode.startsWith(prefix);
  return outcodeOf(postcode) === prefix;
}

/** Pick the most specific matching prefix. */
export function bestPrefixMatch<T extends { postcode_prefix: string }>(postcode: string, areas: T[]): T | null {
  let best: T | null = null;
  for (const a of areas) {
    if (!postcodeInPrefix(postcode, a.postcode_prefix)) continue;
    if (!best || a.postcode_prefix.length > best.postcode_prefix.length) best = a;
  }
  return best;
}
