// api/_lib/sheets.js
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
        'tenant_id','company_id','company_name','domain','homepage_url','kb_version',
        'kb_sources_json','kb_json','company_system_prompt','created_at','updated_at'
      ],
    });
  }
  return sheet;
}

module.exports = { openTenantsSheet };
