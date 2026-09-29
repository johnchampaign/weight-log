import {
  buildTrendSeries, fitSlope, parseDate, toISO,
  KCAL_PER_UNIT, planWeightOn, planEndDate, analyseTrend, intervalStart, bodyMassIndex,
} from "./trend.js?v=4";

const state = {
  email: null,
  profile: null,      // /api/me: names, units, height, plan
  units: { store: "lb", log: "lb", display: "lb", energy: "kcal", dec: "." },
  entries: [],        // [{date, weight, comment, rung, flag}] ascending; weights in units.store
  view: null,         // {year, month} month is 0-based
  plan: null,         // {startDate, startWeight, goalWeight, calorieBalance, show}
  customRange: null,  // {from, to} for the Trend tab
  heightCm: null,     // for BMI; null = not set
  chartPeriod: { period: "q" },  // Chart tab: m/q/h/y, or {period: "c", from, to}
};

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- units

// As in HDO: weights are stored in the log unit (kg, or lb for pound and
// stone logs) and shown and typed in the display unit; stone displays as
// "14 4.2" (stones, pounds) and rates of change are in pounds. Energy is
// worked out in kcal and shown in kcal or kJ. Every number shown uses the
// chosen decimal character.
const LB_PER_KG = 2.2046226218;
const KJ_PER_KCAL = 4.18331; // HDiet::monthlog ENERGY_CONVERSION

const dispBase = () => (state.units.display === "kg" ? "kg" : "lb");

function toDisp(w) {
  const s = state.units.store, d = dispBase();
  return s === d ? w : s === "kg" ? w * LB_PER_KG : w / LB_PER_KG;
}

function fromDisp(v) {
  const s = state.units.store, d = dispBase();
  return s === d ? v : s === "kg" ? v / LB_PER_KG : v * LB_PER_KG;
}

function num(v, digits) {
  const s = v.toFixed(digits);
  return state.units.dec === "," ? s.replace(".", ",") : s;
}

// Weight (stored value) as text in the display unit. `unit` appends the
// unit: "14 st 4.2 lb" for stone, "200.2 lb", "90.8 kg".
function fmtW(w, { unit = false } = {}) {
  const v = toDisp(w);
  if (state.units.display === "st") {
    const lb = Math.round(v * 10) / 10;
    const st = Math.floor(lb / 14);
    const rest = num(lb - st * 14, 1);
    return unit ? `${st} st ${rest} lb` : `${st} ${rest}`;
  }
  return num(v, 1) + (unit ? ` ${state.units.display}` : "");
}

// A change in weight (stored units) in the display's base unit.
const fmtDelta = (d, digits) => num(toDisp(d), digits);

const eUnit = () => state.units.energy;
const toEnergy = (kcal) => (state.units.energy === "kJ" ? kcal * KJ_PER_KCAL : kcal);
const fromEnergy = (v) => (state.units.energy === "kJ" ? v / KJ_PER_KCAL : v);
const energyWord = () => (state.units.energy === "kJ" ? "Energy" : "Calorie");

// Typed weight in the display unit -> stored value; null if blank, NaN if
// unreadable. Stone accepts "14 4.2" (st lb) or a plain number of stones.
function parseW(text) {
  const t = text.trim().replace(/,/g, ".");
  if (t === "") return null;
  let v;
  if (state.units.display === "st") {
    const m = t.match(/^(\d+)\s*(?:st)?\s+(\d+(?:\.\d*)?)\s*(?:lb)?$/i);
    if (m) v = Number(m[1]) * 14 + Number(m[2]);
    else if (/^\d+(\.\d*)?\s*(?:st)?$/i.test(t)) v = parseFloat(t) * 14;
    else return NaN;
  } else {
    if (!/^\d+(\.\d*)?$/.test(t) && !/^\.\d+$/.test(t)) return NaN;
    v = Number(t);
  }
  const w = fromDisp(v);
  // Same unit as storage: keep HDO's one decimal. Converted: full precision.
  return state.units.store === dispBase() ? Math.round(w * 10) / 10 : w;
}

// Axis label for a value already in display units.
function fmtAxis(v) {
  if (state.units.display === "st") {
    const st = Math.floor(v / 14 + 1e-9);
    const lb = v - st * 14;
    if (Math.abs(lb) < 1e-9) return `${st} st`;
    return `${st} ${Math.abs(lb - Math.round(lb)) < 1e-9 ? Math.round(lb) : num(lb, 1)}`;
  }
  return Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : num(v, 1);
}

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

let resetToken = null;

async function boot() {
  const now = new Date();
  state.view = { year: now.getFullYear(), month: now.getMonth() };
  api("/api/features").then((f) => { $("#forgot-link").hidden = !f.passwordReset; }).catch(() => {});

  // A password reset link: keep the token in memory only, out of the
  // address bar and history.
  const reset = location.hash.match(/^#reset=([0-9a-f]{64})$/);
  if (reset) {
    resetToken = reset[1];
    history.replaceState(null, "", location.pathname);
    showAuth("reset");
    return;
  }
  try {
    await enterApp();
  } catch {
    showAuth();
  }
}

// panel: "signin" (sign in / create account), "forgot" or "reset".
function showAuth(panel = "signin") {
  $("#auth-view").hidden = false;
  $("#log-view").hidden = true;
  $("#user-nav").hidden = true;
  $(".auth-tabs").hidden = panel !== "signin";
  $("#auth-form").hidden = panel !== "signin";
  $("#forgot-form").hidden = panel !== "forgot";
  $("#reset-form").hidden = panel !== "reset";
  const focus = { signin: "#auth-email", forgot: "#forgot-email", reset: "#reset-password" }[panel];
  $(focus).focus();
}

async function enterApp() {
  const [me, { weights }] = await Promise.all([api("/api/me"), api("/api/weights")]);
  applyProfile(me);
  state.entries = weights;
  state.customRange = null;
  $("#range-from").value = "";
  $("#range-to").value = "";
  state.chartPeriod = { period: "q" };
  document.querySelector('input[name="chart-period"][value="q"]').checked = true;
  $("#auth-view").hidden = true;
  $("#log-view").hidden = false;
  $("#user-nav").hidden = false;
  showTab();
  fillSettingsForms();
  fillPlanForm();
  render();
}

function applyProfile(me) {
  state.profile = me;
  state.email = me.email;
  state.plan = me.plan;
  state.heightCm = me.heightCm ?? null;
  state.units = {
    store: me.unit,
    log: me.logUnit,
    display: me.displayUnit,
    energy: me.energyUnit,
    dec: me.decimalChar,
  };
  const name = [me.firstName, me.lastName].filter(Boolean).join(" ");
  $("#nav-email").textContent = name || me.email;
  $("#nav-email").title = me.email;
  renderUnitLabels();
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

// ---------------------------------------------------------------- password reset

$("#forgot-link").addEventListener("click", (e) => {
  e.preventDefault();
  $("#forgot-email").value = $("#auth-email").value;
  $("#forgot-message").hidden = true;
  showAuth("forgot");
});

for (const link of document.querySelectorAll(".back-to-signin")) {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    showAuth("signin");
  });
}

$("#forgot-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#forgot-submit"), msg = $("#forgot-message");
  btn.disabled = true;
  try {
    await api("/api/password-reset", { method: "POST", body: JSON.stringify({ email: $("#forgot-email").value }) });
    msg.textContent = "If an account uses that address, a reset link is on its way. It works for one hour; " +
      "check your spam folder if it doesn't arrive in a few minutes.";
    msg.className = "small";
  } catch (err) {
    msg.textContent = err.message;
    msg.className = "small error";
  } finally {
    msg.hidden = false;
    btn.disabled = false;
  }
});

$("#reset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#reset-error"), btn = $("#reset-submit");
  err.hidden = true;
  if ($("#reset-password").value !== $("#reset-retype").value) {
    err.textContent = "The two passwords don't match.";
    err.hidden = false;
    return;
  }
  btn.disabled = true;
  try {
    await api("/api/password-reset/confirm", {
      method: "POST",
      body: JSON.stringify({ token: resetToken, newPassword: $("#reset-password").value }),
    });
    resetToken = null;
    $("#reset-password").value = $("#reset-retype").value = "";
    await enterApp();
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

$("#logout-btn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  state.email = null;
  state.entries = [];
  state.plan = null;
  state.heightCm = null;
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

// ---------------------------------------------------------------- unit labels

function renderUnitLabels() {
  const d = state.units.display;
  for (const el of document.querySelectorAll(".unit-label")) {
    el.textContent = d === "st" ? `st lb, e.g. 14 ${num(4.2, 1)}` : d;
  }
  $("#trend-unit-w").textContent = dispBase();
  $("#trend-unit-e").textContent = eUnit();
  $("#plan-balance-unit").textContent = eUnit();
  $("#plan-balance").max = state.units.energy === "kJ" ? "20900" : "5000";
}

// ---------------------------------------------------------------- tabs

const TABS = ["log", "history", "chart", "trend", "goal", "settings"];

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
  const m = {
    dates,
    today: todayISO(),
    trend: buildTrendSeries(state.entries, dates[dates.length - 1]),
    byDate: new Map(state.entries.map((e) => [e.date, e])),
    weightsByDate: new Map(state.entries.filter((e) => e.weight != null).map((e) => [e.date, e.weight])),
  };

  renderTable(m);
  renderChart(m);
  renderStats(m);
  renderHistoryTab();
  renderHistoryChart();
  renderTrendTab();
}

function makeInput(date, kind, value, label, disabled) {
  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.dataset.date = date;
  input.dataset.kind = kind;
  input.value = value;
  input.disabled = disabled;
  input.setAttribute("aria-label", `${label} for ${date}`);
  input.addEventListener("change", onDayChange);
  input.addEventListener("keydown", onFieldKeydown);
  input.addEventListener("input", () => input.setCustomValidity(""));
  return input;
}

function renderTable({ dates, today, trend, byDate, weightsByDate }) {
  const tbody = $("#log-table tbody");
  tbody.textContent = "";
  for (const date of dates) {
    const d = parseDate(date);
    const dow = d.getUTCDay();
    const isFuture = date > today;
    const entry = byDate.get(date);
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
    const shown = weight !== undefined ? fmtW(weight) : "";
    const wInput = makeInput(date, "w", shown, "Weight", isFuture);
    wInput.dataset.orig = shown;
    wInput.inputMode = state.units.display === "st" ? "text" : "decimal";
    wInput.placeholder = isFuture ? "" : "—";
    weightTd.appendChild(wInput);

    const trendTd = document.createElement("td");
    trendTd.className = "num";
    trendTd.textContent = !isFuture && t !== undefined ? fmtW(t) : "";

    const varTd = document.createElement("td");
    varTd.className = "num var";
    if (weight !== undefined && t !== undefined) {
      const v = weight - t;
      varTd.textContent = (v >= 0 ? "+" : "") + fmtDelta(v, 1);
      varTd.classList.add(v > 0 ? "bad" : "good");
    }

    const rungTd = document.createElement("td");
    rungTd.className = "rung";
    const rInput = makeInput(date, "r", entry?.rung ? String(entry.rung) : "", "Exercise rung", isFuture);
    rInput.inputMode = "numeric";
    rInput.title = "Exercise rung 1–48.  Shortcuts: . copies the previous rung, + one higher, − one lower";
    rungTd.appendChild(rInput);

    const flagTd = document.createElement("td");
    flagTd.className = "flag";
    const fInput = document.createElement("input");
    fInput.type = "checkbox";
    fInput.dataset.date = date;
    fInput.dataset.kind = "f";
    fInput.checked = !!entry?.flag;
    fInput.disabled = isFuture;
    fInput.setAttribute("aria-label", `Flag ${date}`);
    fInput.addEventListener("change", onDayChange);
    flagTd.appendChild(fInput);

    const commentTd = document.createElement("td");
    commentTd.className = "comment";
    const cInput = makeInput(date, "c", entry?.comment || "", "Comment", isFuture);
    cInput.maxLength = 4096;
    commentTd.appendChild(cInput);

    tr.append(dayNum, dayName, weightTd, trendTd, varTd, rungTd, flagTd, commentTd);
    tbody.appendChild(tr);
  }
}

function onFieldKeydown(e) {
  // Enter / arrows move down or up the same column, like a spreadsheet.
  if (e.key !== "Enter" && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const kind = e.target.dataset.kind;
  const inputs = [...document.querySelectorAll(`#log-table input[data-kind="${kind}"]:not(:disabled)`)];
  const i = inputs.indexOf(e.target);
  const next = e.key === "ArrowUp" ? inputs[i - 1] : inputs[i + 1];
  if (e.key === "Enter" || e.key === "ArrowDown") e.target.dispatchEvent(new Event("change"));
  next?.focus();
  next?.select();
}

function fieldError(input, message) {
  input.classList.add("save-error");
  input.setCustomValidity(message);
  input.reportValidity();
}

// HDO rung shortcuts: "." or "," copies the latest earlier rung this month,
// "+" / "-" step one rung up or down from it. Returns a number, "" (blank),
// or an error string.
function resolveRung(date, raw) {
  const value = raw.trim();
  if (value === "") return "";
  let r;
  if (/^[.,+\-]$/.test(value)) {
    const earlier = [...document.querySelectorAll('#log-table input[data-kind="r"]')]
      .filter((el) => el.dataset.date < date && /^\d/.test(el.value.trim()))
      .map((el) => Number(el.value));
    if (earlier.length === 0) return "No earlier rung this month to copy.";
    r = earlier[earlier.length - 1] + (value === "+" ? 1 : value === "-" ? -1 : 0);
  } else {
    r = Math.floor(Number(value));
  }
  return isFinite(r) && r >= 1 && r <= 48 ? r : "Rung must be a whole number from 1 to 48.";
}

async function onDayChange(e) {
  const input = e.target;
  const date = input.dataset.date;
  const field = (kind) => document.querySelector(`#log-table input[data-date="${date}"][data-kind="${kind}"]`);
  const wInput = field("w"), rInput = field("r"), fInput = field("f"), cInput = field("c");

  // An untouched weight keeps its stored value exactly; only edits are
  // converted from the display unit.
  const stored = state.entries.find((en) => en.date === date)?.weight ?? null;
  const weight = wInput.value === wInput.dataset.orig ? stored : parseW(wInput.value);
  if (weight !== null && !(Number.isFinite(weight) && weight > 0 && weight <= 1500)) {
    fieldError(wInput, state.units.display === "st"
      ? `Enter stones and pounds (e.g. 14 ${num(4.2, 1)}), or leave it blank.`
      : "Enter a weight, or leave it blank.");
    return;
  }

  const r = resolveRung(date, rInput.value);
  if (typeof r === "string" && r !== "") {
    fieldError(rInput, r);
    return;
  }
  const rung = r === "" ? null : r;
  rInput.value = rung ?? "";

  const flag = fInput.checked;
  const comment = cInput.value.trim().slice(0, 4096) || null;

  for (const el of [wInput, rInput, cInput]) el.classList.remove("save-error");
  input.classList.add("saving");
  try {
    await api("/api/weight", { method: "PUT", body: JSON.stringify({ date, weight, comment, rung, flag }) });
    const i = state.entries.findIndex((en) => en.date === date);
    if (weight === null && comment === null && rung === null && !flag) {
      if (i >= 0) state.entries.splice(i, 1);
    } else if (i >= 0) {
      Object.assign(state.entries[i], { weight, comment, rung, flag });
    } else {
      state.entries.push({ date, weight, comment, rung, flag });
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

const RUNG_MAX = 48;

function renderChart({ dates, today, trend, byDate, weightsByDate }) {
  const wrap = $("#chart-wrap");
  const plotDates = dates.filter((d) => d <= today && trend.has(d));
  const logged = dates.filter((d) => weightsByDate.has(d));
  const rungs = dates.map((d) => byDate.get(d)?.rung || null);
  const hasRungs = rungs.some((r) => r !== null);

  const planPoints = [];
  if (state.plan?.show) {
    for (const d of dates) {
      const pw = planWeightOn(state.plan, d, state.units.store);
      if (pw !== null) planPoints.push([d, pw]);
    }
  }

  if (logged.length === 0 && plotDates.length === 0 && planPoints.length === 0 && !hasRungs) {
    wrap.innerHTML = `<p class="chart-empty">No entries yet — type a weight into a day below and the trend chart appears here.</p>`;
    return;
  }

  const W = 840, H = 300, L = 46, T = 14, B = 26;
  const R = hasRungs ? 40 : 14;
  const n = dates.length;

  const values = [];
  for (const d of plotDates) values.push(toDisp(trend.get(d)));
  for (const d of logged) values.push(toDisp(weightsByDate.get(d)));
  for (const [, pw] of planPoints) values.push(toDisp(pw));
  let lo, hi;
  if (values.length > 0) {
    lo = Math.min(...values);
    hi = Math.max(...values);
    const pad = Math.max((hi - lo) * 0.15, 1);
    lo -= pad; hi += pad;
  } else {
    // Only rungs this month: HDO's default adult range.
    [lo, hi] = dispBase() === "kg" ? [40, 120] : [90, 265];
  }

  const x = (date) => L + ((parseDate(date).getUTCDate() - 0.5) / n) * (W - L - R);
  // y() takes stored weights; the scale itself is in display units.
  const yd = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const y = (w) => yd(toDisp(w));
  const yRung = (r) => (H - B) - ((r - 1) / RUNG_MAX) * (H - T - B);

  // y gridlines: pick a step giving ~5 lines
  const span = hi - lo;
  const steps = state.units.display === "st" ? [1, 2, 7, 14, 28, 70] : [0.5, 1, 2, 5, 10, 20, 50];
  const step = steps.find((s) => span / s <= 7) || 100;
  let grid = "";
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    grid += `<line x1="${L}" y1="${yd(v)}" x2="${W - R}" y2="${yd(v)}" stroke="var(--line)" stroke-width="1"/>` +
            `<text x="${L - 6}" y="${yd(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${fmtAxis(v)}</text>`;
  }

  // x labels: every ~5 days
  let xlabels = "";
  for (let d = 1; d <= n; d += n > 20 ? 5 : 2) {
    const date = dates[d - 1];
    xlabels += `<text x="${x(date)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${d}</text>`;
  }

  let rungLine = "";
  if (hasRungs) {
    rungLine = rungSegmentsSVG(rungs, (i) => x(dates[i]), yRung);
    for (let i = 0; i < n; i++) {
      if (rungs[i] !== null) {
        rungLine += `<circle cx="${x(dates[i]).toFixed(1)}" cy="${yRung(rungs[i]).toFixed(1)}" r="2.2" fill="var(--rung)">` +
          `<title>${dates[i]}: rung ${rungs[i]}</title></circle>`;
      }
    }
    const ax = W - R;
    rungLine += `<line x1="${ax}" y1="${T}" x2="${ax}" y2="${H - B}" stroke="var(--muted)" stroke-width="1"/>` +
      `<text x="${ax + 6}" y="${T - 2}" font-size="10" fill="var(--rung)">Rung</text>`;
    for (let r = 1; r <= RUNG_MAX; r = Math.floor(r / 6) * 6 + 6) {
      rungLine += `<line x1="${ax - 4}" y1="${yRung(r)}" x2="${ax}" y2="${yRung(r)}" stroke="var(--muted)"/>` +
        `<text x="${ax + 6}" y="${yRung(r) + 4}" font-size="11" fill="var(--rung)">${r}</text>`;
    }
  }

  // floats & sinkers: diamond at each weight, tied to the trend line; flagged
  // days are filled yellow (as in HDO), commented days get a dot on the side
  // away from the trend so the float/sinker line doesn't hide it.
  let marks = "";
  for (const date of logged) {
    const wx = x(date), wy = y(weightsByDate.get(date)), ty = y(trend.get(date));
    marks += `<line x1="${wx}" y1="${wy}" x2="${wx}" y2="${ty}" stroke="var(--good)" stroke-width="1.4"/>`;
  }
  for (const date of logged) {
    const e = byDate.get(date);
    const wx = x(date), wy = y(weightsByDate.get(date));
    const dotY = wy > y(trend.get(date)) ? wy + 8.5 : wy - 8.5;
    const tip = `${date}: ${fmtW(weightsByDate.get(date), { unit: true })}` +
      (e.rung ? ` · rung ${e.rung}` : "") + (e.flag ? " · flagged" : "") + (e.comment ? ` — ${e.comment}` : "");
    marks += `<g><title>${escapeXML(tip)}</title>` +
      `<path d="M ${wx} ${wy - 4.6} L ${wx + 4.6} ${wy} L ${wx} ${wy + 4.6} L ${wx - 4.6} ${wy} Z"
              fill="${e.flag ? "var(--flag)" : "#fff"}" stroke="#4a4437" stroke-width="1.3"/>` +
      (e.comment ? `<circle cx="${wx}" cy="${dotY}" r="2.2" fill="var(--ink)"/>` : "") + `</g>`;
  }

  const trendPath = plotDates.map((d, i) => `${i === 0 ? "M" : "L"} ${x(d).toFixed(1)} ${y(trend.get(d)).toFixed(1)}`).join(" ");

  let planLine = "";
  if (planPoints.length > 0) {
    const pts = planPoints.length === 1 ? [planPoints[0], planPoints[0]] : planPoints;
    const d = pts.map(([date, pw], i) => `${i === 0 ? "M" : "L"} ${x(date).toFixed(1)} ${y(pw).toFixed(1)}`).join(" ");
    const [lastDate, lastPw] = planPoints[planPoints.length - 1];
    planLine = `<path d="${d}" fill="none" stroke="var(--plan)" stroke-width="2" stroke-dasharray="7 5">
                  <title>Diet plan: ${fmtW(lastPw, { unit: true })} on ${lastDate}</title></path>`;
  }

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight and trend chart">
      ${grid}${xlabels}
      ${rungLine}
      ${planLine}
      ${trendPath ? `<path d="${trendPath}" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linejoin="round"/>` : ""}
      ${marks}
    </svg>`;
}

// Exercise rung line (HDiet::monthlog::plotChart / history::drawChart):
// consecutive rung days are joined; a run is carried flat one day past its
// last rung; a lone rung on the final day is drawn flat from the day before.
function rungSegmentsSVG(rungs, xAt, yRung) {
  const n = rungs.length;
  const segs = [];
  let last = null;
  for (let i = 0; i < n; i++) {
    const r = rungs[i];
    if (r !== null) {
      const cx = xAt(i), cy = yRung(r);
      if (last) segs.push([last[0], last[1], cx, cy]);
      else if (i === n - 1 && i > 0) segs.push([xAt(i - 1), cy, cx, cy]);
      last = [cx, cy];
    } else if (last) {
      segs.push([last[0], last[1], xAt(i), last[1]]);
      last = null;
    }
  }
  return segs.map(([x1, y1, x2, y2]) =>
    `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--rung)" stroke-width="2"/>`
  ).join("");
}

function escapeXML(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------- stats

function renderStats({ dates, trend, byDate, weightsByDate }) {
  const el = $("#stats");
  const lastLogged = [...dates].reverse().find((d) => weightsByDate.has(d));
  const unit = state.units.store;
  let cells = "";

  if (lastLogged) {
    // slope: least-squares fit over daily trend values through the last logged day,
    // exactly as Hacker's Diet Online does.
    const fitValues = dates.filter((d) => d <= lastLogged && trend.has(d)).map((d) => trend.get(d));
    const slope = fitSlope(fitValues);

    const entriesCount = dates.filter((d) => weightsByDate.has(d)).length;
    const endTrend = trend.get(lastLogged);

    cells += statCell("Trend now", fmtW(endTrend, { unit: true }));
    cells += statCell("Entries this month", String(entriesCount));

    if (slope !== null) {
      const weekly = slope * 7;
      const sign = weekly > 0 ? "+" : "";
      cells += statCell("Rate", `${sign}${fmtDelta(weekly, 2)} ${dispBase()}/week`, weekly);
      const kcal = slope * KCAL_PER_UNIT[unit];
      cells += statCell(
        `${energyWord()} ${kcal <= 0 ? "deficit" : "excess"}`,
        `${Math.abs(Math.round(toEnergy(kcal)))} ${eUnit()}/day`,
        kcal
      );
    }

    // HDiet::monthlog::bodyMassIndex: trend on the month's last weigh-in, and
    // the mean of the trend over the days weighed that month.
    if (state.heightCm) {
      const weighedTrend = dates.filter((d) => weightsByDate.has(d)).map((d) => trend.get(d));
      const meanTrend = weighedTrend.reduce((a, b) => a + b, 0) / weighedTrend.length;
      const recent = bodyMassIndex(endTrend, unit, state.heightCm);
      const mean = bodyMassIndex(meanTrend, unit, state.heightCm);
      cells += statCell("Body mass index", num(recent, 1), 0, `month mean ${num(mean, 1)}`);
    }
  }

  // HDiet::monthlog::fractionFlagged: flagged days over all days in the month.
  const flagged = dates.filter((d) => byDate.get(d)?.flag).length;
  const pct = Math.round((flagged * 100) / dates.length);
  if (pct > 0) {
    cells += statCell("Flagged", `${pct}%`, 0, `${flagged} of ${dates.length} days`);
  }

  el.innerHTML = cells;
}

function statCell(label, value, signedForColor = 0, sub = "") {
  const cls = signedForColor < -1e-9 ? "good" : signedForColor > 1e-9 ? "bad" : "";
  return `<div class="stat"><div class="label">${label}</div><div class="value ${cls}">${value}</div>` +
    (sub ? `<div class="sub">${sub}</div>` : "") + `</div>`;
}

// ---------------------------------------------------------------- settings tab

// HDO's Settings page (HackDiet.pl q=modacct): units, height, name, and
// sign-in details.
function fillSettingsForms() {
  const p = state.profile, u = state.units;
  const pick = (name, value) => {
    const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (el) el.checked = true;
  };
  pick("log-unit", u.log);
  pick("display-unit", u.display);
  pick("energy-unit", u.energy);
  pick("decimal-char", u.dec);
  $("#units-status").textContent = "";
  fillHeightForm();
  $("#name-first").value = p.firstName;
  $("#name-middle").value = p.middleName;
  $("#name-last").value = p.lastName;
  $("#name-status").textContent = "";
  $("#acct-email").value = p.email;
  $("#acct-new-password").value = $("#acct-retype").value = $("#acct-current").value = "";
  $("#acct-match").textContent = "";
  $("#acct-status").textContent = "";
}

async function saveSettings(changes, statusEl, message) {
  try {
    const me = await api("/api/settings", { method: "PUT", body: JSON.stringify(changes) });
    applyProfile(me);
    if ("logUnit" in changes) state.entries = (await api("/api/weights")).weights;
    fillSettingsForms();
    fillPlanForm();
    render();
    statusEl.textContent = message;
  } catch (err) {
    statusEl.textContent = err.message;
    if (err.status === 401) showAuth();
  }
}

$("#units-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const val = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
  const changes = {
    displayUnit: val("display-unit"),
    energyUnit: val("energy-unit"),
    decimalChar: val("decimal-char"),
  };
  const logUnit = val("log-unit");
  if (logUnit !== state.units.log) {
    const converts = (logUnit === "kg") !== (state.units.log === "kg");
    if (converts && !confirm(
      "Changing the log unit converts every weight you've stored to " +
      (logUnit === "kg" ? "kilograms" : "pounds") + ". Your log will look the same in your display unit. Continue?"
    )) return;
    changes.logUnit = logUnit;
  }
  await saveSettings(changes, $("#units-status"), "Saved.");
});

const CM_PER_IN = 2.54;

function fillHeightForm() {
  const cm = state.heightCm;
  $("#height-cm").value = cm ? (Number.isInteger(cm) ? String(cm) : num(cm, 1)) : "";
  syncFeetInches();
  $("#height-status").textContent = cm ? "" : "Not set: BMI is hidden.";
}

function syncFeetInches() {
  const cm = Number($("#height-cm").value.trim().replace(",", "."));
  if (!(cm > 0)) {
    $("#height-ft").value = $("#height-in").value = "";
    return;
  }
  const totalIn = cm / CM_PER_IN;
  let ft = Math.floor(totalIn / 12);
  let inches = Math.round((totalIn - ft * 12) * 10) / 10;
  if (inches >= 12) { ft += 1; inches -= 12; }
  $("#height-ft").value = String(ft);
  $("#height-in").value = Number.isInteger(inches) ? String(inches) : num(inches, 1);
}

function syncCentimetres() {
  const ft = Number($("#height-ft").value.trim() || 0);
  const inches = Number($("#height-in").value.trim().replace(",", ".") || 0);
  const total = ft * 12 + inches;
  const cm = Math.round(total * CM_PER_IN * 10) / 10;
  $("#height-cm").value = total > 0 && isFinite(total) ? (Number.isInteger(cm) ? String(cm) : num(cm, 1)) : "";
}

$("#height-cm").addEventListener("input", syncFeetInches);
$("#height-ft").addEventListener("input", syncCentimetres);
$("#height-in").addEventListener("input", syncCentimetres);

$("#height-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = $("#height-cm").value.trim().replace(",", ".");
  await saveSettings({ heightCm: raw === "" ? null : Number(raw) }, $("#height-status"),
    raw === "" ? "Height cleared: BMI is hidden." : "Saved. BMI shows on the Log and Chart tabs.");
});

$("#name-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await saveSettings({
    firstName: $("#name-first").value,
    middleName: $("#name-middle").value,
    lastName: $("#name-last").value,
  }, $("#name-status"), "Saved.");
});

function updatePasswordMatch() {
  const a = $("#acct-new-password").value, b = $("#acct-retype").value;
  $("#acct-match").textContent = !a && !b ? "" : a === b ? "✓ Passwords match" : "Passwords don't match yet";
  $("#acct-match").className = "small " + (!a && !b ? "" : a === b ? "good" : "bad");
}
$("#acct-new-password").addEventListener("input", updatePasswordMatch);
$("#acct-retype").addEventListener("input", updatePasswordMatch);

$("#account-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("#acct-status");
  const email = $("#acct-email").value.trim();
  const newPassword = $("#acct-new-password").value;
  if (newPassword && newPassword !== $("#acct-retype").value) {
    status.textContent = "The new passwords don't match.";
    return;
  }
  const body = { currentPassword: $("#acct-current").value };
  if (email.toLowerCase() !== state.email) body.email = email;
  if (newPassword) body.newPassword = newPassword;
  if (!body.email && !body.newPassword) {
    status.textContent = "Change your email or enter a new password first.";
    return;
  }
  try {
    const res = await api("/api/account", { method: "PUT", body: JSON.stringify(body) });
    applyProfile(await api("/api/me"));
    fillSettingsForms();
    $("#acct-status").textContent =
      res.changed.includes("password")
        ? "Saved. Your password is changed and any other signed-in devices have been signed out."
        : "Saved.";
  } catch (err) {
    status.textContent = err.message;
    if (err.status === 401) showAuth();
  }
});

// ---------------------------------------------------------------- history tab

// HDO "Choose Monthly Log" (HackDiet.pl q=calendar): a calendar per year that
// has entries, oldest first; months with entries link to that month's log.
function renderHistoryTab() {
  const byMonth = new Map();
  for (const e of state.entries) {
    const ym = e.date.slice(0, 7);
    const c = byMonth.get(ym) || { weighIns: 0, entries: 0 };
    c.entries++;
    if (typeof e.weight === "number" && e.weight > 0) c.weighIns++;
    byMonth.set(ym, c);
  }
  const years = [...new Set([...byMonth.keys()].map((ym) => ym.slice(0, 4)))].sort();
  const viewing = `${state.view.year}-${String(state.view.month + 1).padStart(2, "0")}`;

  $("#history-empty").hidden = years.length > 0;
  $("#year-calendars").innerHTML = years.map((y) => {
    const cells = MONTHS.map((name, i) => {
      const ym = `${y}-${String(i + 1).padStart(2, "0")}`;
      const c = byMonth.get(ym);
      const cls = ym === viewing ? ' class="viewing"' : "";
      if (!c) return `<span${cls}>${name.slice(0, 3)}</span>`;
      const tip = c.weighIns === 1 ? "1 weigh-in" : `${c.weighIns} weigh-ins`;
      return `<a href="#log" data-month="${ym}" title="${name} ${y}: ${tip}"${cls}>${name.slice(0, 3)}</a>`;
    }).join("");
    return `<div class="year-cal"><h3>${y}</h3><div class="months">${cells}</div></div>`;
  }).join("");

  // "Show log for" picker: any month back to 1985 (as HDO) or the first entry.
  const ySel = $("#goto-y"), mSel = $("#goto-m");
  if (mSel.options.length === 0) {
    mSel.innerHTML = MONTHS.map((name, i) => `<option value="${i}">${name}</option>`).join("");
  }
  const thisYear = new Date().getFullYear();
  const oldest = Math.min(1985, years.length ? Number(years[0]) : thisYear);
  if (ySel.options.length !== thisYear - oldest + 1) {
    ySel.innerHTML = Array.from({ length: thisYear - oldest + 1 }, (_, k) => `<option>${thisYear - k}</option>`).join("");
  }
  mSel.value = String(state.view.month);
  ySel.value = String(state.view.year);
}

function openMonth(year, month) {
  state.view = { year, month };
  render();
  location.hash = "#log";
  window.scrollTo(0, 0);
}

$("#year-calendars").addEventListener("click", (e) => {
  const link = e.target.closest("a[data-month]");
  if (!link) return;
  e.preventDefault();
  const [y, m] = link.dataset.month.split("-").map(Number);
  openMonth(y, m - 1);
});

$("#goto-month").addEventListener("submit", (e) => {
  e.preventDefault();
  openMonth(Number($("#goto-y").value), Number($("#goto-m").value));
});

// ---------------------------------------------------------------- chart tab

// HDO "Chart Workshop" (HackDiet.pl q=histreq, history::drawChart).
const CHART_PERIODS = { m: -1, q: -3, h: -6, y: -12 };

function addDays(iso, n) {
  return toISO(new Date(parseDate(iso).getTime() + n * 86400000));
}

function dayDiff(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

// Standard periods end on the last weigh-in and start no earlier than the
// first; a custom range is clamped to the log and reordered if reversed.
function chartRange(first, last) {
  const p = state.chartPeriod;
  if (p.period === "c" && p.from && p.to) {
    let { from, to } = p;
    if (from < first || from > last) from = first;
    if (to < first || to > last) to = last;
    if (to < from) [from, to] = [to, from];
    if (from !== to) return [from, to];
  }
  const start = intervalStart(last, CHART_PERIODS[p.period] ?? -3);
  return [start < first ? first : start, last];
}

// Date-axis ticks: day-of-week ticks under a month, month names up to two
// years (the year itself at January), years beyond that.
function chartTicks(days, plotW) {
  const n = days.length, ticks = [];
  const months = dayDiff(days[0], days[n - 1]) / 30.44;
  if (months > 24) {
    const years = months / 12;
    const every = Math.max(1, Math.ceil((years * 40) / plotW));
    days.forEach((d, i) => {
      const [y, m, dd] = d.split("-").map(Number);
      if (m === 1 && dd === 1 && y % every === 0) ticks.push({ i, label: String(y) });
    });
    return ticks;
  }
  days.forEach((d, i) => {
    const [y, m, dd] = d.split("-").map(Number);
    if (i === 0 || dd === 1) {
      ticks.push({ i, label: m === 1 ? String(y) : MONTHS[m - 1].slice(0, 3), major: true });
    } else if (n - 1 < 32 && dd % 7 === 0 && dd <= 28) {
      ticks.push({ i, label: String(dd) });
    }
  });
  return ticks;
}

// SVG path through points, breaking wherever a value is null.
function brokenPath(points) {
  let d = "", pen = false;
  for (const p of points) {
    if (!p) { pen = false; continue; }
    d += `${pen ? "L" : "M"} ${p[0].toFixed(1)} ${p[1].toFixed(1)} `;
    pen = true;
  }
  return d;
}

function renderHistoryChart() {
  const wrap = $("#history-chart"), statsEl = $("#history-stats");
  const weighed = weighedEntries();
  if (weighed.length === 0) {
    wrap.innerHTML = `<p class="chart-empty">No weigh-ins yet. Your chart appears here once you've logged some.</p>`;
    statsEl.innerHTML = "";
    return;
  }
  const first = weighed[0].date, last = weighed[weighed.length - 1].date;
  let [from, to] = chartRange(first, last);
  if (from === to) from = addDays(to, -7);

  const fromInput = $("#chart-from"), toInput = $("#chart-to");
  fromInput.min = toInput.min = first;
  fromInput.max = toInput.max = last;
  fromInput.value = from;
  toInput.value = to;

  const n = dayDiff(from, to) + 1;
  const days = Array.from({ length: n }, (_, i) => addDays(from, i));
  const trend = buildTrendSeries(state.entries, to);
  const byDate = new Map(state.entries.map((e) => [e.date, e]));
  const unit = state.units.store;

  const weightOf = (d) => { const w = byDate.get(d)?.weight; return typeof w === "number" && w > 0 ? w : null; };
  const rungs = days.map((d) => byDate.get(d)?.rung || null);
  const hasRungs = rungs.some((r) => r !== null);

  if (!days.some((d) => weightOf(d) !== null)) {
    wrap.innerHTML = `<p class="chart-empty">There are no weight log entries in this date range.</p>`;
    statsEl.innerHTML = "";
    return;
  }

  const W = 840, H = 420, L = 52, T = 28, B = 30;
  const R = hasRungs ? 44 : 16;
  const plotW = W - L - R, plotH = H - T - B;
  const INSET = 7; // keeps end-of-range diamonds clear of the axes
  const xAt = (i) => L + INSET + ((plotW - 2 * INSET) * i) / (n - 1);
  const pxPerDay = (plotW - 2 * INSET) / (n - 1);

  // Diet plan: start (or chart start) -> plan end -> flat at goal.
  let planPts = [];
  if (state.plan?.show && state.plan.startDate <= to) {
    const ps = state.plan.startDate > from ? state.plan.startDate : from;
    const pe = planEndDate(state.plan, unit);
    const at = [ps];
    if (pe && pe > ps && pe < to) at.push(pe);
    at.push(to);
    planPts = at.map((d) => [dayDiff(from, d), planWeightOn(state.plan, d, unit)]);
  }

  // Vertical scale: weights, trend and plan in range; 1/2/5 steps, at least
  // one unit, sized to about one label per 22px (HDO: one per text line).
  const values = [];
  for (const d of days) {
    const w = weightOf(d), t = trend.get(d);
    if (w !== null) values.push(toDisp(w));
    if (t !== undefined) values.push(toDisp(t));
  }
  for (const [, pw] of planPts) values.push(toDisp(pw));
  let lo = Math.min(...values), hi = Math.max(...values);
  if (hi - lo < 1e-9) { lo -= 10; hi += 10; }
  const maxRows = plotH / 22;
  let step = 1;
  if (state.units.display === "st") {
    // Whole and half stones read better than 1/2/5 steps of pounds.
    step = [1, 2, 7, 14, 28, 70, 140].find((c) => (hi - lo) / c <= maxRows) || 280;
  } else {
    for (let power = 1; ; power *= 10) {
      const s = [1, 2, 5].map((f) => f * power).find((c) => (hi - lo) / c <= maxRows);
      if (s) { step = s; break; }
    }
  }
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  // y() takes stored weights; the scale itself is in display units.
  const yd = (v) => T + (1 - (v - lo) / (hi - lo)) * plotH;
  const y = (w) => yd(toDisp(w));
  const yRung = (r) => (H - B) - ((r - 1) / RUNG_MAX) * plotH;

  let svg = `<text x="${L + plotW / 2}" y="${T - 10}" text-anchor="middle" font-size="12" fill="var(--ink)">` +
    `${formatDate(from)} – ${formatDate(to)}</text>`;
  for (let v = lo; v <= hi + 1e-9; v += step) {
    svg += `<line x1="${L}" y1="${yd(v)}" x2="${W - R}" y2="${yd(v)}" stroke="var(--line)"/>` +
      `<text x="${L - 6}" y="${yd(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${fmtAxis(v)}</text>`;
  }
  for (const { i, label, major } of chartTicks(days, plotW)) {
    const tx = xAt(i);
    svg += `<line x1="${tx}" y1="${H - B}" x2="${tx}" y2="${H - B + (major ? 6 : 4)}" stroke="var(--muted)"/>` +
      `<text x="${tx}" y="${H - B + 18}" text-anchor="middle" font-size="11" fill="var(--muted)"` +
      `${major ? ' font-weight="600"' : ""}>${label}</text>`;
  }
  svg += `<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="var(--muted)"/>`;

  let weightsSVG = "", trendD = "", rungSVG = "", lastRung = null;

  if (pxPerDay >= 2) {
    // One point per day.
    trendD = brokenPath(days.map((d, i) => (trend.has(d) ? [xAt(i), y(trend.get(d))] : null)));
    if (pxPerDay >= 7) {
      // Floats and sinkers, as on the monthly chart.
      days.forEach((d, i) => {
        const w = weightOf(d);
        if (w === null) return;
        const e = byDate.get(d), wx = xAt(i), wy = y(w), ty = y(trend.get(d));
        const tip = `${d}: ${fmtW(w, { unit: true })}` + (e.rung ? ` · rung ${e.rung}` : "") +
          (e.flag ? " · flagged" : "") + (e.comment ? ` — ${e.comment}` : "");
        weightsSVG += `<line x1="${wx}" y1="${wy}" x2="${wx}" y2="${ty}" stroke="var(--good)" stroke-width="1.2"/>` +
          `<g><title>${escapeXML(tip)}</title><path d="M ${wx} ${wy - 4} L ${wx + 4} ${wy} L ${wx} ${wy + 4} L ${wx - 4} ${wy} Z"
            fill="${e.flag ? "var(--flag)" : "#fff"}" stroke="#4a4437" stroke-width="1.2"/></g>`;
      });
    } else {
      // Weights joined by a grey line (across missed days, as in HDO).
      const pts = [];
      days.forEach((d, i) => { const w = weightOf(d); if (w !== null) pts.push([xAt(i), y(w)]); });
      weightsSVG = `<path d="${brokenPath(pts)}" fill="none" stroke="var(--weight-line)" stroke-width="1.2"/>`;
    }
    if (hasRungs) {
      rungSVG = rungSegmentsSVG(rungs, xAt, yRung);
      lastRung = [...rungs].reverse().find((r) => r !== null);
    }
  } else {
    // More days than pixels: average each column's days (history::getDays).
    // Weight and trend average over weighed days only, so gaps in the log
    // show as gaps in both lines.
    const cols = Math.floor(plotW);
    const wPts = [], tPts = [], rPts = [];
    for (let c = 0; c < cols; c++) {
      const i0 = Math.floor((n * c) / cols), i1 = Math.max(i0 + 1, Math.floor((n * (c + 1)) / cols));
      let ws = 0, ts = 0, wn = 0, rs = 0, rn = 0;
      for (let i = i0; i < i1 && i < n; i++) {
        const w = weightOf(days[i]);
        if (w !== null) { ws += w; ts += trend.get(days[i]); wn++; }
        if (rungs[i] !== null) { rs += rungs[i]; rn++; }
      }
      const cx = L + (plotW * (c + 0.5)) / cols;
      wPts.push(wn ? [cx, y(ws / wn)] : null);
      tPts.push(wn ? [cx, y(ts / wn)] : null);
      rPts.push(rn ? [cx, yRung(rs / rn)] : null);
      if (rn) lastRung = Math.round(rs / rn);
    }
    weightsSVG = `<path d="${brokenPath(wPts)}" fill="none" stroke="var(--weight-line)" stroke-width="1"/>`;
    trendD = brokenPath(tPts);
    if (hasRungs) rungSVG = `<path d="${brokenPath(rPts)}" fill="none" stroke="var(--rung)" stroke-width="1.5"/>`;
  }

  // Rung scale: 1, 6, 12 … 48, skipping labels that would crowd the last rung,
  // which is labelled itself.
  if (hasRungs && lastRung !== null) {
    const ax = W - R;
    const label = (r, bold) =>
      `<line x1="${ax - 4}" y1="${yRung(r)}" x2="${ax}" y2="${yRung(r)}" stroke="var(--muted)"/>` +
      `<text x="${ax + 6}" y="${yRung(r) + 4}" font-size="11" fill="var(--rung)"${bold ? ' font-weight="700"' : ""}>${r}</text>`;
    rungSVG += `<line x1="${ax}" y1="${T}" x2="${ax}" y2="${H - B}" stroke="var(--muted)"/>` +
      `<text x="${ax + 6}" y="${T - 2}" font-size="10" fill="var(--rung)">Rung</text>`;
    for (let r = 1; r <= RUNG_MAX; r = Math.floor(r / 6) * 6 + 6) {
      if (Math.abs(lastRung - r) >= 6) rungSVG += label(r, false);
    }
    rungSVG += label(lastRung, true);
  }

  const planSVG = planPts.length
    ? `<path d="${brokenPath(planPts.map(([i, w]) => [xAt(i), y(w)]))}" fill="none" stroke="var(--plan)"
         stroke-width="2" stroke-dasharray="7 5"><title>Diet plan</title></path>`
    : "";

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight chart ${from} to ${to}">
      ${svg}${rungSVG}${planSVG}${pxPerDay >= 7 ? "" : weightsSVG}
      <path d="${trendD}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linejoin="round"/>
      ${pxPerDay >= 7 ? weightsSVG : ""}
    </svg>`;

  // Caption (HDO prints this under the chart): rate over the whole period,
  // % of days flagged, and BMI from the trend.
  let cells = "";
  const [r] = analyseTrend(trend, [[from, to]]);
  if (r && r.slope !== null) {
    const weekly = r.slope * 7, kcal = r.slope * KCAL_PER_UNIT[unit];
    cells += statCell("Rate", `${weekly > 0 ? "+" : ""}${fmtDelta(weekly, 2)} ${dispBase()}/week`, weekly);
    cells += statCell(`${energyWord()} ${kcal <= 0 ? "deficit" : "excess"}`,
      `${Math.abs(Math.round(toEnergy(kcal)))} ${eUnit()}/day`, kcal);
  }
  const flagged = days.filter((d) => byDate.get(d)?.flag).length;
  const pct = Math.round((flagged * 100) / n);
  if (pct > 0) cells += statCell("Flagged", `${pct}%`, 0, `${flagged} of ${n} days`);
  if (state.heightCm && r) {
    const trendVals = days.filter((d) => trend.has(d)).map((d) => trend.get(d));
    const recent = bodyMassIndex(trendVals[trendVals.length - 1], unit, state.heightCm);
    const mean = bodyMassIndex(r.mean, unit, state.heightCm);
    cells += statCell("Body mass index", num(recent, 1), 0, `mean ${num(mean, 1)} over the period`);
  }
  statsEl.innerHTML = cells;
}

$("#chart-form").addEventListener("change", (e) => {
  if (e.target.name === "chart-period") {
    state.chartPeriod = e.target.value === "c"
      ? { period: "c", from: $("#chart-from").value, to: $("#chart-to").value }
      : { period: e.target.value };
  } else if (e.target.type === "date") {
    document.querySelector('input[name="chart-period"][value="c"]').checked = true;
    state.chartPeriod = { period: "c", from: $("#chart-from").value, to: $("#chart-to").value };
  }
  renderHistoryChart();
});

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
      const weekly = toDisp(r.slope * 7);
      const energy = toEnergy(r.slope * KCAL_PER_UNIT[state.units.store]);
      tr.innerHTML =
        `<td>${row.name}</td>` +
        `<td class="num ${signClass(weekly, 2)}">${signed(weekly, 2)}</td>` +
        `<td class="num ${signClass(energy, 0)}">${signed(energy, 0)}</td>` +
        `<td class="num">${fmtW(r.min)}</td>` +
        `<td class="num">${fmtW(r.mean)}</td>` +
        `<td class="num">${fmtW(r.max)}</td>`;
    }
    tbody.appendChild(tr);
  });
}

// Signed figure as HDO prints it: "+0.49", "−0.49", and "0.00" with no sign
// or colour when it rounds to zero.
function signed(v, digits) {
  const s = num(Math.abs(v), digits);
  if (Number(Math.abs(v).toFixed(digits)) === 0) return s;
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
  $("#plan-start-weight").value = p ? fmtW(p.startWeight) : lt ? fmtW(lt.value) : "";
  $("#plan-goal-weight").value = p ? fmtW(p.goalWeight) : "";
  $("#plan-balance").value = String(Math.round(toEnergy(p ? Math.abs(p.calorieBalance) : 500)));
  $("#plan-show").checked = p ? p.show : false;
  $("#plan-remove").hidden = !p;
  $("#plan-status").textContent = "";
  updatePlanSummary();
}

// Fields left as displayed keep the saved plan's exact values, so viewing
// in another unit never nudges them.
function readPlanForm() {
  const p = state.plan;
  const sw = $("#plan-start-weight").value, gw = $("#plan-goal-weight").value;
  const startWeight = p && sw === fmtW(p.startWeight) ? p.startWeight : parseW(sw);
  const goalWeight = p && gw === fmtW(p.goalWeight) ? p.goalWeight : parseW(gw);
  const shownBalance = Number($("#plan-balance").value);
  const kcal = p && shownBalance === Math.round(toEnergy(Math.abs(p.calorieBalance)))
    ? Math.abs(p.calorieBalance)
    : Math.round(fromEnergy(shownBalance));
  const plan = {
    startDate: $("#plan-start-date").value,
    startWeight,
    goalWeight,
    calorieBalance: kcal,
    show: $("#plan-show").checked,
  };
  const ok = plan.startDate && startWeight > 0 && goalWeight > 0 && kcal > 0;
  if (ok && goalWeight < startWeight) plan.calorieBalance = -kcal;
  return ok ? plan : null;
}

function updatePlanSummary() {
  const el = $("#plan-summary");
  const plan = readPlanForm();
  if (!plan) {
    el.textContent = `Enter a start weight, goal weight and daily ${eUnit()} figure to see your projection.`;
    return;
  }
  const unit = state.units.store;
  const weekly = (Math.abs(plan.calorieBalance) * 7) / KCAL_PER_UNIT[unit];
  const losing = plan.goalWeight < plan.startWeight;
  const end = planEndDate(plan, unit);
  const weeks = Math.round((parseDate(end) - parseDate(plan.startDate)) / (7 * 86400000));

  let html = plan.goalWeight === plan.startWeight
    ? `Your goal equals your start weight: the plan is a flat line at ${fmtW(plan.goalWeight, { unit: true })}.`
    : `A ${Math.round(toEnergy(Math.abs(plan.calorieBalance)))} ${eUnit()}/day ${losing ? "deficit" : "excess"} means
       ${losing ? "losing" : "gaining"} <strong>${fmtDelta(weekly, 2)} ${dispBase()}/week</strong>, reaching
       ${fmtW(plan.goalWeight, { unit: true })} around <strong>${formatDate(end)}</strong>
       (about ${weeks} week${weeks === 1 ? "" : "s"}).`;

  if (state.heightCm) {
    const startBmi = bodyMassIndex(plan.startWeight, unit, state.heightCm);
    const goalBmi = bodyMassIndex(plan.goalWeight, unit, state.heightCm);
    html += `<br>Body mass index: ${num(startBmi, 1)} at the start, ${num(goalBmi, 1)} at your goal.`;
  }

  const lt = latestTrend();
  if (lt && lt.date >= plan.startDate) {
    const target = planWeightOn(plan, lt.date, unit);
    const diff = lt.value - target;
    const ahead = losing ? diff <= 0 : diff >= 0;
    html += `<br>On ${formatDate(lt.date)} the plan called for ${fmtW(target, { unit: true })}; your trend was
      ${fmtW(lt.value, { unit: true })}, <span class="${ahead ? "good" : "bad"}">${fmtDelta(Math.abs(diff), 1)} ${dispBase()}
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
