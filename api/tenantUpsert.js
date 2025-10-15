// api/tenantUpsert.js
// Upsert a tenant row (latest KB + system prompt) into Google Sheets.
// Accepts `demo_url` and saves it alongside the KB metadata.

const { openTenantsSheet } = require('./_lib/sheets');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'POST only' });
    return;
  }

  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const required = ['tenant_id', 'company_id', 'kb_json', 'company_system_prompt'];
    for (const k of required) {
      if (!b[k]) {
        res.status(400).json({ ok: false, error: `Missing ${k}` });
        return;
      }
    }

    const sheet = await openTenantsSheet();
    await sheet.loadHeaderRow();

    const rows = await sheet.getRows({ query: `tenant_id = "${b.tenant_id}"` });
    const now = new Date().toISOString();

    const payload = {
      tenant_id: b.tenant_id,
      company_id: b.company_id,
      company_name: b.company_name || '',
      domain: b.domain || '',
      homepage_url: b.homepage_url || '',
      kb_version: b.kb_version || '',
      // 👇 NEW: store the signed demo link provided by the workflow
      demo_url: b.demo_url || '',
      kb_sources_json: JSON.stringify(b.kb_sources || []),
      kb_json: typeof b.kb_json === 'string' ? b.kb_json : JSON.stringify(b.kb_json),
      company_system_prompt: b.company_system_prompt,
    };

    if (rows.length) {
      Object.assign(rows[0], payload, { updated_at: now });
      await rows[0].save();
    } else {
      await sheet.addRow({ ...payload, created_at: now, updated_at: now });
    }

    res.status(200).json({ ok: true, tenant_id: b.tenant_id });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
