// /api/tenantUpsert.js
// CommonJS + Vercel "nodejs" runtime

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
  // Vercel stores multiline secrets with literal \n
  key = key.replace(/\\n/g, "\n");

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

const EXPECTED_HEADERS = [
  "tenant_id",
  "company_id",
  "company_name",
  "domain",
  "homepage_url",
  "kb_version",
  "demo_url",
  "kb_sources_json",
  "company_system_prompt",
  // optional timestamps; filled iff present
  "created_at",
  "updated_at",
];

async function ensureHeaderRow(sheets, spreadsheetId, sheetTitle = "Tenants") {
  // Use first sheet if exists; else fallback to named range
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const firstTitle =
    meta?.data?.sheets?.[0]?.properties?.title || sheetTitle;
  const title = firstTitle;

  const read = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${title}!A1:Z1`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const existing = (read.data.values && read.data.values[0]) || [];

  const needsRewrite =
    existing.length === 0 ||
    EXPECTED_HEADERS.some((h, i) => (existing[i] || "") !== h);

  if (needsRewrite) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${title}!A1:${String.fromCharCode(
        65 + EXPECTED_HEADERS.length - 1
      )}1`,
      valueInputOption: "RAW",
      requestBody: { values: [EXPECTED_HEADERS] },
    });
  }

  return title;
}

function makeRow(body, headers) {
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
  set("kb_sources_json", body.kb_sources_json || "");
  set("company_system_prompt", body.company_system_prompt || "");

  if (index.has("created_at") && !body.created_at) set("created_at", now);
  if (index.has("updated_at")) set("updated_at", now);

  return row;
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

    // accept kb_sources as array -> stringify compactly
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

    const { sheets, spreadsheetId } = await getSheets();
    const title = await ensureHeaderRow(sheets, spreadsheetId);
    const headers = EXPECTED_HEADERS;

    const row = makeRow(body, headers);

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${title}!A1:A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });

    return res.status(200).json({ ok: true, tenant_id: body.tenant_id });
  } catch (e) {
    const code = e.code || 500;
    return res.status(code).json({
      ok: false,
      error: String(e?.message || e),
      hint: (e?.stack || "").split("\n").slice(0, 2).join("\n"),
      needs: {
        SHEET_ID: process.env.SHEET_ID ? "ok" : "missing",
        GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
          ? "ok"
          : "missing",
        GOOGLE_SERVICE_ACCOUNT_KEY: process.env.GOOGLE_SERVICE_ACCOUNT_KEY
          ? "ok"
          : "missing",
      },
    });
  }
};
