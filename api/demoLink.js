// api/demoLink.js
module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ ok:false, error:'GET only' }); return; }
  const { tenant_id, ttl = '120' } = req.query || {};
  if (!tenant_id) { res.status(400).json({ ok:false, error:'tenant_id required' }); return; }

  const exp = Math.floor(Date.now()/1000) + parseInt(ttl,10)*60;
  const raw = `${tenant_id}.${exp}.${process.env.DEMO_SECRET}`;
  const cryptoMod = await import('node:crypto');
  const sig = cryptoMod.createHash('sha256').update(raw).digest('base64url');

  const token = `${tenant_id}.${exp}.${sig}`;
  const url = `${process.env.BASE_URL}/demo?tenant=${encodeURIComponent(tenant_id)}&token=${encodeURIComponent(token)}`;
  res.status(200).json({ ok:true, url, token });
};
