// Weight Log — Hacker's Diet style weight tracker.
// API worker; static UI is served from public/ via the assets binding.

import { buildTrendSeries } from "../public/trend.js";

const PBKDF2_ITERATIONS = 100000;
const SESSION_DAYS = 180;
const COOKIE = "session";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return json({ error: "Not found" }, 404);
    }
    try {
      return await route(request, env, url);
    } catch (err) {
      console.log(JSON.stringify({ event: "unhandled_error", path: url.pathname, message: err.message }));
      return json({ error: "Internal error" }, 500);
    }
  },
};

async function route(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // Cross-origin write protection: mutating requests must come from our own origin.
  if (method !== "GET" && method !== "HEAD") {
    const origin = request.headers.get("Origin");
    if (origin && new URL(origin).host !== url.host) {
      return json({ error: "Cross-origin request rejected" }, 403);
    }
  }

  if (path === "/api/register" && method === "POST") return register(request, env);
  if (path === "/api/login" && method === "POST") return login(request, env);
  if (path === "/api/logout" && method === "POST") return logout(request, env);

  const user = await authenticate(request, env);
  if (!user) return json({ error: "Not signed in" }, 401);

  if (path === "/api/me" && method === "GET") {
    return json({ email: user.email, unit: user.unit });
  }
  if (path === "/api/settings" && method === "POST") return saveSettings(request, env, user);
  if (path === "/api/weights" && method === "GET") return listWeights(env, user);
  if (path === "/api/weight" && method === "PUT") return putWeight(request, env, user);
  if (path === "/api/import" && method === "POST") return importCSV(request, env, user);
  if (path === "/api/export.csv" && method === "GET") return exportCSV(env, user);

  return json({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------- auth

async function register(request, env) {
  const body = await readJSON(request);
  const email = normalizeEmail(body?.email);
  const password = typeof body?.password === "string" ? body.password : "";
  const unit = body?.unit === "kg" ? "kg" : "lb";

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return json({ error: "Please enter a valid email address" }, 400);
  }
  if (password.length < 8) {
    return json({ error: "Password must be at least 8 characters" }, 400);
  }

  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  const result = await env.DB.prepare(
    "INSERT INTO users (email, password_hash, salt, unit) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING RETURNING id"
  ).bind(email, hash, salt, unit).first();

  if (!result) {
    return json({ error: "An account with that email already exists" }, 409);
  }
  return createSession(env, result.id, { email, unit });
}

async function login(request, env) {
  const body = await readJSON(request);
  const email = normalizeEmail(body?.email);
  const password = typeof body?.password === "string" ? body.password : "";

  const user = email
    ? await env.DB.prepare("SELECT id, email, password_hash, salt, unit FROM users WHERE email = ?").bind(email).first()
    : null;

  // Hash even when the user doesn't exist so response time doesn't reveal
  // which addresses are registered.
  const hash = await hashPassword(password, user ? user.salt : randomHex(16));
  if (!user || !timingSafeEqualHex(hash, user.password_hash)) {
    return json({ error: "Invalid email or password" }, 401);
  }

  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Date.now()).run();
  return createSession(env, user.id, { email: user.email, unit: user.unit });
}

async function logout(request, env) {
  const token = getCookie(request, COOKIE);
  if (token) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  }
  return json({ ok: true }, 200, `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

async function createSession(env, userId, payload) {
  const token = randomHex(32);
  const expires = Date.now() + SESSION_DAYS * 86400000;
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256Hex(token), userId, expires).run();
  const cookie = `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
  return json(payload, 200, cookie);
}

async function authenticate(request, env) {
  const token = getCookie(request, COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.unit FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(await sha256Hex(token), Date.now()).first();
  return row ?? null;
}

// ---------------------------------------------------------------- data

async function saveSettings(request, env, user) {
  const body = await readJSON(request);
  const unit = body?.unit === "kg" ? "kg" : body?.unit === "lb" ? "lb" : null;
  if (!unit) return json({ error: "Unit must be lb or kg" }, 400);
  await env.DB.prepare("UPDATE users SET unit = ? WHERE id = ?").bind(unit, user.id).run();
  return json({ ok: true, unit });
}

async function listWeights(env, user) {
  const { results } = await env.DB.prepare(
    "SELECT date, weight FROM weights WHERE user_id = ? ORDER BY date"
  ).bind(user.id).all();
  return json({ weights: results });
}

async function putWeight(request, env, user) {
  const body = await readJSON(request);
  const date = typeof body?.date === "string" ? body.date : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) {
    return json({ error: "Date must be YYYY-MM-DD" }, 400);
  }

  if (body.weight === null || body.weight === "" || body.weight === 0) {
    await env.DB.prepare("DELETE FROM weights WHERE user_id = ? AND date = ?").bind(user.id, date).run();
    return json({ ok: true, deleted: true });
  }

  const weight = Number(body.weight);
  if (!isFinite(weight) || weight <= 0 || weight > 1500) {
    return json({ error: "Weight out of range" }, 400);
  }
  await env.DB.prepare(
    `INSERT INTO weights (user_id, date, weight) VALUES (?, ?, ?)
     ON CONFLICT(user_id, date) DO UPDATE SET weight = excluded.weight`
  ).bind(user.id, date, Math.round(weight * 10) / 10).run();
  return json({ ok: true });
}

// Accepts CSV text in either this site's export format (Date,Weight,Trend)
// or Hacker's Diet Online CSV (Date,Weight,Rung,Flag,Comment with header
// blocks). Rows are matched on "YYYY-MM-DD,<number>"; existing dates are
// overwritten, blank-weight rows skipped.
async function importCSV(request, env, user) {
  if (Number(request.headers.get("Content-Length") || 0) > 4_000_000) {
    return json({ error: "File too large" }, 413);
  }
  const body = await readJSON(request);
  if (typeof body?.csv !== "string") return json({ error: "Missing csv field" }, 400);

  const rows = [];
  let skipped = 0;
  for (const rawLine of body.csv.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    const m = line.match(/^(\d{4}-\d{2}-\d{2}),([0-9]*\.?[0-9]+)(,|$)/);
    if (!m) {
      if (/^\d{4}-\d{2}-\d{2},/.test(line)) skipped++; // date row with no weight
      continue;
    }
    const weight = Number(m[2]);
    if (!isFinite(weight) || weight <= 0 || weight > 1500 || isNaN(Date.parse(m[1]))) {
      skipped++;
      continue;
    }
    rows.push({ date: m[1], weight });
  }

  if (rows.length === 0) {
    return json({ error: "No weight entries found in that file" }, 400);
  }

  // D1 allows 100 bound parameters per statement: 3 per row -> chunks of 30.
  const CHUNK = 30;
  const statements = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const sql =
      "INSERT INTO weights (user_id, date, weight) VALUES " +
      chunk.map(() => "(?, ?, ?)").join(", ") +
      " ON CONFLICT(user_id, date) DO UPDATE SET weight = excluded.weight";
    statements.push(env.DB.prepare(sql).bind(...chunk.flatMap((r) => [user.id, r.date, r.weight])));
  }
  await env.DB.batch(statements);
  return json({ ok: true, imported: rows.length, skipped });
}

async function exportCSV(env, user) {
  const { results } = await env.DB.prepare(
    "SELECT date, weight FROM weights WHERE user_id = ? ORDER BY date"
  ).bind(user.id).all();

  const lines = [`Date,Weight (${user.unit}),Trend (${user.unit})`];
  if (results.length > 0) {
    const trend = buildTrendSeries(results, results[results.length - 1].date);
    for (const { date, weight } of results) {
      lines.push(`${date},${weight},${trend.get(date).toFixed(2)}`);
    }
  }
  return new Response(lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="weight-log.csv"',
      "Cache-Control": "no-store",
    },
  });
}

// ---------------------------------------------------------------- helpers

async function readJSON(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function json(data, status = 200, setCookie = null) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  return new Response(JSON.stringify(data), { status, headers });
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
  return toHex(bits);
}

function timingSafeEqualHex(aHex, bHex) {
  if (typeof aHex !== "string" || typeof bHex !== "string" || aHex.length !== bHex.length) return false;
  return crypto.subtle.timingSafeEqual(fromHex(aHex), fromHex(bHex));
}
