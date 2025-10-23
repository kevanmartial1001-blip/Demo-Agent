// tools/email_send.js
// UNIVERSAL EMAIL SENDER (multi-provider, version-agnostic)
// --------------------------------------------------------
// Supported providers (auto-detected via env; first match wins):
//   • Mailgun            → MAILGUN_API_KEY, MAILGUN_DOMAIN
//   • SendGrid           → SENDGRID_API_KEY
//   • Postmark           → POSTMARK_API_TOKEN
//   • Resend             → RESEND_API_KEY
//   • AWS SES (HTTPS)    → AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION (and allow SES in that region)
//   • Microsoft Graph    → MS_GRAPH_TOKEN  (mail.send scope)
//   • Gmail API          → GMAIL_ACCESS_TOKEN  (gmail.send scope)
//   • Brevo/Sendinblue   → BREVO_API_KEY
//   • SMTP (fallback)    → SMTP_HOST, SMTP_USER, SMTP_PASS  [Node runtime only; not Edge-compatible]
//
// Optional common env:
//   MAIL_FROM       = "Your Brand <no-reply@yourdomain.com>"
//   MAIL_PROVIDER   = force a provider ("mailgun"|"sendgrid"|...)
//   MAIL_REPLY_TO   = default reply-to (overridable by input.reply_to)
//   MAIL_DRY_RUN    = "1"  -> logs only; no external call
//   MAIL_DEMO       = "1"  -> return a mocked success for demos when no provider is set
//
// Input:
//   {
//     to: string | string[],
//     cc?: string|string[],
//     bcc?: string|string[],
//     subject: string,
//     html?: string,
//     text?: string,
//     reply_to?: string,
//     attachments?: Array<{
//       filename?: string,
//       mime?: string,
//       encoding?: "base64" | "utf8",
//       content?: string,     // base64 or utf8 (based on `encoding`)
//       url?: string          // remote file to fetch and attach
//     }>
//   }
//
// Output:
//   { data: { provider, id?: string|null, to: string|string[], subject }, link?: string }
//
// Notes:
//   • Designed for Node runtime (Edge-safe for all HTTP providers except SMTP).
//   • If you must run in Edge, avoid SMTP (it requires TCP sockets / nodemailer).
//   • “Demo mode” returns a fake id so you can show end-to-end UX before wiring creds.

const DRY_RUN  = String(process.env.MAIL_DRY_RUN || "") === "1";
const DEMO_MODE = String(process.env.MAIL_DEMO || "") === "1";

function arr(v) { return !v ? [] : Array.isArray(v) ? v : [v]; }
function commaList(v){ return arr(v).join(", "); }

function pickProvider() {
  const forced = (process.env.MAIL_PROVIDER || "").toLowerCase().trim();
  if (forced) return forced;

  if (process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN) return "mailgun";
  if (process.env.SENDGRID_API_KEY)                                return "sendgrid";
  if (process.env.POSTMARK_API_TOKEN)                              return "postmark";
  if (process.env.RESEND_API_KEY)                                  return "resend";
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_REGION) return "ses";
  if (process.env.MS_GRAPH_TOKEN)                                  return "msgraph";
  if (process.env.GMAIL_ACCESS_TOKEN)                              return "gmail";
  if (process.env.BREVO_API_KEY)                                   return "brevo";
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) return "smtp";
  return null;
}

function stripHtml(html = "") {
  return html
    .replace(/<\/(style|script)>/gi, "\n")
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function escapeHtml(s = "") {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function parseAddress(str) {
  // "Name <email@x.com>" → { email, name? }
  if (!str) return {};
  const m = String(str).match(/^(.*)<([^>]+)>$/);
  if (m) return { email: m[2].trim(), name: m[1].trim().replace(/^"|"$/g, "") || undefined };
  return { email: String(str).trim() };
}

async function normalizeAttachments(atts = []) {
  const out = [];
  for (const a of atts) {
    let { filename, content, encoding, mime, url } = a || {};
    if (!filename) {
      if (url) {
        try { const u = new URL(url); filename = u.pathname.split("/").pop() || "file"; }
        catch { filename = "file"; }
      } else { filename = "file"; }
    }
    let buf;
    if (url) {
      const r = await fetch(url);
      const ab = await r.arrayBuffer();
      buf = Buffer.from(ab);
      if (!mime) mime = r.headers.get("content-type") || "application/octet-stream";
    } else if (typeof content === "string") {
      buf = Buffer.from(content, encoding === "base64" ? "base64" : "utf8");
    } else {
      continue;
    }
    out.push({ filename, buffer: buf, mime: mime || "application/octet-stream" });
  }
  return out;
}

function emitNote(emit, msg){ try { emit && emit({ type:"note", msg }); } catch {} }
function emitWarn(emit, msg){ try { emit && emit({ type:"warn", msg }); } catch {} }
function emitErr(emit, msg){  try { emit && emit({ type:"error", msg }); } catch {} }

// ---------- Provider implementations (HTTP-based) ----------
async function viaMailgun({ from, to, cc, bcc, replyTo, subject, text, html, attachments }) {
  const key = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  const form = new FormData();
  form.set("from", from);
  form.set("to", to);
  if (cc) form.set("cc", cc);
  if (bcc) form.set("bcc", bcc);
  if (replyTo) form.set("h:Reply-To", replyTo);
  form.set("subject", subject);
  if (text) form.set("text", text);
  if (html) form.set("html", html);
  for (const a of attachments) form.append("attachment", new Blob([a.buffer], { type: a.mime }), a.filename);

  const r = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`api:${key}`).toString("base64") },
    body: form,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Mailgun HTTP ${r.status}`);
  return { id: j.id || null };
}

async function viaSendGrid({ from, to, cc, bcc, replyTo, subject, text, html, attachments }) {
  const key = process.env.SENDGRID_API_KEY;
  const body = {
    personalizations: [{
      to: arr(to).map(e => ({ email: e })),
      ...(cc ? { cc: arr(cc).map(e => ({ email: e })) } : {}),
      ...(bcc ? { bcc: arr(bcc).map(e => ({ email: e })) } : {}),
    }],
    from: parseAddress(from),
    subject,
    content: [
      ...(text ? [{ type: "text/plain", value: text }] : []),
      ...(html ? [{ type: "text/html", value: html }] : []),
    ],
    ...(replyTo ? { reply_to: parseAddress(replyTo) } : {}),
  };
  if (attachments?.length) {
    body.attachments = attachments.map(a => ({
      filename: a.filename,
      type: a.mime,
      content: a.buffer.toString("base64"),
      disposition: "attachment",
    }));
  }
  const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type":"application/json" },
    body: JSON.stringify(body),
  });
  const ok = r.ok;
  if (!ok) throw new Error(`SendGrid HTTP ${r.status} ${await r.text().catch(()=> "")}`);
  return { id: r.headers.get("x-message-id") || null };
}

async function viaPostmark({ from, to, cc, bcc, replyTo, subject, text, html, attachments }) {
  const token = process.env.POSTMARK_API_TOKEN;
  const body = {
    From: parseAddress(from).email,
    To: commaList(to),
    Cc: cc || undefined,
    Bcc: bcc || undefined,
    ReplyTo: replyTo || undefined,
    Subject: subject,
    HtmlBody: html || undefined,
    TextBody: text || undefined,
    Attachments: (attachments||[]).map(a=>({
      Name: a.filename,
      Content: a.buffer.toString("base64"),
      ContentType: a.mime
    })),
    MessageStream: "outbound",
  };
  const r = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: { "X-Postmark-Server-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(j.Message || `Postmark HTTP ${r.status}`);
  return { id: j.MessageID || null };
}

async function viaResend({ from, to, cc, bcc, replyTo, subject, text, html, attachments }) {
  const key = process.env.RESEND_API_KEY;
  const body = {
    from,
    to: arr(to),
    cc: cc ? arr(cc) : undefined,
    bcc: bcc ? arr(bcc) : undefined,
    subject,
    text,
    html,
    reply_to: replyTo,
    attachments: (attachments||[]).map(a => ({
      filename: a.filename,
      content: a.buffer.toString("base64"),
    })),
  };
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type":"application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(j.message || `Resend HTTP ${r.status}`);
  return { id: j.id || null, link: j?.data?.url || undefined };
}

async function viaBrevo({ from, to, cc, bcc, replyTo, subject, text, html, attachments }) {
  const key = process.env.BREVO_API_KEY;
  const body = {
    sender: parseAddress(from),
    to: arr(to).map(e=>({ email:e })),
    subject,
    htmlContent: html || undefined,
    textContent: text || undefined,
    ...(replyTo ? { replyTo: parseAddress(replyTo) } : {}),
    ...(cc ? { cc: arr(cc).map(e=>({ email:e })) } : {}),
    ...(bcc ? { bcc: arr(bcc).map(e=>({ email:e })) } : {}),
    attachment: (attachments||[]).map(a=>({
      name: a.filename,
      content: a.buffer.toString("base64")
    })),
  };
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": key, "Content-Type":"application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(j.message || `Brevo HTTP ${r.status}`);
  return { id: j.messageId || j.message || null };
}

async function viaMsGraph({ from, to, cc, bcc, replyTo, subject, text, html, attachments }) {
  const token = process.env.MS_GRAPH_TOKEN; // user-delegated or app+impersonation with Mail.Send
  const body = {
    message: {
      subject,
      body: { contentType: html ? "HTML" : "Text", content: html || text || "" },
      toRecipients: arr(to).map(e=>({ emailAddress:{ address:e }})),
      ...(cc ? { ccRecipients: arr(cc).map(e=>({ emailAddress:{ address:e }})) } : {}),
      ...(bcc ? { bccRecipients: arr(bcc).map(e=>({ emailAddress:{ address:e }})) } : {}),
      ...(replyTo ? { replyTo:[{ emailAddress: parseAddress(replyTo) }]} : {}),
      ...(from ? { from: { emailAddress: parseAddress(from) }} : {}),
      // Attachments (simple file attachments)
      ...(attachments?.length ? {
        attachments: attachments.map(a=>({
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: a.filename,
          contentType: a.mime,
          contentBytes: a.buffer.toString("base64"),
        }))
      } : {})
    },
    saveToSentItems: true
  };
  const r = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type":"application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`MS Graph HTTP ${r.status} ${await r.text().catch(()=> "")}`);
  return { id: null };
}

async function viaGmailApi({ from, to, cc, bcc, replyTo, subject, text, html, attachments }) {
  // Build a raw RFC822 message (base64url) for Gmail send
  const token = process.env.GMAIL_ACCESS_TOKEN;
  const boundary = "mixed_" + Math.random().toString(36).slice(2);
  const lines = [];
  lines.push(`From: ${from}`);
  lines.push(`To: ${commaList(to)}`);
  if (cc)  lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  if (replyTo) lines.push(`Reply-To: ${replyTo}`);
  lines.push(`Subject: ${subject}`);
  lines.push(`MIME-Version: 1.0`);

  if (attachments?.length) {
    lines.push(`Content-Type: multipart/mixed; boundary=${boundary}\n`);
    // body part
    const altBoundary = "alt_" + Math.random().toString(36).slice(2);
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: multipart/alternative; boundary=${altBoundary}\n`);
    if (text) {
      lines.push(`--${altBoundary}`);
      lines.push(`Content-Type: text/plain; charset=UTF-8`);
      lines.push(`\n${text}\n`);
    }
    if (html) {
      lines.push(`--${altBoundary}`);
      lines.push(`Content-Type: text/html; charset=UTF-8`);
      lines.push(`\n${html}\n`);
    }
    lines.push(`--${altBoundary}--`);
    // attachments
    for (const a of attachments) {
      lines.push(`--${boundary}`);
      lines.push(`Content-Type: ${a.mime}; name="${a.filename}"`);
      lines.push(`Content-Transfer-Encoding: base64`);
      lines.push(`Content-Disposition: attachment; filename="${a.filename}"\n`);
      lines.push(a.buffer.toString("base64").replace(/(.{76})/g, "$1\n"));
      lines.push("");
    }
    lines.push(`--${boundary}--`);
  } else if (html) {
    lines.push(`Content-Type: text/html; charset=UTF-8\n`);
    lines.push(html);
  } else {
    lines.push(`Content-Type: text/plain; charset=UTF-8\n`);
    lines.push(text || "");
  }

  const raw = Buffer.from(lines.join("\r\n")).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/,"");

  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type":"application/json" },
    body: JSON.stringify({ raw }),
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(j.error?.message || `Gmail HTTP ${r.status}`);
  return { id: j.id || null };
}

// ---- AWS SigV4 signing (minimal) for SES v2 SendEmail ----
async function viaSes({ from, to, cc, bcc, replyTo, subject, text, html, attachments }) {
  const region = process.env.AWS_REGION;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  // SES v2 endpoint
  const host = `email.${region}.amazonaws.com`;
  const endpoint = `https://${host}/v2/email/outbound-emails`;

  const Content = html ? { Simple: { Subject:{ Data: subject }, Body:{ Html:{ Data: html }, ...(text? { Text:{ Data:text } } : {}) } } }
                       : { Simple: { Subject:{ Data: subject }, Body:{ Text:{ Data: text || "" } } } };

  // Attachments (SES expects base64 content)
  if (attachments?.length) {
    // Switch to Raw email if attachments present
    const boundary = "mime_" + Math.random().toString(36).slice(2);
    const parts = [];
    parts.push(`From: ${from}`);
    parts.push(`To: ${commaList(to)}`);
    if (cc)  parts.push(`Cc: ${cc}`);
    if (bcc) parts.push(`Bcc: ${bcc}`);
    if (replyTo) parts.push(`Reply-To: ${replyTo}`);
    parts.push(`Subject: ${subject}`);
    parts.push(`MIME-Version: 1.0`);
    parts.push(`Content-Type: multipart/mixed; boundary="${boundary}"\n`);

    const altBoundary = "alt_" + Math.random().toString(36).slice(2);
    parts.push(`--${boundary}`);
    parts.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"\n`);
    if (text) {
      parts.push(`--${altBoundary}`);
      parts.push(`Content-Type: text/plain; charset=UTF-8`);
      parts.push(`\n${text}\n`);
    }
    if (html) {
      parts.push(`--${altBoundary}`);
      parts.push(`Content-Type: text/html; charset=UTF-8`);
      parts.push(`\n${html}\n`);
    }
    parts.push(`--${altBoundary}--`);

    for (const a of attachments) {
      parts.push(`--${boundary}`);
      parts.push(`Content-Type: ${a.mime}; name="${a.filename}"`);
      parts.push(`Content-Transfer-Encoding: base64`);
      parts.push(`Content-Disposition: attachment; filename="${a.filename}"\n`);
      parts.push(a.buffer.toString("base64").replace(/(.{76})/g, "$1\n"));
      parts.push("");
    }
    parts.push(`--${boundary}--`);

    const rawData = Buffer.from(parts.join("\r\n")).toString("base64");
    const body = { Content: { Raw: { Data: rawData } }, Destination: { ToAddresses: arr(to) }, FromEmailAddress: parseAddress(from).email, ...(replyTo ? { ReplyToAddresses: [parseAddress(replyTo).email] } : {}) };
    return await sesSignedPost(endpoint, region, accessKeyId, secretAccessKey, body);
  }

  // Simple (no attachments)
  const body = {
    FromEmailAddress: parseAddress(from).email,
    Destination: {
      ToAddresses: arr(to),
      ...(cc ? { CcAddresses: arr(cc) } : {}),
      ...(bcc ? { BccAddresses: arr(bcc) } : {}),
    },
    ...(replyTo ? { ReplyToAddresses: [parseAddress(replyTo).email] } : {}),
    Content
  };
  return await sesSignedPost(endpoint, region, accessKeyId, secretAccessKey, body);
}

async function sesSignedPost(url, region, accessKeyId, secretAccessKey, bodyObj) {
  const service = "ses";
  const amzdate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzdate.slice(0,8);
  const host = new URL(url).host;
  const payload = JSON.stringify(bodyObj);
  const hashedPayload = sha256Hex(payload);

  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-date:${amzdate}\n`;
  const signedHeaders = "content-type;host;x-amz-date";
  const canonicalRequest = `POST\n/v2/email/outbound-emails\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;
  const credentialScope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzdate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;

  const kDate = hmac(`AWS4${secretAccessKey}`, date);
  const kRegion = hmacRaw(kDate, region);
  const kService = hmacRaw(kRegion, service);
  const kSigning = hmacRaw(kService, "aws4_request");
  const signature = hmacHex(kSigning, stringToSign);

  const auth = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type":"application/json", "X-Amz-Date": amzdate, "Authorization": auth },
    body: payload,
  });
  if (!r.ok) throw new Error(`SES HTTP ${r.status} ${await r.text().catch(()=> "")}`);
  const j = await r.json().catch(()=> ({}));
  return { id: j?.MessageId || null };
}

// Tiny SHA256/HMAC helpers using Web Crypto if available
function toUint8(s){ return new TextEncoder().encode(s); }
function hex(buf){ return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join(""); }
function isWebCrypto(){ return typeof crypto !== "undefined" && crypto.subtle; }

function sha256Hex(s){
  if (isWebCrypto()) return crypto.subtle.digest("SHA-256", toUint8(s)).then(hexSync => hex(hexSync));
  const { createHash } = require("crypto"); return createHash("sha256").update(s, "utf8").digest("hex");
}
function hmacRaw(key, data){
  if (isWebCrypto()) { /* not used directly */ }
  const { createHmac } = require("crypto"); return createHmac("sha256", key).update(data, "utf8").digest();
}
function hmac(key, data){
  const { createHmac } = require("crypto"); return createHmac("sha256", key).update(data, "utf8").digest();
}
function hmacHex(key, data){
  const { createHmac } = require("crypto"); return createHmac("sha256", key).update(data, "utf8").digest("hex");
}

// ---------- SMTP (Node only; not for Edge) ----------
async function viaSmtp({ from, to, cc, bcc, replyTo, subject, text, html, attachments }) {
  let nodemailer;
  try {
    nodemailer = (await import("nodemailer")).default;
  } catch {
    throw new Error("SMTP requires 'nodemailer' (install in Node runtime).");
  }
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const info = await transport.sendMail({
    from, to, cc, bcc, subject, replyTo,
    text, html,
    attachments: (attachments||[]).map(a=>({ filename:a.filename, content:a.buffer, contentType:a.mime })),
  });
  return { id: info.messageId || null };
}

// ---------------------- MAIN ENTRY ----------------------
export async function run({ input = {}, emit }) {
  const provider = pickProvider();
  const from = process.env.MAIL_FROM || "AI Assistant <no-reply@example.com>";
  const replyToDefault = process.env.MAIL_REPLY_TO || null;

  const to = commaList(input.to);
  const cc = input.cc ? commaList(input.cc) : undefined;
  const bcc = input.bcc ? commaList(input.bcc) : undefined;
  const replyTo = input.reply_to || replyToDefault || undefined;

  if (!to) {
    emitErr(emit, "email_send: 'to' is required");
    return { data: { error: "'to' is required" } };
  }

  const subject = input.subject || "(no subject)";
  const html = input.html || (input.text ? `<pre>${escapeHtml(input.text)}</pre>` : "<p>(no content)</p>");
  const text = input.text || stripHtml(html);
  const attachments = await normalizeAttachments(input.attachments || []);

  // DEMO / DRY RUN shortcuts
  if (DRY_RUN) {
    emitNote(emit, `email_send[DRY_RUN]: provider=${provider || "n/a"} to=${to} subject="${subject}"`);
    return { data: { provider: provider || "dry-run", id: null, to, subject }, link: undefined };
  }
  if (!provider) {
    if (DEMO_MODE) {
      const fake = "demo_" + Math.random().toString(36).slice(2,10);
      emitNote(emit, `email_send[DEMO]: No provider configured. Returning mocked id=${fake}`);
      return { data: { provider: "demo", id: fake, to, subject }, link: "about:blank#demo-email" };
    }
    emitErr(emit, "email_send: No email provider configured (set MAIL_PROVIDER or provider creds).");
    return { data: { error: "no_provider_configured", to, subject } };
  }

  emitNote(emit, `email_send: sending via ${provider} → ${to}`);

  try {
    let out;
    const payload = { from, to: arr(input.to), cc, bcc, replyTo, subject, text, html, attachments };

    switch (provider) {
      case "mailgun":  out = await viaMailgun(payload);  break;
      case "sendgrid": out = await viaSendGrid(payload); break;
      case "postmark": out = await viaPostmark(payload); break;
      case "resend":   out = await viaResend(payload);   break;
      case "ses":      out = await viaSes(payload);      break;
      case "msgraph":  out = await viaMsGraph(payload);  break;
      case "gmail":    out = await viaGmailApi(payload); break;
      case "brevo":    out = await viaBrevo(payload);    break;
      case "smtp":     out = await viaSmtp(payload);     break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }

    const id = out?.id || null;
    const link = out?.link || undefined;
    emitNote(emit, `email_send[${provider}]: sent ${id ? `id=${id}` : "✓"}`);
    return { data: { provider, id, to, subject }, link };
  } catch (e) {
    const err = String(e?.message || e);
    emitErr(emit, `email_send failed: ${err}`);
    return { data: { error: err, provider, to, subject } };
  }
}
