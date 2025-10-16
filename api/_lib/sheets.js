// api/_lib/sheets.js
// Google Sheets helper — ensures a "Tenants" sheet with expected headers.
// Uses the `google-spreadsheet` package with a service account.

const { GoogleSpreadsheet } = require('google-spreadsheet');

function normalizeKey(k) {
  // Your env is GOOGLE_SERVICE_ACCOUNT_KEY (with \n). Convert to real newlines.
  return String(k || '').replace(/\\n/g, '\n');
}

async function openTenantsSheet() {
  const SHEET_ID = process.env.SHEET_ID;
  const EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const KEY = normalizeKey(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);

  if (!SHEET_ID) throw new Error('Missing env SHEET_ID');
  if (!EMAIL)    throw new Error('Missing env GOOGLE_SERVICE_ACCOUNT_EMAIL');
  if (!KEY)      throw new Error('Missing env GOOGLE_SERVICE_ACCOUNT_KEY');

  const doc = new GoogleSpreadsheet(SHEET_ID);
  await doc.useServiceAccountAuth({ client_email: EMAIL, private_key: KEY });
  await doc.loadInfo();

  // Your tab name is "Tenants" (capital T)
  let sheet = doc.sheetsByTitle['Tenants'];
  if (!sheet) {
    sheet = await doc.addSheet({
      title: 'Tenants',
      headerValues: [
        'tenant_id',
        'company_id',
        'company_name',
        'domain',
        'homepage_url',
        'kb_version',
        'demo_url',                // ready-to-click demo link
        'kb_sources_json',
        'kb_json',
        'company_system_prompt',
        'created_at',
        'updated_at',
      ],
    });
  } else {
    // Ensure header contains demo_url even for older sheets
    await sheet.loadHeaderRow();
    const headers = sheet.headerValues || [];
    if (!headers.includes('demo_url')) {
      const insertAt = headers.indexOf('kb_sources_json');
      const newHeaders = headers.slice();
      const pos = insertAt >= 0 ? insertAt : headers.length;
      newHeaders.splice(pos, 0, 'demo_url');
      await sheet.setHeaderRow(newHeaders);
    }
  }

  // Provide a familiar getRows({ query }) API (google-spreadsheet v4 supports it)
  return sheet;
}

module.exports = { openTenantsSheet };
