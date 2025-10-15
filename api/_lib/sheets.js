// api/_lib/sheets.js
// Google Sheets helper — ensures a "Tenants" sheet with expected headers.

const { GoogleSpreadsheet } = require('google-spreadsheet');

async function openTenantsSheet() {
  const doc = new GoogleSpreadsheet(process.env.SHEET_ID);
  await doc.useServiceAccountAuth({
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n'),
  });
  await doc.loadInfo();

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
        // 👇 NEW: store a ready-to-click demo link
        'demo_url',
        // keep JSON fields after the link column
        'kb_sources_json',
        'kb_json',
        'company_system_prompt',
        'created_at',
        'updated_at',
      ],
    });
  } else {
    // Ensure header contains demo_url (if sheet existed before this change)
    await sheet.loadHeaderRow();
    const headers = sheet.headerValues || [];
    if (!headers.includes('demo_url')) {
      const insertAt = headers.indexOf('kb_sources_json');
      const newHeaders = headers.slice();
      // insert 'demo_url' before 'kb_sources_json'
      const pos = insertAt >= 0 ? insertAt : headers.length;
      newHeaders.splice(pos, 0, 'demo_url');
      await sheet.setHeaderRow(newHeaders);
    }
  }

  return sheet;
}

module.exports = { openTenantsSheet };
