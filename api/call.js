// /api/call.js
module.exports.config = { runtime: 'nodejs18.x' };

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_CALLER_ID, TWILIO_TWIML_URL } = process.env;
// TWILIO_CALLER_ID: your verified/owned Twilio number, e.g. +12025550123
// TWILIO_TWIML_URL: optional; if set, Twilio will fetch TwiML from here (else we use /api/twiml in this project)

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method Not Allowed' });
  try {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_CALLER_ID) {
      return res.status(500).json({ ok:false, error:'Twilio call env vars missing' });
    }
    const { to, message } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!to) return res.status(400).json({ ok:false, error:'to required' });

    const form = new URLSearchParams();
    form.set('To', to);                         // e.g. +34XXXXXXXXX
    form.set('From', TWILIO_CALLER_ID);
    const twimlUrl = TWILIO_TWIML_URL || `${req.headers['x-forwarded-proto']||'https'}://${req.headers.host}/api/twiml?message=${encodeURIComponent(message||'This is your AI demo call.')} `;
    form.set('Url', twimlUrl);

    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`, {
      method:'POST',
      headers:{ 'Authorization':`Basic ${auth}`, 'Content-Type':'application/x-www-form-urlencoded' },
      body: form
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ ok:false, error:j.message || 'Twilio error' });
    return res.status(200).json({ ok:true, sid:j.sid });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e.message||e) });
  }
};
