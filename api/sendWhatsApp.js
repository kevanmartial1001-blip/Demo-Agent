// /api/sendWhatsApp.js
module.exports.config = { runtime: 'nodejs18.x' };

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const WHATSAPP_FROM      = process.env.TWILIO_WHATSAPP_FROM; // e.g. 'whatsapp:+14155238886' or your WA-enabled number

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method Not Allowed' });
  try {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !WHATSAPP_FROM) {
      return res.status(500).json({ ok:false, error:'Twilio env vars missing' });
    }
    const { to, body } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!to || !body) return res.status(400).json({ ok:false, error:'to and body required' });

    const form = new URLSearchParams();
    form.set('From', WHATSAPP_FROM);      // must include whatsapp:
    form.set('To', `whatsapp:${to}`);     // e.g. +34XXXXXXXXX
    form.set('Body', body);

    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
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
