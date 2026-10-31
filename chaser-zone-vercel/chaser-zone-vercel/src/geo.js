const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

/** Precompute radians and cos(lat) once per fix so each distance check stays cheap. */
export function toPoint(lat, lng) {
  const latRad = lat * DEG;
  return { lat, lng, latRad, lngRad: lng * DEG, cosLat: Math.cos(latRad) };
}

/** Great-circle distance in meters between two points built with toPoint(). */
export function haversineMeters(a, b) {
  const dLat = b.latRad - a.latRad;
  const dLng = b.lngRad - a.lngRad;
  const h = Math.sin(dLat / 2) ** 2 + a.cosLat * b.cosLat * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial compass bearing in degrees (0 = north) from point a to point b. */
export function bearingDegrees(a, b) {
  const dLng = b.lngRad - a.lngRad;
  const y = Math.sin(dLng) * b.cosLat;
  const x = a.cosLat * Math.sin(b.latRad) - Math.sin(a.latRad) * b.cosLat * Math.cos(dLng);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** Validate an untrusted telemetry packet. Returns a normalized fix or null. */
export function parseTelemetry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { lat, lng, accuracy, ageMs } = raw;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return {
    point: toPoint(lat, lng),
    accuracy: Number.isFinite(accuracy) ? clamp(accuracy, 0, 10_000) : 10_000,
    ageMs: Number.isFinite(ageMs) ? clamp(ageMs, 0, 60_000) : 0,
  };
}
