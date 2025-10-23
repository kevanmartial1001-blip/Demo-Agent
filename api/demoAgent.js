// /api/demoAgent.js
// Human-like assistant with proactive planning, tool probing, demo fallbacks,
// sticky task mode, and human-style bursts for ANY task (email, CRM, tasks,
// calendar, mailbox, inventory, search, etc.). No external deps required.

module.exports.config = { runtime: "nodejs" };

/* ───────────────────────── Utils ───────────────────────── */
function traceId(){ return "trc_" + Math.random().toString(36).slice(2,10); }
function nowISO(){ return new Date().toISOString(); }
function fmtEUR(n){ try { return new Intl.NumberFormat('en-US',{style:'currency',currency:'EUR'}).format(n); } catch { return `€${(+n||0).toFixed(2)}`; } }
function okJSON(res, obj){ try{ res.setHeader("Content-Type","application/json"); }catch{} return res.status(200).json(obj); }
function errJSON(res, msg){
  try{ res.setHeader("Content-Type","application/json"); }catch{}
  return res.status(200).json({
    mode:"text",
    script:[{ text:"Something went wrong — I switched to safe demo mode.", delay_ms:0, show_role:true }],
    cards:[{ format:"text", summary:"Error", value:String(msg) }],
    meta:{ error:true, trace_id: traceId(), steps:["Caught error in /api/demoAgent; returned fallback."] }
  });
}
function readBody(req){
  try{
    if (req && typeof req.body === "object" && req.body !== null) return req.body;
    if (req && typeof req.body === "string") return JSON.parse(req.body || "{}");
  }catch{}
  return {};
}
function bursts(...lines){ return lines.map((text,i)=>({ text, delay_ms: 300, show_role: i===0 })); }
function clamp(n,min,max){ return Math.min(max, Math.max(min, n)); }
function cap(s){ return (s||"").replace(/\b\w/g, c=>c.toUpperCase()); }

/* ───────────────────────── Tool auto-detection ─────────────────────────
   Set env vars to make the assistant try real tools first (else demo fallback).
*/
const CAP = {
  email:    !!process.env.EMAIL_PROVIDER,
  whatsapp: !!process.env.WHATSAPP_PROVIDER,
  sms:      !!process.env.SMS_PROVIDER,
  voice:    !!process.env.VOICE_PROVIDER,
  calendar: !!process.env.CAL_PROVIDER,
  doc:      !!process.env.DOC_PROVIDER,
  sheet:    !!process.env.SHEET_PROVIDER,
  slide:    !!process.env.SLIDE_PROVIDER,
  file:     !!process.env.FILE_PROVIDER,
  pdf:      !!process.env.PDF_PROVIDER,
  crm:      !!process.env.CRM_PROVIDER,
  billing:  !!process.env.BILLING_PROVIDER,
  pay:      !!process.env.PAYMENT_PROVIDER,
  search:   !!process.env.SEARCH_PROVIDER,
  browser:  !!process.env.BROWSER_PROVIDER,
  tasks:    !!process.env.TASKS_PROVIDER,
  ticket:   !!process.env.TICKET_PROVIDER,
  inventory:!!process.env.INVENTORY_PROVIDER,
  order:    !!process.env.ORDER_PROVIDER,
  shipping: !!process.env.SHIPPING_PROVIDER,
  kb:       !!process.env.KB_PROVIDER,
  mailbox:  !!process.env.MAILBOX_PROVIDER, // e.g., Gmail/Outlook relay behind /tools/email_read
};

async function tryToolCall(req, path, payload, timeoutMs=9000){
  const proto = req.headers["x-forwarded-proto"] || "https";
  const baseUrl = `${proto}://${req.headers.host}`;
  const ac = new AbortController();
  const t = setTimeout(()=>ac.abort("timeout"), timeoutMs);
  try{
    const r = await fetch(`${baseUrl}${path}`,{
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(payload||{}),
      signal: ac.signal
    });
    clearTimeout(t);
    const j = await r.json().catch(()=>({ ok:false, error:"Bad JSON" }));
    if (!r.ok || j.ok === false) return { ok:false, error: j.error || `HTTP ${r.status}` };
    return j;
  }catch(e){
    clearTimeout(t);
    return { ok:false, error: String(e?.message || e) };
  }
}

/* ───────────────────────── Visual mocks (impactful) ───────────────────────── */
function imgEmailPreview({to, subject}){
  const title = encodeURIComponent(`Email to ${to||"Contact"}`);
  const sub   = encodeURIComponent(subject||"Follow-up");
  return `https://placehold.co/980x520/png?text=${title}%0A${sub}`;
}
function imgPDFMock(kind, id, who){
  const text = encodeURIComponent(`${kind} ${id} · ${who||"Contact"}`);
  return `https://placehold.co/980x1380/png?text=${text}`;
}
function imgCalendarCard({title, when}){
  const txt = encodeURIComponent(`${title||"Event"}%0A${when||nowISO().slice(0,10)}`);
  return `https://placehold.co/980x360/png?text=${txt}`;
}
function imgCRMCard({contact, note}){
  const txt = encodeURIComponent(`${contact||"Contact"}%0A${note||"Activity logged"}`);
  return `https://placehold.co/980x400/png?text=${txt}`;
}
function imgListingsGrid({title="Marbella · 5-bed · Sea view · 2000m²+"}={}){ 
  const txt = encodeURIComponent(title);
  return `https://placehold.co/980x640/png?text=${txt}`;
}

/* ───────────────────────── Context store ───────────────────────── */
const CTX = new Map();
function newCtx(){
  return {
    people: [],
    current_contact: null,
    tone: "professional",
    mode: "idle",       // 'idle' | 'task'
    focus: null,        // e.g., 'email+crm'
    email: { to:null, subject:null, body:null, attachments:[] },
    quote: { contact:null, amount:null, currency:"EUR", pdf_url:null, id:null },
    crm:   { action:null, type:null, notes:null, due:null, status:"Open" },
    calendar: { title:null, start:null, end:null, location:"Google Meet" },
    requested: { email:false, quote:false, crm:false, calendar:false, search:false },
    last_plan: [],
    pending: null,
    last_updated: nowISO(),
  };
}
function loadCtx(session_id){ if (!CTX.has(session_id)) CTX.set(session_id, newCtx()); return CTX.get(session_id); }
function saveCtx(session_id, ctx){ ctx.last_updated = nowISO(); CTX.set(session_id, ctx); }

/* ───────────────────────── Optional LLM for general Q&A ───────────────────────── */
const MODEL = process.env.OPENAI_AGENT_MODEL || "gpt-4o-mini";
async function maybeLLMAnswer({ company_system_prompt, kb_json, user }){
  if (!process.env.OPENAI_API_KEY) return null;
  const sysParts = [];
  if (company_system_prompt) sysParts.push(company_system_prompt);
  const co = kb_json?.meta?.company;
  if (co) sysParts.push(`Company profile: ${JSON.stringify(co).slice(0,800)}`);
  const messages = [
    { role:"system", content: (sysParts.join("\n\n") || "You are a concise, helpful assistant. Use business context if available.") },
    { role:"user", content: user }
  ];
  try{
    const r = await fetch("https://api.openai.com/v1/chat/completions",{
      method:"POST",
      headers:{ "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type":"application/json" },
      body: JSON.stringify({ model: MODEL, temperature: 0.2, messages })
    });
    if (!r.ok) return null;
    const j = await r.json().catch(()=>null);
    return j?.choices?.[0]?.message?.content?.trim() || null;
  }catch{ return null; }
}

/* ───────────────────────── NER / Slots / Coref ───────────────────────── */
function extractName(utt=""){
  const withTitle = utt.match(/\b(Mr\.|Mrs\.|Ms\.|Dr\.)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/);
  if (withTitle) return `${withTitle[1]} ${withTitle[2]}`;
  const bare = utt.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)\b/);
  return bare ? bare[1] : null;
}
function extractAmountEUR(utt=""){
  const m = String(utt).match(/(\d[\d.,]*)\s*€|€\s*(\d[\d.,]*)/);
  if (!m) return null;
  const raw = (m[1] || m[2] || "").trim();
  const n = Number(raw.replace(/[.,](?=\d{3}\b)/g,"").replace(",",".")); // handle 3,500
  return isFinite(n) && n>0 ? Math.round(n*100)/100 : null;
}
function resolvePronounToContact(utt, ctx){
  const lower = utt.toLowerCase();
  if (/\b(him|her|them|client)\b/.test(lower) && ctx.current_contact) return ctx.current_contact;
  return null;
}
function ingestUtterance(utt, ctx){
  const name = extractName(utt) || resolvePronounToContact(utt, ctx);
  if (name){
    if (!ctx.people.find(p => p.name.toLowerCase() === name.toLowerCase())) ctx.people.push({ name });
    ctx.current_contact = name;
    if (!ctx.quote.contact) ctx.quote.contact = name;
  }
  const amt = extractAmountEUR(utt);
  if (amt) ctx.quote.amount = clamp(amt, 10, 10_000_000);
}
function extractProduct(utt=""){
  const m = utt.match(/\bproduct\s+([a-z0-9\- ]{2,40})\b/i);
  return m ? m[1].trim() : null;
}

/* ───────────────────────── Intent detection ───────────────────────── */
function detect(utt=""){
  const u = utt.toLowerCase();
  const intents = new Set();

  // Email
  if (/\b(email|e-mail|mail)\b/.test(u) && /\b(prepare|draft|write|compose|send)\b/.test(u)) intents.add("email_prepare");

  // Quote / invoice
  if (/\b(quote|proposal|estimate)\b/.test(u)) intents.add("quote_create");
  if (/\b(invoice|bill)\b/.test(u)) intents.add("invoice_create");

  // CRM
  if (/\b(crm|update crm|log|activity|follow[- ]?up|note)\b/.test(u)) intents.add("crm_update");

  // Calendar / tasks
  if (/\b(schedule|meeting|calendar|book|reminder)\b/.test(u)) intents.add("calendar_create_event");
  if (/\b(tasks?|agenda|todo|to\-do|what.*(tomorrow|today|next week))\b/.test(u)) intents.add("org_tasks_query");

  // Mailbox read
  if (/\b(mailbox|inbox|emails?|latest emails?|last emails?)\b/.test(u)) intents.add("mailbox_list");

  // Inventory
  if (/\b(inventory|stock|available|availability|in stock)\b/.test(u) || /\bproduct\s+[a-z0-9\- ]+/i.test(u)) intents.add("inventory_query");

  // Web search
  if (/\b(search|find|look up|scan|scrape|crawl)\b/.test(u) || /\b(idealista|rightmove|booking|airbnb|tripadvisor|amazon)\b/.test(u))
    intents.add("search_web");

  // Confirmations
  if (/\b(send|create|confirm|yes|go ahead|please send|ship it)\b/.test(u)) intents.add("confirm_action");

  // Conversation
  if (/\b(hi|hello|hey)\b/.test(u)) intents.add("small_talk");

  if (intents.size === 0) intents.add("general_question");
  return Array.from(intents);
}

/* ───────────────────────── Task Brief + Probing ───────────────────────── */
function buildTaskBrief(utt, ctx){
  return {
    who: ctx.current_contact || ctx.quote?.contact || null,
    what: utt,
    amount: ctx.quote?.amount || null,
    when: (/(today|tomorrow|in \d+ (?:day|days|week|weeks))/i.exec(utt)||[])[0] || null,
    artefacts: {
      wantsEmail: /\b(email|e-mail|mail)\b/i.test(utt),
      wantsQuote: /\b(quote|proposal|estimate)\b/i.test(utt),
      wantsInvoice: /\b(invoice|bill)\b/i.test(utt),
      wantsFollowUp: /\bfollow[- ]?up\b/i.test(utt),
    }
  };
}

async function preTaskProbe(req, brief, ctx, steps){
  // CRM awareness if a contact exists
  if ((brief.who || ctx.current_contact || ctx.quote?.contact)) {
    await enrichFromCRM(req, ctx, steps);
  }

  // Tasks / calendar
  if (CAP.tasks && /tasks?|agenda|tomorrow|today/i.test(brief.what)) {
    const r = await tryToolCall(req, "/api/tools/tasks_list.js", { range: "tomorrow" });
    if (r?.ok) steps.push(`Tasks: found ${r.items?.length||0} item(s) for tomorrow via provider.`);
  } else if (/tasks?|agenda|tomorrow|today/i.test(brief.what)) {
    steps.push("Tasks provider not connected — will show demo agenda.");
  }
  if (CAP.calendar && /tomorrow|today|meeting|call|schedule|book/i.test(brief.what)) {
    const r = await tryToolCall(req, "/api/tools/calendar_find_slots.js", { range: "tomorrow" });
    if (r?.ok) steps.push("Calendar probe completed.");
  }

  // Mailbox quick probe
  if (CAP.mailbox && /\b(mailbox|inbox|emails?)\b/i.test(brief.what)){
    const r = await tryToolCall(req, "/api/tools/email_read.js", { newer_than_days: 3, max: 5 });
    if (r?.ok) steps.push(`Mailbox: fetched latest ${r.items?.length||0}.`);
  }

  // Inventory quick probe if product hinted
  const prod = extractProduct(brief.what);
  if (prod && CAP.inventory){
    const r = await tryToolCall(req, "/api/tools/inventory_lookup.js", { query: prod });
    if (r?.ok) steps.push(`Inventory probe: '${prod}' checked (${r.items?.length||0} matches).`);
  }
}

/* ───────────────────────── Human voice helper ───────────────────────── */
function humanBursts({ ack, did=[], result=null, next=[] }){
  const out = [];
  if (ack) out.push(ack);
  if (did.length) out.push(`I checked: ${did.join("; ")}.`);
  if (result) out.push(result);
  if (next.length) out.push(`Next: ${next.join(" · ")}.`);
  return bursts(...out);
}

/* ───────────────────────── CRM enrichment (pre-task awareness) ───────────────────────── */
async function enrichFromCRM(req, ctx, steps){
  const contact = ctx.current_contact || ctx.quote.contact;
  if (!contact) return;
  if (CAP.crm){
    const find = await tryToolCall(req, "/api/tools/crm_find_contact.js", { query: contact });
    if (find?.ok && find?.contact){
      const c = find.contact;
      const p = ctx.people.find(p=>p.name.toLowerCase()===contact.toLowerCase());
      if (p){ p.email = c.email||p.email; p.id = c.id||p.id; }
      if (!ctx.email.to && c.email) ctx.email.to = c.email;
      steps.push(`CRM: Found ${contact} (${c.email||"no email"})`);
      const act = await tryToolCall(req, "/api/tools/crm_log_activity.js", { dry_run:true, contact_id:c.id, note:"Context check" });
      if (act?.ok) steps.push("CRM: Retrieved latest activity (summary).");
    } else {
      steps.push("CRM: No direct match (using demo profile).");
    }
  } else {
    const p = ctx.people.find(p=>p.name.toLowerCase()===contact.toLowerCase());
    if (p && !p.email) p.email = `${contact.replace(/\s+/g,'.').replace(/[^a-zA-Z.]/g,'').toLowerCase()}@example.com`;
    if (!ctx.email.to && p?.email) ctx.email.to = p.email;
    steps.push(`CRM (demo): Using ${contact} <${p?.email||"pending@crm"}>.`);
  }
}

/* ───────────────────────── Handlers (tool-first; demo fallback) ───────────────────────── */
function cardImage(summary, url){ return { format:"image", summary, value:{ url } }; }

/* EMAIL PREPARE */
function handleEmailPrepare(ctx, steps){
  const contact = ctx.current_contact || ctx.quote.contact || "your client";
  if (!ctx.email.subject) ctx.email.subject = `Follow-up on our last conversation`;
  if (!ctx.email.body){
    ctx.email.body =
`Hi ${contact.replace(/^(Mr\.|Mrs\.|Ms\.|Dr\.)\s*/,'')},

Just following up as promised. I’ve attached the document for your review.
If everything looks good, I can proceed right away.

Best regards,
Your AI Employee`;
  }
  steps.push(`Email draft ready for ${contact}.`);
  if (ctx.quote?.pdf_url && !ctx.email.attachments.find(a=>a.url===ctx.quote.pdf_url)){
    ctx.email.attachments.push({ name: `${ctx.quote.id||'Quote'}.pdf`, url: ctx.quote.pdf_url });
    steps.push("Attached quote PDF to email.");
  }
  const previewImg = imgEmailPreview({ to: ctx.email.to || contact, subject: ctx.email.subject });

  const script = humanBursts({
    ack: `On it — drafting an email to ${contact}.`,
    did: [ctx.email.to ? `found email ${ctx.email.to}` : "no email in CRM (using placeholder)"],
    result: "Draft is ready below.",
    next: ["Send now", "Edit subject", "Edit body"]
  });

  return {
    script,
    cards: [
      cardImage("Email Preview (demo)", previewImg),
      { format:"text", summary:"Email Draft (fields)", value:
        `<strong>To:</strong> ${ctx.email.to || `${contact} (email pending)`}<br/>`+
        `<strong>Subject:</strong> ${ctx.email.subject}<br/>`+
        `<pre style="white-space:pre-wrap;margin:8px 0 0 0">${ctx.email.body}</pre>`+
        (ctx.email.attachments.length?`<br/><strong>Attachments:</strong> ${ctx.email.attachments.map(a=>a.name).join(", ")}`:"")
      }
    ],
    ask: {
      context_id: traceId(),
      question: "Send the email now?",
      options: [{id:"send_email",label:"Send"}, {id:"edit_subject",label:"Edit subject"}, {id:"edit_body",label:"Edit body"}]
    }
  };
}

/* QUOTE CREATE */
function handleQuoteCreate(ctx, steps){
  const contact = ctx.current_contact || ctx.quote.contact || "your client";
  if (!ctx.quote.id) ctx.quote.id = "Q-" + Math.random().toString(36).slice(2,7).toUpperCase();
  if (!ctx.quote.amount) ctx.quote.amount = 3500;
  if (!ctx.quote.currency) ctx.quote.currency = "EUR";
  if (!ctx.quote.pdf_url) ctx.quote.pdf_url = imgPDFMock("Quote", ctx.quote.id, contact);
  steps.push(`Quote prepared for ${contact}, total ${fmtEUR(ctx.quote.amount)}.`);

  if (!ctx.email.attachments.find(a=>a.url===ctx.quote.pdf_url)){
    ctx.email.attachments.push({ name: `${ctx.quote.id}.pdf`, url: ctx.quote.pdf_url });
    steps.push("Quote attached to email draft.");
  }

  return {
    script: humanBursts({
      ack: `Creating a quote for ${contact}.`,
      result: `Total assumed ${fmtEUR(ctx.quote.amount)} (edit if needed).`,
      next: ["Send via email", "Edit amount", "Log in CRM"]
    }),
    cards: [
      cardImage("Quote PDF (preview)", ctx.quote.pdf_url),
      {
        format:"table",
        summary:"Quote Details",
        value:{
          columns:["Quote #","Customer","Date","Subtotal","Tax","Total"],
          rows:[[ctx.quote.id, contact, nowISO().slice(0,10), fmtEUR(ctx.quote.amount), fmtEUR(0), fmtEUR(ctx.quote.amount)]]
        }
      }
    ],
    ask:{
      context_id: traceId(),
      question:"Next step?",
      options:[{id:"open_email",label:"Open email draft"}, {id:"send_email",label:"Send quote via email"}, {id:"edit_amount",label:"Edit amount"}]
    }
  };
}

/* CRM UPDATE */
function handleCRMUpdate(ctx, steps){
  const contact = ctx.current_contact || ctx.quote.contact || "your client";
  if (!ctx.crm.type) ctx.crm.type = "follow_up";
  if (!ctx.crm.notes) ctx.crm.notes = "Follow-up email prepared; quote attached.";
  if (!ctx.crm.due){
    const due = new Date(Date.now() + 2*24*3600*1000);
    ctx.crm.due = due.toISOString().slice(0,10);
  }
  steps.push(`Prepared CRM ${ctx.crm.type.replace('_',' ')} for ${contact}.`);
  const crmImg = imgCRMCard({ contact, note: ctx.crm.notes });
  return {
    script: humanBursts({
      ack: `Logging a ${ctx.crm.type.replace('_',' ')} for ${contact}.`,
      result: "I’ve set a reminder and included email + quote context.",
      next: ["Keep for 2 days", "Today", "Next week"]
    }),
    cards:[ cardImage("CRM Activity (demo)", crmImg),
      { format:"table", summary:"CRM Activity (fields)", value:{
          columns:["Type","Contact","Notes","Due","Status"],
          rows:[[ctx.crm.type, contact, ctx.crm.notes, ctx.crm.due, ctx.crm.status]]
      }} ],
    ask:{
      context_id: traceId(),
      question:"Keep the reminder for 2 days?",
      options:[{id:"keep_2d",label:"Yes"}, {id:"today",label:"Today"}, {id:"next_week",label:"Next week"}]
    }
  };
}

/* CALENDAR EVENT */
function handleCalendarEvent(ctx, steps, deltaDays=3, explicit=false){
  const contact = ctx.current_contact || "client";
  const start = new Date(Date.now() + deltaDays*24*3600*1000);
  start.setHours(9,0,0,0);
  const end = new Date(start.getTime()+30*60*1000);
  ctx.calendar.title = `Call ${contact}`;
  ctx.calendar.start = start.toISOString();
  ctx.calendar.end = end.toISOString();
  steps.push(`Drafted calendar event: ${ctx.calendar.title} (${start.toLocaleString()}).`);
  const calImg = imgCalendarCard({ title: ctx.calendar.title, when: start.toLocaleString() });
  return {
    script: humanBursts({
      ack: explicit ? `Scheduling a reminder in ${deltaDays} day(s).` : "I can set that up.",
      result: `Here’s a 30-minute slot with a Meet link for ${contact}.`,
      next: ["Create the event", "Edit details"]
    }),
    cards:[ cardImage("Calendar Draft (demo)", calImg),
      { format:"table", summary:"Event (fields)", value:{
          columns:["Title","Start","End","Location"],
          rows:[[ctx.calendar.title, start.toLocaleString(), end.toLocaleString(), ctx.calendar.location]]
      }} ],
    ask:{ context_id: traceId(), question:"Create the event and invite you?", options:[{id:"create_event",label:"Create"}, {id:"edit_event",label:"Edit details"}] }
  };
}

/* ORG TASKS (agenda) */
function handleOrgTasksDemo(steps){
  steps.push("Showing agenda (demo).");
  return {
    script: humanBursts({
      ack: "Got your agenda.",
      result: "Here’s a compact view of tomorrow.",
      next: ["Create a follow-up call", "Move a task", "Email summary"]
    }),
    cards: [
      { format:"table", summary:"Tomorrow — Agenda (demo)", value:{
        columns:["Time","Item","Owner","Status"],
        rows:[
          ["09:00","Client follow-up — Rosenberg","You","Open"],
          ["11:00","Quote review — Martin","You","Open"],
          ["14:30","Ops sync","Ops","Scheduled"],
          ["16:00","Invoice check","Finance","Open"]
        ]
      } }
    ],
    ask: { context_id: traceId(), question:"Want me to book/adjust anything?", options:[
      {id:"create_event",label:"Book a call"},
      {id:"send_email",label:"Email summary"},
      {id:"not_now",label:"All good"}
    ] }
  };
}
async function handleOrgTasksQuery(req, ctx, steps){
  if (CAP.tasks){
    const r = await tryToolCall(req, "/api/tools/tasks_list.js", { range: "tomorrow" });
    if (r?.ok && Array.isArray(r.items) && r.items.length){
      steps.push(`Tasks: ${r.items.length} for tomorrow (provider).`);
      const rows = r.items.slice(0,6).map(x => [x.time||"", x.title||"", x.owner||"", x.status||"Open"]);
      return {
        script: humanBursts({
          ack: "Pulled your tasks for tomorrow.",
          result: "Here’s your agenda.",
          next: ["Book a reminder", "Send summary", "Reassign task"]
        }),
        cards: [{ format:"table", summary:"Tomorrow — Agenda", value:{ columns:["Time","Item","Owner","Status"], rows } }],
        ask: { context_id: traceId(), question:"Next step?", options:[
          {id:"create_event",label:"Book a reminder"},
          {id:"send_email",label:"Email summary"},
          {id:"not_now",label:"Done"}
        ] }
      };
    }
  }
  return handleOrgTasksDemo(steps);
}

/* MAILBOX LIST (latest emails) */
async function handleMailboxList(req, steps){
  if (CAP.mailbox){
    const r = await tryToolCall(req, "/api/tools/email_read.js", { newer_than_days: 7, max: 6 });
    if (r?.ok && Array.isArray(r.items)){
      steps.push(`Mailbox: showing ${r.items.length} latest.`);
      const rows = r.items.map(m => [m.from||"", m.subject||"", (m.date||"").slice(0,10)]);
      return {
        script: humanBursts({
          ack: "I checked our mailbox.",
          result: "Here are the most recent emails.",
          next: ["Draft replies", "Summarize threads", "Filter by sender"]
        }),
        cards: [{ format:"table", summary:"Latest Emails", value:{ columns:["From","Subject","Date"], rows } }],
        ask: { context_id: traceId(), question:"Want me to draft any replies?", options:[
          {id:"email_prepare",label:"Draft a reply"}, {id:"not_now",label:"Not now"}
        ] }
      };
    }
  }
  steps.push("Mailbox provider not connected — showing demo.");
  return {
    script: humanBursts({
      ack: "I looked up our mailbox.",
      result: "Here’s a demo of the last emails.",
      next: ["Connect mailbox", "Draft replies"]
    }),
    cards: [{ format:"table", summary:"Latest Emails (demo)", value:{
      columns:["From","Subject","Date"],
      rows:[
        ["nick@client.com","Re: Pricing update","2025-10-22"],
        ["ops@company.com","Ops sync notes","2025-10-22"],
        ["billing@vendor.io","Invoice 33445","2025-10-21"],
        ["anna@partner.com","Partnership idea","2025-10-21"]
      ]
    } }],
    ask: { context_id: traceId(), question:"Connect mailbox now?", options:[{id:"connect_mailbox",label:"Connect"},{id:"not_now",label:"Not now"}] }
  };
}

/* INVENTORY QUERY */
async function handleInventoryQuery(req, utterance, steps){
  const prod = extractProduct(utterance) || "Product X";
  if (CAP.inventory){
    const r = await tryToolCall(req, "/api/tools/inventory_lookup.js", { query: prod });
    if (r?.ok && Array.isArray(r.items)){
      steps.push(`Inventory: ${r.items.length} matches for "${prod}".`);
      const rows = r.items.slice(0,6).map(x => [x.sku||"", x.name||"", x.qty||0, x.location||""]);
      return {
        script: humanBursts({
          ack: `I checked our inventory for “${prod}”.`,
          result: "Here’s what I found.",
          next: ["Create order", "Notify sales", "Update stock"]
        }),
        cards: [{ format:"table", summary:`Inventory — ${cap(prod)}`, value:{ columns:["SKU","Name","Qty","Location"], rows } }],
        ask: { context_id: traceId(), question:"Next step?", options:[
          {id:"order_create",label:"Create order"},
          {id:"crm_update",label:"Log in CRM"},
          {id:"not_now",label:"Done"}
        ] }
      };
    }
  }
  steps.push("Inventory provider not connected — demo list.");
  return {
    script: humanBursts({
      ack: `I checked our inventory (demo) for “${prod}”.`,
      result: "Sample results below.",
      next: ["Connect inventory", "Create order (demo)"]
    }),
    cards: [{ format:"table", summary:`Inventory (demo) — ${cap(prod)}`, value:{
      columns:["SKU","Name","Qty","Location"],
      rows:[
        ["PX-001","Product X — Black","24","WH-A"],
        ["PX-002","Product X — Blue","12","WH-B"],
        ["PX-003","Product X — Pro","0","WH-A (backorder)"]
      ]
    } }],
    ask: { context_id: traceId(), question:"Proceed anyway?", options:[{id:"order_create",label:"Create order (demo)"},{id:"not_now",label:"Not now"}] }
  };
}

/* SEARCH WEB (as you had) */
async function handleSearchWeb(req, ctx, userText, steps){
  const targetSite = (userText.match(/\b(idealista|rightmove|airbnb|booking|tripadvisor|amazon)\b/i)||[])[1];
  const q = userText;
  if (CAP.browser || CAP.search){
    const r = await tryToolCall(req, CAP.browser ? "/api/tools/browser_scrape.js" : "/api/tools/search_web.js", { query:q, site:targetSite||null });
    if (r.ok && Array.isArray(r.results) && r.results.length){
      steps.push(`Searched ${targetSite||'web'} via provider.`);
      const rows = r.results.slice(0,5).map(x => [x.title||"Result", x.snippet||"", x.url||""]);
      return {
        script: humanBursts({
          ack: targetSite ? `I scanned ${targetSite}.` : "I searched the web.",
          result: "Here’s a short list — want me to go deeper?",
          next: ["Dive deeper", "This is enough"]
        }),
        cards: [
          cardImage("Results (visual demo)", imgListingsGrid({ title: targetSite ? `${targetSite} · Top matches` : "Top Results" })),
          { format:"table", summary:"Top results", value:{ columns:["Title","Snippet","URL"], rows } }
        ],
        ask: { context_id: traceId(), question:"Go deeper?", options:[{id:"deep_search",label:"Yes, dive deeper"}, {id:"enough",label:"This is enough"}] }
      };
    }
    steps.push(`Provider returned no usable results — showing demo.`);
  } else {
    steps.push("Search/browse not connected — showing demo.");
  }
  return {
    script: humanBursts({
      ack: targetSite ? `I’d normally search ${targetSite}, but it’s not connected yet.` : "Web search isn’t connected yet.",
      result: "Here’s a quick mock so you can see the flow.",
      next: ["Connect browsing", "Proceed with demo"]
    }),
    cards: [
      cardImage("Listings (demo)", imgListingsGrid({})),
      { format:"table", summary:"Example Listings (demo)", value:{
        columns:["Name","Beds","Plot","ETA to Puente Romano"],
        rows:[
          ["Villa La Vista","5","2500 m²","10 min"],
          ["Villa Mediterráneo","5","2200 m²","12 min"],
          ["Villa Sol y Mar","5","3000 m²","15 min"],
          ["Villa Oasis","5","2100 m²","14 min"],
          ["Villa Azure","5","2500 m²","13 min"],
        ]
      } }
    ],
    ask: { context_id: traceId(), question:"Connect browsing now?", options:[{id:"connect_browse",label:"Connect"}, {id:"not_now",label:"Not now"}] }
  };
}

/* EXECUTION HELPERS (real tool if connected; else demo succeeds) */
async function executeSendEmail(req, ctx, steps){
  const to = ctx.email.to || (ctx.current_contact || "contact");
  const payload = {
    to,
    subject: ctx.email.subject,
    html: `<p>${(ctx.email.body||"").replace(/\n/g,"<br/>")}</p>`,
    attachments: ctx.email.attachments || []
  };
  if (CAP.email){
    const r = await tryToolCall(req, "/api/tools/email_send.js", payload);
    if (r.ok){ steps.push("Email sent via provider."); return { ok:true }; }
    steps.push(`Email provider failed: ${r.error}`);
  } else {
    steps.push("Email provider not connected — demo-sent.");
  }
  return { ok:true, demo:true };
}
async function executeCreateEvent(req, ctx, steps){
  const payload = {
    title: ctx.calendar.title,
    start_iso: ctx.calendar.start,
    end_iso: ctx.calendar.end,
    attendees: []
  };
  if (CAP.calendar){
    const r = await tryToolCall(req, "/api/tools/calendar_create_event.js", payload);
    if (r.ok){ steps.push("Calendar event created."); return { ok:true, event_id:r.event_id }; }
    steps.push(`Calendar provider failed: ${r.error}`);
  } else {
    steps.push("Calendar provider not connected — demo-created.");
  }
  return { ok:true, demo:true };
}
async function executeCRMLog(req, ctx, steps, extraNote=null){
  const contact = ctx.current_contact || ctx.quote.contact || "your client";
  const note = extraNote || ctx.crm.notes || "Follow-up recorded.";
  if (CAP.crm){
    const r = await tryToolCall(req, "/api/tools/crm_log_activity.js", {
      contact: contact, note, type: ctx.crm.type||"follow_up", due: ctx.crm.due
    });
    if (r.ok){ steps.push("CRM updated with latest activity."); return { ok:true }; }
    steps.push(`CRM update failed: ${r.error}`);
  } else {
    steps.push("CRM not connected — demo logged.");
  }
  return { ok:true, demo:true };
}
/* SMALL TALK / GENERAL Q */
function handleSmallTalk(){
  return {
    script: bursts("Hey — I’m here.","Ask me to create, send, schedule, or look up anything."),
    cards: [], ask: null, steps:["Greeted user"]
  };
}
async function handleGeneralQuestion(utterance, kb_json, company_system_prompt){
  let text = await maybeLLMAnswer({ company_system_prompt, kb_json, user: utterance });
  if (!text){
    const co = kb_json?.meta?.company?.name || "our company";
    text = `Here’s a concise answer based on what I know about ${co}. If you'd like, I can also take action for you.`;
  }
  return { script: bursts(text), cards: [], ask:null, steps:["Answered via KB/LLM (or demo)."] };
}

/* PLANNER */
function buildPlan(intents, ctx, utterance){
  const plan = [];
  const wantsEmail   = intents.includes("email_prepare");
  const wantsQuote   = intents.includes("quote_create");
  const wantsCRM     = intents.includes("crm_update");
  const wantsCal     = intents.includes("calendar_create_event");
  const wantsSearch  = intents.includes("search_web");
  const wantsTasks   = intents.includes("org_tasks_query");
  const wantsMailbox = intents.includes("mailbox_list");
  const wantsInv     = intents.includes("inventory_query");
  const wantsConfirm = intents.includes("confirm_action");

  if (wantsEmail && wantsQuote){ plan.push("quote_create"); plan.push("email_prepare"); }
  else if (wantsQuote){ plan.push("quote_create"); }
  if (wantsEmail && !plan.includes("email_prepare")) plan.push("email_prepare");

  if (wantsCRM) plan.push("crm_update");
  if (wantsCal) plan.push("calendar_create_event");
  if (wantsTasks) plan.push("org_tasks_query");
  if (wantsMailbox) plan.push("mailbox_list");
  if (wantsInv) plan.push("inventory_query");
  if (wantsSearch) plan.push("search_web");
  if (wantsConfirm) plan.push("confirm_action");

  if (intents.includes("small_talk")) plan.push("small_talk");
  if (intents.includes("general_question") && plan.length===0) plan.push("general_question");
  return plan;
}

/* CONFIRMATION (execute + persist back to tools) */
async function handleConfirmation(req, ctx, steps, utterance){
  const u = utterance.toLowerCase();

  if ((ctx.pending && ctx.pending.type==="send_email") || /\b(send|email)\b/.test(u)){
    await executeSendEmail(req, ctx, steps);
    await executeCRMLog(req, ctx, steps, "Email sent with latest quote attached.");
    return { script: bursts("Done — I sent the email.","I’ve also logged the activity in our CRM."), cards: [], ask: null };
  }

  if ((ctx.pending && ctx.pending.type==="create_event") || /\b(create|book)\b/.test(u)){
    await executeCreateEvent(req, ctx, steps);
    await executeCRMLog(req, ctx, steps, "Calendar event created for follow-up call.");
    return { script: bursts("Calendar event created.","I noted it in the CRM as well."), cards: [], ask: null };
  }

  return { script: bursts("Got it — tell me ‘send’ or ‘create’ when you’re ready."), cards: [], ask: null };
}

/* ───────────────────────── Main route ───────────────────────── */
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

    let {
      utterance = "",
      mode = "text",
      history = [],
      tenant = null, token = null,
      kb_json = null, company_system_prompt = null,
      session_id = "demo"
    } = readBody(req);

    const ctx = loadCtx(session_id);
    ingestUtterance(utterance, ctx);

    const intents = detect(utterance);
    let plan = buildPlan(intents, ctx, utterance);
    const steps = [];

    // ENTER STICKY TASK MODE if we have execution intents
    if (plan.some(p => ["email_prepare","quote_create","invoice_create","crm_update","calendar_create_event","org_tasks_query","mailbox_list","inventory_query","search_web","confirm_action"].includes(p))) {
      ctx.mode = "task";
      ctx.focus = plan.join("+");
    }
    // If in task mode, avoid drifting to general chit-chat
    if (ctx.mode === "task" && !(plan.length === 1 && plan[0] === "general_question")) {
      const idx = plan.indexOf("general_question");
      if (idx >= 0) plan.splice(idx, 1);
    }

    const brief = buildTaskBrief(utterance, ctx);
    await preTaskProbe(req, brief, ctx, steps);

    const script = [];
    const cards  = [];
    let ask = null;

    if (plan.length > 1 && !(plan.length===1 && plan[0]==="general_question")){
      script.push(...bursts(`Plan: ${plan.map(p => p.replace(/_/g,' ')).join(' → ')}.`));
      steps.push(`Planner: ${plan.join(' -> ')}`);
    }

    for (const step of plan){
      let out = null;

      if (step === "quote_create"){
        out = handleQuoteCreate(ctx, steps);
        ctx.pending = { type:"send_email" };

      } else if (step === "email_prepare"){
        out = handleEmailPrepare(ctx, steps);
        ctx.pending = { type:"send_email" };

      } else if (step === "crm_update"){
        out = handleCRMUpdate(ctx, steps);

      } else if (step === "calendar_create_event"){
        const m = utterance.toLowerCase().match(/\bin\s+(\d+)\s+day/);
        const days = m ? clamp(parseInt(m[1],10), 0, 365) : 3;
        out = handleCalendarEvent(ctx, steps, days, !!m);
        ctx.pending = { type:"create_event" };

      } else if (step === "org_tasks_query"){
        out = await handleOrgTasksQuery(req, ctx, steps);

      } else if (step === "mailbox_list"){
        out = await handleMailboxList(req, steps);

      } else if (step === "inventory_query"){
        out = await handleInventoryQuery(req, utterance, steps);

      } else if (step === "search_web"){
        out = await handleSearchWeb(req, ctx, utterance, steps);

      } else if (step === "confirm_action"){
        out = await handleConfirmation(req, ctx, steps, utterance);

      } else if (step === "small_talk"){
        out = handleSmallTalk();

      } else if (step === "general_question"){
        out = await handleGeneralQuestion(utterance, kb_json, company_system_prompt);
      }

      if (out){
        if (out.script) script.push(...out.script);
        if (out.cards)  cards.push(...out.cards);
        if (out.ask)    ask = out.ask; // last ask wins
      }
    }

    // Persist context
    ctx.last_plan = plan;
    // Exit task mode on clear “thanks/done/stop”
    if (/\b(thanks|thank you|done|that’s all|stop)\b/i.test(utterance)) {
      ctx.mode = "idle";
      ctx.focus = null;
    }
    saveCtx(session_id, ctx);

    // Fallback if nothing planned
    if (plan.length === 0){
      const fallback = handleSmallTalk();
      script.push(...fallback.script);
      steps.push(...fallback.steps);
    }

    return okJSON(res, {
      mode,
      script,
      cards,
      ask,
      meta: {
        intent: plan[0] || "general",
        trace_id: traceId(),
        steps,
        plan,
        session_id,
        tools_connected: CAP
      }
    });

  } catch (e) {
    return errJSON(res, e?.message || e);
  }
};
