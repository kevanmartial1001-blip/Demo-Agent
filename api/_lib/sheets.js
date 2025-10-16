// api/_lib/sheets.js
// Google Sheets helper (Tenants tab) using official googleapis client.
// Env required:
//   SHEET_ID
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_SERVICE_ACCOUNT_KEY   (private key; literal \n allowed; we normalize)
// Optional:
//   SHEET_TAB (default: "Tenants")

const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

function normalizeKey(k) {
  return String(k || '').replace(/\\n/g, '\n');
}

async function makeClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = normalizeKey(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  if (!email) throw new Error('Missing env GOOGLE_SERVICE_ACCOUNT_EMAIL');
  if (!key) throw new Error('Missing env GOOGLE_SERVICE_ACCOUNT_KEY');

  const auth = new google.auth.JWT({
    email,
    key,
    scopes: SCOPES,
  });
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

function wrapRows(headers, dataRows) {
  // Returns an array of row-like objects with .get(colName)
  const rows = (dataRows || []).map((arr) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = arr[i] ?? ''; });
    return {
      get: (k) => obj[k],
      _raw: obj
    };
  });
  rows.headerValues = headers;
  return rows;
}

function parseQueryEq(query) {
  // supports: tenant_id = "value"   (with optional spaces)
  const m = /^\s*([a-zA-Z0-9_]+)\s*=\s*"(.*)"\s*$/.exec(String(query || ''));
  if (!m) return null;
  return { key: m[1], value: m[2] };
}

async function openTenantsSheet() {
  const SHEET_ID = process.env.SHEET_ID;
  const TAB = process.env.SHEET_TAB || 'Tenants';
  if (!SHEET_ID) throw new Error('Missing env SHEET_ID');

  const client = await makeClient();

  // Get header row
  const headerResp = await client.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!1:1`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const headers = (headerResp.data.values && headerResp.data.values[0]) || [];
  if (!headers.length) {
    throw new Error(`Worksheet "${TAB}" has no header row`);
  }

  // Lazy data loader so health can just open without loading all rows
  async function loadAllRows() {
    const dataResp = await client.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${TAB}!A2:ZZ`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    return wrapRows(headers, dataResp.data.values || []);
  }

  // Provide a minimal sheet-ish API we need downstream
  const sheet = {
    title: TAB,
    headerValues: headers,
    async getRows({ query } = {}) {
      const rows = await loadAllRows();
      if (!query) return rows;

      const q = parseQueryEq(query);
      if (!q) return rows; // unsupported query -> return all

      return rows.filter(r => String(r.get(q.key) || '') === q.value);
    }
  };

  return sheet;
}

module.exports = { openTenantsSheet };
