// /api/tenantGet.js
// Reassembles kb_json split across kb_json, kb_json_1..n with robust salvage.
// Add ?debug=1 to see parse diagnostics.

module.exports.config = { runtime: "nodejs" };

const crypto = require("node:crypto");
const { google } = require("googleapis");

// ---------- token verify ----------
function verifyToken(token) {
  if (!token) return null;
  const [tenant, expStr, sig] = String(token).split(".");
  const exp = parseInt(expStr, 10);
  if (!tenant || !exp || exp < Math.floor(Date.now() / 1000)) return null;
  const raw = `${tenant}.${exp}.${process.env.DEMO_SECRET}`;
  const chk = crypto.createHash("sha256").update(raw).digest("base64url");
  return chk === sig ? tenant : null;
}

// ---------- Google Sheets ----------
function serviceAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!email || !key) throw new Error("Google SA missing");
  key = key.replace(/\\n/g, "\n");
  return new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}
async function readSheet() {
  const spreadsheetId = process.env.SHEET_ID;
  if (!spreadsheetId) throw new Error("SHEET_ID missing");
  const auth = serviceAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Tenants!A1:ZZ100000",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const values = data.values || [];
  const headers = values[0] || [];
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
  const rows = values.slice(1).map((r) => {
    const o = {};
    headers.forEach((h) => (o[h] = idx[h] != null ? (r[idx[h]] ?? "") : ""));
    return o;
  });
  return { headers, rows };
}

// ---------- JSON parsing helpers ----------
function parseJSONSafe(s) {
  if (s == null) return null;
  try { return JSON.parse(String(s)); } catch { return null; }
}
function hardClean(str) {
  return String(str || "")
    .replace(/^\uFEFF/, "")                // BOM
    .replace(/\u0000/g, "")                // nulls
    .replace(/\u201C|\u201D/g, '"')        // curly double
    .replace(/\u2018|\u2019/g, "'")        // curly single
    .replace(/\r/g, "");
}
function unwrapIfDoubleEncoded(s) {
  // If the whole thing is a JSON string containing JSON, parse twice
  const first = parseJSONSafe(s);
  if (typeof first === "string") {
    const second = parseJSONSafe(first);
    if (second && typeof second === "object") return second;
  }
  return null;
}
function extractBracedJSON(s) {
  // Grab substring from first "{" to last "}" (common when commas/notes are around)
  const start = s.indexOf("{");
  const end   = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sub = s.slice(start, end + 1);
    const obj = parseJSONSafe(sub);
    if (obj && typeof obj === "object") return obj;
  }
  return null;
}

// Concatenate parts in numeric order and salvage
function reassembleKb(headers, row) {
  const cols = headers
    .filter((h) => /^kb_json(?:_\d+)?$/i.test(h))
    .sort((a, b) => {
      const na = a === "kb_json" ? 0 : parseInt(a.split("_")[2] || a.split("_")[1] || "0", 10);
      const nb = b === "kb_json" ? 0 : parseInt(b.split("_")[2] || b.split("_")[1] || "0", 10);
      return na - nb;
    });

  const parts = cols.map((c) => String(row[c] || ""));
  const joinedRaw = parts.join("");
  const joined = hardClean(joinedRaw).trim();

  // Attempt 1: parse as-is
  let kb = parseJSONSafe(joined);

  // Attempt 2: double-encoded (a big quoted string that contains JSON)
  if (!kb) kb = unwrapIfDoubleEncoded(joined);

  // Attempt 3: extract from first "{" to last "}"
  if (!kb) kb = extractBracedJSON(joined);

  // Attempt 4: last resort — try the single kb_json cell only
  if (!kb || typeof kb !== "object") kb = parseJSONSafe(hardClean(row.kb_json));

  // Keep object or empty
  if (!kb || typeof kb !== "object") kb = {};

  return {
    kb,
    kb_parts: cols,
    kb_joined_len: joined.length,
  };
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") return res.status(405).json({ ok:false, error:"GET only" });

    const { tenant, token, debug } = req.query || {};
    const v = verifyToken(token);
    if (v !== tenant) return res.status(401).json({ ok:false, error:"invalid token" });

    const { headers, rows } = await readSheet();
    const row = rows.find((r) => String(r.tenant_id) === String(tenant));
    if (!row) return res.status(404).json({ ok:false, error:"not found" });

    const { kb, kb_parts, kb_joined_len } = reassembleKb(headers, row);

    const payload = {
      tenant_id: row.tenant_id || "",
      company_id: row.company_id || "",
      company_name: row.company_name || "",
      domain: row.domain || "",
      homepage_url: row.homepage_url || "",
      kb_version: row.kb_version || "",
      demo_url: row.demo_url || "",
      kb_sources: (() => { try { return JSON.parse(row.kb_sources_json || "[]"); } catch { return []; } })(),
      kb_json: kb,
      company_system_prompt: row.company_system_prompt || "",
      updated_at: row.updated_at || "",
    };

    if (debug) {
      const sections = kb && kb.sections ? kb.sections : {};
      return res.status(200).json({
        ok: true,
        tenant: payload,
        _debug: {
          kb_parts,
          kb_joined_len,
          sections_keys: Object.keys(sections),
          sections_counts: Object.fromEntries(
            Object.entries(sections).map(([k,v]) => [k, Array.isArray(v) ? v.length : 0])
          ),
        },
      });
    }

    return res.status(200).json({ ok:true, tenant: payload });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
};
