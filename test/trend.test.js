// Hacker's Diet trend math (public/trend.js). These tests pin down the
// existing behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTrendSeries, fitSlope } from "../public/trend.js";

// Equal to within 1e-9: floating point makes e.g. 180 - 197.1 come out as
// -17.099999999999994, so exact === comparisons would fail spuriously.
const assertNear = (actual, expected, msg) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ""} expected ${expected}, got ${actual}`);

test("trend starts at the first weight and moves 1/10 of the gap per logged day", () => {
  const t = buildTrendSeries(
    [{ date: "2024-01-01", weight: 200 }, { date: "2024-01-02", weight: 190 }, { date: "2024-01-03", weight: 210 }],
    "2024-01-03"
  );
  assert.deepEqual([...t.keys()], ["2024-01-01", "2024-01-02", "2024-01-03"]);
  assertNear(t.get("2024-01-01"), 200);
  assertNear(t.get("2024-01-02"), 199); // 200 + (190 - 200) / 10
  assertNear(t.get("2024-01-03"), 200.1); // 199 + (210 - 199) / 10
});

test("missing days carry the trend unchanged, through endDate", () => {
  const t = buildTrendSeries(
    [{ date: "2024-01-01", weight: 200 }, { date: "2024-01-04", weight: 180 }],
    "2024-01-06"
  );
  assert.equal(t.size, 6);
  assertNear(t.get("2024-01-02"), 200);
  assertNear(t.get("2024-01-03"), 200);
  assertNear(t.get("2024-01-04"), 198); // 200 + (180 - 200) / 10
  assertNear(t.get("2024-01-05"), 198);
  assertNear(t.get("2024-01-06"), 198);
});

test("comment-only and zero-weight days never move the trend", () => {
  const t = buildTrendSeries(
    [
      { date: "2024-01-01", weight: null, comment: "before first weight" },
      { date: "2024-01-02", weight: 100 },
      { date: "2024-01-03", weight: null, comment: "in Iceland" },
      { date: "2024-01-04", weight: 0 },
      { date: "2024-01-05", comment: "no weight key at all" },
    ],
    "2024-01-05"
  );
  assert.equal(t.has("2024-01-01"), false, "series starts at the first weighted day");
  for (const d of ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"]) assertNear(t.get(d), 100, d);
});

test("empty input and endDate before the first weight give an empty series", () => {
  assert.equal(buildTrendSeries([], "2024-01-01").size, 0);
  assert.equal(buildTrendSeries([{ date: "2024-01-01", weight: null }], "2024-01-01").size, 0);
  assert.equal(buildTrendSeries([{ date: "2024-02-01", weight: 150 }], "2024-01-31").size, 0);
});

test("trend crosses month, year and leap-day boundaries day by day", () => {
  const t = buildTrendSeries([{ date: "2023-12-31", weight: 80 }, { date: "2024-03-01", weight: 70 }], "2024-03-01");
  assert.equal(t.size, 62); // Dec 31 + 31 Jan + 29 Feb + Mar 1
  assert.ok(t.has("2024-02-29"));
  assertNear(t.get("2024-02-29"), 80);
  assertNear(t.get("2024-03-01"), 79);
});

// Floaters and sinkers: on the chart each logged weight is drawn at its own
// value and joined by a vertical line to the trend value of the SAME day
// (public/app.js renderChart); the table's Var column is weight - trend.
// Weight above trend floats (bad, "+"), below it sinks (good).
test("floaters and sinkers are measured against the same day's trend", () => {
  const entries = [
    { date: "2024-01-01", weight: 200 },
    { date: "2024-01-02", weight: 190 },
    { date: "2024-01-04", weight: 180 },
    { date: "2024-01-05", weight: 210 },
  ];
  const t = buildTrendSeries(entries, "2024-01-05");
  const variance = Object.fromEntries(entries.map((e) => [e.date, e.weight - t.get(e.date)]));
  assertNear(variance["2024-01-01"], 0);
  assertNear(variance["2024-01-02"], -9); // sinker: 190 vs trend 199
  assertNear(variance["2024-01-04"], 180 - 197.1); // sinker (trend 199 carried over 01-03)
  assertNear(t.get("2024-01-05"), 197.1 + (210 - 197.1) / 10);
  assertNear(variance["2024-01-05"], 210 - 198.39); // floater
  assert.ok(variance["2024-01-05"] > 0);
});

// fitSlope answers "how fast is the trend changing?". It takes one trend value
// per consecutive day and returns the slope of the best-fitting straight line,
// in lb (or kg) per day. The app shows slope * 7 as the weekly Rate, and
// slope * KCAL_PER_UNIT (in trend.js) as the daily calorie deficit or excess.
//
// "Best-fitting" means least squares. Picture the values as dots on a graph
// (day across, weight up). For any straight line, measure each dot's vertical
// gap to it, square the gaps (so gaps above and below both count, and big
// misses count extra) and add them up. The least-squares line is the one with
// the smallest total. It is what a spreadsheet's SLOPE() function computes.
test("fitSlope is the slope of the best-fitting straight line", () => {
  // Fewer than two values: no line can be drawn, so no rate is shown.
  assert.equal(fitSlope([]), null);
  assert.equal(fitSlope([150]), null);

  // Values on a perfect straight line: the slope is simply the daily step.
  assertNear(fitSlope([5, 5]), 0); // flat
  assertNear(fitSlope([1, 2, 3]), 1); // up 1 a day
  assertNear(fitSlope([10, 8, 6, 4]), -2); // down 2 a day

  // Values that are NOT on a straight line, which is what real trends look
  // like. These are days 1-4 of the floaters/sinkers test above (weights 200,
  // 190, none, 180). The textbook shortcut for the least-squares slope is
  // sum(dx * dy) / sum(dx * dx), where dx is how far each day is from the
  // average day (2.5) and dy how far each value is from the average (198.775):
  //
  //   day  value   dx      dy      dx * dy   dx * dx
  //    1   200    -1.5    1.225   -1.8375     2.25
  //    2   199    -0.5    0.225   -0.1125     0.25
  //    3   199     0.5    0.225    0.1125     0.25
  //    4   197.1   1.5   -1.675   -2.5125     2.25
  //                               -4.35       5       -4.35 / 5 = -0.87 a day
  //
  // fitSlope uses Hacker's Diet Online's running-sum form of the same formula,
  // so this checks the two agree on uneven data.
  assertNear(fitSlope([200, 199, 199, 197.1]), -0.87);
});
