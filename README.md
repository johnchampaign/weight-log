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
- CSV export (`Date,Weight,Trend`).
- CSV import — accepts both this site's export format and the Hacker's Diet
  Online CSV export (`Date,Weight,Rung,Flag,Comment`). Existing dates are
  overwritten, blank rows skipped. (Comments/flags/rungs are not imported.)

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

Schema changes: edit [schema.sql](schema.sql) (idempotent) and run

```bash
npx wrangler d1 execute weight-log --remote --file schema.sql -y
```
