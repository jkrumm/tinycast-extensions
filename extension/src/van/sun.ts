// Sunrise and sunset from the NOAA general solar position equations — pure, no
// dependency. Source: NOAA Global Monitoring Laboratory, "General Solar
// Position Calculations" (the spreadsheet behind gml.noaa.gov/grad/solcalc),
// accurate to about a minute away from the poles; used here to shade the night
// in the 3-day charge chart, where that is far more than enough.

export interface Location {
  lat: number; // degrees north
  lon: number; // degrees east
}

export type SunTimes =
  | { kind: "day-night"; sunrise: number; sunset: number } // epoch ms
  | { kind: "polar-day" } // the sun does not set
  | { kind: "polar-night" }; // the sun does not rise

const RAD = Math.PI / 180;
// Apparent sunrise/sunset: the sun's centre 90.833° from the zenith (refraction
// plus the solar radius).
const ZENITH = 90.833;

// Julian day of 12:00 UTC on a calendar date (Gregorian).
function julianDayAtNoon(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const m = month <= 2 ? month + 12 : month;
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return (
    Math.floor(365.25 * (y + 4716)) +
    Math.floor(30.6001 * (m + 1)) +
    day +
    b -
    1524.5 +
    0.5
  );
}

// Sunrise/sunset on the UTC calendar date `year-month-day` (month 1–12) at the
// given place. Times are epoch ms and may fall on the neighbouring UTC day for
// places far from Greenwich.
export function sunTimes(opts: {
  year: number;
  month: number;
  day: number;
  location: Location;
}): SunTimes {
  const { year, month, day, location } = opts;
  const t = (julianDayAtNoon(year, month, day) - 2451545) / 36525; // Julian century

  const meanLong = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const center =
    Math.sin(meanAnomaly * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnomaly * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnomaly * RAD) * 0.000289;
  const trueLong = meanLong + center;
  const apparentLong =
    trueLong - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * t) * RAD);
  const meanObliquity =
    23 +
    (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity =
    meanObliquity + 0.00256 * Math.cos((125.04 - 1934.136 * t) * RAD);
  const declination = Math.asin(
    Math.sin(obliquity * RAD) * Math.sin(apparentLong * RAD),
  );

  const y = Math.tan((obliquity / 2) * RAD) ** 2;
  const equationOfTime =
    (4 *
      (y * Math.sin(2 * meanLong * RAD) -
        2 * eccentricity * Math.sin(meanAnomaly * RAD) +
        4 *
          eccentricity *
          y *
          Math.sin(meanAnomaly * RAD) *
          Math.cos(2 * meanLong * RAD) -
        0.5 * y * y * Math.sin(4 * meanLong * RAD) -
        1.25 * eccentricity * eccentricity * Math.sin(2 * meanAnomaly * RAD))) /
    RAD; // minutes

  const lat = location.lat * RAD;
  const cosHourAngle =
    Math.cos(ZENITH * RAD) / (Math.cos(lat) * Math.cos(declination)) -
    Math.tan(lat) * Math.tan(declination);
  if (cosHourAngle > 1) return { kind: "polar-night" };
  if (cosHourAngle < -1) return { kind: "polar-day" };
  const hourAngle = Math.acos(cosHourAngle) / RAD; // degrees

  const noonMinutes = 720 - 4 * location.lon - equationOfTime;
  const dayStart = Date.UTC(year, month - 1, day);
  return {
    kind: "day-night",
    sunrise: dayStart + (noonMinutes - 4 * hourAngle) * 60_000,
    sunset: dayStart + (noonMinutes + 4 * hourAngle) * 60_000,
  };
}

export interface Span {
  from: number;
  to: number;
}

// The night spans (sunset → next sunrise) overlapping [from, to], clipped to
// it. Walks the UTC calendar days around the window so a place far from
// Greenwich still gets both ends of every night.
export function nightSpans(opts: {
  from: number;
  to: number;
  location: Location;
}): Span[] {
  const { from, to, location } = opts;
  const DAY = 86_400_000;
  const first = new Date(from - 2 * DAY);
  const spans: Span[] = [];
  let dayStart = Date.UTC(
    first.getUTCFullYear(),
    first.getUTCMonth(),
    first.getUTCDate(),
  );
  let darkSince: number | null = null; // a sunset waiting for its sunrise
  for (; dayStart <= to + 2 * DAY; dayStart += DAY) {
    const d = new Date(dayStart);
    const sun = sunTimes({
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      location,
    });
    if (sun.kind === "polar-night") {
      spans.push({ from: dayStart, to: dayStart + DAY });
      continue;
    }
    if (sun.kind === "polar-day") continue;
    // sunrise ends a night started by the previous sunset (or by midnight if
    // the walk began in the dark); sunset starts the next one.
    if (darkSince !== null) {
      spans.push({ from: darkSince, to: sun.sunrise });
    } else if (sun.sunrise > dayStart && sun.sunrise < sun.sunset) {
      spans.push({ from: dayStart, to: sun.sunrise });
    }
    darkSince = sun.sunset;
  }
  return mergeAndClip(spans, from, to);
}

function mergeAndClip(spans: Span[], from: number, to: number): Span[] {
  const clipped = spans
    .map((s) => ({ from: Math.max(s.from, from), to: Math.min(s.to, to) }))
    .filter((s) => s.to > s.from)
    .sort((a, b) => a.from - b.from);
  const merged: Span[] = [];
  for (const s of clipped) {
    const last = merged[merged.length - 1];
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else merged.push({ ...s });
  }
  return merged;
}

// The place is not configured and never asked for: latitude 45° N (the middle
// of where a European van travels) and the longitude implied by the machine's
// UTC offset, 15° per hour. Sunrise/sunset come out right to within about an
// hour — plenty for faint night shading.
export function defaultLocation(now: number = Date.now()): Location {
  return { lat: 45, lon: (-new Date(now).getTimezoneOffset() / 60) * 15 };
}
