import { buildTrendSeries, fitSlope, parseDate, toISO } from "./trend.js?v=2";

const KCAL_PER_UNIT = { lb: 3500, kg: 7700 }; // energy per unit of body weight

const state = {
  email: null,
  unit: "lb",
  entries: [],        // [{date, weight}] ascending
  view: null,         // {year, month} month is 0-based
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
    const me = await api("/api/me");
    await enterApp(me);
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

async function enterApp(me) {
  state.email = me.email;
  state.unit = me.unit;
  const { weights } = await api("/api/weights");
  state.entries = weights;
  $("#auth-view").hidden = true;
  $("#log-view").hidden = false;
  $("#user-nav").hidden = false;
  $("#nav-email").textContent = me.email;
  renderUnitToggle();
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
    const me = await api(`/api/${authMode === "login" ? "login" : "register"}`, {
      method: "POST",
      body: JSON.stringify({
        email: $("#auth-email").value,
        password: $("#auth-password").value,
        unit: $("#auth-unit").value,
      }),
    });
    $("#auth-password").value = "";
    await enterApp(me);
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
    const { weights } = await api("/api/weights");
    state.entries = weights;
    render();
    alert(`Imported ${result.imported} entries` + (result.skipped ? ` (${result.skipped} rows without a weight skipped)` : "") + ".");
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
}

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

  const values = [];
  for (const d of plotDates) values.push(trend.get(d));
  for (const d of logged) values.push(weightsByDate.get(d));
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

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight and trend chart">
      ${grid}${xlabels}
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

boot();
