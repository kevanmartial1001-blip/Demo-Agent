// /api/tenantUpsert.js
// Upserts a tenant row to Google Sheets and **splits kb_json** across kb_json, kb_json_1..N safely.

module.exports.config = { runtime: "nodejs18.x" };

const { google } = require("googleapis");
const crypto = require("node:crypto");

// ========== helpers ==========
function badRequest(msg) { const e = new Error(msg); e.code = 400; return e; }
function assertBody(b, k) { if (!b?.[k] || String(b[k]).trim() === "") throw badRequest(`${k} required`); }

function serviceAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!email || !key) { const e = new Error("Google service account not configured (env missing)"); e.code = 500; throw e; }
  key = key.replace(/\\n/g, "\n");
  return new google.auth.JWT({ email, key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
}

async function getSheets() {
  const spreadsheetId = process.env.SHEET_ID;
  if (!spreadsheetId) { const e = new Error("SHEET_ID missing"); e.code = 500; throw e; }
  const auth = serviceAuth();
  const sheets = google.sheets({ version: "v4", auth });
  return { sheets, spreadsheetId };
}

// We will allow up to 20 chunks by default; each chunk <= 48k to stay safely under ~50k cell limit.
const KB_CHUNK_SIZE = 48000;
const KB_MAX_CHUNKS = 20;

// Base headers (we’ll append kb_json columns dynamically)
const BASE_HEADERS = [
  "tenant_id",
  "company_id",
  "company_name",
  "domain",
  "homepage_url",
  "kb_version",
  "demo_url",
  "kb_sources_json",
  "company_system_prompt",
  "kb_sha256",        // NEW: checksum of stitched kb_json
  "created_at",
  "updated_at",
];

/** Build the target header list including kb_json, kb_json_1..N */
function buildHeadersWithKb(maxChunksNeeded) {
  const kbHeaders = ["kb_json"];
  for (let i = 1; i <= Math.min(maxChunksNeeded, KB_MAX_CHUNKS - 1); i++) {
    kbHeaders.push(`kb_json_${i}`);
  }
  // Insert kb headers before timestamps (and after company_system_prompt / kb_sha256)
  const out = [];
  for (const h of BASE_HEADERS) {
    out.push(h);
    if (h === "kb_sha256") out.push(...kbHeaders);
  }
  return out;
}

async function ensureHeaderRow(sheets, spreadsheetId, sheetTitle = null, maxChunksNeeded = 1) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const title = sheetTitle || meta?.data?.sheets?.[0]?.properties?.title || "Tenants";

  const read = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `${title}!A1:ZZZ`, valueRenderOption: "UNFORMATTED_VALUE",
  });
  const curValues = read?.data?.values || [];
  const curHeaders = (curValues[0] || []).map((h) => String(h || "").trim());

  const wantHeaders = buildHeadersWithKb(maxChunksNeeded);
  let needRewrite = curHeaders.length === 0 || wantHeaders.some((h, i) => (curHeaders[i] || "") !== h);

  if (needRewrite) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${title}!A1:${String.fromCharCode(65 + wantHeaders.length - 1)}1`,
      valueInputOption: "RAW",
      requestBody: { values: [wantHeaders] },
    });
    return { title, headers: wantHeaders };
  }
  return { title, headers: curHeaders };
}

function stringifyKB(body) {
  // Accept either kb_json (object) OR kb_json_raw (string)
  if (typeof body.kb_json_raw === "string" && body.kb_json_raw.trim().length) {
    return body.kb_json_raw.trim();
  }
  if (body.kb_json && typeof body.kb_json === "object") {
    return JSON.stringify(body.kb_json);
  }
  // If missing, store empty
  return "";
}

function chunkKB(jsonStr) {
  if (!jsonStr) return { chunks: [""], sha: "" };
  const clean = jsonStr.replace(/^\uFEFF/, "");
  const sha = crypto.createHash("sha256").update(clean).digest("hex");
  const chunks = [];
  for (let i = 0; i < clean.length; i += KB_CHUNK_SIZE) {
    chunks.push(clean.slice(i, i + KB_CHUNK_SIZE));
  }
  if (chunks.length > KB_MAX_CHUNKS) {
    throw badRequest(`kb_json too large (${clean.length} chars). Max supported ~${KB_CHUNK_SIZE * KB_MAX_CHUNKS} chars.`);
  }
  return { chunks, sha };
}

function rowFromBody(body, headers, kbChunks, kbSha) {
  const now = new Date().toISOString();
  const index = new Map(headers.map((h, i) => [h, i]));
  const row = new Array(headers.length).fill("");

  const set = (k, v) => { if (index.has(k)) row[index.get(k)] = v == null ? "" : v; };

  set("tenant_id", body.tenant_id);
  set("company_id", body.company_id || "");
  set("company_name", body.company_name || "");
  set("domain", body.domain || "");
  set("homepage_url", body.homepage_url || "");
  set("kb_version", body.kb_version || "");
  set("demo_url", body.demo_url || "");
  // kb_sources_json (optional) – accept array and stringify compact
  if (!body.kb_sources_json && Array.isArray(body.kb_sources)) {
    try {
      body.kb_sources_json = JSON.stringify(
        body.kb_sources.map((s) => ({ host: s.host || s.lane || null, src_url: s.src_url || s.url || null }))
      );
    } catch {}
  }
  set("kb_sources_json", body.kb_sources_json || "");
  set("company_system_prompt", body.company_system_prompt || "");
  set("kb_sha256", kbSha || "");

  // place chunks
  for (let i = 0; i < kbChunks.length; i++) {
    const col = i === 0 ? "kb_json" : `kb_json_${i}`;
    set(col, kbChunks[i]);
  }

  if (index.has("created_at") && !body.created_at) set("created_at", now);
  if (index.has("updated_at")) set("updated_at", now);

  return row;
}

// ========== handler ==========
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const ct = String(req.headers["content-type"] || "");
    const isJson = ct.includes("application/json");
    const body = typeof req.body === "string" ? (isJson ? JSON.parse(req.body || "{}") : {}) : (req.body || {});

    assertBody(body, "tenant_id");

    // Build KB chunks
    const kbStr = stringifyKB(body);               // from kb_json or kb_json_raw
    const { chunks, sha } = chunkKB(kbStr);
    const maxChunksNeeded = Math.max(chunks.length, 1);

    const { sheets, spreadsheetId } = await getSheets();
    const { title, headers } = await ensureHeaderRow(sheets, spreadsheetId, null, maxChunksNeeded);

    const row = rowFromBody(body, headers, chunks, sha);

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${title}!A1:A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });

    return res.status(200).json({ ok: true, tenant_id: body.tenant_id, kb_chunks: chunks.length, kb_sha256: sha });
  } catch (e) {
    const code = e.code || 500;
    return res.status(code).json({
      ok: false,
      error: String(e?.message || e),
      hint: (e?.stack || "").split("\n").slice(0, 2).join("\n"),
      needs: {
        SHEET_ID: process.env.SHEET_ID ? "ok" : "missing",
        GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ? "ok" : "missing",
        GOOGLE_SERVICE_ACCOUNT_KEY: process.env.GOOGLE_SERVICE_ACCOUNT_KEY ? "ok" : "missing",
      },
    });
  }
};
