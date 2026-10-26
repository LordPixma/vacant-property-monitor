import { describe, expect, it } from "vitest";
import { addressMatchScore, splitAddress } from "../src/lib/address";
import { hashPassword, passwordProblem, verifyPassword } from "../src/lib/crypto";
import { csvToObjects, parseCsv, toCsv } from "../src/lib/csv";
import { boundingBox, distanceMetres } from "../src/lib/geo";
import { bestPrefixMatch, normalisePostcode, normalisePrefix, postcodeInPrefix } from "../src/lib/postcode";
import { sniffImage } from "../src/routes/fieldwork";

describe("postcodes", () => {
  it("normalises", () => {
    expect(normalisePostcode("m145tp")).toBe("M14 5TP");
    expect(normalisePostcode(" SW1A 1aa ")).toBe("SW1A 1AA");
    expect(normalisePostcode("EC1A1BB")).toBe("EC1A 1BB");
    expect(normalisePostcode("not a postcode")).toBeNull();
    expect(normalisePostcode("M14")).toBeNull();
  });
  it("parses prefixes", () => {
    expect(normalisePrefix("m14")).toEqual({ prefix: "M14", kind: "outcode" });
    expect(normalisePrefix("M14 5")).toEqual({ prefix: "M14 5", kind: "sector" });
    expect(normalisePrefix("m14 5tp")).toEqual({ prefix: "M14 5TP", kind: "postcode" });
    expect(normalisePrefix("M145")).toBeNull(); // no space: not a valid outcode, and too ambiguous to guess a sector
    expect(normalisePrefix("hello")).toBeNull();
  });
  it("matches the most specific area", () => {
    expect(postcodeInPrefix("M14 5TP", "M14")).toBe(true);
    expect(postcodeInPrefix("M1 4AB", "M14")).toBe(false);
    expect(postcodeInPrefix("M14 5TP", "M14 5")).toBe(true);
    expect(postcodeInPrefix("M14 6AB", "M14 5")).toBe(false);
    const areas = [{ id: "a", postcode_prefix: "M14" }, { id: "b", postcode_prefix: "M14 5" }];
    expect(bestPrefixMatch("M14 5TP", areas)?.id).toBe("b");
    expect(bestPrefixMatch("M14 7AA", areas)?.id).toBe("a");
    expect(bestPrefixMatch("LS1 4AP", areas)).toBeNull();
  });
});

describe("addresses", () => {
  it("splits flat, number and street", () => {
    expect(splitAddress("Flat 2, 14 Park Road")).toEqual({ saon: "FLAT 2", paon: "14", street: "PARK RD" });
    expect(splitAddress("27a High Street")).toEqual({ saon: null, paon: "27A", street: "HIGH ST" });
  });
  it("scores matches against Land Registry style fields", () => {
    expect(addressMatchScore("14 Park Road", { paon: "14", street: "PARK ROAD" })).toBe(1);
    expect(addressMatchScore("14 Park Road", { paon: "16", street: "PARK ROAD" })).toBe(0);
    expect(addressMatchScore("Flat 2, 14 Park Road", { paon: "14", saon: "FLAT 3", street: "PARK ROAD" })).toBe(0);
    expect(addressMatchScore("Flat 2, 14 Park Road", { paon: "14", saon: "FLAT 2", street: "PARK ROAD" })).toBe(1);
    expect(addressMatchScore("14 Park Road", { line: "14, Park Road" })).toBe(1);
  });
});

describe("csv", () => {
  it("handles quotes, commas and newlines", () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\n"multi\nline",2\n')).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"'],
      ["multi\nline", "2"],
    ]);
  });
  it("normalises headers", () => {
    expect(csvToObjects("Property Address,Post Code\n1 A St,M1 1AA")[0]).toEqual({ property_address: "1 A St", post_code: "M1 1AA" });
  });
  it("neutralises formula injection on export", () => {
    expect(toCsv([{ a: "=HYPERLINK(1)", b: "plain" }])).toBe("a,b\r\n'=HYPERLINK(1),plain\r\n");
    expect(toCsv([{ a: -2.2346, b: "-2.5", c: "-cmd" }])).toBe("a,b,c\r\n-2.2346,-2.5,'-cmd\r\n");
  });
});

describe("crypto", () => {
  it("hashes and verifies passwords", async () => {
    const h = await hashPassword("correct horse battery", undefined, 1000);
    expect(await verifyPassword("correct horse battery", h.hash, h.salt, 1000)).toBe(true);
    expect(await verifyPassword("wrong horse battery", h.hash, h.salt, 1000)).toBe(false);
  });
  it("enforces a sane policy", () => {
    expect(passwordProblem("short")).not.toBeNull();
    expect(passwordProblem("1234567890")).not.toBeNull();
    expect(passwordProblem("aaaaaaaaaaaa")).not.toBeNull();
    expect(passwordProblem("a long passphrase")).toBeNull();
  });
});

describe("geo", () => {
  it("measures distance", () => {
    // Manchester Piccadilly to Manchester Victoria is about 1.5 km.
    const d = distanceMetres(53.4773, -2.2309, 53.4875, -2.2425);
    expect(d).toBeGreaterThan(1300);
    expect(d).toBeLessThan(1600);
  });
  it("bounding box contains the radius", () => {
    const b = boundingBox(53.45, -2.22, 1000);
    expect(distanceMetres(53.45, -2.22, b.maxLat, -2.22)).toBeCloseTo(1000, -1);
  });
});

describe("image sniffing", () => {
  it("accepts real images and rejects others", () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))?.type).toBe("image/jpeg");
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))?.type).toBe("image/png");
    expect(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))?.type).toBe("image/webp");
    expect(sniffImage(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
  });
});
