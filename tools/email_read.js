// tools/email_read.js
// UNIVERSAL EMAIL READER (Gmail, Outlook/Graph, IMAP) + Demo Mode
// ---------------------------------------------------------------
// Auto-detected providers (first match wins, or force with EMAIL_READ_PROVIDER):
//   • Gmail API          → GMAIL_ACCESS_TOKEN   (scope: gmail.readonly)
//   • Microsoft Graph    → MS_GRAPH_TOKEN       (scope: Mail.Read)
//   • IMAP (generic)     → IMAP_HOST, IMAP_USER, IMAP_PASS [, IMAP_PORT=993, IMAP_SECURE=true]
// If no provider is configured and DEMO is enabled, returns mocked messages.
//
// Common env:
//   EMAIL_READ_PROVIDER = "gmail" | "msgraph" | "imap"
//   EMAIL_READ_DRY_RUN  = "1"   // no external calls, return empty ok
//   EMAIL_READ_DEMO     = "1"   // if no provider configured, return fake data
//
// Input:
//   {
//     provider?: "gmail"|"msgraph"|"imap",
//     query?: string,                 // Gmail-style (gmail) or free text (used to build filters)
//     from?: string,
//     to?: string,
//     subject?: string,
//     after?: string,                 // ISO date (e.g., "2025-10-01")
//     before?: string,                // ISO date
//     thread_id?: string,             // gmail: threadId ; msgraph: conversationId ; imap: (not supported)
//     limit?: number,                 // default 10, max 50
//     include_bodies?: boolean        // default false (faster); true returns text/html when available
//   }
//
// Output:
//   {
//     data: {
//       provider: string,
//       messages: [{
//         id, thread_id?, date, from, to, subject, snippet,
//         text?, html?, headers? (map), link?
//       }]
//     },
//     link?: string // inbox link when available
//   }
//
// Notes:
//   • Gmail/Graph paths are Edge-compatible (HTTP). IMAP requires Node runtime.
//   • Bodies can be large; prefer include_bodies:false for speed.

const DRY_RUN   = String(process.env.EMAIL_READ_DRY_RUN || "") === "1";
const DEMO_MODE = String(process.env.EMAIL_READ_DEMO || process.env.MAIL_DEMO || "") === "1";

function detectProvider(forced) {
  if (forced) return forced;
  const hinted = (process.env.EMAIL_READ_PROVIDER || "").toLowerCase().trim();
  if (hinted) return hinted;
  if (process.env.GMAIL_ACCESS_TOKEN) return "gmail";
  if (process.env.MS_GRAPH_TOKEN)     return "msgraph";
  if (process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASS) return "imap";
  return null;
}

function escHeader(s=""){ return s.replace(/\r?\n/g," ").trim(); }
function arr(v){ return Array.isArray(v)?v:(v?[v]:[]); }
function pick(o = {}, keys = []) { const out={}; for (const k of keys) if (o[k]!==undefined) out[k]=o[k]; return out; }

function emitNote(emit, msg){ try { emit && emit({ type:"note", msg }); } catch {} }
function emitWarn(emit, msg){ try { emit && emit({ type:"warn", msg }); } catch {} }
function emitErr(emit, msg){  try { emit && emit({ type:"error", msg }); } catch {} }

// ---------- DEMO ----------
function demoMessages({ limit=10 }) {
  const now = new Date();
  const msgs = [];
  for (let i=0;i<Math.min(limit,5);i++){
    msgs.push({
      id: "demo_"+(i+1),
      thread_id: "demo_thread_"+Math.ceil((i+1)/2),
      date: new Date(now.getTime() - i*3600_000).toUTCString(),
      from: `Client ${i+1} <client${i+1}@example.com>`,
      to: `You <you@yourco.com>`,
      subject: `Demo message #${i+1}`,
      snippet: `This is a demo preview line for message #${i+1}.`,
      text: `Hello,\nThis is the full text for demo message #${i+1}.\nRegards.`,
      html: `<p>Hello,</p><p>This is the <b>HTML</b> for demo message #${i+1}.</p><p>Regards.</p>`,
      headers: { "X-Demo": "true" },
      link: "about:blank#demo-email"
    });
  }
  return msgs;
}

// ---------- GMAIL ----------
function b64urlDecode(s=""){ try { return Buffer.from(s.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString("utf8"); } catch{ return ""; } }
function headerValue(headers=[], name=""){ const h=headers.find(x => (x.name||"").toLowerCase()===name.toLowerCase()); return h?.value || ""; }

function gmailQuery({ query, from, to, subject, after, before }) {
  let q = query ? String(query) : "";
  if (from)   q += ` from:${from}`;
  if (to)     q += ` to:${to}`;
  if (subject)q += ` subject:(${subject})`;
  if (after)  q += ` after:${after.replace(/-/g,"/")}`;   // Gmail wants yyyy/mm/dd
  if (before) q += ` before:${before.replace(/-/g,"/")}`;
  return q.trim();
}

async function gmailList({ q, limit=10, threadId }) {
  const token = process.env.GMAIL_ACCESS_TOKEN;
  if (!token) throw new Error("Missing GMAIL_ACCESS_TOKEN");
  const base = "https://gmail.googleapis.com/gmail/v1/users/me";

  if (threadId) {
    const tr = await fetch(`${base}/threads/${encodeURIComponent(threadId)}`, { headers:{ Authorization:`Bearer ${token}` }});
    if (!tr.ok) throw new Error(`Gmail thread HTTP ${tr.status}`);
    const tj = await tr.json();
    return (tj.messages||[]).map(m => ({ id: m.id }));
  }

  const params = new URLSearchParams({ q, maxResults: String(limit) });
  const r = await fetch(`${base}/messages?${params.toString()}`, { headers:{ Authorization:`Bearer ${token}` }});
  if (!r.ok) throw new Error(`Gmail list HTTP ${r.status}`);
  const j = await r.json();
  return j.messages || [];
}

async function gmailGet(id, include_bodies=false) {
  const token = process.env.GMAIL_ACCESS_TOKEN;
  const base = "https://gmail.googleapis.com/gmail/v1/users/me";
  const r = await fetch(`${base}/messages/${encodeURIComponent(id)}?format=full`, { headers:{ Authorization:`Bearer ${token}` }});
  if (!r.ok) throw new Error(`Gmail get HTTP ${r.status}`);
  const msg = await r.json();
  const headers = msg.payload?.headers || [];
  const from = headerValue(headers, "From");
  const to = headerValue(headers, "To");
  const subject = headerValue(headers, "Subject");
  const date = headerValue(headers, "Date");
  const threadId = msg.threadId;
  const snippet = (msg.snippet || "").trim();

  let text=null, html=null;
  if (include_bodies) {
    const parts = { text:[], html:[] };
    (function walk(p){
      if (!p) return;
      const mime = (p.mimeType||"").toLowerCase();
      if (p.body?.data && (mime==="text/plain" || mime==="text/html")) {
        const decoded = b64urlDecode(p.body.data);
        if (mime==="text/plain") parts.text.push(decoded); else parts.html.push(decoded);
      }
      (p.parts||[]).forEach(walk);
    })(msg.payload);
    text = parts.text.join("\n\n") || null;
    html = parts.html.join("\n") || null;
  }

  return {
    id: msg.id, thread_id: threadId, date, from, to, subject, snippet,
    ...(include_bodies ? { text: text || undefined, html: html || undefined } : {}),
    headers: Object.fromEntries(headers.map(h => [h.name, h.value])),
    link: `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(headerValue(headers,"Message-Id")||msg.id)}`
  };
}

async function viaGmail({ input, emit }) {
  const limit = Math.min(Math.max(Number(input.limit || 10),1),50);
  const q = gmailQuery(input);
  const ids = await gmailList({ q, limit, threadId: input.thread_id });
  emitNote(emit, `email_read[gmail]: hits=${ids.length}`);

  const out = [];
  for (const it of ids) {
    try { out.push(await gmailGet(it.id, !!input.include_bodies)); }
    catch (e) { emitWarn(emit, `gmail get failed for id=${it.id}: ${String(e.message||e)}`); }
  }
  return { data: { provider: "gmail", messages: out }, link: "https://mail.google.com/mail/u/0/#inbox" };
}

// ---------- MICROSOFT GRAPH (Outlook) ----------
function msFilter({ from, to, subject, after, before, thread_id }) {
  const filters = [];
  if (from)    filters.push(`from/emailAddress/address eq '${from.replace(/'/g,"''")}'`);
  if (to)      filters.push(`contains(toupper(recipients), '${to.toUpperCase().replace(/'/g,"''")}')`);
  if (subject) filters.push(`contains(subject,'${subject.replace(/'/g,"''")}')`);
  if (after)   filters.push(`receivedDateTime ge ${after}`);
  if (before)  filters.push(`receivedDateTime le ${before}`);
  if (thread_id) filters.push(`conversationId eq '${thread_id.replace(/'/g,"''")}'`);
  return filters.join(" and ");
}

async function viaMsGraph({ input, emit }) {
  const token = process.env.MS_GRAPH_TOKEN;
  if (!token) throw new Error("Missing MS_GRAPH_TOKEN");
  const limit = Math.min(Math.max(Number(input.limit||10),1),50);

  const base = "https://graph.microsoft.com/v1.0/me/messages";
  const params = new URLSearchParams();
  params.set("$top", String(limit));
  params.set("$orderby", "receivedDateTime DESC");
  const filter = msFilter(input);
  if (filter) params.set("$filter", filter);
  // expand body/unique body if include_bodies
  if (input.include_bodies) params.set("$select", "id,conversationId,receivedDateTime,from,toRecipients,subject,bodyPreview,body");

  const r = await fetch(`${base}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) throw new Error(`Graph list HTTP ${r.status} ${await r.text().catch(()=> "")}`);
  const j = await r.json();

  const messages = (j.value || []).map(it => {
    const from = it.from?.emailAddress ? `${it.from.emailAddress.name ? it.from.emailAddress.name+" " : ""}<${it.from.emailAddress.address}>` : "";
    const to = (it.toRecipients || []).map(rcp => `<${rcp.emailAddress.address}>`).join(", ");
    const date = it.receivedDateTime ? new Date(it.receivedDateTime).toUTCString() : "";
    const headers = {}; // Graph doesn't expose raw headers here
    return {
      id: it.id,
      thread_id: it.conversationId,
      date,
      from,
      to,
      subject: it.subject || "",
      snippet: (it.bodyPreview || "").trim(),
      ...(input.include_bodies ? { 
        text: it.body?.contentType==="text" ? it.body?.content : undefined,
        html: it.body?.contentType==="html" ? it.body?.content : undefined
      } : {}),
      headers
    };
  });

  return { data: { provider: "msgraph", messages }, link: "https://outlook.office.com/mail/" };
}

// ---------- IMAP (generic; Node runtime) ----------
async function viaImap({ input, emit }) {
  let ImapFlow;
  try { ({ ImapFlow } = await import("imapflow")); }
  catch { throw new Error("IMAP requires 'imapflow' (npm i imapflow) and Node runtime."); }

  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  const port = Number(process.env.IMAP_PORT || 993);
  const secure = String(process.env.IMAP_SECURE || "true") !== "false";

  if (!host || !user || !pass) throw new Error("Missing IMAP_HOST/IMAP_USER/IMAP_PASS");

  const client = new ImapFlow({ host, port, secure, auth: { user, pass } });
  await client.connect();

  try {
    await client.mailboxOpen("INBOX", { readOnly: true });

    // Build basic search
    const crit = ["ALL"];
    if (input.from)    crit.push(["FROM", input.from]);
    if (input.to)      crit.push(["TO", input.to]);
    if (input.subject) crit.push(["SUBJECT", input.subject]);
    if (input.after)   crit.push(["SINCE", new Date(input.after)]);
    if (input.before)  crit.push(["BEFORE", new Date(input.before)]);
    const limit = Math.min(Math.max(Number(input.limit||10),1),50);

    const uids = await client.search(crit, { uid: true });
    const take = uids.slice(-limit); // latest first
    emitNote(emit, `email_read[imap]: matched=${uids.length}, returning=${take.length}`);

    const messages = [];
    for await (const msg of client.fetch(take, { envelope: true, source: input.include_bodies, bodyStructure: true })) {
      const env = msg.envelope || {};
      const from = (env.from||[]).map(x => `${x.name?x.name+" ":""}<${x.address||""}>`).join(", ");
      const to = (env.to||[]).map(x => `${x.name?x.name+" ":""}<${x.address||""}>`).join(", ");
      const subject = escHeader(env.subject || "");
      const date = env.date ? new Date(env.date).toUTCString() : "";
      const id = String(msg.uid);

      let text, html;
      if (input.include_bodies) {
        // Parse very lightly: try to pull a text part from the raw source
        try {
          const src = await client.download(msg.uid);
          const chunks=[]; for await (const c of src) chunks.push(c);
          const raw = Buffer.concat(chunks).toString("utf8");
          const mHtml = raw.match(/Content-Type:\s*text\/html[\s\S]*?\r\n\r\n([\s\S]*?)\r\n--/i);
          const mText = raw.match(/Content-Type:\s*text\/plain[\s\S]*?\r\n\r\n([\s\S]*?)\r\n--/i);
          html = mHtml ? mHtml[1].trim() : undefined;
          text = mText ? mText[1].trim() : undefined;
        } catch {}
      }

      messages.push({
        id,
        thread_id: undefined,
        date,
        from,
        to,
        subject,
        snippet: subject, // IMAP has no snippet; use subject as a small preview
        ...(input.include_bodies ? { text, html } : {}),
        headers: pick(env, ["messageId","inReplyTo"])
      });
    }

    return { data: { provider: "imap", messages } };
  } finally {
    try { await client.logout(); } catch {}
  }
}

// ---------------------- MAIN ENTRY ----------------------
export async function run({ input = {}, emit }) {
  try {
    const forced = input.provider && String(input.provider).toLowerCase();
    const provider = detectProvider(forced);

    if (DRY_RUN) {
      emitNote(emit, `email_read[DRY_RUN]: provider=${provider || "n/a"}`);
      return { data: { provider: provider || "dry-run", messages: [] } };
    }

    if (!provider) {
      if (DEMO_MODE) {
        emitNote(emit, "email_read[DEMO]: No provider configured; returning mocked messages.");
        return { data: { provider: "demo", messages: demoMessages({ limit: input.limit }) }, link: "about:blank#demo-inbox" };
      }
      throw new Error("No email provider configured. Set EMAIL_READ_PROVIDER or provider credentials (Gmail/Graph/IMAP).");
    }

    switch (provider) {
      case "gmail":   return await viaGmail({ input, emit });
      case "msgraph": return await viaMsGraph({ input, emit });
      case "imap":    return await viaImap({ input, emit });
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
  } catch (e) {
    const err = String(e?.message || e);
    emitErr(emit, `email_read failed: ${err}`);
    return { data: { error: err, provider: input.provider || process.env.EMAIL_READ_PROVIDER || null, messages: [] } };
  }
}
