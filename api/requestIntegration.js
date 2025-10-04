// /api/requestIntegration.js
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    console.log('REQUEST_INTEGRATION', {
      when: new Date().toISOString(),
      name: body.name||'', email: body.email||'', company: body.company||'',
      note: body.note||'', intent: body.intent||'', trace_id: body.trace_id||''
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
