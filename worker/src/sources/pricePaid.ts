import { addressMatchScore } from "../lib/address";
import type { SourceDef } from "./types";

export interface Sale {
  date: string;
  price: number;
  paon: string | null;
  saon: string | null;
  street: string | null;
  property_type: string | null;
  estate_type: string | null;
  new_build: boolean;
  /** Category A: an ordinary sale at full market value. Category B covers repossessions, portfolio and company sales. */
  standard: boolean;
}

const TYPE_LABELS: Record<string, string> = {
  detached: "Detached",
  "semi-detached": "Semi-detached",
  terraced: "Terraced",
  "flat-maisonette": "Flat / maisonette",
  "other-property-type": "Other",
  otherPropertyType: "Other",
  flatMaisonette: "Flat / maisonette",
  semiDetached: "Semi-detached",
};

export function pricePaidQuery(postcode: string): string {
  // Postcode is canonicalised before it gets here (A-Z, 0-9 and one space), so it is safe to inline.
  return `PREFIX lrppi: <http://landregistry.data.gov.uk/def/ppi/>
PREFIX lrcommon: <http://landregistry.data.gov.uk/def/common/>
SELECT ?amount ?date ?paon ?saon ?street ?ptype ?estate ?newbuild ?cat WHERE {
  ?addr lrcommon:postcode "${postcode}" .
  ?tx lrppi:propertyAddress ?addr ;
      lrppi:pricePaid ?amount ;
      lrppi:transactionDate ?date .
  OPTIONAL { ?tx lrppi:propertyType ?ptype }
  OPTIONAL { ?tx lrppi:estateType ?estate }
  OPTIONAL { ?tx lrppi:newBuild ?newbuild }
  OPTIONAL { ?tx lrppi:transactionCategory ?cat }
  OPTIONAL { ?addr lrcommon:paon ?paon }
  OPTIONAL { ?addr lrcommon:saon ?saon }
  OPTIONAL { ?addr lrcommon:street ?street }
} ORDER BY DESC(?date) LIMIT 300`;
}

const last = (uri?: string) => (uri ? uri.split("/").pop() ?? null : null);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapBindings(json: any): Sale[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (json?.results?.bindings ?? []).map((b: any) => {
    const t = last(b.ptype?.value);
    return {
      date: b.date?.value,
      price: Number(b.amount?.value),
      paon: b.paon?.value ?? null,
      saon: b.saon?.value ?? null,
      street: b.street?.value ?? null,
      property_type: t ? TYPE_LABELS[t] ?? t : null,
      estate_type: last(b.estate?.value),
      new_build: b.newbuild?.value === "true",
      standard: !String(b.cat?.value ?? "").includes("additional"),
    };
  });
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export function summariseSales(sales: Sale[], addressLine1: string | null, today = new Date()) {
  const fiveYearsAgo = new Date(today);
  fiveYearsAgo.setUTCFullYear(today.getUTCFullYear() - 5);
  const cutoff = fiveYearsAgo.toISOString().slice(0, 10);
  // Medians use ordinary residential sales only: one portfolio or commercial sale can be worth
  // hundreds of homes and would swamp a postcode's median.
  const priced = sales.filter((s) => s.standard && s.property_type !== "Other");
  const recent = priced.filter((s) => s.date >= cutoff);
  const byYear: Record<string, number[]> = {};
  for (const s of priced) (byYear[s.date.slice(0, 4)] ??= []).push(s.price);
  const matched = addressLine1
    ? sales
        .map((s) => ({ s, score: addressMatchScore(addressLine1, { paon: s.paon, saon: s.saon, street: s.street }) }))
        .filter((m) => m.score >= 0.6)
        .map((m) => m.s)
    : [];
  return {
    transactions_in_postcode: sales.length,
    median_price_5y: median(recent.map((s) => s.price)),
    sales_last_5y: recent.length,
    excluded_from_median: sales.length - priced.length,
    latest_sale_in_postcode: sales[0] ?? null,
    yearly_median: Object.entries(byYear)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-12)
      .map(([year, prices]) => ({ year, median: median(prices), count: prices.length })),
    this_property: {
      matched: matched.length > 0,
      sales: matched,
      last_sale_date: matched[0]?.date ?? null,
      last_sale_price: matched[0]?.price ?? null,
      years_since_last_sale: matched[0] ? Math.round(((today.getTime() - Date.parse(matched[0].date)) / 31_557_600_000) * 10) / 10 : null,
    },
    recent_sales: sales.slice(0, 15),
  };
}

export const pricePaidSource: SourceDef = {
  id: "price_paid",
  label: "Sales history (HM Land Registry)",
  attribution: "HM Land Registry Price Paid Data — Open Government Licence v3.0. Contains HM Land Registry data © Crown copyright and database right.",
  needs: [],
  async run(input, ctx) {
    const sales = await ctx.cached(`ppd:${input.postcode}`, 7 * 86_400, async () => {
      const url = `https://landregistry.data.gov.uk/landregistry/query?query=${encodeURIComponent(pricePaidQuery(input.postcode))}`;
      const json = await ctx.fetchJson(url, { headers: { accept: "application/sparql-results+json" }, timeoutMs: 20_000 });
      return mapBindings(json);
    });
    if (!sales.length) return { status: "empty", data: summariseSales([], input.addressLine1) };
    return { status: "ok", data: summariseSales(sales, input.addressLine1) };
  },
};
