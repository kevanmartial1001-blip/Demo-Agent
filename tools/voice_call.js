// tools/voice_call.js
// UNIVERSAL OUTBOUND VOICE CALLER (Twilio, Vonage, Plivo, AWS Connect) + Demo
// --------------------------------------------------------------------------
// Auto-detected providers (first match wins; or force with VOICE_PROVIDER):
//   • Twilio Voice        → TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN [, TWILIO_VOICE_FROM]
//   • Vonage Voice (NCCO) → VONAGE_API_KEY, VONAGE_API_SECRET [, VONAGE_VOICE_FROM]
//   • Plivo Voice         → PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN [, PLIVO_VOICE_FROM, PLIVO_ANSWER_URL_TEMPLATE]
//   • AWS Connect         → AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION,
//                           CONNECT_INSTANCE_ID, CONNECT_CONTACT_FLOW_ID, CONNECT_SOURCE_NUMBER
//
// Common env:
//   VOICE_PROVIDER     = "twilio"|"vonage"|"plivo"|"connect"
//   VOICE_DRY_RUN      = "1"   // log only
//   VOICE_DEMO         = "1"   // mocked success when no provider
//
// Input:
//   {
//     to: string,                  // E.164 (+15551234567)
//     from?: string,               // E.164 (or configured per provider)
//     script?: string,             // what the bot should say (plain text)
//     ssml?: string,               // optional SSML (overrides `script` if provided)
//     language?: string,           // e.g., "en-US", "es-ES"
//     voice?: string,              // e.g., "Polly.Joanna", "female", "male"
//     answer_url?: string,         // if you already host IVR XML (Twiml/Plivo XML/NCCO)
//     record?: boolean             // start call recording if supported
//   }
//
// Output:
//   { data: { provider, id?: string|null, to, status?: string }, link?: string }
//
// Notes:
//   • Twilio: we send inline TwiML via `Twiml` (or use input.answer_url if provided).
//   • Vonage: inline NCCO with a single "talk" action (or redirect to `answer_url` as webhook if provided).
//   • Plivo: requires an `answer_url`. If not provided, we try PLIVO_ANSWER_URL_TEMPLATE with ?text=... (URL-encoded).
//   • AWS Connect: dials via StartOutboundVoiceContact with a Contact Flow (script played in the flow).
//   • Keep messages short and avoid secrets in the script (calls may be recorded by provider).
//   • Entirely HTTP-based; no SDK version pinning (Edge-safe). Plivo needs a reachable answer_url.

const DRY_RUN = String(process.env.VOICE_DRY_RUN || "") === "1";
const DEMO    = String(process.env.VOICE_DEMO || process.env.MAIL_DEMO || "") === "1";

function detectProvider() {
  const forced = (process.env.VOICE_PROVIDER || "").toLowerCase().trim();
  if (forced) return forced;
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) return "twilio";
  if (process.env.VONAGE_API_KEY && process.env.VONAGE_API_SECRET)     return "vonage";
  if (process.env.PLIVO_AUTH_ID && process.env.PLIVO_AUTH_TOKEN)       return "plivo";
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_REGION &&
      process.env.CONNECT_INSTANCE_ID && process.env.CONNECT_CONTACT_FLOW_ID && process.env.CONNECT_SOURCE_NUMBER)
    return "connect";
  return null;
}

function emitNote(emit, msg){ try { emit && emit({ type:"note", msg }); } catch {} }
function emitErr(emit, msg){  try { emit && emit({ type:"error", msg }); } catch {} }

function xmlEscape(s=""){ return s.replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c])); }
function base64(s){ return Buffer.from(s).toString("base64"); }

// --------------------------- Twilio Voice ---------------------------
// POST /2010-04-01/Accounts/{SID}/Calls.json
async function viaTwilio({ to, from, script, ssml, language, voice, answer_url, record }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error("Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN");

  const auth = "Basic " + base64(`${sid}:${token}`);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`;

  const From = from || process.env.TWILIO_VOICE_FROM;
  if (!From && !process.env.TWILIO_MESSAGING_SERVICE_SID) {
    // For calls, a From number is required (owned/verified)
    emitNote(null, "Twilio: no FROM provided; ensure TWILIO_VOICE_FROM is set.");
  }

  const params = new URLSearchParams();
  params.set("To", to);
  if (From) params.set("From", From);
  if (record) params.set("Record", "true");

  if (answer_url) {
    params.set("Url", answer_url);
  } else {
    // Inline TwiML
    const sayAttrs = [];
    if (voice)    sayAttrs.push(`voice="${xmlEscape(voice)}"`);
    if (language) sayAttrs.push(`language="${xmlEscape(language)}"`);
    const sayTag = ssml
      ? `<Say ${sayAttrs.join(" ")}>${xmlEscape(ssml)}</Say>`
      : `<Say ${sayAttrs.join(" ")}>${xmlEscape(script || "Hello. This is your AI assistant.")}</Say>`;
    const twiml = `<Response>${sayTag}</Response>`;
    params.set("Twiml", twiml);
  }

  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type":"application/x-www-form-urlencoded" },
    body: params
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(j.message || `Twilio Voice HTTP ${r.status}`);
  return { id: j.sid || null, status: j.status || "queued", link: j.subresource_uris?.recordings ? `https://www.twilio.com/console/voice/calls/logs/${j.sid}` : undefined };
}

// --------------------------- Vonage Voice (NCCO) ---------------------------
// POST https://api.nexmo.com/v1/calls
async function viaVonage({ to, from, script, ssml, language, voice, answer_url, record }) {
  const key = process.env.VONAGE_API_KEY;
  const secret = process.env.VONAGE_API_SECRET;
  if (!key || !secret) throw new Error("Missing VONAGE_API_KEY / VONAGE_API_SECRET");

  const url = "https://api.nexmo.com/v1/calls";
  let ncco;
  if (answer_url) {
    ncco = [{ action: "notify", payload: {}, eventUrl: [answer_url] }]; // minimal redirect
  } else {
    ncco = [{
      action: "talk",
      text: (ssml || script || "Hello. This is your AI assistant."),
      language: language || "en-US",
      voiceName: voice || undefined,
      style: 0
    }];
    if (record) {
      // Vonage recording is usually started via a separate API, but we can include a prompt here;
      // For simplicity we leave it out; you can record via REST after call starts if needed.
    }
  }

  const payload = {
    to: [{ type: "phone", number: to }],
    from: { type: "phone", number: from || process.env.VONAGE_VOICE_FROM || "" },
    ncco
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Basic " + base64(`${key}:${secret}`), "Content-Type":"application/json" },
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(j.title || `Vonage Voice HTTP ${r.status}`);
  return { id: j.uuid || null, status: j.status || "started" };
}

// --------------------------- Plivo Voice ---------------------------
// POST https://api.plivo.com/v1/Account/{auth_id}/Call/
// Requires an answer_url that returns valid Plivo XML. If not supplied, we try
// PLIVO_ANSWER_URL_TEMPLATE (e.g., https://example.com/plivo-tts?text={TEXT}&lang={LANG}).
async function viaPlivo({ to, from, script, ssml, language, voice, answer_url, record }) {
  const authId = process.env.PLIVO_AUTH_ID;
  const authToken = process.env.PLIVO_AUTH_TOKEN;
  if (!authId || !authToken) throw new Error("Missing PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN");

  let urlToUse = answer_url;
  if (!urlToUse) {
    const tpl = process.env.PLIVO_ANSWER_URL_TEMPLATE;
    if (!tpl) throw new Error("Plivo requires answer_url or PLIVO_ANSWER_URL_TEMPLATE");
    const text = encodeURIComponent(ssml || script || "Hello. This is your AI assistant.");
    const lang = encodeURIComponent(language || "en-US");
    const v    = encodeURIComponent(voice || "");
    urlToUse = tpl.replace("{TEXT}", text).replace("{LANG}", lang).replace("{VOICE}", v);
  }

  const auth = "Basic " + base64(`${authId}:${authToken}`);
  const url = `https://api.plivo.com/v1/Account/${authId}/Call/`;
  const payload = {
    from: from || process.env.PLIVO_VOICE_FROM || "",
    to,
    answer_url: urlToUse,
    answer_method: "GET",
    ...(record ? { recording_callback_url: process.env.PLIVO_RECORDING_CALLBACK_URL || undefined, recording: "true" } : {})
  };
  const r = await fetch(url, { method:"POST", headers:{ Authorization: auth, "Content-Type":"application/json" }, body: JSON.stringify(payload) });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(j.error || `Plivo Voice HTTP ${r.status}`);
  return { id: (j && (j.request_uuid || j.api_id)) || null, status: "queued" };
}

// --------------------------- AWS Connect ---------------------------
// POST https://connect.{region}.amazonaws.com/contact/outbound-voice
// Action: StartOutboundVoiceContact (SigV4)
async function viaConnect({ to, script /* ignored here */, language, voice /* ignored here */, record }) {
  const region = process.env.AWS_REGION;
  const instanceId = process.env.CONNECT_INSTANCE_ID;
  const flowId = process.env.CONNECT_CONTACT_FLOW_ID;
  const source = process.env.CONNECT_SOURCE_NUMBER;

  // You play/prompts via the configured Contact Flow in Connect.
  const endpoint = `https://connect.${region}.amazonaws.com/contact/outbound-voice`;
  const body = {
    DestinationPhoneNumber: to,
    ContactFlowId: flowId,
    InstanceId: instanceId,
    SourcePhoneNumber: process.env.CONNECT_SOURCE_NUMBER || source,
    Attributes: {} // you can inject variables here for the flow
  };

  const { headers } = await awsSignV4({
    method: "POST",
    url: endpoint,
    service: "connect",
    region,
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(body),
  });
  const r = await fetch(endpoint, { method:"POST", headers, body: JSON.stringify(body) });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(j.message || `Connect HTTP ${r.status}`);
  return { id: j.ContactId || null, status: "started" };
}

// --------------------------- AWS SigV4 helper ---------------------------
async function awsSignV4({ method, url, service, region, headers = {}, body = "" }) {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error("Missing AWS credentials for Connect");

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

  const payload = typeof body === "string" ? body : JSON.stringify(body || "");
  const payloadHash = await sha256Hex(payload);

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

// crypto helpers
function te(s){ return new TextEncoder().encode(s); }
function hex(buf){ return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join(""); }
const hasSubtle = typeof crypto !== "undefined" && crypto.subtle;
async function sha256Hex(s){ if (hasSubtle) return hex(await crypto.subtle.digest("SHA-256", te(s))); const { createHash } = await import("node:crypto"); return createHash("sha256").update(s).digest("hex"); }
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

// --------------------------- MAIN ENTRY ---------------------------
export async function run({ input = {}, emit }) {
  const provider = detectProvider();
  const to = input.to;
  const from = input.from;
  const script = input.script || "";
  const ssml = input.ssml || null;
  const language = input.language || "en-US";
  const voice = input.voice || undefined;
  const answer_url = input.answer_url || undefined;
  const record = !!input.record;

  if (!to) {
    emitErr(emit, "voice_call: 'to' is required");
    return { data: { error: "'to' is required" } };
  }

  if (DRY_RUN) {
    emitNote(emit, `voice_call[DRY_RUN]: provider=${provider || "n/a"} to=${to} script="${script.slice(0,80)}"`);
    return { data: { provider: provider || "dry-run", id: null, to, status: "dry-run" } };
  }

  if (!provider) {
    if (DEMO) {
      const fake = "demo_" + Math.random().toString(36).slice(2,9);
      emitNote(emit, `voice_call[DEMO]: No provider configured; returning mocked id=${fake}`);
      return { data: { provider: "demo", id: fake, to, status: "queued" }, link: "about:blank#demo-voice" };
    }
    emitErr(emit, "voice_call: No voice provider configured (set VOICE_PROVIDER or provider envs).");
    return { data: { error: "no_provider_configured", to } };
  }

  emitNote(emit, `voice_call: via ${provider} → ${to}`);

  try {
    let out;
    switch (provider) {
      case "twilio":
        out = await viaTwilio({ to, from, script, ssml, language, voice, answer_url, record });
        break;
      case "vonage":
        out = await viaVonage({ to, from, script, ssml, language, voice, answer_url, record });
        break;
      case "plivo":
        out = await viaPlivo({ to, from, script, ssml, language, voice, answer_url, record });
        break;
      case "connect":
        out = await viaConnect({ to, script, language, voice, record });
        break;
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
    return { data: { provider, id: out?.id || null, to, status: out?.status || "started" }, link: out?.link };
  } catch (e) {
    const err = String(e?.message || e);
    emitErr(emit, `voice_call failed: ${err}`);
    return { data: { error: err, provider, to } };
  }
}
