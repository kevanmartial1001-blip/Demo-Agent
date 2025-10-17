// /api/tenantGet.js
// Reads a tenant row from Google Sheets, stitches kb_json segment columns, parses JSON, and returns it.
// Runtime: Node 18 on Vercel

module.exports.config = { runtime: "nodejs18.x" };

const { google } = require("googleapis");
const crypto = require("node:crypto");

// ----- token verify (must match /api/demoLink) -----
function verify(token) {
  if (!token) return null;
  const [tenant, expStr, sig] = String(token).split(".");
  const exp = parseInt(expStr, 10);
  if (!tenant || !exp || exp < Math.floor(Date.now() / 1000)) return null;
  const raw = `${tenant}.${exp}.${process.env.DEMO_SECRET}`;
  const chk = crypto.createHash("sha256").update(raw).digest("base64url");
  return chk === sig ? tenant : null;
}

// ----- google sheets helpers -----
function serviceAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!email || !key) {
    const e = new Error("Google service account not configured (env missing)");
    e.code = 500;
    throw e;
  }
  key = key.replace(/\\n/g, "\n"); // Vercel multiline secrets
  return new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

async function openSheets() {
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

// safe JSON.parse
function safeParseJson(raw) {
  if (!raw || typeof raw !== "string") return { ok: false, err: "empty" };
  const cleaned = raw.replace(/^\uFEFF/, "").trim(); // strip BOM + trim
  try {
    const obj = JSON.parse(cleaned);
    return { ok: true, obj };
  } catch (e) {
    return { ok: false, err: String(e?.message || e), rawHead: cleaned.slice(0, 180), rawTail: cleaned.slice(-180) };
  }
}

// derive counts
function sectionCounts(kbJson) {
  const s = kbJson?.sections || {};
  const out = {};
  for (const [k, v] of Object.entries(s)) out[k] = Array.isArray(v) ? v.length : 0;
  return out;
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "GET only" });
  }

  try {
    const { tenant, token, debug } = req.query || {};
    const ok = verify(token);
    if (ok !== tenant) {
      return res.status(401).json({ ok: false, error: "invalid token" });
    }

    const { sheets, spreadsheetId } = await openSheets();

    // Read a generous range so we catch wide KB columns.
    // We’ll use the first sheet (as per your setup).
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const title = meta?.data?.sheets?.[0]?.properties?.title || "Tenants";

    const read = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${title}!A1:ZZZ`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });

    const values = read?.data?.values || [];
    if (values.length < 2) {
      return res.status(404).json({ ok: false, error: "sheet empty" });
    }

    const headers = values[0].map((h) => String(h || "").trim());
    const idx = new Map(headers.map((h, i) => [h, i]));
    if (!idx.has("tenant_id")) {
      return res.status(500).json({ ok: false, error: "tenant_id column not found" });
    }

    // find row
    let row = null;
    for (let r = 1; r < values.length; r++) {
      const line = values[r] || [];
      if ((line[idx.get("tenant_id")] || "") === tenant) {
        row = line;
        break;
      }
    }
    if (!row) {
      return res.status(404).json({ ok: false, error: "not found" });
    }

    // basic fields
    const get = (k) => (idx.has(k) ? (row[idx.get(k)] ?? "") : "");
    const payload = {
      tenant_id: get("tenant_id"),
      company_id: get("company_id"),
      company_name: get("company_name"),
      domain: get("domain"),
      homepage_url: get("homepage_url"),
      kb_version: get("kb_version"),
      demo_url: get("demo_url"),
      kb_sources: (() => {
        const raw = get("kb_sources_json");
        try { return raw ? JSON.parse(String(raw)) : []; } catch { return []; }
      })(),
      company_system_prompt: get("company_system_prompt"),
      updated_at: get("updated_at"),
    };

    // ---- stitch kb_json ----
    const kbCols = headers
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => h === "kb_json" || h.startsWith("kb_json_"))
      .sort((a, b) => {
        if (a.h === "kb_json") return -1;
        if (b.h === "kb_json") return 1;
        // sort kb_json_1, kb_json_2, ...
        const ai = parseInt(a.h.split("_")[2] || a.h.split("_")[1] || "0", 10) || 0;
        const bi = parseInt(b.h.split("_")[2] || b.h.split("_")[1] || "0", 10) || 0;
        return ai - bi;
      });

    const parts = kbCols.map(({ i }) => String(row[i] ?? "")).filter(Boolean);
    const kbJoined = parts.join("");
    let kb_json = {};
    let parseErr = null;

    if (kbJoined && kbJoined.length) {
      const p = safeParseJson(kbJoined);
      if (p.ok) kb_json = p.obj;
      else parseErr = p;
    }

    payload.kb_json = kb_json;

    const out = { ok: true, tenant: payload };
    if (debug) {
      out._debug = {
        kb_parts: kbCols.map(({ h }) => h),
        kb_joined_len: kbJoined.length,
        sections_keys: Object.keys(kb_json?.sections || {}),
        sections_counts: sectionCounts(kb_json),
      };
      if (parseErr) {
        out._debug.parse_error = parseErr.err;
        out._debug.sample_head = parseErr.rawHead;
        out._debug.sample_tail = parseErr.rawTail;
      }
    }

    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
