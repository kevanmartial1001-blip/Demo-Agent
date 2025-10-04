// /api/sendEmail.js
module.exports.config = { runtime: 'nodejs18.x' };

const nodemailer = require('nodemailer');

const {
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
} = process.env;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method Not Allowed' });
  try {
    if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) {
      return res.status(500).json({ ok:false, error:'SMTP env vars missing' });
    }
    const { to, subject, html } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!to || !subject || !html) return res.status(400).json({ ok:false, error:'to, subject, html required' });

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465, // true for 465, false otherwise
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });

    const info = await transporter.sendMail({
      from: SMTP_FROM,
      to,
      subject,
      html
    });

    return res.status(200).json({ ok:true, id: info.messageId });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e.message||e) });
  }
};
