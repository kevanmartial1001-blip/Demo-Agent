// tools/email_send.js
// Sends transactional or draft emails through Mailgun, SendGrid, or SMTP.
// Configure one provider by environment vars:
//
// MAIL_PROVIDER = "mailgun" | "sendgrid" | "smtp"
// MAIL_FROM     = "Your Company <no-reply@yourdomain.com>"
// MAILGUN_API_KEY / MAILGUN_DOMAIN
// SENDGRID_API_KEY
// SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS
//
// Input:
//   { to, cc?, bcc?, subject, html, text?, attachments?[] }
// Output:
//   { data:{ id, provider, to, subject }, link? }

import nodemailer from "nodemailer";

export async function run({ input = {}, emit }) {
  const provider = process.env.MAIL_PROVIDER || "mailgun";
  const from = process.env.MAIL_FROM || "AI Assistant <no-reply@example.com>";

  const msg = {
    from,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject || "(no subject)",
    text: input.text || undefined,
    html: input.html || input.text || "<p>(no content)</p>",
    attachments: input.attachments || undefined,
  };

  emit?.({ type: "note", msg: `email_send: sending via ${provider} → ${msg.to}` });

  try {
    let result;

    if (provider === "mailgun") {
      const apiKey = process.env.MAILGUN_API_KEY;
      const domain = process.env.MAILGUN_DOMAIN;
      const r = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`api:${apiKey}`).toString("base64"),
        },
        body: new URLSearchParams({
          from,
          to: msg.to,
          subject: msg.subject,
          text: msg.text || "",
          html: msg.html || "",
        }),
      });
      const j = await r.json().catch(() => ({}));
      result = { id: j.id || null, message: j.message || null };
    }

    else if (provider === "sendgrid") {
      const key = process.env.SENDGRID_API_KEY;
      const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: msg.to }] }],
          from: { email: from },
          subject: msg.subject,
          content: [{ type: "text/html", value: msg.html }],
        }),
      });
      result = { id: r.headers.get("x-message-id") || null };
    }

    else if (provider === "smtp") {
      const transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });
      const info = await transport.sendMail(msg);
      result = { id: info.messageId };
    }

    else {
      throw new Error(`Unsupported provider ${provider}`);
    }

    emit?.({ type: "note", msg: `email_send: sent → ${msg.to}` });
    return {
      data: { provider, id: result?.id || null, to: msg.to, subject: msg.subject },
    };
  } catch (e) {
    const err = String(e?.message || e);
    emit?.({ type: "error", msg: "email_send failed: " + err });
    return { data: { error: err } };
  }
}
