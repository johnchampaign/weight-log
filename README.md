# Weight Log

A [Hacker's Diet](https://www.fourmilab.ch/hackdiet/) style weight tracker:
log a daily weight, and an exponentially smoothed moving average (10%
smoothing factor) shows the real trend beneath the day-to-day noise, with a
floats-and-sinkers chart, weekly rate, and estimated daily calorie
deficit/excess.

**Live:** https://weight-log.johnchampaign.workers.dev

## Features

- Month-view log: one entry field per day, spreadsheet-style keyboard
  navigation (Enter/arrows move between days).
- Trend math identical to Hacker's Diet Online (`monthlog.pm` /
  `trendfit.pm`): logged days move the trend by `(weight − trend) / 10`,
  missing days carry it unchanged; rate is a least-squares fit over the daily
  trend values.
- Accounts (email + password), sessions last 180 days.
- lb/kg preference.
- Per-day comments (up to 4096 chars); comment-only days are allowed and
  never move the trend.
- **History tab** — HDO's "Choose Monthly Log": a calendar for each year
  with entries, oldest first; months with entries open that month's log.
  "Show log for" jumps to any month back to 1985.
- **Chart tab** — HDO's Chart Workshop (`history::drawChart`): the last
  month, quarter, six months or year up to the latest weigh-in, or any custom
  range. Trend, weights, rung line and plan line, with the period's weekly
  rate, calorie balance, % flagged and BMI underneath. Weights are floats and
  sinkers at 7+ px/day, a grey line below that, and columns average several
  days when a range has more days than pixels (HDO's `getDays`).
- **Trend tab** — HDO's Trend Analysis: gain/loss per week, calorie
  excess/deficit, and min/mean/max trend over the last week, fortnight,
  month, quarter, six months and year (ending on the latest weigh-in), plus
  any custom period. Same interval rules as HDO (`history::analyseTrend`).
- **Goal tab** — HDO's diet calculator: start date/weight, goal weight and
  daily calorie deficit. When enabled, the plan is drawn on the month chart
  as a dashed yellow line, flat at the goal weight after the plan ends.
- **Body mass index** — set a height (cm, or feet and inches) on the Goal
  tab and the Log tab shows BMI as HDO did (`monthlog::bodyMassIndex`): from
  the trend on the month's last weigh-in, plus the mean trend over the days
  weighed that month. No height, no BMI.
- **Exercise rung and flag** per day, as in HDO. Rungs (1–48, the book's
  exercise ladder) plot as a blue line on their own right-hand scale; `.`
  copies the month's previous rung, `+`/`-` step one up or down. Flagged
  days' diamonds are filled yellow and the month shows the % flagged.
  Commented days get a small dot beside the diamond.
- CSV export (`Date,Weight,Trend,Rung,Flag,Comment`).
- CSV import — accepts both this site's export format and the Hacker's Diet
  Online CSV export (`Date,Weight,Rung,Flag,Comment`). Existing dates are
  overwritten, blank rows skipped. Comments, rungs, flags and the diet plan
  import too. HDO months logged in a different unit than the
  account (per-month `StartTrend` unit field) are converted.

## Stack

Single Cloudflare Worker ([src/index.js](src/index.js)) serving a JSON API,
with the static UI in [public/](public/) via the assets binding and a D1
(SQLite) database. No framework, no build step. Trend math lives in
[public/trend.js](public/trend.js), shared by the browser and the Worker
(CSV export).

Auth: PBKDF2-SHA256 (100k iterations, per-user salt), session tokens stored
hashed, HttpOnly/Secure/SameSite=Lax cookie, Origin check on mutating
requests.

## Develop / deploy

```bash
npm install
npx wrangler dev        # local, uses a local D1 copy
npx wrangler deploy
```

Schema: [schema.sql](schema.sql) is the full schema for a fresh database.
Changes to the live database go in [migrations/](migrations/) and are
applied once, in order:

```bash
npx wrangler d1 execute weight-log --remote --file migrations/004-rung-flag.sql -y
```
