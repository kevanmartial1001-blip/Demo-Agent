// /api/demoAgent.js
// Human-like assistant with context, planner, tool auto-detection, and graceful demo fallbacks.

module.exports.config = { runtime: "nodejs" };

/* ───────────────────────── Utils ───────────────────────── */
function traceId(){ return "trc_" + Math.random().toString(36).slice(2,10); }
function nowISO(){ return new Date().toISOString(); }
function fmtEUR(n){ try { return new Intl.NumberFormat(undefined,{style:'currency',currency:'EUR'}).format(n); } catch { return `€${(+n||0).toFixed(2)}`; } }
function okJSON(res, obj){ try{ res.setHeader("Content-Type","application/json"); }catch{} return res.status(200).json(obj); }
function errJSON(res, msg){ try{ res.setHeader("Content-Type","application/json"); }catch{} return res.status(200).json({
  mode:"text",
  script:[{ text:"Something went wrong — I switched to safe demo mode.", delay_ms:0, show_role:true }],
  cards:[{ format:"text", summary:"Error", value:String(msg) }],
  meta:{ error:true, trace_id: traceId(), steps:["Caught error in /api/demoAgent; returned fallback."] }
});}
function readBody(req){
  try{
    if (req && typeof req.body === "object" && req.body !== null) return req.body;
    if (req && typeof req.body === "string") return JSON.parse(req.body || "{}");
  }catch{}
  return {};
}
function bursts(...lines){ return lines.map((text,i)=>({ text, delay_ms: 300, show_role: i===0 })); }
function clamp(n,min,max){ return Math.min(max, Math.max(min, n)); }

/* ─────────────── Realism helpers (IDs, dates, names) ─────────────── */
function naturalId(prefix="Q") {
  const n = Math.floor(10000 + Math.random() * 90000);
  return `${prefix}-${n}`;
}
function shortDate(d = new Date()) {
  try { return new Intl.DateTimeFormat(undefined, { year:"numeric", month:"short", day:"2-digit"}).format(new Date(d)); }
  catch { return String(d).slice(0,10); }
}
function personName(raw) {
  return String(raw||"").replace(/\b(Mr|Mrs|Ms|Dr)\b(?!\.)/, "$1");
}

/* ───────────────────────── Tool auto-detection ───────────────────────── */
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

/* ───────────────────────── Visual mocks ───────────────────────── */
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
function imgListingsGrid({title="Marbella · 5-bed · Sea view · 2000m²+"}={}) {
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
    email: { to:null, subject:null, body:null, attachments:[] },
    quote: { contact:null, amount:null, currency:"EUR", pdf_url:null, id:null },
    invoice: null,
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
  const n = Number(raw.replace(/[.,](?=\d{3}\b)/g,"").replace(",",".")); // 3.500,00 → 3500
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

/* ───────────────────────── Intent detection ───────────────────────── */
function detect(utt=""){
  const u = utt.toLowerCase();
  const intents = [];
  if (/\b(email|e-mail|mail)\b/.test(u) && /\b(prepare|draft|write|compose|send)\b/.test(u)) intents.push("email_prepare");
  if (/\b(quote|proposal|estimate)\b/.test(u) && !/\b(no|not|without)\s+(quote|proposal|estimate)\b/.test(u)) intents.push("quote_create");
  if (/\b(invoice|bill)\b/.test(u)) intents.push("invoice_create");
  if (/\b(crm|update crm|log|activity|follow[- ]?up|note)\b/.test(u) || /\b(check|latest)\b.*\b(crm)\b/.test(u)) intents.push("crm_update_or_summary");
  if (/\b(schedule|meeting|calendar|book|reminder)\b/.test(u)) intents.push("calendar_create_event");
  if (/\b(search|find|look up|scan|scrape|crawl)\b/.test(u) || /\b(idealista|rightmove|booking|airbnb|tripadvisor)\b/.test(u)) intents.push("search_web");
  if (/\b(send|create|confirm|yes|go ahead|please send|ship it)\b/.test(u)) intents.push("confirm_action");
  if (/\b(hi|hello|hey|what can you do|who are you)\b/.test(u)) intents.push("small_talk");
  if (intents.length===0) intents.push("general_question");
  return intents;
}

/* ───────────────────────── CRM enrichment ───────────────────────── */
async function enrichFromCRM(req, ctx, steps){
  const contact = ctx.current_contact || ctx.quote.contact;
  if (!contact) return { found:false };
  if (CAP.crm){
    const find = await tryToolCall(req, "/api/tools/crm_find_contact.js", { query: contact });
    if (find?.ok && find?.contact){
      const c = find.contact;
      const p = ctx.people.find(p=>p.name.toLowerCase()===contact.toLowerCase());
      if (p){ p.email = c.email||p.email; p.id = c.id||p.id; }
      if (!ctx.email.to && c.email) ctx.email.to = c.email;
      steps.push(`CRM: Found ${contact} (${c.email||"no email"})`);
      // Pull last 3 activities if tool supports
      const act = await tryToolCall(req, "/api/tools/crm_log_activity.js", { dry_run:true, contact_id:c.id, note:"Context check" });
      if (act?.ok) steps.push("CRM: Retrieved latest activity (summary).");
      return { found:true, contact:c, items: act?.items || [] };
    } else {
      steps.push("CRM: No direct match (using demo profile).");
      return { found:false };
    }
  } else {
    // demo enrichment
    const p = ctx.people.find(p=>p.name.toLowerCase()===contact.toLowerCase()) || {name:contact};
    if (!p.email) p.email = `${contact.replace(/\s+/g,'.').replace(/[^a-zA-Z.]/g,'').toLowerCase()}@example.com`;
    if (!ctx.email.to) ctx.email.to = p.email;
    steps.push(`CRM (demo): Using ${contact} <${p.email}>.`);
    const items = [
      { date: new Date(Date.now()-24*3600*1000), kind:"Email", note:"Asked about pricing tiers" },
      { date: new Date(Date.now()-2*24*3600*1000), kind:"Call", note:"Requested timeline update" },
      { date: new Date(Date.now()-4*24*3600*1000), kind:"Note", note:"Meeting scheduled for next week" },
    ];
    return { found:true, contact:{ id:"demo", email:p.email, name:contact }, items };
  }
}

/* ───────────────────────── Render helpers ───────────────────────── */
function cardImage(summary, url){ return { format:"image", summary, value:{ url } }; }

/* ───────────────────────── Step: Email Prepare ───────────────────────── */
function step_prepare_email(ctx, steps, grounding) {
  const contact = personName(ctx.current_contact || ctx.quote.contact || "the client");
  if (!ctx.email.subject) ctx.email.subject = `Follow-up on our last conversation`;
  if (!ctx.email.body){
    const lastNote = grounding?.items?.[0];
    const ref = lastNote ? ` following up on ${shortDate(lastNote.date)} about “${lastNote.note}”.` : ".";
    ctx.email.body =
`Hi ${contact.replace(/^(Mr\.|Mrs\.|Ms\.|Dr\.)\s*/,'')},

I’m ${process.env.ASSISTANT_NAME || "your AI assistant"} from our team${ref}
If it helps, I can send updated details right away.

Best regards,
${process.env.AGENT_SIGNATURE || "Your AI Employee"}`;
  }

  // attach quote if exists
  if (ctx.quote?.pdf_url && !ctx.email.attachments.find(a=>a.url===ctx.quote.pdf_url)){
    ctx.email.attachments.push({ name: `${ctx.quote.id||'Quote'}.pdf`, url: ctx.quote.pdf_url });
    steps.push("Attached quote PDF to email.");
  }

  const previewHTML = `
    <div style="font-family:ui-sans-serif,system-ui,Segoe UI,Arial;max-width:680px">
      <div style="border-bottom:1px solid #e5e7eb;padding-bottom:8px;margin-bottom:12px">
        <div><strong>To:</strong> ${ctx.email.to || `${contact} (add email)`}</div>
        <div><strong>Subject:</strong> ${ctx.email.subject}</div>
        <div style="color:#6b7280">${shortDate()}</div>
      </div>
      <div style="white-space:pre-wrap;line-height:1.6">${ctx.email.body}</div>
    </div>`.trim();

  steps.push("Prepared email draft referencing the latest context.");

  return {
    script: bursts(
      grounding?.items?.length
        ? `I checked our CRM — last note was “${grounding.items[0].note}” on ${shortDate(grounding.items[0].date)}.`
        : `I checked our CRM for ${contact}.`,
      `I drafted an email to ${contact}. Tell me what to tweak.`
    ),
    cards: [
      { format:"text", summary:"Email Preview", value: previewHTML }
    ],
    ask: { question:"Send the email now?", options:[{id:"send_email",label:"Send"},{id:"edit_subject",label:"Edit subject"},{id:"edit_body",label:"Edit body"}] }
  };
}

/* ───────────────────────── Step: CRM Summary (human) ───────────────────────── */
function step_summarize_context(ctx, grounding) {
  const contact = personName(ctx.current_contact || ctx.quote.contact || "the client");
  const items = grounding?.items || [];
  let lines = [];
  if (items.length) {
    for (const it of items.slice(0,3)) {
      lines.push(`• ${shortDate(it.date)} — ${it.kind}: ${it.note}`);
    }
  }
  const firstBurst = items.length
    ? `I checked our CRM for ${contact}. Here’s what’s most recent:`
    : `I checked our CRM for ${contact}, but there’s no recent activity logged.`;

  return {
    script: bursts(firstBurst, lines.join(" ")),
    cards: [],
    ask: { question:"Want me to draft a follow-up or set a reminder?", options:[{id:"draft_email",label:"Draft email"},{id:"set_reminder",label:"Set reminder"}] }
  };
}

/* ───────────────────────── Step: Quote Create (humanized) ───────────────────────── */
function step_quote_create(ctx, steps) {
  const contact = personName(ctx.current_contact || ctx.quote.contact || "the client");
  if (!ctx.quote.id) ctx.quote.id = naturalId("Q");
  if (!ctx.quote.amount) ctx.quote.amount = 3500;
  if (!ctx.quote.currency) ctx.quote.currency = "EUR";
  if (!ctx.quote.pdf_url) ctx.quote.pdf_url = imgPDFMock("Quote", ctx.quote.id, contact);
  steps.push(`Quote prepared for ${contact}, total ${fmtEUR(ctx.quote.amount)}.`);

  if (!ctx.email.attachments.find(a=>a.url===ctx.quote.pdf_url)){
    ctx.email.attachments.push({ name: `${ctx.quote.id}.pdf`, url: ctx.quote.pdf_url });
    steps.push("Quote attached to email draft.");
  }

  return {
    script: bursts(
      `I prepared a quote for ${contact}.`,
      `Total ${fmtEUR(ctx.quote.amount)} — say the word if you want changes.`
    ),
    cards: [
      { format:"image", summary:"Quote PDF", value:{ url: ctx.quote.pdf_url } },
      { format:"table", summary:"Quote Details", value:{
        columns:["Quote #","Customer","Date","Subtotal","Tax","Total"],
        rows:[[ctx.quote.id, contact, shortDate(), fmtEUR(ctx.quote.amount), fmtEUR(0), fmtEUR(ctx.quote.amount)]]
      } }
    ],
    ask:{ question:"Next step?", options:[{id:"open_email",label:"Open email draft"}, {id:"send_email",label:"Send quote via email"}, {id:"edit_amount",label:"Edit amount"}] }
  };
}

/* ───────────────────────── Step: CRM Update (keep concise) ───────────────────────── */
function step_crm_update(ctx, steps) {
  const contact = personName(ctx.current_contact || ctx.quote.contact || "the client");
  if (!ctx.crm.type) ctx.crm.type = "follow_up";
  if (!ctx.crm.notes) ctx.crm.notes = "Follow-up email prepared; waiting for reply.";
  if (!ctx.crm.due){
    const due = new Date(Date.now() + 2*24*3600*1000);
    ctx.crm.due = due.toISOString().slice(0,10);
  }
  steps.push(`Prepared CRM ${ctx.crm.type.replace('_',' ')} for ${contact}.`);
  const crmImg = imgCRMCard({ contact, note: ctx.crm.notes });

  return {
    script: bursts(
      `I logged a ${ctx.crm.type.replace('_',' ')} for ${contact}.`,
      "I set a short reminder so this doesn’t slip."
    ),
    cards:[ cardImage("CRM Activity", crmImg),
      { format:"table", summary:"CRM Activity (fields)", value:{
          columns:["Type","Contact","Notes","Due","Status"],
          rows:[[ctx.crm.type, contact, ctx.crm.notes, ctx.crm.due, ctx.crm.status]]
      }} ],
    ask:{
      question:"Keep the reminder for 2 days?",
      options:[{id:"keep_2d",label:"Yes"}, {id:"today",label:"Today"}, {id:"next_week",label:"Next week"}]
    }
  };
}

/* ───────────────────────── Step: Calendar Event ───────────────────────── */
function step_calendar_event(ctx, steps, days=3) {
  const contact = personName(ctx.current_contact || "client");
  const start = new Date(Date.now() + days*24*3600*1000);
  start.setHours(9,0,0,0);
  const end = new Date(start.getTime()+30*60*1000);
  ctx.calendar.title = `Call ${contact}`;
  ctx.calendar.start = start.toISOString();
  ctx.calendar.end = end.toISOString();
  steps.push(`Drafted calendar event: ${ctx.calendar.title} (${start.toLocaleString()}).`);
  const calImg = imgCalendarCard({ title: ctx.calendar.title, when: start.toLocaleString() });

  return {
    script: bursts(`I can set a quick call with ${contact}.`, `Here’s a 30-minute slot with a Meet link.`),
    cards: [
      cardImage("Calendar Draft", calImg),
      { format:"table", summary:"Event (fields)", value:{
          columns:["Title","Start","End","Location"],
          rows:[[ctx.calendar.title, start.toLocaleString(), end.toLocaleString(), ctx.calendar.location]]
      }}
    ],
    ask:{ question:"Create the event and invite you?", options:[{id:"create_event",label:"Create"}, {id:"edit_event",label:"Edit details"}] }
  };
}

/* ───────────────────────── Step: Search / Browse (humanized) ───────────────────────── */
async function step_search_or_scrape(req, ctx, userText, steps){
  const targetSite = (userText.match(/\b(idealista|rightmove|airbnb|booking|tripadvisor)\b/i)||[])[1];
  const q = userText;
  if (CAP.browser || CAP.search){
    const r = await tryToolCall(req, CAP.browser ? "/api/tools/browser_scrape.js" : "/api/tools/search_web.js", { query:q, site:targetSite||null });
    if (r.ok && Array.isArray(r.results) && r.results.length){
      steps.push(`Searched ${targetSite||'web'} via provider.`);
      const rows = r.results.slice(0,5).map(x => [x.title||"Result", x.snippet||"", x.url||""]);
      return {
        script: bursts(
          targetSite ? `I scanned ${targetSite} and pulled top matches.` : "I searched the web and pulled the top results.",
          "Here’s a short list — want me to go deeper?"
        ),
        cards: [
          cardImage("Results", imgListingsGrid({ title: targetSite ? `${targetSite} · Top matches` : "Top Results" })),
          { format:"table", summary:"Top results", value:{ columns:["Title","Snippet","URL"], rows } }
        ],
        ask: { question:"Go deeper or shortlist?", options:[{id:"deep_search",label:"Go deeper"}, {id:"enough",label:"Shortlist this"}] }
      };
    }
    steps.push(`Provider returned no usable results — showing demo.`);
  } else {
    steps.push("Search/browse not connected — showing demo.");
  }
  // Demo fallback
  return {
    script: bursts(
      targetSite ? `I’d normally search ${targetSite}, but it isn’t connected yet.` : "Web search isn’t connected yet.",
      "Here’s a quick mock so you can see the flow."
    ),
    cards: [
      cardImage("Listings", imgListingsGrid({})),
      { format:"table", summary:"Example Listings", value:{
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
    ask: { question:"Connect browsing now?", options:[{id:"connect_browse",label:"Connect"}, {id:"not_now",label:"Not now"}] }
  };
}

/* ───────────────────────── Executions ───────────────────────── */
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
  const payload = { title: ctx.calendar.title, start_iso: ctx.calendar.start, end_iso: ctx.calendar.end, attendees: [] };
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
  const contact = ctx.current_contact || ctx.quote.contact || "the client";
  const note = extraNote || ctx.crm.notes || "Follow-up recorded.";
  if (CAP.crm){
    const r = await tryToolCall(req, "/api/tools/crm_log_activity.js", {
      contact, note, type: ctx.crm.type||"follow_up", due: ctx.crm.due
    });
    if (r.ok){ steps.push("CRM updated with latest activity."); return { ok:true }; }
    steps.push(`CRM update failed: ${r.error}`);
  } else {
    steps.push("CRM not connected — demo logged.");
  }
  return { ok:true, demo:true };
}

/* ───────────────────────── Small talk / General Q ───────────────────────── */
function handleSmallTalk(){
  return { script: bursts("I’m here — what can I do for you?","Ask me to create, send, schedule, or look up anything."), cards: [], ask: null, steps:["Greeted user"] };
}
async function handleGeneralQuestion(utterance, kb_json, company_system_prompt){
  let text = await maybeLLMAnswer({ company_system_prompt, kb_json, user: utterance });
  if (!text){
    const co = kb_json?.meta?.company?.name || "your business";
    text = `Here’s a concise answer based on what I know about ${co}. If you'd like, I can also take action for you.`;
  }
  return { script: bursts(text), cards: [], ask:null, steps:["Answered via KB/LLM (or demo)."] };
}

/* ───────────────────────── Planner ───────────────────────── */
function buildPlan(intents){
  const plan = [];
  const has = (i)=>intents.includes(i);
  if (has("quote_create")) plan.push("quote_create");
  if (has("email_prepare")) plan.push("email_prepare");
  if (has("crm_update_or_summary")) plan.push("crm_update_or_summary");
  if (has("calendar_create_event")) plan.push("calendar_create_event");
  if (has("search_web")) plan.push("search_web");
  if (has("confirm_action")) plan.push("confirm_action");
  if (has("small_talk")) plan.push("small_talk");
  if (intents.includes("general_question") && plan.length===0) plan.push("general_question");
  return plan;
}

/* ───────────────────────── Confirmation routing ───────────────────────── */
async function handleConfirmation(req, ctx, steps, utterance){
  const u = utterance.toLowerCase();
  if ((ctx.pending && ctx.pending.type==="send_email") || /\bsend\b/.test(u)){
    await executeSendEmail(req, ctx, steps);
    await executeCRMLog(req, ctx, steps, "Email sent with latest context.");
    return { script: bursts("Done — email sent.","I noted it in our CRM."), cards: [], ask: null };
  }
  if ((ctx.pending && ctx.pending.type==="create_event") || /\bcreate\b/.test(u)){
    await executeCreateEvent(req, ctx, steps);
    await executeCRMLog(req, ctx, steps, "Calendar event created for follow-up call.");
    return { script: bursts("Calendar event created.","I also noted it in the CRM."), cards: [], ask: null };
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
    const plan = buildPlan(intents);
    const steps = [];

    // Awareness via CRM when a person is involved
    let grounding = null;
    if ((plan.includes("email_prepare") || plan.includes("quote_create") || plan.includes("crm_update_or_summary") || plan.includes("calendar_create_event")) && (ctx.current_contact || ctx.quote.contact)){
      grounding = await enrichFromCRM(req, ctx, steps);
    }

    const script = [];
    const cards  = [];
    let ask = null;

    if (plan.length > 1 && !(plan.length===1 && plan[0]==="general_question")){
      script.push(...bursts(`Plan: probe context → prepare → deliver.`));
      steps.push(`Planner: ${plan.join(' -> ')}`);
    }

    for (const step of plan){
      let out = null;

      if (step === "quote_create"){
        out = step_quote_create(ctx, steps);
        ctx.pending = { type:"send_email" };

      } else if (step === "email_prepare"){
        out = step_prepare_email(ctx, steps, grounding);
        ctx.pending = { type:"send_email" };

      } else if (step === "crm_update_or_summary"){
        out = step_summarize_context(ctx, grounding);

      } else if (step === "calendar_create_event"){
        const m = utterance.toLowerCase().match(/\bin\s+(\d+)\s+day/);
        const days = m ? clamp(parseInt(m[1],10), 0, 365) : 3;
        out = step_calendar_event(ctx, steps, days);
        ctx.pending = { type:"create_event" };

      } else if (step === "search_web"){
        out = await step_search_or_scrape(req, ctx, utterance, steps);

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
        if (out.ask)    ask = out.ask;
      }
    }

    // Persist
    ctx.last_plan = plan;
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
