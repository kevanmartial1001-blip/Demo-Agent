// /api/sendMailgun.js
module.exports.config = { runtime: "nodejs18.x" };

const MG_API_KEY  = process.env.MAILGUN_API_KEY;   // must start with "key-"
const MG_DOMAIN   = process.env.MAILGUN_DOMAIN;    // e.g. sandboxxxxxx.mailgun.org
const MG_FROM_ENV = process.env.MAILGUN_FROM;      // e.g. "Your AI Employee <postmaster@...>"
const MG_BASE_URL = process.env.MAILGUN_BASE_URL || "https://api.mailgun.net"; // EU: https://api.eu.mailgun.net

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

  if (!MG_API_KEY || !MG_DOMAIN) {
    return res.status(500).json({ ok:false, error:"Missing MAILGUN_API_KEY or MAILGUN_DOMAIN" });
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { to, subject, html, text, cc, bcc, replyTo } = body;
    if (!to || !subject || !html) return res.status(400).json({ ok:false, error:"to, subject and html are required" });

    const from = MG_FROM_ENV || `Your AI Employee <postmaster@${MG_DOMAIN}>`;

    const form = new FormData();
    form.append("from", from);
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
      body: form
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      // Bubble up the exact provider error so you see what's wrong from the UI
      return res.status(resp.status).json({ ok:false, error: data?.message || `Mailgun ${resp.status}` });
    }
    return res.status(200).json({ ok:true, id:data?.id || null, message:data?.message || "Queued" });
  } catch (e) {
    console.error("Mailgun error:", e);
    return res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
};
