import {
  buildTrendSeries, fitSlope, parseDate, toISO,
  KCAL_PER_UNIT, planWeightOn, planEndDate, analyseTrend, intervalStart,
} from "./trend.js?v=3";

const state = {
  email: null,
  unit: "lb",
  entries: [],        // [{date, weight, comment}] ascending
  view: null,         // {year, month} month is 0-based
  plan: null,         // {startDate, startWeight, goalWeight, calorieBalance, show}
  customRange: null,  // {from, to} for the Trend tab
};

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- api

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------- boot

async function boot() {
  const now = new Date();
  state.view = { year: now.getFullYear(), month: now.getMonth() };
  try {
    await enterApp();
  } catch {
    showAuth();
  }
}

function showAuth() {
  $("#auth-view").hidden = false;
  $("#log-view").hidden = true;
  $("#user-nav").hidden = true;
  $("#auth-email").focus();
}

async function enterApp() {
  const [me, { weights }] = await Promise.all([api("/api/me"), api("/api/weights")]);
  state.email = me.email;
  state.unit = me.unit;
  state.plan = me.plan;
  state.entries = weights;
  state.customRange = null;
  $("#range-from").value = "";
  $("#range-to").value = "";
  $("#auth-view").hidden = true;
  $("#log-view").hidden = false;
  $("#user-nav").hidden = false;
  $("#nav-email").textContent = me.email;
  renderUnitToggle();
  showTab();
  fillPlanForm();
  render();
}

// ---------------------------------------------------------------- auth ui

let authMode = "login";

function setAuthMode(mode) {
  authMode = mode;
  $("#tab-login").classList.toggle("active", mode === "login");
  $("#tab-register").classList.toggle("active", mode === "register");
  $("#unit-row").hidden = mode !== "register";
  $("#auth-submit").textContent = mode === "login" ? "Sign in" : "Create account";
  $("#auth-password").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("#auth-error").hidden = true;
}

$("#tab-login").addEventListener("click", () => setAuthMode("login"));
$("#tab-register").addEventListener("click", () => setAuthMode("register"));

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#auth-submit");
  btn.disabled = true;
  $("#auth-error").hidden = true;
  try {
    await api(`/api/${authMode === "login" ? "login" : "register"}`, {
      method: "POST",
      body: JSON.stringify({
        email: $("#auth-email").value,
        password: $("#auth-password").value,
        unit: $("#auth-unit").value,
      }),
    });
    $("#auth-password").value = "";
    await enterApp();
  } catch (err) {
    const el = $("#auth-error");
    el.textContent = err.message;
    el.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

$("#logout-btn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  state.email = null;
  state.entries = [];
  state.plan = null;
  showAuth();
});

// ---------------------------------------------------------------- import

$("#import-btn").addEventListener("click", () => $("#import-file").click());

$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const btn = $("#import-btn");
  btn.disabled = true;
  btn.textContent = "Importing…";
  try {
    const csv = await file.text();
    const result = await api("/api/import", { method: "POST", body: JSON.stringify({ csv }) });
    await enterApp();
    alert(
      `Imported ${result.imported} entries` +
      (result.skipped ? ` (${result.skipped} empty rows skipped)` : "") +
      (result.plan ? ", plus your diet plan (see the Goal tab)" : "") + "."
    );
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Import CSV";
  }
});

// ---------------------------------------------------------------- unit toggle

function renderUnitToggle() {
  for (const btn of document.querySelectorAll("#unit-toggle button")) {
    btn.classList.toggle("active", btn.dataset.unit === state.unit);
  }
  for (const el of document.querySelectorAll(".unit-label")) el.textContent = state.unit;
  $("#trend-unit-w").textContent = state.unit;
}

// ---------------------------------------------------------------- tabs

const TABS = ["log", "trend", "goal"];

function showTab() {
  const name = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "log";
  for (const t of TABS) {
    $(`#tab-${t}`).hidden = t !== name;
    const link = document.querySelector(`.tabs a[data-tab="${t}"]`);
    link.classList.toggle("active", t === name);
    link.setAttribute("aria-selected", String(t === name));
  }
  if (name === "goal") updatePlanSummary();
}

window.addEventListener("hashchange", showTab);

$("#unit-toggle").addEventListener("click", async (e) => {
  const unit = e.target.dataset?.unit;
  if (!unit || unit === state.unit) return;
  state.unit = unit;
  renderUnitToggle();
  render();
  await api("/api/settings", { method: "POST", body: JSON.stringify({ unit }) }).catch(() => {});
});

// ---------------------------------------------------------------- month nav

function shiftMonth(delta) {
  const d = new Date(state.view.year, state.view.month + delta, 1);
  state.view = { year: d.getFullYear(), month: d.getMonth() };
  render();
}

$("#prev-month").addEventListener("click", () => shiftMonth(-1));
$("#next-month").addEventListener("click", () => shiftMonth(1));
$("#today-btn").addEventListener("click", () => {
  const now = new Date();
  state.view = { year: now.getFullYear(), month: now.getMonth() };
  render();
});

// ---------------------------------------------------------------- rendering

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function monthDates(year, month) {
  const n = new Date(year, month + 1, 0).getDate();
  const dates = [];
  for (let d = 1; d <= n; d++) {
    dates.push(`${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  return dates;
}

function render() {
  const { year, month } = state.view;
  $("#month-title").textContent = `${MONTHS[month]} ${year}`;

  const dates = monthDates(year, month);
  const trend = buildTrendSeries(state.entries, dates[dates.length - 1]);
  const weightsByDate = new Map(
    state.entries.filter((e) => e.weight != null).map((e) => [e.date, e.weight])
  );
  const commentsByDate = new Map(
    state.entries.filter((e) => e.comment).map((e) => [e.date, e.comment])
  );
  const today = todayISO();

  renderTable(dates, weightsByDate, commentsByDate, trend, today);
  renderChart(dates, weightsByDate, commentsByDate, trend, today);
  renderStats(dates, weightsByDate, trend, today);
  renderTrendTab();
}

function renderTable(dates, weightsByDate, commentsByDate, trend, today) {
  const tbody = $("#log-table tbody");
  tbody.textContent = "";
  for (const date of dates) {
    const d = parseDate(date);
    const dow = d.getUTCDay();
    const isFuture = date > today;
    const weight = weightsByDate.get(date);
    const t = trend.get(date);

    const tr = document.createElement("tr");
    tr.className = [
      dow === 0 || dow === 6 ? "weekend" : "",
      date === today ? "today" : "",
      isFuture ? "future" : "",
    ].join(" ").trim();

    const dayNum = document.createElement("td");
    dayNum.className = "daynum";
    dayNum.textContent = String(d.getUTCDate());

    const dayName = document.createElement("td");
    dayName.className = "dayname";
    dayName.textContent = DAYS[dow];

    const weightTd = document.createElement("td");
    weightTd.className = "num";
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.autocomplete = "off";
    input.dataset.date = date;
    input.dataset.kind = "w";
    input.value = weight !== undefined ? String(weight) : "";
    input.placeholder = isFuture ? "" : "—";
    input.disabled = isFuture;
    input.setAttribute("aria-label", `Weight for ${date}`);
    input.addEventListener("change", onDayChange);
    input.addEventListener("keydown", onWeightKeydown);
    weightTd.appendChild(input);

    const trendTd = document.createElement("td");
    trendTd.className = "num";
    trendTd.textContent = !isFuture && t !== undefined ? t.toFixed(1) : "";

    const varTd = document.createElement("td");
    varTd.className = "num var";
    if (weight !== undefined && t !== undefined) {
      const v = weight - t;
      varTd.textContent = (v >= 0 ? "+" : "") + v.toFixed(1);
      varTd.classList.add(v > 0 ? "bad" : "good");
    }

    const commentTd = document.createElement("td");
    commentTd.className = "comment";
    const cInput = document.createElement("input");
    cInput.type = "text";
    cInput.autocomplete = "off";
    cInput.maxLength = 4096;
    cInput.dataset.date = date;
    cInput.dataset.kind = "c";
    cInput.value = commentsByDate.get(date) || "";
    cInput.disabled = isFuture;
    cInput.setAttribute("aria-label", `Comment for ${date}`);
    cInput.addEventListener("change", onDayChange);
    commentTd.appendChild(cInput);

    tr.append(dayNum, dayName, weightTd, trendTd, varTd, commentTd);
    tbody.appendChild(tr);
  }
}

function onWeightKeydown(e) {
  // Enter / arrows move between day fields, like a spreadsheet.
  if (e.key !== "Enter" && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const inputs = [...document.querySelectorAll('#log-table input[data-kind="w"]:not(:disabled)')];
  const i = inputs.indexOf(e.target);
  const next = e.key === "ArrowUp" ? inputs[i - 1] : inputs[i + 1];
  if (e.key === "Enter" || e.key === "ArrowDown") e.target.dispatchEvent(new Event("change"));
  next?.focus();
  next?.select();
}

async function onDayChange(e) {
  const input = e.target;
  const date = input.dataset.date;
  const wInput = document.querySelector(`#log-table input[data-date="${date}"][data-kind="w"]`);
  const cInput = document.querySelector(`#log-table input[data-date="${date}"][data-kind="c"]`);
  const raw = wInput.value.trim().replace(",", ".");

  let weight = null;
  if (raw !== "") {
    weight = Number(raw);
    if (!isFinite(weight) || weight <= 0 || weight > 1500) {
      wInput.classList.add("save-error");
      return;
    }
    weight = Math.round(weight * 10) / 10;
  }
  const comment = cInput.value.trim().slice(0, 4096) || null;

  input.classList.remove("save-error");
  input.classList.add("saving");
  try {
    await api("/api/weight", { method: "PUT", body: JSON.stringify({ date, weight, comment }) });
    const i = state.entries.findIndex((en) => en.date === date);
    if (weight === null && comment === null) {
      if (i >= 0) state.entries.splice(i, 1);
    } else if (i >= 0) {
      Object.assign(state.entries[i], { weight, comment });
    } else {
      state.entries.push({ date, weight, comment });
      state.entries.sort((a, b) => a.date.localeCompare(b.date));
    }
    const active = document.activeElement;
    render();
    if (active?.dataset?.date) {
      document.querySelector(
        `#log-table input[data-date="${active.dataset.date}"][data-kind="${active.dataset.kind}"]`
      )?.focus();
    }
  } catch (err) {
    input.classList.add("save-error");
    if (err.status === 401) showAuth();
  } finally {
    input.classList.remove("saving");
  }
}

// ---------------------------------------------------------------- chart

function renderChart(dates, weightsByDate, commentsByDate, trend, today) {
  const wrap = $("#chart-wrap");
  const plotDates = dates.filter((d) => d <= today && trend.has(d));
  const logged = dates.filter((d) => weightsByDate.has(d));

  if (logged.length === 0 && plotDates.length === 0) {
    wrap.innerHTML = `<p class="chart-empty">No entries yet — type a weight into a day below and the trend chart appears here.</p>`;
    return;
  }

  const W = 840, H = 300, L = 46, R = 14, T = 14, B = 26;
  const n = dates.length;

  const planPoints = [];
  if (state.plan?.show) {
    for (const d of dates) {
      const pw = planWeightOn(state.plan, d, state.unit);
      if (pw !== null) planPoints.push([d, pw]);
    }
  }

  const values = [];
  for (const d of plotDates) values.push(trend.get(d));
  for (const d of logged) values.push(weightsByDate.get(d));
  for (const [, pw] of planPoints) values.push(pw);
  let lo = Math.min(...values), hi = Math.max(...values);
  const pad = Math.max((hi - lo) * 0.15, 1);
  lo -= pad; hi += pad;

  const x = (date) => L + ((parseDate(date).getUTCDate() - 0.5) / n) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

  // y gridlines: pick a step giving ~5 lines
  const span = hi - lo;
  const step = [0.5, 1, 2, 5, 10, 20, 50].find((s) => span / s <= 7) || 100;
  let grid = "";
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    grid += `<line x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/>` +
            `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${roundLabel(v)}</text>`;
  }

  // x labels: every ~5 days
  let xlabels = "";
  for (let d = 1; d <= n; d += n > 20 ? 5 : 2) {
    const date = dates[d - 1];
    xlabels += `<text x="${x(date)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${d}</text>`;
  }

  // floats & sinkers: white diamond at each weight, tied to the trend line
  let marks = "";
  for (const date of logged) {
    const wx = x(date), wy = y(weightsByDate.get(date)), ty = y(trend.get(date));
    marks += `<line x1="${wx}" y1="${wy}" x2="${wx}" y2="${ty}" stroke="var(--good)" stroke-width="1.4"/>`;
  }
  for (const date of logged) {
    const wx = x(date), wy = y(weightsByDate.get(date));
    const comment = commentsByDate.get(date);
    const tip = `${date}: ${weightsByDate.get(date)} ${state.unit}` + (comment ? ` — ${comment}` : "");
    marks += `<path d="M ${wx} ${wy - 4.6} L ${wx + 4.6} ${wy} L ${wx} ${wy + 4.6} L ${wx - 4.6} ${wy} Z"
              fill="${comment ? "#f6d55c" : "#fff"}" stroke="#4a4437" stroke-width="1.3"><title>${escapeXML(tip)}</title></path>`;
  }

  const trendPath = plotDates.map((d, i) => `${i === 0 ? "M" : "L"} ${x(d).toFixed(1)} ${y(trend.get(d)).toFixed(1)}`).join(" ");

  let planLine = "";
  if (planPoints.length > 0) {
    const pts = planPoints.length === 1 ? [planPoints[0], planPoints[0]] : planPoints;
    const d = pts.map(([date, pw], i) => `${i === 0 ? "M" : "L"} ${x(date).toFixed(1)} ${y(pw).toFixed(1)}`).join(" ");
    const [lastDate, lastPw] = planPoints[planPoints.length - 1];
    planLine = `<path d="${d}" fill="none" stroke="var(--plan)" stroke-width="2" stroke-dasharray="7 5">
                  <title>Diet plan: ${lastPw.toFixed(1)} ${state.unit} on ${lastDate}</title></path>`;
  }

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight and trend chart">
      ${grid}${xlabels}
      ${planLine}
      <path d="${trendPath}" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linejoin="round"/>
      ${marks}
    </svg>`;
}

function escapeXML(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function roundLabel(v) {
  return Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(1);
}

// ---------------------------------------------------------------- stats

function renderStats(dates, weightsByDate, trend, today) {
  const el = $("#stats");
  const lastLogged = [...dates].reverse().find((d) => weightsByDate.has(d));

  if (!lastLogged) {
    el.innerHTML = "";
    return;
  }

  // slope: least-squares fit over daily trend values through the last logged day,
  // exactly as Hacker's Diet Online does.
  const fitValues = dates.filter((d) => d <= lastLogged && trend.has(d)).map((d) => trend.get(d));
  const slope = fitSlope(fitValues);
  const unit = state.unit;

  const entriesCount = dates.filter((d) => weightsByDate.has(d)).length;
  const endTrend = trend.get(lastLogged);

  let cells = statCell("Trend now", `${endTrend.toFixed(1)} ${unit}`);
  cells += statCell("Entries this month", String(entriesCount));

  if (slope !== null) {
    const weekly = slope * 7;
    const sign = weekly > 0 ? "+" : "";
    cells += statCell("Rate", `${sign}${weekly.toFixed(2)} ${unit}/week`, weekly);
    const kcal = slope * KCAL_PER_UNIT[unit];
    cells += statCell(
      kcal <= 0 ? "Calorie deficit" : "Calorie excess",
      `${Math.abs(Math.round(kcal))} kcal/day`,
      kcal
    );
  }
  el.innerHTML = cells;
}

function statCell(label, value, signedForColor = 0) {
  const cls = signedForColor < -1e-9 ? "good" : signedForColor > 1e-9 ? "bad" : "";
  return `<div class="stat"><div class="label">${label}</div><div class="value ${cls}">${value}</div></div>`;
}

// ---------------------------------------------------------------- trend tab

// HDO's standard periods: positive = days back, negative = calendar months back.
const PERIODS = [[7, "Week"], [14, "Fortnight"], [-1, "Month"], [-3, "Quarter"], [-6, "Six months"], [-12, "Year"]];

function weighedEntries() {
  return state.entries.filter((e) => typeof e.weight === "number" && e.weight > 0);
}

function renderTrendTab() {
  const weighed = weighedEntries();
  const tbody = $("#trend-table tbody");
  tbody.textContent = "";

  const first = weighed[0]?.date;
  const last = weighed[weighed.length - 1]?.date;

  const rangeFrom = $("#range-from"), rangeTo = $("#range-to");
  if (first) {
    rangeFrom.min = rangeTo.min = first;
    rangeFrom.max = rangeTo.max = last;
    if (!rangeFrom.value) rangeFrom.value = first;
    if (!rangeTo.value) rangeTo.value = last;
  }

  const rows = [];
  if (first) {
    for (const [n, name] of PERIODS) {
      const start = intervalStart(last, n);
      if (start < first) break;
      rows.push({ name, from: start, to: last });
    }
  }

  let custom = null;
  if (first && state.customRange) {
    let { from, to } = state.customRange;
    if (from < first || from > last) from = first;
    if (to < first || to > last) to = last;
    if (to < from) [from, to] = [to, from];
    if (from !== to) custom = { name: durationLabel(from, to), from, to, custom: true };
  }

  const all = custom ? [...rows, custom] : rows;
  $("#trend-empty").hidden = all.length > 0;
  $("#trend-table").hidden = all.length === 0;
  $("#range-clear").hidden = !state.customRange;
  if (all.length === 0) return;

  $("#trend-ending").textContent = rows.length
    ? `Periods ending ${formatDate(last)} (your most recent weigh-in)`
    : "Custom period";

  const trend = buildTrendSeries(weighed, last);
  const results = analyseTrend(trend, all.map((r) => [r.from, r.to]));

  all.forEach((row, i) => {
    const r = results[i];
    if (row.custom && rows.length) {
      const cap = document.createElement("tr");
      cap.innerHTML = `<th colspan="6" class="caption-row">${formatDate(row.from)} – ${formatDate(row.to)}</th>`;
      tbody.appendChild(cap);
    }
    const tr = document.createElement("tr");
    if (!r || r.slope === null) {
      tr.innerHTML = `<td>${row.name}</td><td class="num" colspan="5">Not enough data</td>`;
    } else {
      const weekly = r.slope * 7;
      const kcal = r.slope * KCAL_PER_UNIT[state.unit];
      tr.innerHTML =
        `<td>${row.name}</td>` +
        `<td class="num ${signClass(weekly, 2)}">${signed(weekly, 2)}</td>` +
        `<td class="num ${signClass(kcal, 0)}">${signed(kcal, 0)}</td>` +
        `<td class="num">${r.min.toFixed(1)}</td>` +
        `<td class="num">${r.mean.toFixed(1)}</td>` +
        `<td class="num">${r.max.toFixed(1)}</td>`;
    }
    tbody.appendChild(tr);
  });
}

// Signed figure as HDO prints it: "+0.49", "−0.49", and "0.00" with no sign
// or colour when it rounds to zero.
function signed(v, digits) {
  const s = Math.abs(v).toFixed(digits);
  if (Number(s) === 0) return s;
  return (v > 0 ? "+" : "−") + s;
}

function signClass(v, digits) {
  if (Number(Math.abs(v).toFixed(digits)) === 0) return "";
  return v > 0 ? "bad" : "good";
}

// "1 y 2 m 5 d", counting whole calendar months back from `to`, like HDO.
function durationLabel(from, to) {
  let months = 0;
  while (intervalStart(to, -(months + 1)) >= from) months++;
  const monthStart = months ? intervalStart(to, -months) : to;
  const days = Math.round((parseDate(monthStart) - parseDate(from)) / 86400000);
  const y = Math.floor(months / 12), m = months % 12;
  return [y && `${y} y`, m && `${m} m`, days && `${days} d`].filter(Boolean).join(" ");
}

function formatDate(iso) {
  const d = parseDate(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}`;
}

$("#custom-range").addEventListener("submit", (e) => {
  e.preventDefault();
  state.customRange = { from: $("#range-from").value, to: $("#range-to").value };
  renderTrendTab();
});

$("#range-clear").addEventListener("click", () => {
  state.customRange = null;
  $("#range-from").value = "";
  $("#range-to").value = "";
  renderTrendTab();
});

// ---------------------------------------------------------------- goal tab

function latestTrend() {
  const weighed = weighedEntries();
  if (weighed.length === 0) return null;
  const last = weighed[weighed.length - 1].date;
  return { date: last, value: buildTrendSeries(weighed, last).get(last) };
}

function fillPlanForm() {
  const p = state.plan;
  const lt = latestTrend();
  $("#plan-start-date").value = p ? p.startDate : todayISO();
  $("#plan-start-weight").value = p ? String(p.startWeight) : lt ? lt.value.toFixed(1) : "";
  $("#plan-goal-weight").value = p ? String(p.goalWeight) : "";
  $("#plan-balance").value = p ? String(Math.abs(p.calorieBalance)) : "500";
  $("#plan-show").checked = p ? p.show : true;
  $("#plan-remove").hidden = !p;
  $("#plan-status").textContent = "";
  updatePlanSummary();
}

function readPlanForm() {
  const plan = {
    startDate: $("#plan-start-date").value,
    startWeight: Number($("#plan-start-weight").value.trim().replace(",", ".")),
    goalWeight: Number($("#plan-goal-weight").value.trim().replace(",", ".")),
    calorieBalance: Number($("#plan-balance").value),
    show: $("#plan-show").checked,
  };
  const ok = plan.startDate && plan.startWeight > 0 && plan.goalWeight > 0 && plan.calorieBalance > 0;
  if (ok && plan.goalWeight < plan.startWeight) plan.calorieBalance = -plan.calorieBalance;
  return ok ? plan : null;
}

function updatePlanSummary() {
  const el = $("#plan-summary");
  const plan = readPlanForm();
  if (!plan) {
    el.textContent = "Enter a start weight, goal weight and daily calorie figure to see your projection.";
    return;
  }
  const unit = state.unit;
  const weekly = (Math.abs(plan.calorieBalance) * 7) / KCAL_PER_UNIT[unit];
  const losing = plan.goalWeight < plan.startWeight;
  const end = planEndDate(plan, unit);
  const weeks = Math.round((parseDate(end) - parseDate(plan.startDate)) / (7 * 86400000));

  let html = plan.goalWeight === plan.startWeight
    ? `Your goal equals your start weight: the plan is a flat line at ${plan.goalWeight.toFixed(1)} ${unit}.`
    : `A ${Math.abs(plan.calorieBalance)} kcal/day ${losing ? "deficit" : "excess"} means
       ${losing ? "losing" : "gaining"} <strong>${weekly.toFixed(2)} ${unit}/week</strong>, reaching
       ${plan.goalWeight.toFixed(1)} ${unit} around <strong>${formatDate(end)}</strong>
       (about ${weeks} week${weeks === 1 ? "" : "s"}).`;

  const lt = latestTrend();
  if (lt && lt.date >= plan.startDate) {
    const target = planWeightOn(plan, lt.date, unit);
    const diff = lt.value - target;
    const ahead = losing ? diff <= 0 : diff >= 0;
    html += `<br>On ${formatDate(lt.date)} the plan called for ${target.toFixed(1)} ${unit}; your trend was
      ${lt.value.toFixed(1)} ${unit}, <span class="${ahead ? "good" : "bad"}">${Math.abs(diff).toFixed(1)} ${unit}
      ${diff > 0 ? "above" : "below"} plan</span>.`;
  }
  el.innerHTML = html;
}

$("#plan-form").addEventListener("input", updatePlanSummary);

$("#plan-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const plan = readPlanForm();
  const status = $("#plan-status");
  if (!plan) {
    status.textContent = "Please fill in every field with a positive number.";
    return;
  }
  try {
    const res = await api("/api/plan", { method: "PUT", body: JSON.stringify({ plan }) });
    state.plan = res.plan;
    fillPlanForm();
    render();
    status.textContent = "Saved.";
  } catch (err) {
    status.textContent = err.message;
    if (err.status === 401) showAuth();
  }
});

$("#plan-remove").addEventListener("click", async () => {
  if (!confirm("Remove your diet plan? Your weight log is not affected.")) return;
  try {
    await api("/api/plan", { method: "PUT", body: JSON.stringify({ plan: null }) });
    state.plan = null;
    fillPlanForm();
    render();
    $("#plan-status").textContent = "Plan removed.";
  } catch (err) {
    $("#plan-status").textContent = err.message;
  }
});

boot();
