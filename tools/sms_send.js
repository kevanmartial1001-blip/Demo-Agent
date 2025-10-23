// tools/sms_send.js
// UNIVERSAL SMS/MMS SENDER (version-agnostic, multi-provider, demo-ready)
// ----------------------------------------------------------------------
// Auto-detected providers (first match wins; or force with SMS_PROVIDER):
//   • Twilio           → TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN [, TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM]
//   • Vonage/Nexmo     → VONAGE_API_KEY, VONAGE_API_SECRET [, VONAGE_FROM]
//   • Plivo            → PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN [, PLIVO_FROM]
//   • MessageBird      → MESSAGEBIRD_API_KEY [, MESSAGEBIRD_ORIGINATOR]
//   • Sinch XMS        → SINCH_SERVICE_PLAN_ID, SINCH_API_TOKEN [, SINCH_FROM]
//   • AWS SNS (SMS)    → AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION [, SNS_SENDER_ID]
//   • Telesign         → TELESIGN_CUSTOMER_ID, TELESIGN_API_KEY [, TELESIGN_FROM]
// If nothing is configured and DEMO mode is on, returns a mocked success.
//
// Common env:
//   SMS_PROVIDER   = "twilio"|"vonage"|"plivo"|"messagebird"|"sinch"|"sns"|"telesign"
//   SMS_DRY_RUN    = "1"   // no external call, return ok
//   SMS_DEMO       = "1"   // if no provider configured, return fake data
//
// Input:
//   {
//     to: string,                  // E.164 recommended (+15551234567)
//     body: string,                // message text
//     from?: string,               // sender id/number (some providers require a verified number or service)
//     media_urls?: string[],       // optional (Twilio MMS supported; others mostly ignore)
//     type?: "sms"|"mms"           // hint; defaults "sms"
//   }
//
// Output:
//   { data: { provider, id?: string|null, to, status?: string }, link?: string }
//
// Notes:
//   • Keep messages short (GSM-7) for broadest compatibility.
//   • For branded sender IDs, check local regulations (use SNS_SENDER_ID, VONAGE_FROM, MESSAGEBIRD_ORIGINATOR).
//   • All implementations use raw HTTPS; no SDK version pinning.

const DRY_RUN = String(process.env.SMS_DRY_RUN || "") === "1";
const DEMO    = String(process.env.SMS_DEMO || process.env.MAIL_DEMO || "") === "1";

function detectProvider() {
  const forced = (process.env.SMS_PROVIDER || "").toLowerCase().trim();
  if (forced) return forced;
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) return "twilio";
  if (process.env.VONAGE_API_KEY && process.env.VONAGE_API_SECRET)     return "vonage";
  if (process.env.PLIVO_AUTH_ID && process.env.PLIVO_AUTH_TOKEN)       return "plivo";
  if (process.env.MESSAGEBIRD_API_KEY)                                 return "messagebird";
  if (process.env.SINCH_SERVICE_PLAN_ID && process.env.SINCH_API_TOKEN)return "sinch";
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_REGION) return "sns";
  if (process.env.TELESIGN_CUSTOMER_ID && process.env.TELESIGN_API_KEY) return "telesign";
  return null;
}

function emitNote(emit, msg){ try { emit && emit({ type:"note", msg }); } catch {} }
function emitWarn(emit, msg){ try { emit && emit({ type:"warn", msg }); } catch {} }
function emitErr(emit, msg){  try { emit && emit({ type:"error", msg }); } catch {} }

function toForm(params){ return new URLSearchParams(params); }
function toJSON(body){ return JSON.stringify(body); }
function arr(v){ return Array.isArray(v)?v:(v?[v]:[]); }

// ---------------------- Providers ----------------------

// Twilio: SMS + MMS (MediaUrl[])
async function viaTwilio({ to, body, from, media_urls }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const msid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (!sid || !token) throw new Error("Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN");

  const auth = "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;

  const params = {};
  params.To = to;
  params.Body = body || "";
  if (msid) params.MessagingServiceSid = msid;
  else params.From = from || process.env.TWILIO_FROM || "";

  if (media_urls && media_urls.length) {
    // Twilio accepts repeated MediaUrl params
    media_urls.forEach((u, i) => { params[`MediaUrl`] = u; });
  }

  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type":"application/x-www-form-urlencoded" },
    body: toForm(params),
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(j.message || `Twilio HTTP ${r.status}`);
  return { id: j.sid || null, status: j.status || undefined, link: j.uri ? `https://www.twilio.com${j.uri}` : undefined };
}

// Vonage (Nexmo) SMS (text only here for universality)
async function viaVonage({ to, body, from }) {
  const key = process.env.VONAGE_API_KEY;
  const secret = process.env.VONAGE_API_SECRET;
  const originator = from || process.env.VONAGE_FROM || "Vonage";
  const url = "https://rest.nexmo.com/sms/json";
  const payload = { api_key: key, api_secret: secret, to, from: originator, text: body || "", type: "text" };
  const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: toJSON(payload) });
  const j = await r.json().catch(()=> ({}));
  const m = j.messages?.[0];
  if (!m || m.status !== "0") throw new Error(`Vonage: ${m?.error_text || "failed"}`);
  return { id: m["message-id"] || null, status: "queued" };
}

// Plivo SMS
async function viaPlivo({ to, body, from }) {
  const id = process.env.PLIVO_AUTH_ID;
  const token = process.env.PLIVO_AUTH_TOKEN;
  const auth = "Basic " + Buffer.from(`${id}:${token}`).toString("base64");
  const url = `https://api.plivo.com/v1/Account/${id}/Message/`;
  const payload = { src: from || process.env.PLIVO_FROM || "", dst: to, text: body || "" };
  const r = await fetch(url, { method:"POST", headers:{ Authorization: auth, "Content-Type":"application/json" }, body: toJSON(payload) });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(j.error || `Plivo HTTP ${r.status}`);
  return { id: j.message_uuid?.[0] || null, status: "queued" };
}

// MessageBird SMS
async function viaMessageBird({ to, body, from }) {
  const key = process.env.MESSAGEBIRD_API_KEY;
  const originator = from || process.env.MESSAGEBIRD_ORIGINATOR || "MBird";
  const url = "https://rest.messagebird.com/messages";
  const params = new URLSearchParams({ recipients: to, originator, body: body || "" });
  const r = await fetch(url, { method:"POST", headers:{ Authorization: `AccessKey ${key}` }, body: params });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) {
    const err = (j.errors && j.errors[0]?.description) || `MessageBird HTTP ${r.status}`;
    throw new Error(err);
  }
  return { id: j.id || null, status: j.status || undefined };
}

// Sinch XMS
async function viaSinch({ to, body, from }) {
  const plan = process.env.SINCH_SERVICE_PLAN_ID;
  const token = process.env.SINCH_API_TOKEN;
  const url = `https://sms.api.sinch.com/xms/v1/${plan}/batches`;
  const payload = { from: from || process.env.SINCH_FROM || undefined, to: [to], body: body || "" };
  const r = await fetch(url, { method:"POST", headers:{ Authorization:`Bearer ${token}`, "Content-Type":"application/json" }, body: toJSON(payload) });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(j.errorCode ? `${j.errorCode}: ${j.message}` : `Sinch HTTP ${r.status}`);
  return { id: j.id || null, status: j.status || undefined };
}

// AWS SNS (SMS)
async function viaSNS({ to, body, from }) {
  const region = process.env.AWS_REGION;
  const host = `sns.${region}.amazonaws.com`;
  const endpoint = `https://${host}/`;
  const service = "sns";

  // Query-style form (Action=Publish)
  const params = {
    Action: "Publish",
    Message: body || "",
    PhoneNumber: to,
    Version: "2010-03-31",
  };
  // Optional sender id
  const sender = from || process.env.SNS_SENDER_ID;
  if (sender) {
    params["MessageAttributes.entry.1.Name"] = "AWS.SNS.SMS.SenderID";
    params["MessageAttributes.entry.1.Value.DataType"] = "String";
    params["MessageAttributes.entry.1.Value.StringValue"] = sender;
  }

  const form = new URLSearchParams(params).toString();
  const { headers } = await awsSignV4({
    method: "POST",
    url: endpoint,
    service,
    region,
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: form,
  });
  const r = await fetch(endpoint, { method:"POST", headers, body: form });
  const txt = await r.text();
  if (!r.ok) throw new Error(`SNS HTTP ${r.status} ${txt.slice(0,180)}`);
  const m = txt.match(/<MessageId>([^<]+)<\/MessageId>/);
  return { id: m ? m[1] : null, status: "published" };
}

// Telesign
async function viaTelesign({ to, body, from }) {
  const cust = process.env.TELESIGN_CUSTOMER_ID;
  const key = process.env.TELESIGN_API_KEY;
  const url = "https://rest-api.telesign.com/v1/messaging";
  const payload = { phone_number: to, message: body || "", message_type: "ARN", sender_id: from || process.env.TELESIGN_FROM || undefined };
  const auth = "Basic " + Buffer.from(`${cust}:${key}`).toString("base64");
  const r = await fetch(url, { method:"POST", headers:{ Authorization: auth, "Content-Type":"application/json" }, body: toJSON(payload) });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(j.status?.description || `Telesign HTTP ${r.status}`);
  return { id: j.reference_id || null, status: j.status?.description || "queued" };
}

// ---------------------- AWS SigV4 helper ----------------------
async function awsSignV4({ method, url, service, region, headers = {}, body = "" }) {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error("Missing AWS credentials for SNS");

  const u = new URL(url);
  const amzdate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const datestamp = amzdate.slice(0, 8);

  const canonicalUri = u.pathname || "/";
  const canonicalQueryString = u.searchParams.toString();
  const hdrs = {
    host: u.host,
    "x-amz-date": amzdate,
    ...Object.fromEntries(Object.entries(headers).map(([k,v]) => [k.toLowerCase(), v])),
  };

  const signedHeaders = Object.keys(hdrs).sort().join(";");
  const canonicalHeaders = Object.keys(hdrs).sort().map(k => `${k}:${String(hdrs[k]).trim()}\n`).join("");
  const payloadHash = await sha256Hex(body);

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${datestamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzdate,
    credentialScope,
    await sha256Hex(canonicalRequest)
  ].join("\n");

  const kDate = await hmac(`AWS4${secretAccessKey}`, datestamp);
  const kRegion = await hmacRaw(kDate, region);
  const kService = await hmacRaw(kRegion, service);
  const kSigning = await hmacRaw(kService, "aws4_request");
  const signature = await hmacHex(kSigning, stringToSign);

  const authorization = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: { ...headers, "X-Amz-Date": amzdate, Authorization: authorization } };
}

// Crypto helpers (use Web Crypto if available; fallback to node:crypto)
function te(s){ return new TextEncoder().encode(s); }
function hex(buf){ return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join(""); }
const hasSubtle = typeof crypto !== "undefined" && crypto.subtle;

async function sha256Hex(s){
  if (hasSubtle) return hex(await crypto.subtle.digest("SHA-256", te(s)));
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(s).digest("hex");
}
async function hmacRaw(keyBytesOrStr, data) {
  if (hasSubtle && (keyBytesOrStr instanceof ArrayBuffer || ArrayBuffer.isView(keyBytesOrStr))) {
    const k = await crypto.subtle.importKey("raw", keyBytesOrStr, { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
    return await crypto.subtle.sign("HMAC", k, te(data));
  } else if (hasSubtle && typeof keyBytesOrStr === "string") {
    const k = await crypto.subtle.importKey("raw", te(keyBytesOrStr), { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
    return await crypto.subtle.sign("HMAC", k, te(data));
  } else {
    const { createHmac } = await import("node:crypto");
    return createHmac("sha256", keyBytesOrStr).update(data).digest();
  }
}
async function hmac(keyBytesOrStr, data){ return hmacRaw(keyBytesOrStr, data); }
async function hmacHex(keyBytesOrStr, data){ return hex(await hmacRaw(keyBytesOrStr, data)); }

// ---------------------- MAIN ENTRY ----------------------
export async function run({ input = {}, emit }) {
  const provider = detectProvider();
  const to = input.to;
  const body = input.body || "";
  const from = input.from;
  const media_urls = arr(input.media_urls);

  if (!to) {
    emitErr(emit, "sms_send: 'to' is required");
    return { data: { error: "'to' is required" } };
  }

  if (DRY_RUN) {
    emitNote(emit, `sms_send[DRY_RUN]: provider=${provider || "n/a"} to=${to} body="${body.slice(0,80)}"`);
    return { data: { provider: provider || "dry-run", id: null, to, status: "dry-run" } };
  }

  if (!provider) {
    if (DEMO) {
      const fake = "demo_" + Math.random().toString(36).slice(2,9);
      emitNote(emit, `sms_send[DEMO]: No provider configured; returning mocked id=${fake}`);
      return { data: { provider: "demo", id: fake, to, status: "queued" }, link: "about:blank#demo-sms" };
    }
    emitErr(emit, "sms_send: No SMS provider configured (set SMS_PROVIDER or provider envs).");
    return { data: { error: "no_provider_configured", to } };
  }

  emitNote(emit, `sms_send: via ${provider} → ${to}`);

  try {
    let out;
    switch (provider) {
      case "twilio":      out = await viaTwilio({ to, body, from, media_urls }); break;
      case "vonage":      out = await viaVonage({ to, body, from }); break;
      case "plivo":       out = await viaPlivo({ to, body, from }); break;
      case "messagebird": out = await viaMessageBird({ to, body, from }); break;
      case "sinch":       out = await viaSinch({ to, body, from }); break;
      case "sns":         out = await viaSNS({ to, body, from }); break;
      case "telesign":    out = await viaTelesign({ to, body, from }); break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return { data: { provider, id: out?.id || null, to, status: out?.status || "sent" }, link: out?.link };
  } catch (e) {
    const err = String(e?.message || e);
    emitErr(emit, `sms_send failed: ${err}`);
    return { data: { error: err, provider, to } };
  }
}
