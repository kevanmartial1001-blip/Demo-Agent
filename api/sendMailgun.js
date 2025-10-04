// /api/sendMailgun.js
// Sends an email via Mailgun. Accepts JSON body:
// { to: "user@example.com", subject: "Hi", html: "<p>Hello</p>", text?: "Hello", cc?: "...", bcc?: "...", replyTo?: "..." }
//
// Required Vercel env vars:
// - MAILGUN_API_KEY
// - MAILGUN_DOMAIN                (e.g. "mg.yourdomain.com" or "sandbox12345.mailgun.org")
// - MAILGUN_FROM                  (e.g. "Your AI Employee <no-reply@yourdomain.com>")
// Optional:
// - MAILGUN_BASE_URL              (default "https://api.mailgun.net"; use "https://api.eu.mailgun.net" for EU region)

module.exports.config = { runtime: "nodejs18.x" };

const MG_API_KEY   = process.env.MAILGUN_API_KEY;
const MG_DOMAIN    = process.env.MAILGUN_DOMAIN;
const MG_FROM      = process.env.MAILGUN_FROM;
const MG_BASE_URL  = process.env.MAILGUN_BASE_URL || "https://api.mailgun.net";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  if (!MG_API_KEY || !MG_DOMAIN || !MG_FROM) {
    return res.status(500).json({
      ok: false,
      error: "Missing MAILGUN_API_KEY, MAILGUN_DOMAIN, or MAILGUN_FROM env var",
    });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const { to, subject, html, text, cc, bcc, replyTo } = body;

    if (!to || !subject || !html) {
      return res.status(400).json({ ok: false, error: "to, subject, and html are required" });
    }

    // Mailgun expects multipart/form-data (FormData available on Node 18+)
    const form = new FormData();
    form.append("from", MG_FROM);
    form.append("to", to);
    if (cc) form.append("cc", cc);
    if (bcc) form.append("bcc", bcc);
    form.append("subject", subject);
    if (text) form.append("text", text);
    form.append("html", html);
    if (replyTo) form.append("h:Reply-To", replyTo);

    const auth = "Basic " + Buffer.from(`api:${MG_API_KEY}`).toString("base64");

    const resp = await fetch(`${MG_BASE_URL}/v3/${MG_DOMAIN}/messages`, {
      method: "POST",
      headers: { Authorization: auth },
      body: form,
    });

    const data = await resp.json();
    if (!resp.ok) {
      return res.status(resp.status).json({ ok: false, error: data.message || "Mailgun error" });
    }

    return res.status(200).json({ ok: true, id: data.id || null, message: data.message || "Queued. Thank you." });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
