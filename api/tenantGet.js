// api/tenantGet.js
// Returns the stored tenant (KB, prompt, etc.) for UI grounding.
// DEV build: token validated by format + expiry + tenant match (signature ignored).

module.exports.config = { runtime: "nodejs20.x" }; // <-- Force Node runtime so ./_lib/sheets works

const { openTenantsSheet } = require('./_lib/sheets');

// Simple dev validator: "<tenant>.<exp>.<sig>" with exp in the future, tenant must match.
function verifyDev({ token, tenant }) {
  if (!token || !tenant) return false;
  const parts = String(token).split('.');
  if (parts.length !== 3) return false;
  const [tFromToken, expStr /*, sig*/] = parts;
  const exp = parseInt(expStr, 10);
  if (!tFromToken || tFromToken !== tenant) return false;
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  return true;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ ok:false, error:'GET only' }); return;
  }

  try {
    const q = req.query || {};
    const tenant = q.tenant || q.tenant_id || '';
    const token  = q.token  || '';

    if (!verifyDev({ token, tenant })) {
      res.status(401).json({ ok:false, error:'invalid token' }); return;
    }

    // Open sheet
    let sheet;
    try {
      sheet = await openTenantsSheet();
    } catch (e) {
      res.status(500).json({ ok:false, error:'sheet_open_failed', detail: String(e?.message || e) }); return;
    }

    // Query by tenant_id
    let rows;
    try {
      rows = await sheet.getRows({ query: `tenant_id = "${tenant}"` });
    } catch (e) {
      res.status(500).json({ ok:false, error:'sheet_query_failed', detail: String(e?.message || e) }); return;
    }

    if (!rows || !rows.length) {
      res.status(404).json({ ok:false, error:'not_found' }); return;
    }

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
