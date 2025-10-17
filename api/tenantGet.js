// /api/tenantGet.js
// Vercel nodejs runtime (CommonJS). Uses googleapis (not google-spreadsheet).

module.exports.config = { runtime: "nodejs" };

const crypto = require("node:crypto");
const { google } = require("googleapis");

// ---------- token verify (same contract as /api/demoLink) ----------
function verifyToken(token) {
  if (!token) return null;
  const [tenant, expStr, sig] = String(token).split(".");
  const exp = parseInt(expStr, 10);
  if (!tenant || !exp || exp < Math.floor(Date.now() / 1000)) return null;
  const raw = `${tenant}.${exp}.${process.env.DEMO_SECRET}`;
  const chk = crypto.createHash("sha256").update(raw).digest("base64url");
  return chk === sig ? tenant : null;
}

// ---------- Google Sheets helpers ----------
function serviceAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!email || !key) throw new Error("Google service account not configured");
  key = key.replace(/\\n/g, "\n");
  return new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

async function readTenantsSheetAll() {
  const spreadsheetId = process.env.SHEET_ID;
  if (!spreadsheetId) throw new Error("SHEET_ID missing");
  const auth = serviceAuth();
  const sheets = google.sheets({ version: "v4", auth });

  // Read a wide range to include added columns (A:ZZ)
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Tenants!A1:ZZ10000",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = data.values || [];
  const headers = rows[0] || [];
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
  const items = rows.slice(1).map((r) => {
    const get = (k) => (idx[k] != null ? (r[idx[k]] ?? "") : "");
    const obj = {};
    headers.forEach((h) => (obj[h] = get(h)));
    return obj;
  });
  return { headers, items };
}

function parseJSONSafe(s) {
  if (!s) return null;
  try { return JSON.parse(String(s)); } catch { return null; }
}

// Concatenate kb_json, kb_json_1, kb_json_2 … into one big string and parse
function reassembleKbJson(headers, rowObj) {
  const kbCols = headers
    .filter((h) => /^kb_json(_\d+)?$/i.test(h))
    .sort((a, b) => {
      const na = a === "kb_json" ? 0 : parseInt(a.split("_")[2] || a.split("_")[1] || "0", 10);
      const nb = b === "kb_json" ? 0 : parseInt(b.split("_")[2] || b.split("_")[1] || "0", 10);
      return na - nb;
    });

  const parts = kbCols.map((h) => String(rowObj[h] || ""));
  const joined = parts.join("");
  const kb = parseJSONSafe(joined) || parseJSONSafe(rowObj.kb_json) || {};
  return kb;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ ok: false, error: "GET only" });
    }

    const { tenant, token } = req.query || {};
    const validT = verifyToken(token);
    if (validT !== tenant) {
      return res.status(401).json({ ok: false, error: "invalid token" });
    }

    const { headers, items } = await readTenantsSheetAll();
    const row = items.find((r) => String(r.tenant_id) === String(tenant));
    if (!row) return res.status(404).json({ ok: false, error: "not found" });

    const payload = {
      tenant_id: row.tenant_id || "",
      company_id: row.company_id || "",
      company_name: row.company_name || "",
      domain: row.domain || "",
      homepage_url: row.homepage_url || "",
      kb_version: row.kb_version || "",
      demo_url: row.demo_url || "",
      kb_sources: parseJSONSafe(row.kb_sources_json) || [],
      kb_json: reassembleKbJson(headers, row),
      company_system_prompt: row.company_system_prompt || "",
      updated_at: row.updated_at || "",
    };

    return res.status(200).json({ ok: true, tenant: payload });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "sheet_read_failed",
      detail: String(e?.message || e),
    });
  }
};
