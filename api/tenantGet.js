// api/tenantGet.js
const { openTenantsSheet } = require('./_lib/sheets');
const crypto = require('node:crypto');

function verify(token) {
  if (!token) return null;
  const [tenant, expStr, sig] = token.split('.');
  const exp = parseInt(expStr, 10);
  if (!tenant || !exp || exp < Math.floor(Date.now()/1000)) return null;
  const raw = `${tenant}.${exp}.${process.env.DEMO_SECRET}`;
  const chk = crypto.createHash('sha256').update(raw).digest('base64url');
  return chk === sig ? tenant : null;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ ok:false, error:'GET only' }); return; }
  try {
    const { tenant, token } = req.query || {};
    const ok = verify(token);
    if (ok !== tenant) { res.status(401).json({ ok:false, error:'invalid token' }); return; }

    const sheet = await openTenantsSheet();
    const rows = await sheet.getRows({ query: `tenant_id = "${tenant}"` });
    if (!rows.length) { res.status(404).json({ ok:false, error:'not found' }); return; }

    const r = rows[0];
    const payload = {
      tenant_id: r.get('tenant_id'),
      company_id: r.get('company_id'),
      company_name: r.get('company_name'),
      domain: r.get('domain'),
      homepage_url: r.get('homepage_url'),
      kb_version: r.get('kb_version'),
      kb_sources: JSON.parse(r.get('kb_sources_json') || '[]'),
      kb_json: JSON.parse(r.get('kb_json') || '{}'),
      company_system_prompt: r.get('company_system_prompt'),
      updated_at: r.get('updated_at'),
    };
    res.status(200).json({ ok:true, tenant: payload });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
};
