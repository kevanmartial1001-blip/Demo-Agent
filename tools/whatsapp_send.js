// tools/whatsapp_send.js
// UNIVERSAL WHATSAPP SENDER (Meta Cloud, Twilio, Vonage Messages API, 360dialog, WATI) + Demo
// ------------------------------------------------------------------------------------------
// Auto-detected providers (first match wins; or force with WHATSAPP_PROVIDER):
//   • Meta WhatsApp Cloud API → META_WA_TOKEN, META_WA_PHONE_ID [, META_WA_WABA_ID]
//   • Twilio WhatsApp         → TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN [, TWILIO_WHATSAPP_FROM]  (E.164 without "whatsapp:"; we add it)
//   • Vonage Messages API     → VONAGE_APPLICATION_ID, VONAGE_PRIVATE_KEY_B64 [, VONAGE_WHATSAPP_NUMBER]
//   • 360dialog                → D360_API_KEY [, D360_BASE_URL=https://waba.360dialog.io]
//   • WATI                     → WATI_API_KEY, WATI_BASE_URL
//
// Common env:
//   WHATSAPP_PROVIDER = "meta"|"twilio"|"vonage"|"d360"|"wati"
//   WHATSAPP_DRY_RUN  = "1"   // log only
//   WHATSAPP_DEMO     = "1"   // return mocked success if nothing configured
//
// Minimum Input:
//   {
//     to: string,                   // E.164 (e.g., +15551234567)
//     body?: string,                // plain text message
//     media_url?: string,           // optional image/document url (provider-hosted or public)
//     caption?: string,             // optional caption for media
//     template?: {                   // optional: HSM template send
//       name: string,
//       language: string,           // e.g., "en", "en_US"
//       components?: any[]          // provider-specific variables/components
//     },
//     from?: string                 // optional override of sender where provider allows
//   }
//
// Output:
//   { data: { provider, id?: string|null, to, status?: string }, link?: string }
//
// Notes:
//   • This file is HTTP-only (Edge-safe). No SDK version pinning.
//   • We keep the surface minimal: text, media, or template. Rich/interactive can be added later.
//   • For Twilio, we use the Programmable Messaging API with the WhatsApp channel.

const DRY_RUN = String(process.env.WHATSAPP_DRY_RUN || "") === "1";
const DEMO    = String(process.env.WHATSAPP_DEMO || process.env.MAIL_DEMO || "") === "1";

function detectProvider() {
  const forced = (process.env.WHATSAPP_PROVIDER || "").toLowerCase().trim();
  if (forced) return forced;
  if (process.env.META_WA_TOKEN && process.env.META_WA_PHONE_ID) return "meta";
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) return "twilio";
  if (process.env.VONAGE_APPLICATION_ID && process.env.VONAGE_PRIVATE_KEY_B64) return "vonage";
  if (process.env.D360_API_KEY) return "d360";
  if (process.env.WATI_API_KEY && process.env.WATI_BASE_URL) return "wati";
  return null;
}

function emitNote(emit, msg){ try { emit && emit({ type:"note", msg }); } catch {} }
function emitErr(emit, msg){  try { emit && emit({ type:"error", msg }); } catch {} }
function arr(v){ return Array.isArray(v)?v:(v?[v]:[]); }
function toForm(o){ return new URLSearchParams(o); }
function toJSON(o){ return JSON.stringify(o); }

// ---------------- Meta WhatsApp Cloud API ----------------
// Docs POST https://graph.facebook.com/v18.0/{PHONE_NUMBER_ID}/messages
async function viaMeta({ to, body, media_url, caption, template, from }) {
  const token = process.env.META_WA_TOKEN;
  const phoneId = process.env.META_WA_PHONE_ID;
  if (!token || !phoneId) throw new Error("Missing META_WA_TOKEN / META_WA_PHONE_ID");

  let payload;
  if (template?.name) {
    payload = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language || "en" },
        ...(template.components ? { components: template.components } : {})
      }
    };
  } else if (media_url) {
    // choose media type heuristically by extension
    const lower = media_url.toLowerCase();
    const isImage = /\.(png|jpe?g|gif|webp)$/.test(lower);
    const isDoc   = /\.(pdf|docx?|xlsx?|pptx?)$/.test(lower);
    if (isImage) {
      payload = { messaging_product: "whatsapp", to, type: "image", image: { link: media_url, caption } };
    } else if (isDoc) {
      payload = { messaging_product: "whatsapp", to, type: "document", document: { link: media_url, caption, filename: caption || "file" } };
    } else {
      // fallback as image if unknown
      payload = { messaging_product: "whatsapp", to, type: "image", image: { link: media_url, caption } };
    }
  } else {
    payload = { messaging_product: "whatsapp", to, type: "text", text: { body: body || "" }, ...(from ? { from } : {}) };
  }

  const r = await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type":"application/json" },
    body: toJSON(payload),
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(j.error?.message || `Meta WhatsApp HTTP ${r.status}`);
  const mid = j.messages?.[0]?.id || null;
  return { id: mid, status: "queued", link: undefined };
}

// ---------------- Twilio WhatsApp ----------------
// POST to Messages API with From=whatsapp:+1..., To=whatsapp:+XX..., Body, MediaUrl
async function viaTwilio({ to, body, media_url, caption, from }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error("Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN");

  const auth = "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;

  const From = `whatsapp:${from || process.env.TWILIO_WHATSAPP_FROM || ""}`;
  const To = `whatsapp:${to}`;

  const params = { From, To };
  if (media_url) {
    params.MediaUrl = media_url;
    if (caption) params.Body = caption || ""; // Twilio uses Body as caption for media
  } else {
    params.Body = body || "";
  }

  const r = await fetch(url, { method: "POST", headers: { Authorization: auth, "Content-Type":"application/x-www-form-urlencoded" }, body: toForm(params) });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(j.message || `Twilio HTTP ${r.status}`);
  return { id: j.sid || null, status: j.status || undefined, link: j.uri ? `https://www.twilio.com${j.uri}` : undefined };
}

// ---------------- Vonage Messages API (WhatsApp) ----------------
// Requires JWT signed with application private key (base64). Channel "whatsapp".
async function viaVonage({ to, body, media_url, caption, from }) {
  const appId = process.env.VONAGE_APPLICATION_ID;
  const pkB64 = process.env.VONAGE_PRIVATE_KEY_B64;
  const waFrom = from || process.env.VONAGE_WHATSAPP_NUMBER;
  if (!appId || !pkB64 || !waFrom) throw new Error("Missing VONAGE_APPLICATION_ID / VONAGE_PRIVATE_KEY_B64 / VONAGE_WHATSAPP_NUMBER");

  const jwt = await vonageJwt({ application_id: appId, private_key_b64: pkB64 });
  let payload;
  if (media_url) {
    payload = {
      from: waFrom,
      to,
      channel: "whatsapp",
      message_type: "image", // minimal: treat as image; docs & others available if needed
      image: { url: media_url, caption }
    };
  } else {
    payload = {
      from: waFrom,
      to,
      channel: "whatsapp",
      message_type: "text",
      text: body || ""
    };
  }

  const r = await fetch("https://api.nexmo.com/v1/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type":"application/json" },
    body: toJSON(payload),
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(j.detail || j.title || `Vonage HTTP ${r.status}`);
  return { id: j.message_uuid || null, status: j.status || "accepted" };
}

// ---------------- 360dialog (WhatsApp Business API) ----------------
// Base: https://waba.360dialog.io (can be region-specific)
async function viaD360({ to, body, media_url, caption, template }) {
  const key = process.env.D360_API_KEY;
  const base = process.env.D360_BASE_URL || "https://waba.360dialog.io";
  if (!key) throw new Error("Missing D360_API_KEY");

  if (template?.name) {
    const payload = {
      to,
      type: "template",
      template: {
        namespace: template.namespace || undefined, // optional
        name: template.name,
        language: { policy: "deterministic", code: template.language || "en" },
        ...(template.components ? { components: template.components } : {})
      }
    };
    const r = await fetch(`${base}/v1/messages`, { method:"POST", headers:{ "D360-API-KEY": key, "Content-Type":"application/json" }, body: toJSON(payload) });
    const j = await r.json().catch(()=> ({}));
    if (!r.ok) throw new Error(j.error?.message || `360dialog HTTP ${r.status}`);
    return { id: j.messages?.[0]?.id || null, status: "queued" };
  }

  if (media_url) {
    // image/document heuristic
    const lower = media_url.toLowerCase();
    const isImage = /\.(png|jpe?g|gif|webp)$/.test(lower);
    const kind = isImage ? "image" : "document";
    const payload = { to, type: kind, [kind]: { link: media_url, caption } };
    const r = await fetch(`${base}/v1/messages`, { method:"POST", headers:{ "D360-API-KEY": key, "Content-Type":"application/json" }, body: toJSON(payload) });
    const j = await r.json().catch(()=> ({}));
    if (!r.ok) throw new Error(j.error?.message || `360dialog HTTP ${r.status}`);
    return { id: j.messages?.[0]?.id || null, status: "queued" };
  }

  // text
  const r = await fetch(`${base}/v1/messages`, {
    method:"POST",
    headers:{ "D360-API-KEY": key, "Content-Type":"application/json" },
    body: toJSON({ to, type:"text", text:{ body: body || "" } })
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(j.error?.message || `360dialog HTTP ${r.status}`);
  return { id: j.messages?.[0]?.id || null, status: "queued" };
}

// ---------------- WATI ----------------
// Simple /api/v1/sendSessionMessage or /sendTemplateMessage depending on input
async function viaWATI({ to, body, template, media_url, caption }) {
  const base = process.env.WATI_BASE_URL;
  const key = process.env.WATI_API_KEY;
  if (!base || !key) throw new Error("Missing WATI_BASE_URL / WATI_API_KEY");

  if (template?.name) {
    const r = await fetch(`${base.replace(/\/$/,"")}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(to)}`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type":"application/json" },
      body: toJSON({
        template_name: template.name,
        broadcast_name: template.broadcast_name || undefined,
        parameters: template.parameters || []
      })
    });
    const j = await r.json().catch(()=> ({}));
    if (!r.ok) throw new Error(j.message || `WATI HTTP ${r.status}`);
    return { id: j?.messageId || null, status: "queued" };
  }

  // session message (text/media)
  const payload = media_url
    ? { messageText: caption || "", messageType: "Media", mediaLink: media_url }
    : { messageText: body || "", messageType: "Text" };

  const r = await fetch(`${base.replace(/\/$/,"")}/api/v1/sendSessionMessage/${encodeURIComponent(to)}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type":"application/json" },
    body: toJSON(payload),
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(j.message || `WATI HTTP ${r.status}`);
  return { id: j?.messageId || null, status: "queued" };
}

// ---------------- Vonage JWT helper ----------------
async function vonageJwt({ application_id, private_key_b64 }) {
  // Create a short-lived JWT (60s) for Vonage Messages API
  const now = Math.floor(Date.now()/1000);
  const payload = { application_id, iat: now, exp: now + 60, jti: "wa_"+Math.random().toString(36).slice(2,10) };
  const pkPem = Buffer.from(private_key_b64, "base64").toString("utf8");
  // Sign with RS256 (use WebCrypto if present; fallback to node:crypto)
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const key = await crypto.subtle.importKey("pkcs8", pemToArrayBuffer(pkPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const unsigned = base64url(toJSON({ alg:"RS256", typ:"JWT" })) + "." + base64url(JSON.stringify(payload));
    const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, new TextEncoder().encode(unsigned));
    return unsigned + "." + base64url(sig);
  } else {
    const { createSign } = await import("node:crypto");
    const header = base64url(toJSON({ alg:"RS256", typ:"JWT" }));
    const body   = base64url(JSON.stringify(payload));
    const unsigned = `${header}.${body}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    const sig = signer.sign(pkPem);
    return `${unsigned}.${base64url(sig)}`;
  }
}

function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g,"").replace(/\s+/g,"");
  const bin = Buffer.from(b64, "base64");
  return bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
}
function base64url(input){
  const buf = input instanceof ArrayBuffer ? new Uint8Array(input) : (typeof input === "string" ? new TextEncoder().encode(input) : input);
  const b64 = Buffer.from(buf).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  return b64;
}

// ---------------- MAIN ENTRY ----------------
export async function run({ input = {}, emit }) {
  const provider = detectProvider();
  const to = input.to;
  const body = input.body || "";
  const media_url = input.media_url || null;
  const caption = input.caption || undefined;
  const template = input.template || null;
  const from = input.from || undefined;

  if (!to) {
    emitErr(emit, "whatsapp_send: 'to' is required");
    return { data: { error: "'to' is required" } };
  }

  if (DRY_RUN) {
    emitNote(emit, `whatsapp_send[DRY_RUN]: provider=${provider || "n/a"} to=${to} body="${(body||caption||"").slice(0,80)}"`);
    return { data: { provider: provider || "dry-run", id: null, to, status: "dry-run" } };
  }

  if (!provider) {
    if (DEMO) {
      const fake = "demo_" + Math.random().toString(36).slice(2,9);
      emitNote(emit, `whatsapp_send[DEMO]: No provider configured; returning mocked id=${fake}`);
      return { data: { provider: "demo", id: fake, to, status: "queued" }, link: "about:blank#demo-whatsapp" };
    }
    emitErr(emit, "whatsapp_send: No WhatsApp provider configured (set WHATSAPP_PROVIDER or provider envs).");
    return { data: { error: "no_provider_configured", to } };
  }

  emitNote(emit, `whatsapp_send: via ${provider} → ${to}`);

  try {
    let out;
    switch (provider) {
      case "meta":   out = await viaMeta({ to, body, media_url, caption, template, from }); break;
      case "twilio": out = await viaTwilio({ to, body, media_url, caption, from }); break;
      case "vonage": out = await viaVonage({ to, body, media_url, caption, from }); break;
      case "d360":   out = await viaD360({ to, body, media_url, caption, template }); break;
      case "wati":   out = await viaWATI({ to, body, media_url, caption, template }); break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return { data: { provider, id: out?.id || null, to, status: out?.status || "sent" }, link: out?.link };
  } catch (e) {
    const err = String(e?.message || e);
    emitErr(emit, `whatsapp_send failed: ${err}`);
    return { data: { error: err, provider, to } };
  }
}
