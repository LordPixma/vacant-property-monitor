import { describe, expect, it } from "vitest";
import { headlineTenure, parseNomis } from "../src/sources/census";
import { circlePoly, previousMonths, summariseCrimes } from "../src/sources/crime";
import { certificateDetails, deepPick } from "../src/sources/epc";
import { imdDecile, mapPostcodesIo } from "../src/sources/postcodes";
import { mapBindings, median, pricePaidQuery, summariseSales } from "../src/sources/pricePaid";
import { classify, groupNearby, osmToRows } from "../src/sources/services";
import { areaRadius } from "../src/servicesSync";
import { boxWkt } from "../src/sources/planning";

describe("postcodes.io mapping", () => {
  it("maps the fields and derives the IMD decile", () => {
    const pc = mapPostcodesIo({
      postcode: "M14 5TP",
      latitude: 53.457,
      longitude: -2.2265,
      country: "England",
      admin_district: "Manchester",
      admin_ward: "Moss Side",
      lsoa21: "Manchester 025C",
      index_of_multiple_deprivation: 8203,
      codes: { admin_district: "E08000003", lsoa21: "E01005244" },
    });
    expect(pc.lsoa_code).toBe("E01005244");
    expect(pc.imd_decile).toBe(3);
    expect(imdDecile(1)).toBe(1);
    expect(imdDecile(32844)).toBe(10);
  });
  it("does not claim an IMD decile outside England", () => {
    expect(mapPostcodesIo({ country: "Wales", index_of_multiple_deprivation: 100, codes: {} }).imd_decile).toBeNull();
  });
});

describe("crime", () => {
  it("builds a closed-ish polygon of the right size", () => {
    const pts = circlePoly(53.45, -2.22, 500).split(":");
    expect(pts).toHaveLength(12);
    expect(pts[0]).toBe("53.45449,-2.22000");
  });
  it("walks back months across a year boundary", () => {
    expect(previousMonths("2026-02", 3)).toEqual(["2026-02", "2026-01", "2025-12"]);
  });
  it("summarises", () => {
    const s = summariseCrimes(
      {
        "2026-08": [
          { category: "anti-social-behaviour", month: "2026-08", location: { street: { name: "On or near A St" } } },
          { category: "anti-social-behaviour", month: "2026-08", location: { street: { name: "On or near A St" } } },
          { category: "burglary", month: "2026-08", outcome_status: { category: "Under investigation" } },
        ],
        "2026-07": [{ category: "drugs", month: "2026-07" }],
      },
      500,
    );
    expect(s.latest_month).toBe("2026-08");
    expect(s.latest_total).toBe(3);
    expect(s.anti_social_behaviour).toBe(2);
    expect(s.monthly_average).toBe(2);
    expect(s.top_streets[0]).toEqual({ street: "On or near A St", count: 2 });
    expect(s.categories[0].label).toBe("Anti-social behaviour");
  });
});

describe("price paid", () => {
  const json = {
    results: {
      bindings: [
        { amount: { value: "250000" }, date: { value: "2024-05-13" }, paon: { value: "14" }, street: { value: "PARK ROAD" }, ptype: { value: "http://landregistry.data.gov.uk/def/common/terraced" } },
        { amount: { value: "150000" }, date: { value: "2009-01-02" }, paon: { value: "16" }, street: { value: "PARK ROAD" } },
        { amount: { value: "120000" }, date: { value: "2003-03-01" }, paon: { value: "14" }, street: { value: "PARK ROAD" } },
      ],
    },
  };
  it("inlines only a canonical postcode", () => {
    expect(pricePaidQuery("M14 5TP")).toContain('lrcommon:postcode "M14 5TP"');
  });
  it("maps and summarises, matching this property", () => {
    const sales = mapBindings(json);
    expect(sales[0].property_type).toBe("Terraced");
    const s = summariseSales(sales, "14 Park Road", new Date("2026-10-26"));
    expect(s.transactions_in_postcode).toBe(3);
    expect(s.sales_last_5y).toBe(1);
    expect(s.this_property.sales).toHaveLength(2);
    expect(s.this_property.last_sale_date).toBe("2024-05-13");
    expect(s.this_property.years_since_last_sale).toBeCloseTo(2.5, 0);
  });
  it("keeps portfolio and commercial sales out of the median", () => {
    const sales = mapBindings({
      results: {
        bindings: [
          { amount: { value: "185000000" }, date: { value: "2025-11-30" }, paon: { value: "10" }, ptype: { value: "x/otherPropertyType" }, cat: { value: "x/additionalPricePaidTransaction" } },
          { amount: { value: "300000" }, date: { value: "2025-01-01" }, paon: { value: "12" }, ptype: { value: "x/terraced" }, cat: { value: "x/standardPricePaidTransaction" } },
        ],
      },
    });
    const s = summariseSales(sales, null, new Date("2026-10-26"));
    expect(s.median_price_5y).toBe(300000);
    expect(s.excluded_from_median).toBe(1);
    expect(s.transactions_in_postcode).toBe(2);
  });
  it("median", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(3);
    expect(median([])).toBeNull();
  });
});

describe("epc", () => {
  it("reads nested keys in any case", () => {
    const j = { data: { assessment: { CurrentEnergyEfficiencyBand: "E", total_floor_area: 74, tenure: "Rented (social)" } } };
    expect(deepPick(j, ["currentEnergyEfficiencyBand"])).toBe("E");
    const d = certificateDetails(j);
    expect(d.floor_area_m2).toBe(74);
    expect(d.tenure).toBe("Rented (social)");
    expect(d.main_fuel).toBeNull();
  });
});

describe("census", () => {
  it("parses nomis and extracts tenure headline", () => {
    const rows = parseNomis({
      obs: [
        { c2021_tenure_9: { description: "Total: All households" }, obs_value: { value: 100 } },
        { c2021_tenure_9: { description: "Owned" }, obs_value: { value: 17.5 } },
        { c2021_tenure_9: { description: "Social rented" }, obs_value: { value: 29.4 } },
        { c2021_tenure_9: { description: "Private rented" }, obs_value: { value: 52.3 } },
      ],
    });
    expect(rows).toHaveLength(3);
    expect(headlineTenure(rows)).toMatchObject({ owned: 17.5, social_rented: 29.4, private_rented: 52.3 });
  });
});

describe("services", () => {
  it("classifies, deduplicates and groups nearest first", () => {
    const rows = osmToRows([
      { type: "node", id: 1, lat: 53.46, lon: -2.22, tags: { amenity: "social_facility", social_facility: "food_bank", name: "Far Bank" } },
      { type: "node", id: 2, lat: 53.4501, lon: -2.22, tags: { amenity: "social_facility", social_facility: "food_bank", name: "Near Bank" } },
      { type: "node", id: 2, lat: 53.4501, lon: -2.22, tags: { amenity: "social_facility", social_facility: "food_bank", name: "Near Bank" } },
      { type: "way", id: 3, center: { lat: 53.451, lon: -2.221 }, tags: { amenity: "social_facility", social_facility: "shelter", name: "Night Shelter" } },
      { type: "node", id: 4, lat: 53.452, lon: -2.22, tags: { highway: "bus_stop" } },
      { type: "node", id: 5, lat: 53.452, lon: -2.22, tags: { amenity: "bench" } },
      { type: "node", id: 6, tags: { amenity: "pharmacy" } },
    ]);
    expect(rows.map((r) => r.osm_ref)).toEqual(["node/1", "node/2", "way/3", "node/4"]);
    const g = groupNearby(rows.map((r) => ({ ...r, id: r.osm_ref, source: "osm" as const, notes: null })), 53.45, -2.22, 2000);
    expect(g.food_bank.count).toBe(2);
    expect((g.food_bank.nearest[0] as { name: string }).name).toBe("Near Bank");
    expect(g.shelter.count).toBe(1);
    expect(g.transport.count).toBe(1);
    // Outside the radius is not counted.
    expect(groupNearby(rows.map((r) => ({ ...r, id: r.osm_ref, source: "osm" as const, notes: null })), 53.45, -2.22, 500).food_bank.count).toBe(1);
  });
  it("classifies an old-style homeless shelter but not a bus shelter", () => {
    expect(classify({ amenity: "shelter", shelter_type: "homeless" })).toBe("shelter");
    expect(classify({ amenity: "shelter", shelter_type: "public_transport" })).toBeNull();
  });
  it("sizes the sync radius by prefix", () => {
    expect(areaRadius("M14")).toBe(3000);
    expect(areaRadius("M14 5")).toBe(1500);
    expect(areaRadius("M14 5TP")).toBe(1000);
  });
});

describe("planning", () => {
  it("builds a closed WKT box", () => {
    const w = boxWkt(51.5, -0.1, 250);
    const pts = w.slice(9, -2).split(",");
    expect(pts[0]).toBe(pts[4]);
  });
});
