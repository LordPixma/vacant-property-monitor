const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** A lat/lng box containing a circle, for an indexable pre-filter before the exact distance. */
export function boundingBox(lat: number, lng: number, radiusM: number) {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos(rad(lat)) || 1);
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

export function isUkish(lat: number, lng: number): boolean {
  return lat > 49.5 && lat < 61 && lng > -8.7 && lng < 2.1;
}
