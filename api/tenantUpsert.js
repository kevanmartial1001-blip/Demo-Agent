// /api/tenantUpsert.js
// CommonJS + Vercel "nodejs" runtime
// Accepts a single large `kb_json_str` and auto-splits it into kb_json, kb_json_1..kb_json_6.

module.exports.config = { runtime: "nodejs" };

const { google } = require("googleapis");

/* ----------------------------- helpers ---------------------------------- */
function badRequest(msg) { const e = new Error(msg); e.code = 400; return e; }
function assertBody(b, k) { if (!b?.[k] || String(b[k]).trim() === "") throw badRequest(`${k} required`); }

function serviceAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!email || !key) { const e = new Error("Google service account not configured (env missing)"); e.code = 500; throw e; }
  key = key.replace(/\\n/g, "\n"); // Vercel newlines
  return new google.auth.JWT({ email, key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
}

async function getSheets() {
  const spreadsheetId = process.env.SHEET_ID;
  if (!spreadsheetId) { const e = new Error("SHEET_ID missing"); e.code = 500; throw e; }
  const auth = serviceAuth();
  const sheets = google.sheets({ version: "v4", auth });
  return { sheets, spreadsheetId };
}

/** Columns present in the Tenants sheet (in order). */
const EXPECTED_HEADERS = [
  "tenant_id",
  "company_id",
  "company_name",
  "domain",
  "homepage_url",
  "kb_version",
  "demo_url",
  "kb_sources_json",
  // --- KB chunks (server will auto-fill from kb_json_str) ---
  "kb_json", "kb_json_1", "kb_json_2", "kb_json_3", "kb_json_4", "kb_json_5", "kb_json_6",
  "company_system_prompt",
  "created_at",
  "updated_at",
];

/** Ensure header row exists and in the expected order on the first sheet. */
async function ensureHeaderRow(sheets, spreadsheetId, sheetTitle = "Tenants") {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const title = meta?.data?.sheets?.[0]?.properties?.title || sheetTitle;

  const read = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `${title}!A1:ZZ1`, valueRenderOption: "UNFORMATTED_VALUE",
  });
  const existing = (read.data.values && read.data.values[0]) || [];

  const needsRewrite = existing.length === 0 ||
    EXPECTED_HEADERS.some((h, i) => (existing[i] || "") !== h);

  if (needsRewrite) {
    const lastColIdx = 65 + EXPECTED_HEADERS.length - 1; // 'A' = 65
    const lastA1 = String.fromCharCode(lastColIdx) + "1";
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${title}!A1:${lastA1}`,
      valueInputOption: "RAW",
      requestBody: { values: [EXPECTED_HEADERS] },
    });
  }
  return title;
}

/** Split a big string into safe chunks for Sheets. */
function splitIntoChunks(str, max = 45000) {
  if (!str) return [];
  const out = [];
  for (let i = 0; i < str.length; i += max) out.push(str.slice(i, i + max));
  return out;
}

/** Build the row aligned with EXPECTED_HEADERS */
function makeRow(body, headers) {
  const now = new Date().toISOString();
  const idx = new Map(headers.map((h, i) => [h, i]));
  const row = new Array(headers.length).fill("");

  const set = (k, v) => { if (idx.has(k)) row[idx.get(k)] = v == null ? "" : v; };

  // core fields
  set("tenant_id", body.tenant_id);
  set("company_id", body.company_id || "");
  set("company_name", body.company_name || "");
  set("domain", body.domain || "");
  set("homepage_url", body.homepage_url || "");
  set("kb_version", body.kb_version || "");
  set("demo_url", body.demo_url || "");
  set("kb_sources_json", body.kb_sources_json || "");

  // --- KB handling ---
  // Accept either kb_json_str (preferred) or kb_json (object/string) for backward compatibility
  let kbJsonStr = "";
  if (typeof body.kb_json_str === "string" && body.kb_json_str.trim() !== "") {
    kbJsonStr = body.kb_json_str;
  } else if (body.kb_json != null) {
    try { kbJsonStr = typeof body.kb_json === "string" ? body.kb_json : JSON.stringify(body.kb_json); }
    catch { kbJsonStr = ""; }
  }

  // Trim accidental whitespace
  kbJsonStr = (kbJsonStr || "").trim();

  // Split into chunks and place into kb_json, kb_json_1..6
  const chunks = splitIntoChunks(kbJsonStr, 45000);
  const chunkCols = ["kb_json","kb_json_1","kb_json_2","kb_json_3","kb_json_4","kb_json_5","kb_json_6"];
  chunkCols.forEach((col, i) => set(col, chunks[i] || "")); // empties for unused

  // system prompt
  set("company_system_prompt", body.company_system_prompt || "");

  // timestamps
  if (idx.has("created_at") && !body.created_at) set("created_at", now);
  if (idx.has("updated_at")) set("updated_at", now);

  return { row, chunks_count: chunks.length, kb_len: kbJsonStr.length };
}

/* ------------------------------ handler --------------------------------- */
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

    const ct = String(req.headers["content-type"] || "");
    const isJson = ct.includes("application/json");
    const body = typeof req.body === "string"
      ? (isJson ? JSON.parse(req.body || "{}") : {})
      : (req.body || {});

    // required
    assertBody(body, "tenant_id");

    // normalize kb_sources_json (accept array form from n8n)
    if (!body.kb_sources_json && Array.isArray(body.kb_sources)) {
      try {
        body.kb_sources_json = JSON.stringify(
          body.kb_sources.map(s => ({
            lane: s.lane || s.host || null,
            src_url: s.src_url || s.url || null,
          }))
        );
      } catch { body.kb_sources_json = "[]"; }
    }

    const { sheets, spreadsheetId } = await getSheets();
    const title = await ensureHeaderRow(sheets, spreadsheetId);
    const headers = EXPECTED_HEADERS;

    const { row, chunks_count, kb_len } = makeRow(body, headers);

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${title}!A1:A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });

    return res.status(200).json({
      ok: true,
      tenant_id: body.tenant_id,
      kb: { bytes: kb_len, chunks_used: chunks_count, columns: Math.min(chunks_count, 7) },
    });
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
