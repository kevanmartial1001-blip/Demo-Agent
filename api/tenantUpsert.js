// /api/tenantUpsert.js
// CommonJS + Vercel "nodejs" runtime (kept)
// Adds: kb_json serialization + real UPSERT by tenant_id
//       CHUNKED storage for large KBs: kb_json_1..kb_json_6 (≈270k chars)

module.exports.config = { runtime: "nodejs" };

const { google } = require("googleapis");

// -------- helpers --------
function badRequest(msg) {
  const err = new Error(msg);
  err.code = 400;
  return err;
}
function assertBody(b, k) {
  if (!b?.[k] || String(b[k]).trim() === "") throw badRequest(`${k} required`);
}

function serviceAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!email || !key) {
    const e = new Error("Google service account not configured (env missing)");
    e.code = 500;
    throw e;
  }
  key = key.replace(/\\n/g, "\n"); // handle literal \n in Vercel env
  return new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function getSheets() {
  const spreadsheetId = process.env.SHEET_ID;
  if (!spreadsheetId) {
    const e = new Error("SHEET_ID missing");
    e.code = 500;
    throw e;
  }
  const auth = serviceAuth();
  const sheets = google.sheets({ version: "v4", auth });
  return { sheets, spreadsheetId };
}

// NOTE: we add kb_json_1..kb_json_6 to bypass ~50k chars/cell limit.
const KB_JSON_CHUNK_HEADERS = [
  "kb_json_1","kb_json_2","kb_json_3","kb_json_4","kb_json_5","kb_json_6"
];

const EXPECTED_HEADERS = [
  "tenant_id",
  "company_id",
  "company_name",
  "domain",
  "homepage_url",
  "kb_version",
  "demo_url",
  "kb_sources_json",
  "kb_json",                 // small KBs can fit here
  ...KB_JSON_CHUNK_HEADERS,  // large KBs across these
  "company_system_prompt",
  "created_at",
  "updated_at",
];

// 1-based col number -> A1
function colToA1(n){ let s=''; while(n>0){ const m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=Math.floor((n-1)/26);} return s; }

async function ensureHeaderRow(sheets, spreadsheetId, sheetTitle = "Tenants") {
  // Use first sheet if exists; else fallback to provided title
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const firstTitle = meta?.data?.sheets?.[0]?.properties?.title || sheetTitle;
  const title = firstTitle;

  const read = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${title}!A1:ZZ1`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const existing = (read.data.values && read.data.values[0]) || [];

  const needsRewrite =
    existing.length === 0 ||
    EXPECTED_HEADERS.some((h, i) => (existing[i] || "") !== h);

  if (needsRewrite) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${title}!A1:${colToA1(EXPECTED_HEADERS.length)}1`,
      valueInputOption: "RAW",
      requestBody: { values: [EXPECTED_HEADERS] },
    });
  }

  return title;
}

function serializeKbJson(kb_json) {
  try {
    if (kb_json == null) return "";
    if (typeof kb_json === "string") {
      const trimmed = kb_json.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
      return JSON.stringify({ value: kb_json });
    }
    return JSON.stringify(kb_json);
  } catch {
    return "";
  }
}

// Split into chunks <= limit; returns array of strings
function chunkString(s, maxLen){
  const out=[]; let i=0;
  while(i < s.length){ out.push(s.slice(i, i+maxLen)); i += maxLen; }
  return out;
}

function makeRow(body, headers, { preserveCreatedAt } = {}) {
  const now = new Date().toISOString();
  const index = new Map(headers.map((h, i) => [h, i]));
  const row = new Array(headers.length).fill("");

  const set = (k, v) => {
    if (!index.has(k)) return;
    row[index.get(k)] = v == null ? "" : v;
  };

  set("tenant_id", body.tenant_id);
  set("company_id", body.company_id || "");
  set("company_name", body.company_name || "");
  set("domain", body.domain || "");
  set("homepage_url", body.homepage_url || "");
  set("kb_version", body.kb_version || "");
  set("demo_url", body.demo_url || "");

  // accept kb_sources (array) -> kb_sources_json
  if (!body.kb_sources_json && Array.isArray(body.kb_sources)) {
    try {
      body.kb_sources_json = JSON.stringify(
        body.kb_sources.map((s) => ({
          host: s.host || s.lane || null,
          src_url: s.src_url || s.url || null,
        }))
      );
    } catch {}
  }
  set("kb_sources_json", body.kb_sources_json || "");

  // ---- NEW: store kb_json; chunk if large ----
  const serialized = serializeKbJson(body.kb_json);
  const CELL_LIMIT = 45000; // below ~50k Google limit for safety
  if (serialized.length <= CELL_LIMIT) {
    set("kb_json", serialized);
    // clear chunk columns (important on update)
    for (const h of KB_JSON_CHUNK_HEADERS) set(h, "");
  } else {
    set("kb_json", ""); // keep small cell empty when chunked
    const chunks = chunkString(serialized, CELL_LIMIT).slice(0, KB_JSON_CHUNK_HEADERS.length);
    KB_JSON_CHUNK_HEADERS.forEach((h, i)=> set(h, chunks[i] || ""));
  }

  set("company_system_prompt", body.company_system_prompt || "");

  if (index.has("created_at")) {
    if (preserveCreatedAt) {
      set("created_at", preserveCreatedAt);
    } else {
      set("created_at", body.created_at || now);
    }
  }
  if (index.has("updated_at")) set("updated_at", now);

  return row;
}

async function findRowIndexByTenantId(sheets, spreadsheetId, title, headers, tenant_id) {
  const endCol = colToA1(headers.length);
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${title}!A2:${endCol}`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = resp.data.values || [];
  const idxTenant = headers.indexOf("tenant_id");
  if (idxTenant < 0) return { rowIndex: null, existingRow: null };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    if (String(row[idxTenant] || "") === String(tenant_id)) {
      return { rowIndex: i + 2, existingRow: row }; // +2 because A2 is index 2
    }
  }
  return { rowIndex: null, existingRow: null };
}

// -------- handler --------
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    const ct = String(req.headers["content-type"] || "");
    const isJson = ct.includes("application/json");
    const body =
      typeof req.body === "string"
        ? (isJson ? JSON.parse(req.body || "{}") : {})
        : (req.body || {});

    // minimal required
    assertBody(body, "tenant_id");

    const { sheets, spreadsheetId } = await getSheets();
    const title = await ensureHeaderRow(sheets, spreadsheetId);
    const headers = EXPECTED_HEADERS;
    const endCol = colToA1(headers.length);

    // Look up existing row by tenant_id
    const { rowIndex, existingRow } = await findRowIndexByTenantId(
      sheets,
      spreadsheetId,
      title,
      headers,
      body.tenant_id
    );

    // Preserve created_at on updates (if present)
    let preserveCreatedAt = null;
    if (existingRow) {
      const idxCreated = headers.indexOf("created_at");
      if (idxCreated >= 0) preserveCreatedAt = existingRow[idxCreated] || null;
    }

    const row = makeRow(body, headers, { preserveCreatedAt });

    if (rowIndex) {
      // UPDATE existing row
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${title}!A${rowIndex}:${endCol}${rowIndex}`,
        valueInputOption: "RAW",
        requestBody: { values: [row] },
      });
    } else {
      // APPEND new row
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${title}!A1:${endCol}1`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [row] },
      });
    }

    return res.status(200).json({ ok: true, tenant_id: String(body.tenant_id) });
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
