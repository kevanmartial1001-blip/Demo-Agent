// api/tenantGet.js
// Returns the stored tenant (KB, prompt, etc.) for UI grounding.

module.exports.config = { runtime: "nodejs20.x" }; // ensure Node runtime (crypto OK)

const { openTenantsSheet } = require('./_lib/sheets');
const crypto = require('node:crypto');

function verify(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [tenant, expStr, sig] = parts;
  const exp = parseInt(expStr, 10);
  if (!tenant || Number.isNaN(exp) || exp < Math.floor(Date.now() / 1000)) return null;

  // Dev-safe: if DEMO_SECRET is missing, accept token (testing only).
  if (!process.env.DEMO_SECRET) return tenant;

  const raw = `${tenant}.${exp}.${process.env.DEMO_SECRET}`;
  const chk = crypto.createHash('sha256').update(raw).digest('base64url');
  return chk === sig ? tenant : null;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ ok:false, error:'GET only' });
    return;
  }
  try {
    const q = req.query || {};
    const tenant = q.tenant || q.tenant_id || '';
    const token  = q.token  || '';

    const v = verify(token);
    if (v !== tenant) { res.status(401).json({ ok:false, error:'invalid token' }); return; }

    let sheet;
    try {
      sheet = await openTenantsSheet();
    } catch (e) {
      return res.status(500).json({ ok:false, error:'sheet_open_failed', detail: String(e?.message || e) });
    }

    let rows;
    try {
      rows = await sheet.getRows({ query: `tenant_id = "${tenant}"` });
    } catch (e) {
      return res.status(500).json({ ok:false, error:'sheet_query_failed', detail: String(e?.message || e) });
    }

    if (!rows.length) { res.status(404).json({ ok:false, error:'not_found' }); return; }

    const r = rows[0];
    const safeParse = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };

    const payload = {
      tenant_id: r.get('tenant_id'),
      company_id: r.get('company_id'),
      company_name: r.get('company_name'),
      domain: r.get('domain'),
      homepage_url: r.get('homepage_url'),
      kb_version: r.get('kb_version'),
      kb_sources: safeParse(r.get('kb_sources_json'), []),
      kb_json:    safeParse(r.get('kb_json'), {}),
      company_system_prompt: r.get('company_system_prompt'),
      updated_at: r.get('updated_at'),
    };

    res.status(200).json({ ok:true, tenant: payload });
  } catch (e) {
    console.error('tenantGet crash:', e);
    res.status(500).json({ ok:false, error:'server_error', detail: String(e?.message || e) });
  }
};
