// Trend math from The Hacker's Diet (John Walker), matching the reference
// implementation in Hacker's Diet Online (HDiet/monthlog.pm, HDiet/trendfit.pm):
// an exponentially smoothed moving average with a 10% smoothing factor.
// Shared by the browser UI and the Worker (CSV export) — keep dependency-free.

/**
 * Build the day-by-day trend series.
 *
 * @param {Array<{date: string, weight: number}>} entries - logged weights,
 *   dates as "YYYY-MM-DD", ascending order.
 * @param {string} endDate - last date (inclusive) to carry the trend to.
 * @returns {Map<string, number>} date -> trend value, for every day from the
 *   first entry through endDate. Days with a logged weight move the trend by
 *   (weight - trend) / 10; days without leave it unchanged.
 */
export function buildTrendSeries(entries, endDate) {
  const series = new Map();
  if (entries.length === 0) return series;

  const byDate = new Map(entries.map((e) => [e.date, e.weight]));
  let t = entries[0].weight;
  let day = parseDate(entries[0].date);
  const end = parseDate(endDate);

  while (day <= end) {
    const iso = toISO(day);
    const w = byDate.get(iso);
    if (w !== undefined && w > 0) {
      t = t + (w - t) / 10;
    }
    series.set(iso, t);
    day = new Date(day.getTime() + 86400000);
  }
  return series;
}

/**
 * Least-squares slope over equally spaced values (units per day),
 * identical to HDiet::trendfit. Returns null when fewer than 2 points.
 * @param {number[]} values
 */
export function fitSlope(values) {
  let s1 = 0, s2 = 0, s3 = 0, s4 = 0, n = 0;
  for (const v of values) {
    s1 += (n + 1) * v;
    s2 += n + 1;
    s3 += v;
    s4 += (n + 1) ** 2;
    n++;
  }
  const denom = s4 * n - s2 ** 2;
  if (n < 2 || denom === 0) return null;
  return (s1 * n - s2 * s3) / denom;
}

/** @param {string} iso */
export function parseDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** @param {Date} date */
export function toISO(date) {
  return date.toISOString().slice(0, 10);
}
