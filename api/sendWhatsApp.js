// /api/sendWhatsApp.js
module.exports.config = { runtime: 'nodejs18.x' };

const SID  = process.env.TWILIO_ACCOUNT_SID;
const TOK  = process.env.TWILIO_AUTH_TOKEN;
const FROM = process.env.TWILIO_WHATSAPP_FROM; // MUST be like "whatsapp:+14155238886"

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method Not Allowed' });
  if (!SID || !TOK || !FROM) return res.status(500).json({ ok:false, error:'Twilio env vars missing' });
  try {
    const { to, body } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    if (!to || !body) return res.status(400).json({ ok:false, error:'to and body required' });

    const form = new URLSearchParams();
    form.set('From', FROM);
    form.set('To', `whatsapp:${to}`);
    form.set('Body', body);

    const auth = Buffer.from(`${SID}:${TOK}`).toString('base64');
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
      method:'POST',
      headers:{ 'Authorization':`Basic ${auth}`, 'Content-Type':'application/x-www-form-urlencoded' },
      body: form
    });
    const j = await r.json();
    if (!r.ok) {
      // Twilio returns a very clear "message" and "code" – show both
      return res.status(r.status).json({ ok:false, error: `${j.message || 'Twilio error'} (code ${j.code || 'unknown'})` });
    }
    return res.status(200).json({ ok:true, sid:j.sid });
  } catch (e) {
    console.error('Twilio WA error:', e);
    return res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
};
