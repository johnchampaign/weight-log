// Trend math from The Hacker's Diet (John Walker), matching the reference
// implementation in Hacker's Diet Online (HDiet/monthlog.pm, HDiet/trendfit.pm):
// an exponentially smoothed moving average with a 10% smoothing factor.
// Shared by the browser UI and the Worker (CSV export) — keep dependency-free.

/**
 * Build the day-by-day trend series.
 *
 * @param {Array<{date: string, weight: ?number}>} entries - log rows, dates as
 *   "YYYY-MM-DD", ascending order. Rows with a null/absent weight
 *   (comment-only days) are ignored.
 * @param {string} endDate - last date (inclusive) to carry the trend to.
 * @returns {Map<string, number>} date -> trend value, for every day from the
 *   first weighted entry through endDate. Days with a logged weight move the
 *   trend by (weight - trend) / 10; days without leave it unchanged.
 */
export function buildTrendSeries(allEntries, endDate) {
  const series = new Map();
  const entries = allEntries.filter((e) => typeof e.weight === "number" && e.weight > 0);
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

/** Energy per unit of body weight (HDiet::monthlog CALORIES_PER_WEIGHT_UNIT). */
export const KCAL_PER_UNIT = { lb: 3500, kg: 7716 };

const DAY_MS = 86400000;

export const KG_PER_LB = 1 / 2.2046226218;

/**
 * Body mass index (kg / m²), or null without a height.
 * @param {number} weight - in `unit`
 * @param {"lb"|"kg"} unit
 * @param {?number} heightCm
 */
export function bodyMassIndex(weight, unit, heightCm) {
  if (!heightCm || !(weight > 0)) return null;
  const kg = unit === "kg" ? weight : weight * KG_PER_LB;
  return kg / (heightCm / 100) ** 2;
}

/**
 * Diet plan weight on a date: a straight line from the start weight moving
 * toward the goal at |calorieBalance| / KCAL_PER_UNIT per day, flat at the
 * goal once reached. Null before the plan starts.
 * @param {{startDate: string, startWeight: number, goalWeight: number, calorieBalance: number}} plan
 * @param {string} date
 * @param {"lb"|"kg"} unit
 */
export function planWeightOn(plan, date, unit) {
  if (!plan || date < plan.startDate) return null;
  const days = (parseDate(date) - parseDate(plan.startDate)) / DAY_MS;
  const rate = Math.abs(plan.calorieBalance) / KCAL_PER_UNIT[unit];
  const dir = Math.sign(plan.goalWeight - plan.startWeight);
  const w = plan.startWeight + dir * rate * days;
  return dir < 0 ? Math.max(w, plan.goalWeight) : Math.min(w, plan.goalWeight);
}

/** Date the plan reaches its goal, or null if it can't (zero balance). */
export function planEndDate(plan, unit) {
  const rate = Math.abs(plan.calorieBalance) / KCAL_PER_UNIT[unit];
  if (rate === 0) return null;
  const days = Math.ceil(Math.abs(plan.goalWeight - plan.startWeight) / rate);
  return toISO(new Date(parseDate(plan.startDate).getTime() + days * DAY_MS));
}

/**
 * Hacker's Diet Online "Trend Analysis" (HackDiet.pl q=trendan,
 * history::analyseTrend): for each [start, end] interval, least-squares
 * slope of the daily trend plus its min/mean/max over that interval.
 * @param {Map<string, number>} trend - from buildTrendSeries
 * @param {Array<[string, string]>} intervals - inclusive ISO date pairs
 */
export function analyseTrend(trend, intervals) {
  return intervals.map(([from, to]) => {
    const values = [];
    for (const [date, t] of trend) {
      if (date >= from && date <= to) values.push(t);
    }
    if (values.length === 0) return null;
    return {
      from,
      to,
      slope: fitSlope(values),
      min: Math.min(...values),
      max: Math.max(...values),
      mean: values.reduce((a, b) => a + b, 0) / values.length,
    };
  });
}

/**
 * Start date of an HDO standard interval ending on `end`: positive n means
 * n days back (so "week" spans 8 days inclusive, as in HDO); negative n means
 * |n| calendar months back, clamped to the target month's length.
 * @param {string} end
 * @param {number} n
 */
export function intervalStart(end, n) {
  const d = parseDate(end);
  if (n >= 0) return toISO(new Date(d.getTime() - n * DAY_MS));
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return toISO(new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay))));
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
