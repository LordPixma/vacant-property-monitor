// Matching a free-typed address against Land Registry (PAON/SAON) and EPC address lines.

export function normaliseAddress(s: string | null | undefined): string {
  return (s ?? "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\b(ROAD)\b/g, "RD")
    .replace(/\b(STREET)\b/g, "ST")
    .replace(/\b(AVENUE)\b/g, "AVE")
    .replace(/\b(LANE)\b/g, "LN")
    .replace(/\b(DRIVE)\b/g, "DR")
    .replace(/\b(COURT)\b/g, "CT")
    .replace(/\b(APARTMENT|APT)\b/g, "FLAT")
    .replace(/\s+/g, " ")
    .trim();
}

/** The building number or name (PAON) and the sub-building (SAON, e.g. "FLAT 2") from an address line. */
export function splitAddress(line: string): { saon: string | null; paon: string | null; street: string | null } {
  const n = normaliseAddress(line);
  const flat = /\b(FLAT|UNIT|ROOM|STUDIO)\s+([A-Z0-9]+)\b/.exec(n);
  const saon = flat ? `${flat[1]} ${flat[2]}` : null;
  const rest = flat ? n.replace(flat[0], " ").replace(/\s+/g, " ").trim() : n;
  const num = /\b(\d+[A-Z]?(?:\s*-\s*\d+[A-Z]?)?)\b\s+(.*)$/.exec(rest);
  if (num) return { saon, paon: num[1].replace(/\s/g, ""), street: num[2] || null };
  // A named building: everything before the first street-type word.
  const parts = rest.split(" ");
  const idx = parts.findIndex((p) => /^(RD|ST|AVE|LN|DR|CT|CLOSE|WAY|PLACE|GROVE|TERRACE|CRESCENT|GARDENS|HILL|ROW|SQUARE|WALK)$/.test(p));
  if (idx > 1) return { saon, paon: parts.slice(0, idx - 1).join(" "), street: parts.slice(idx - 1).join(" ") };
  return { saon, paon: rest || null, street: null };
}

/**
 * Score how well a candidate (from a public register) matches our address. 0 = no match, 1 = exact.
 * The building number must match exactly; the flat number must match when both sides have one.
 */
export function addressMatchScore(ours: string, candidate: { paon?: string | null; saon?: string | null; street?: string | null; line?: string | null }): number {
  const a = splitAddress(ours);
  let cPaon = candidate.paon ? normaliseAddress(candidate.paon) : null;
  let cSaon = candidate.saon ? normaliseAddress(candidate.saon) : null;
  let cStreet = candidate.street ? normaliseAddress(candidate.street) : null;
  if (candidate.line && !cPaon) {
    const b = splitAddress(candidate.line);
    cPaon = b.paon;
    cSaon = cSaon ?? b.saon;
    cStreet = cStreet ?? b.street;
  }
  if (!a.paon || !cPaon || a.paon !== cPaon) return 0;
  let score = 0.6;
  if (a.saon || cSaon) {
    if (a.saon && cSaon && a.saon === cSaon) score += 0.25;
    else if (a.saon && cSaon) return 0;
    else score -= 0.2;
  } else score += 0.15;
  if (a.street && cStreet && (a.street.includes(cStreet) || cStreet.includes(a.street))) score += 0.25;
  return Math.min(1, Math.max(0, score));
}
