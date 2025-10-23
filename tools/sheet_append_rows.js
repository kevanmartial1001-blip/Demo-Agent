// tools/sheet_append_rows.js
// UNIVERSAL SHEET APPENDER (Google Sheets, Microsoft Excel, Airtable, Smartsheet, Coda) + Demo
// --------------------------------------------------------------------------------------------
// Auto-detected providers (first match wins; or force with SHEET_PROVIDER):
//   • Google Sheets    → GOOGLE_ACCESS_TOKEN or GOOGLE_SERVICE_ACCOUNT_JSON
//   • Microsoft Excel  → MS_GRAPH_TOKEN or OAUTH_MS_TOKEN
//   • Airtable         → AIRTABLE_API_KEY
//   • Smartsheet       → SMARTSHEET_ACCESS_TOKEN
//   • Coda             → CODA_API_KEY
//
// Common env:
//   SHEET_PROVIDER  = "google"|"excel"|"airtable"|"smartsheet"|"coda"
//   SHEET_DRY_RUN   = "1"
//   SHEET_DEMO      = "1"
//
// Input:
//   {
//     sheetId: string,          // required (or baseId/tableId for Airtable)
//     range?: string,           // optional A1 notation (Google/Excel)
//     rows: Array<Array<any>>,  // required rows of data to append
//     table?: string,           // optional (Airtable/Coda)
//   }
//
// Output:
//   { data: { provider, inserted?: number, link?: string, status?: string }, link?: string }

const DRY_RUN = String(process.env.SHEET_DRY_RUN || "") === "1";
const DEMO = String(process.env.SHEET_DEMO || "") === "1";

function detectProvider() {
  const forced = (process.env.SHEET_PROVIDER || "").toLowerCase().trim();
  if (forced) return forced;
  if (process.env.GOOGLE_ACCESS_TOKEN || process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return "google";
  if (process.env.MS_GRAPH_TOKEN || process.env.OAUTH_MS_TOKEN) return "excel";
  if (process.env.AIRTABLE_API_KEY) return "airtable";
  if (process.env.SMARTSHEET_ACCESS_TOKEN) return "smartsheet";
  if (process.env.CODA_API_KEY) return "coda";
  return null;
}

function emitNote(emit, msg) { try { emit && emit({ type: "note", msg }); } catch {} }
function emitErr(emit, msg) { try { emit && emit({ type: "error", msg }); } catch {} }
function toJSON(o) { return JSON.stringify(o, null, 2); }

// -------------- GOOGLE SHEETS --------------
async function viaGoogle({ sheetId, range, rows }) {
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  if (!token) throw new Error("Missing GOOGLE_ACCESS_TOKEN");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(
    range || "Sheet1"
  )}:append?valueInputOption=USER_ENTERED`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: rows }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Google Sheets HTTP ${r.status}`);
  return { inserted: j.updates?.updatedRows || rows.length, link: `https://docs.google.com/spreadsheets/d/${sheetId}`, status: "appended" };
}

// -------------- MICROSOFT EXCEL --------------
async function viaExcel({ sheetId, rows }) {
  const token = process.env.MS_GRAPH_TOKEN || process.env.OAUTH_MS_TOKEN;
  if (!token) throw new Error("Missing MS_GRAPH_TOKEN");
  const r = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${sheetId}/workbook/tables/Table1/rows/add`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: rows }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Excel HTTP ${r.status}`);
  return { inserted: rows.length, link: j.webUrl, status: "appended" };
}

// -------------- AIRTABLE --------------
async function viaAirtable({ sheetId, table, rows }) {
  const key = process.env.AIRTABLE_API_KEY;
  if (!key) throw new Error("Missing AIRTABLE_API_KEY");
  const url = `https://api.airtable.com/v0/${sheetId}/${encodeURIComponent(table || "Table 1")}`;
  const body = { records: rows.map(r => ({ fields: Object.fromEntries(r.map((v, i) => [`Col${i + 1}`, v])) })) };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Airtable HTTP ${r.status}`);
  return { inserted: j.records?.length || rows.length, link: `https://airtable.com/${sheetId}`, status: "appended" };
}

// -------------- SMARTSHEET --------------
async function viaSmartsheet({ sheetId, rows }) {
  const token = process.env.SMARTSHEET_ACCESS_TOKEN;
  if (!token) throw new Error("Missing SMARTSHEET_ACCESS_TOKEN");
  const body = rows.map(r => ({
    toTop: false,
    cells: r.map((v, i) => ({ columnId: i + 1, value: v })),
  }));
  const r = await fetch(`https://api.smartsheet.com/2.0/sheets/${sheetId}/rows`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Smartsheet HTTP ${r.status}`);
  return { inserted: j.result?.length || rows.length, link: j.permalink, status: "appended" };
}

// -------------- CODA --------------
async function viaCoda({ sheetId, table, rows }) {
  const key = process.env.CODA_API_KEY;
  if (!key) throw new Error("Missing CODA_API_KEY");
  const url = `https://coda.io/apis/v1/docs/${sheetId}/tables/${encodeURIComponent(table || "Table 1")}/rows`;
  const body = { rows: rows.map(r => ({ cells: r.map((v, i) => ({ column: `Col${i + 1}`, value: v })) })) };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Coda HTTP ${r.status}`);
  return { inserted: j.rows?.length || rows.length, link: `https://coda.io/d/${sheetId}`, status: "appended" };
}

// -------------- MAIN ENTRY --------------
export async function run({ input = {}, emit }) {
  const provider = detectProvider();
  const { sheetId, rows } = input;

  if (!sheetId || !Array.isArray(rows)) {
    emitErr(emit, "sheet_append_rows: sheetId and rows[] are required");
    return { data: { error: "missing_fields" } };
  }

  if (DRY_RUN) {
    emitNote(emit, `sheet_append_rows[DRY_RUN]: provider=${provider || "n/a"} rows=${rows.length}`);
    return { data: { provider: provider || "dry-run", status: "dry-run" } };
  }

  if (!provider) {
    if (DEMO) {
      emitNote(emit, "sheet_append_rows[DEMO]: returning fake append");
      return {
        data: { provider: "demo", inserted: rows.length, link: "about:blank#demo-sheet", status: "appended" },
        link: "about:blank#demo-sheet",
      };
    }
    emitErr(emit, "sheet_append_rows: no provider configured.");
    return { data: { error: "no_provider_configured" } };
  }

  emitNote(emit, `sheet_append_rows: via ${provider} → ${rows.length} rows`);
  try {
    let out;
    switch (provider) {
      case "google": out = await viaGoogle(input); break;
      case "excel": out = await viaExcel(input); break;
      case "airtable": out = await viaAirtable(input); break;
      case "smartsheet": out = await viaSmartsheet(input); break;
      case "coda": out = await viaCoda(input); break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return { data: { provider, inserted: out?.inserted || 0, link: out?.link, status: out?.status || "appended" }, link: out?.link };
  } catch (e) {
    const err = String(e?.message || e);
    emitErr(emit, `sheet_append_rows failed: ${err}`);
    return { data: { error: err, provider } };
  }
}
