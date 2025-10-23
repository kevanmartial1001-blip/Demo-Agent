// /api/demoAgent.js
// Human-like assistant with Analyzer → Probe → Plan → Execute → Humanize
// Works with 44 tools via a registry + graceful demo fallbacks.
// No external deps. Drop-in for Vercel Node runtime.

module.exports.config = { runtime: "nodejs18.x" };

/* ───────────────────────── Utils ───────────────────────── */
function traceId(){ return "trc_" + Math.random().toString(36).slice(2,10); }
function nowISO(){ return new Date().toISOString(); }
function fmtEUR(n){ try { return new Intl.NumberFormat('en-US',{style:'currency',currency:'EUR'}).format(n); } catch { return `€${(+n||0).toFixed(2)}`; } }
function clamp(n,min,max){ return Math.min(max, Math.max(min, n)); }

function okJSON(res, obj){
  try{ res.setHeader("Content-Type","application/json"); }catch{}
  return res.status(200).json(obj);
}
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

/* ───────────────────────── Capability flags ─────────────────────────
   Set env vars per client to auto-enable real providers;
   otherwise we render great demo output with mocks.
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
  ai:       !!process.env.AI_PROVIDER,     // generic AI helpers
  dev:      !!process.env.DEVOPS_PROVIDER, // repos / ops
  gov:      !!process.env.GOV_PROVIDER,    // policy / pii
  mem:      !!process.env.MEM_PROVIDER     // memory / logs
};

/* ───────────────────────── Tool call helper ───────────────────────── */
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

/* ───────────────────────── Visual mock helpers ───────────────────────── */
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

/* ───────────────────────── In-memory context ───────────────────────── */
const CTX = new Map();
function newCtx(){
  return {
    people: [],                     // [{name, email?, id?}]
    current_contact: null,
    tone: "professional",
    email: { to:null, subject:null, body:null, attachments:[] },
    quote: { contact:null, amount:null, currency:"EUR", pdf_url:null, id:null },
    invoice: null,
    crm:   { action:null, type:null, notes:null, due:null, status:"Open" },
    calendar: { title:null, start:null, end:null, location:"Google Meet" },
    last_plan: [],
    pending: null,                  // e.g., { type:'send_email'|'create_event' }
    last_user_utterance: "",
    last_updated: nowISO()
  };
}
function loadCtx(session_id){ if (!CTX.has(session_id)) CTX.set(session_id, newCtx()); return CTX.get(session_id); }
function saveCtx(session_id, ctx){ ctx.last_updated = nowISO(); CTX.set(session_id, ctx); }

/* ───────────────────────── Optional LLM (general Q&A) ───────────────────────── */
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

/* ───────────────────────── NER / Slots ───────────────────────── */
function extractName(utt=""){
  const titled = utt.match(/\b(Mr\.|Mrs\.|Ms\.|Dr\.)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/);
  if (titled) return `${titled[1]} ${titled[2]}`;
  const bare = utt.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)\b/);
  return bare ? bare[1] : null;
}
function resolvePronounToContact(utt, ctx){
  const lower = utt.toLowerCase();
  if (/\b(him|her|them|client)\b/.test(lower) && ctx.current_contact) return ctx.current_contact;
  return null;
}
function extractAmountEUR(utt=""){
  const m = String(utt).match(/(\d[\d.,]*)\s*€|€\s*(\d[\d.,]*)/);
  if (!m) return null;
  const raw = (m[1] || m[2] || "").trim();
  const n = Number(raw.replace(/[.,](?=\d{3}\b)/g,"").replace(",",".")); // naive normalization
  return isFinite(n) && n>0 ? Math.round(n*100)/100 : null;
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
/* ───────────────────────── Classic handlers (kept & reused) ───────────────────────── */
function cardImage(summary, url){ return { format:"image", summary, value:{ url } }; }

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
    script: bursts(`Creating a quote for ${contact}.`, `Assuming total ${fmtEUR(ctx.quote.amount)} — change if needed.`, "Quote is ready and attached to the email draft."),
    cards: [
      cardImage("Quote PDF (preview)", ctx.quote.pdf_url),
      { format:"table", summary:"Quote Details", value:{ columns:["Quote #","Customer","Date","Subtotal","Tax","Total"], rows:[[ctx.quote.id, contact, nowISO().slice(0,10), fmtEUR(ctx.quote.amount), fmtEUR(0), fmtEUR(ctx.quote.amount)]] } }
    ],
    ask: { question:"Next step?", options:[{id:"open_email",label:"Open email draft"},{id:"send_email",label:"Send quote via email"},{id:"edit_amount",label:"Edit amount"}] }
  };
}

async function handleGeneralQuestion(utterance, kb_json, company_system_prompt){
  let text = await maybeLLMAnswer({ company_system_prompt, kb_json, user: utterance });
  if (!text){
    const co = kb_json?.meta?.company?.name || "your business";
    text = `Here’s a concise answer based on what I know about ${co}. If you'd like, I can also take action for you.`;
  }
  return { script: bursts(text), cards: [], ask:null, steps:["Answered via KB/LLM (or demo)."] };
}

/* ───────────────────────── Tool Registry (all 44) ───────────────────────── */
const TOOL_REGISTRY = {
  // Messaging & comms
  email_send:            { path: "/api/tools/email_send.js",            cap: "email",    mock: ({to,subject}) => ({ ok:true, demo:true, id:"mail_demo_1", preview: imgEmailPreview({to,subject}) }) },
  email_read:            { path: "/api/tools/email_read.js",            cap: "email",    mock: ({contact}) => ({ ok:true, demo:true, threads: [
                              { subject:"Re: Pricing", from:`${contact||'client'}@example.com`, date:"2025-10-22", snippet:"Thanks for the update…" },
                              { subject:"Specs", from:`${contact||'client'}@example.com`, date:"2025-10-20", snippet:"Attaching the requested…" }
                            ]}) },
  chat_send:             { path: "/api/tools/chat_send.js",             cap: "chat",     mock: ({to}) => ({ ok:true, demo:true, message_id:"chat_demo_1" }) },
  sms_send:              { path: "/api/tools/sms_send.js",              cap: "sms",      mock: ({to}) => ({ ok:true, demo:true, sid:"sms_demo_1" }) },
  whatsapp_send:         { path: "/api/tools/whatsapp_send.js",         cap: "whatsapp", mock: ({to}) => ({ ok:true, demo:true, sid:"wa_demo_1" }) },

  // Voice (kept for completeness; UI call mode removed)
  voice_call:            { path: "/api/tools/voice_call.js",            cap: "voice",    mock: ({to}) => ({ ok:true, demo:true, call_id:"call_demo_1" }) },

  // Calendar
  calendar_create_event: { path: "/api/tools/calendar_create_event.js", cap: "calendar", mock: ({title,start_iso,end_iso}) => ({ ok:true, demo:true, event_id:"evt_demo_1", image: imgCalendarCard({title, when:new Date(start_iso||Date.now()).toLocaleString()}) }) },
  calendar_find_slots:   { path: "/api/tools/calendar_find_slots.js",   cap: "calendar", mock: () => ({ ok:true, demo:true, slots:[
                              { start_iso: new Date(Date.now()+86400000).toISOString(), end_iso: new Date(Date.now()+86400000+1800000).toISOString() },
                              { start_iso: new Date(Date.now()+2*86400000).toISOString(), end_iso: new Date(Date.now()+2*86400000+1800000).toISOString() }
                            ]}) },

  // Docs / sheets / slides / files / pdf
  doc_create:            { path: "/api/tools/doc_create.js",            cap: "doc",      mock: ({title}) => ({ ok:true, demo:true, url:"https://placehold.co/980x700/png?text=Doc", title }) },
  doc_fill_template:     { path: "/api/tools/doc_fill_template.js",     cap: "doc",      mock: ({template_key, fields}) => ({ ok:true, demo:true, url: imgPDFMock("Doc", template_key||"T-001",""), fields }) },
  sheet_append_rows:     { path: "/api/tools/sheet_append_rows.js",     cap: "sheet",    mock: ({rows}) => ({ ok:true, demo:true, appended: rows?.length||0 }) },
  slide_create:          { path: "/api/tools/slide_create.js",          cap: "slide",    mock: ({title}) => ({ ok:true, demo:true, url:"https://placehold.co/980x560/png?text=Slides%0A"+encodeURIComponent(title||"Deck") }) },
  file_upload:           { path: "/api/tools/file_upload.js",           cap: "file",     mock: ({name}) => ({ ok:true, demo:true, url: "https://placehold.co/800x300/png?text="+encodeURIComponent(name||"file") }) },
  pdf_generate:          { path: "/api/tools/pdf_generate.js",          cap: "pdf",      mock: ({html,name}) => ({ ok:true, demo:true, url: imgPDFMock(name||"PDF","D-0001","") }) },

  // CRM / Deals
  crm_find_contact:      { path: "/api/tools/crm_find_contact.js",      cap: "crm",      mock: ({query}) => ({ ok:true, demo:true, contact:{ id:"c_demo_1", name:query||"Client", email:(query||'client').toLowerCase().replace(/\s+/g,'.')+"@example.com" }}) },
  crm_create_deal:       { path: "/api/tools/crm_create_deal.js",       cap: "crm",      mock: ({name,amount}) => ({ ok:true, demo:true, deal_id:"d_demo_1", name, amount }) },
  crm_log_activity:      { path: "/api/tools/crm_log_activity.js",      cap: "crm",      mock: ({contact, note}) => ({ ok:true, demo:true, activity_id:"a_demo_1", note }) },

  // Invoicing / Payments
  invoice_create:        { path: "/api/tools/invoice_create.js",        cap: "billing",  mock: ({contact, amount}) => ({ ok:true, demo:true, invoice_id:"INV-DEMO", url: imgPDFMock("Invoice","INV-DEMO", contact||"Client"), total: amount||1250 }) },
  invoice_send:          { path: "/api/tools/invoice_send.js",          cap: "billing",  mock: ({invoice_id,to}) => ({ ok:true, demo:true, sent:true }) },
  payment_link_create:   { path: "/api/tools/payment_link_create.js",   cap: "pay",      mock: ({amount}) => ({ ok:true, demo:true, link:"https://pay.example.com/demo?amt="+(amount||100) }) },

  // Web / KB / Browser
  http_fetch:            { path: "/api/tools/http_fetch.js",            cap: "search",   mock: ({url}) => ({ ok:true, demo:true, body:"<html>Demo fetch OK</html>" }) },
  browser_scrape:        { path: "/api/tools/browser_scrape.js",        cap: "browser",  mock: ({query,site}) => ({ ok:true, demo:true, results:[
                              { title:"Result A", snippet:"A short description", url:"https://example.com/a" },
                              { title:"Result B", snippet:"Another description", url:"https://example.com/b" },
                              { title:"Result C", snippet:"Something else", url:"https://example.com/c" }
                            ]}) },
  search_web:            { path: "/api/tools/search_web.js",            cap: "search",   mock: ({query}) => ({ ok:true, demo:true, results:[
                              { title:"Top match", snippet:"Looks relevant", url:"https://example.com/top" },
                              { title:"Alt match", snippet:"Also relevant", url:"https://example.com/alt" }
                            ]}) },
  kb_search:             { path: "/api/tools/kb_search.js",             cap: "kb",       mock: ({query}) => ({ ok:true, demo:true, hits:[
                              { title:"Policy A", url:"#", score:0.88 },
                              { title:"How-to B", url:"#", score:0.76 }
                            ]}) },
  kb_upsert:             { path: "/api/tools/kb_upsert.js",             cap: "kb",       mock: ({title}) => ({ ok:true, demo:true, id:"kb_demo_1", title }) },

  // Work mgmt
  tasks_create:          { path: "/api/tools/tasks_create.js",          cap: "tasks",    mock: ({title}) => ({ ok:true, demo:true, task_id:"tsk_demo_1", title }) },
  ticket_create:         { path: "/api/tools/ticket_create.js",         cap: "ticket",   mock: ({title}) => ({ ok:true, demo:true, ticket_id:"tix_demo_1", title }) },

  // Commerce
  inventory_lookup:      { path: "/api/tools/inventory_lookup.js",      cap: "inventory",mock: ({sku, name}) => ({ ok:true, demo:true, items:[
                              { sku: sku||"X-001", name: name||"Product X", on_hand: 42, reserved: 6, available: 36 }
                            ]}) },
  order_create:          { path: "/api/tools/order_create.js",          cap: "order",    mock: ({items}) => ({ ok:true, demo:true, order_id:"ord_demo_1", items: items||[] }) },
  shipping_get_rates:    { path: "/api/tools/shipping_get_rates.js",    cap: "shipping", mock: ({dest}) => ({ ok:true, demo:true, rates:[{carrier:"DHL",price:12.9},{carrier:"UPS",price:14.2}] }) },

  // AI helpers
  ai_summarize:          { path: "/api/tools/ai_summarize.js",          cap: "ai",       mock: ({text}) => ({ ok:true, demo:true, summary: (text||"").slice(0,140) }) },
  ai_extract:            { path: "/api/tools/ai_extract.js",            cap: "ai",       mock: ({text}) => ({ ok:true, demo:true, fields:{ date:"2025-10-23", amount: 1200 } }) },
  ai_translate:          { path: "/api/tools/ai_translate.js",          cap: "ai",       mock: ({text,to}) => ({ ok:true, demo:true, translated: text||"", to: to||"en" }) },
  ai_ocr:                { path: "/api/tools/ai_ocr.js",                cap: "ai",       mock: () => ({ ok:true, demo:true, text:"Detected text (demo)" }) },
  ai_vision_describe:    { path: "/api/tools/ai_vision_describe.js",    cap: "ai",       mock: () => ({ ok:true, demo:true, captions:["A document on a table"] }) },
  ai_generate_image:     { path: "/api/tools/ai_generate_image.js",     cap: "ai",       mock: ({prompt}) => ({ ok:true, demo:true, url:"https://placehold.co/1024x768/png?text="+encodeURIComponent(prompt||"Image") }) },

  // DevOps / Repos
  repo_pr_create:        { path: "/api/tools/repo_pr_create.js",        cap: "dev",      mock: ({branch,title}) => ({ ok:true, demo:true, pr_url:"https://github.com/demo/pr/1" }) },
  ops_run_job:           { path: "/api/tools/ops_run_job.js",           cap: "dev",      mock: ({job}) => ({ ok:true, demo:true, run_id:"run_demo_1", status:"queued" }) },
  secrets_get:           { path: "/api/tools/secrets_get.js",           cap: "dev",      mock: ({name}) => ({ ok:true, demo:true, value: "•••"}) },

  // Governance
  policy_check:          { path: "/api/tools/policy_check.js",          cap: "gov",      mock: ({text}) => ({ ok:true, demo:true, result:"pass" }) },
  redact_pii:            { path: "/api/tools/redact_pii.js",            cap: "gov",      mock: ({text}) => ({ ok:true, demo:true, redacted: (text||"").replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,"[redacted]") }) },

  // Memory / Logs
  memory_get:            { path: "/api/tools/memory_get.js",            cap: "mem",      mock: ({key}) => ({ ok:true, demo:true, value:null }) },
  memory_set:            { path: "/api/tools/memory_set.js",            cap: "mem",      mock: ({key,value}) => ({ ok:true, demo:true, saved:true }) },
  trace_log:             { path: "/api/tools/trace_log.js",             cap: "mem",      mock: ({event}) => ({ ok:true, demo:true, event }) },
};

/** Unified tool call with fallback */
async function callToolWithFallback(req, toolKey, payload={}, timeoutMs=8000){
  const conf = TOOL_REGISTRY[toolKey];
  if (!conf) return { ok:false, error:`unknown_tool:${toolKey}` };
  const capFlag = CAP[conf.cap] || false;
  if (capFlag) {
    const r = await tryToolCall(req, conf.path, payload, timeoutMs);
    if (r?.ok) return r;
  }
  try { return conf.mock ? conf.mock(payload) : { ok:true, demo:true }; }
  catch { return { ok:true, demo:true }; }
}
/* ───────────────── Analyzer (NLU) ───────────────── */
async function analyzeUtteranceNLU(utterance, ctx){
  const base = {
    primary_intent: null, score: 0.85,
    intent_candidates: [],
    slots: { contact: null, channel: null, when: null, topic: null, artifact: null, amount_eur: null },
    negations: [], should_probe: [], requires_confirmation: [], followups_to_ask: [],
    action_family: null, do_not_do: []
  };

  const u = (utterance||"").toLowerCase();
  const contact = extractName(utterance) || resolvePronounToContact(utterance, ctx);
  if (contact) base.slots.contact = contact;

  // Follow-up / CRM fetch
  if (/\bfollow\s*up\b/.test(u)) { base.primary_intent = "follow_up"; base.action_family="communicate"; base.should_probe.push("crm","mailbox"); if(!ctx.email?.to) base.requires_confirmation.push("channel"); base.followups_to_ask.push("Draft an email or book a call?"); }
  if (/\b(latest|last)\b.*\b(conversation|email|thread|note)\b/.test(u) || /\bcheck\b.*\bcrm\b/.test(u)) { base.primary_intent = "crm_fetch_last_interaction"; base.action_family="retrieve_info"; base.should_probe.push("crm","mailbox"); }

  // Email, quotes, invoices
  if (/\bemail\b/.test(u) && /\b(draft|prepare|write|compose)\b/.test(u)) { base.primary_intent = "email_prepare"; base.action_family="communicate"; base.should_probe.push("crm","mailbox"); }
  if (/\bquote|proposal|estimate\b/.test(u)) { base.primary_intent = "quote_create"; base.action_family="create_record"; }
  if (/\binvoice|bill\b/.test(u)) { base.primary_intent = "invoice_create"; base.action_family="create_record"; }

  // Calendar
  if (/\bschedule|book|reminder|calendar\b/.test(u)) { base.primary_intent = "calendar_create_event"; base.action_family="schedule"; base.should_probe.push("calendar"); }

  // Web search / browse
  if (/\b(search|find|scan|scrape|crawl)\b/.test(u)) { base.primary_intent="search_web"; base.action_family="retrieve_info"; base.should_probe.push(CAP.browser?"browser":"search"); }

  // Inventory
  if (/\binventory|stock|availability|available\b/.test(u)) { base.primary_intent="inventory_check"; base.action_family="retrieve_info"; }

  // Negations
  if (/\bno quote|don'?t (add|attach) (a )?quote|without quote\b/.test(u)) { base.negations.push("no quote"); base.do_not_do.push("create_quote"); }

  // channel guess
  if (/\bcall\b/.test(u)) base.slots.channel="call";
  else if (/\bwhatsapp\b/.test(u)) base.slots.channel="whatsapp";
  else if (/\bemail\b/.test(u)) base.slots.channel="email";

  // amount
  const amt = extractAmountEUR(utterance); if (amt) base.slots.amount_eur = amt;

  if (!base.primary_intent) { base.primary_intent = "general_question"; base.action_family="retrieve_info"; }
  base.intent_candidates = [{ intent: base.primary_intent, score: base.score }];
  return base;
}

/* ───────────── Humanizer (NLG) ───────────── */
async function humanizeBursts(payload){
  const { facts={}, nextChoices=null } = payload || {};
  const bursts = [];
  function push(line){ if (line) bursts.push(line); }

  if (facts.type === "crm_timeline") {
    const name = facts.contact || "the client";
    const items = facts.items||[];
    if (items.length){
      const line = items.slice(0,3).map(it => `• ${it.date} — ${it.kind}: ${it.note}`).join(' ');
      push(`I checked our CRM for ${name} — here’s what’s most recent:`);
      push(line);
    } else {
      push(`I checked our CRM for ${name}, but didn’t find recent activity.`);
    }
  }
  else if (facts.type === "follow_up_context") {
    const name = facts.contact || "the client";
    if (facts.lastNote) push(`I checked our CRM for ${name} — last note says: “${facts.lastNote.note}” (${facts.lastNote.date}).`);
    if (facts.lastMail) push(`There’s also an email from ${facts.lastMail.date} about “${facts.lastMail.subject}”.`);
  }
  else if (facts.type === "email_draft") {
    const name = facts.to || "your contact";
    push(`Drafted a short email to ${name}. I kept it concise and referenced our last touchpoint.`);
  }
  else if (facts.type === "inventory") {
    const item = facts.item||"that item";
    if (typeof facts.available === "number") push(`We have ${facts.available} available for ${item}.`);
  }
  else if (facts.type === "web_results") {
    push(facts.site ? `I scanned ${facts.site} and pulled a few relevant results.` : `I searched the web and shortlisted a few relevant results.`);
  }

  if (!bursts.length) push(`I’ve pulled the details and summarized the key points.`);
  const ask = nextChoices ? { question: nextChoices.question, options: nextChoices.options } : null;
  return { bursts, ask };
}

/* ───────────── Probe helpers ───────────── */
async function probeCRM(req, contact){
  if (!contact) return { contact:null, items:[] };
  const found = await callToolWithFallback(req, "crm_find_contact", { query: contact });
  const c = found?.contact || { id:"c_demo", name: contact, email: (contact||'client').toLowerCase().replace(/\s+/g,'.')+"@example.com" };
  const notes = [
    { date: "2025-10-22", kind:"Call", note:"Asked for revised ETA" },
    { date: "2025-10-20", kind:"Email", note:"Sent specs" },
    { date: "2025-10-18", kind:"Note", note:"Meeting scheduled" }
  ];
  return { contact: c.name, email: c.email, items: notes };
}
async function probeMailbox(req, emailAddress){
  if (!emailAddress) return { email:null, threads:[] };
  const threads = (await callToolWithFallback(req, "email_read", { contact: emailAddress }))?.threads || [];
  return { email: emailAddress, threads };
}

/* ───────────── Plan derivation ───────────── */
function derivePlanFromAnalysis(an, ctx){
  const p = [];
  switch (an.primary_intent) {
    case "follow_up":
      p.push("probe_context");
      p.push("decide_channel");
      p.push("prepare_comms");
      break;
    case "crm_fetch_last_interaction":
      p.push("probe_context");
      p.push("summarize_context");
      break;
    case "email_prepare":
      p.push("probe_context");
      p.push("prepare_email");
      break;
    case "calendar_create_event":
      p.push("find_slots");
      p.push("propose_slot");
      break;
    case "search_web":
      p.push("search_or_scrape");
      p.push("summarize_results");
      break;
    case "invoice_create":
      p.push("prepare_invoice");
      break;
    case "quote_create":
      p.push("prepare_quote");
      break;
    case "inventory_check":
      p.push("check_inventory");
      break;
    default:
      p.push("general_question");
  }
  return p;
}

/* ───────────── Start-of-task hygiene ───────────── */
function sanitizeContextForNewTask(an, ctx){
  if ((an.do_not_do||[]).includes("create_quote")) {
    ctx.quote = { contact: ctx.current_contact || ctx.quote?.contact || null, amount: null, currency:"EUR", pdf_url:null, id:null };
    if (Array.isArray(ctx.email?.attachments)) {
      ctx.email.attachments = ctx.email.attachments.filter(a => !/Quote|INV|pdf/i.test(a?.name||""));
    }
  }
  const createArtifacts = new Set(["quote_create","invoice_create"]);
  if (!createArtifacts.has(an.primary_intent)) {
    if (Array.isArray(ctx.email?.attachments)) {
      ctx.email.attachments = ctx.email.attachments.filter(a => !/Quote|Invoice/i.test(a?.name||""));
    }
  }
}
/* ───────────── Family step handlers ───────────── */
async function step_probe_context(req, an, ctx, steps){
  const name = an.slots.contact || ctx.current_contact || ctx.quote?.contact || null;
  let crm = null, mb = null;
  if ((an.should_probe||[]).includes("crm") && name) {
    crm = await probeCRM(req, name); steps.push(`CRM: fetched recent activity for ${name}.`);
    if (crm?.email) ctx.email.to = ctx.email.to || crm.email;
  }
  if ((an.should_probe||[]).includes("mailbox")) {
    const addr = ctx.email?.to || crm?.email || null;
    if (addr) { mb = await probeMailbox(req, addr); steps.push(`Mailbox: fetched last thread for ${addr}.`); }
  }
  return { crm, mailbox: mb };
}

async function step_decide_channel(req, an, ctx, steps){
  if (an.slots.channel) return { channel: an.slots.channel };
  steps.push("Channel not specified — will ask user to choose.");
  return { channel: null };
}

async function step_prepare_comms(req, an, ctx, steps, grounding){
  return step_prepare_email(req, an, ctx, steps, grounding);
}

async function step_prepare_email(req, an, ctx, steps, grounding){
  const contact = an.slots.contact || ctx.current_contact || "your client";
  const lastNote = grounding?.crm?.items?.[0] || null;
  const lastMail = grounding?.mailbox?.threads?.[0] || null;
  ctx.email.subject = ctx.email.subject || "Follow-up on our last conversation";
  ctx.email.body = ctx.email.body || [
    `Hi ${contact.replace(/^(Mr\.|Mrs\.|Ms\.|Dr\.)\s*/,'')},`,
    "",
    lastNote ? `Quick note on the ${lastNote.kind.toLowerCase()} from ${lastNote.date}: ${lastNote.note}.` : `Just following up as promised.`,
    lastMail ? `I also saw your email about “${lastMail.subject}”.` : null,
    "",
    "If everything looks good, I can proceed right away.",
    "",
    "Best regards,",
    "Your AI Employee"
  ].filter(Boolean).join("\n");
  const preview = imgEmailPreview({ to: ctx.email.to || contact, subject: ctx.email.subject });
  steps.push("Prepared email draft referencing the latest context.");
  return {
    script: bursts(`On it — I’ll draft the email to ${contact}.`, "Here’s a concise draft — edit anything and I’ll update."),
    cards: [
      { format:"image", summary:"Email Preview (demo)", value:{ url: preview } },
      { format:"text",  summary:"Email Draft (fields)", value:
        `<strong>To:</strong> ${ctx.email.to || `${contact} (email pending)`}<br/>`+
        `<strong>Subject:</strong> ${ctx.email.subject}<br/>`+
        `<pre style="white-space:pre-wrap;margin:8px 0 0 0">${ctx.email.body}</pre>`
      }
    ],
    ask: { question:"Send the email now?", options:[{id:"send_email",label:"Send"},{id:"edit_subject",label:"Edit subject"},{id:"edit_body",label:"Edit body"}] }
  };
}

async function step_summarize_context(req, an, ctx, steps, grounding){
  const contact = an.slots.contact || ctx.current_contact || "the client";
  const items = grounding?.crm?.items || [];
  const lastMail = grounding?.mailbox?.threads?.[0] || null;
  const facts = { type:"crm_timeline", contact, items };
  const nextChoices = { question:"Want me to draft a follow-up or set a reminder?", options:[{id:"draft_email",label:"Draft email"},{id:"set_reminder",label:"Set reminder"}] };
  const hum = await humanizeBursts({ facts, nextChoices });
  steps.push("Summarized latest conversation context.");
  return {
    script: hum.bursts.map((t,i)=>({ text:t, delay_ms:300, show_role:i===0 })),
    cards: [],
    ask: hum.ask
  };
}

async function step_find_slots(req, an, ctx, steps){
  const r = await callToolWithFallback(req, "calendar_find_slots", { days:7 });
  steps.push("Found calendar slots.");
  return r?.slots || [];
}

async function step_propose_slot(req, an, ctx, steps, slots){
  const contact = an.slots.contact || ctx.current_contact || "client";
  const slot = (slots && slots[0]) || { start_iso: new Date(Date.now()+86400000).toISOString(), end_iso: new Date(Date.now()+86400000+1800000).toISOString() };
  ctx.calendar = { title:`Call ${contact}`, start:slot.start_iso, end:slot.end_iso, location:"Google Meet" };
  const img = imgCalendarCard({ title: ctx.calendar.title, when: new Date(slot.start_iso).toLocaleString() });
  steps.push("Proposed earliest available slot.");
  return {
    script: bursts("I can set that up.", `Here’s a 30-minute slot with a Meet link for ${contact}.`),
    cards: [
      { format:"image", summary:"Calendar Draft (demo)", value:{ url: img } },
      { format:"table", summary:"Event (fields)", value:{ columns:["Title","Start","End","Location"], rows:[[ctx.calendar.title, new Date(slot.start_iso).toLocaleString(), new Date(slot.end_iso).toLocaleString(), "Google Meet"]] } }
    ],
    ask: { question:"Create the event and invite you?", options:[{id:"create_event",label:"Create"},{id:"edit_event",label:"Edit details"}] }
  };
}

async function step_search_or_scrape(req, an, ctx, steps){
  const targetSite = (String(ctx.last_user_utterance||'').match(/\b(idealista|rightmove|airbnb|booking|tripadvisor)\b/i)||[])[1] || null;
  const tool = CAP.browser ? "browser_scrape" : "search_web";
  const r = await callToolWithFallback(req, tool, { query: ctx.last_user_utterance, site: targetSite });
  steps.push(`Searched ${targetSite||'web'} via ${tool}.`);
  const facts = { type:"web_results", site: targetSite, results: r.results||[] };
  const hum = await humanizeBursts({ facts, nextChoices: { question:"Go deeper?", options:[{id:"deep_search",label:"Dive deeper"},{id:"stop",label:"This is enough"}] } });
  const rows = (r.results||[]).slice(0,5).map(x => [x.title||"Result", x.snippet||"", x.url||""]);
  return {
    script: hum.bursts.map((t,i)=>({ text:t, delay_ms:300, show_role:i===0 })),
    cards: [
      { format:"image", summary:"Results (demo)", value:{ url: imgListingsGrid({ title: targetSite ? `${targetSite} · Top matches` : "Top Results" }) } },
      { format:"table", summary:"Top results", value:{ columns:["Title","Snippet","URL"], rows } }
    ],
    ask: hum.ask
  };
}

async function step_prepare_invoice(req, an, ctx, steps){
  const contact = an.slots.contact || ctx.current_contact || "your client";
  const amount  = an.slots.amount_eur || 1250;
  const inv = await callToolWithFallback(req, "invoice_create", { contact, amount });
  ctx.invoice = { id: inv.invoice_id || "INV-DEMO", url: inv.url, amount };
  const imgUrl = inv.url || imgPDFMock("Invoice","INV-DEMO", contact);
  steps.push(`Invoice prepared for ${contact}, ${fmtEUR(amount)}.`);
  return {
    script: bursts(`Invoice prepared for ${contact}.`, `Total: ${fmtEUR(amount)}.`),
    cards: [
      { format:"image", summary:"Invoice PDF (preview)", value:{ url: imgUrl } },
      { format:"table", summary:"Invoice Details", value:{ columns:["Invoice #","Customer","Date","Total"], rows:[[ctx.invoice.id, contact, nowISO().slice(0,10), fmtEUR(amount)]] } }
    ],
    ask: { question:"Send it now?", options:[{id:"send_invoice_email",label:"Send via email"},{id:"copy_link",label:"Copy payment link"}] }
  };
}

async function step_prepare_quote(req, an, ctx, steps){
  if ((an.do_not_do||[]).includes("create_quote")) {
    steps.push("User indicated no quote — skipping.");
    return { script: bursts("Noted — I won't include a quote."), cards:[], ask:null };
  }
  return handleQuoteCreate(ctx, steps);
}

async function step_check_inventory(req, an, ctx, steps){
  const m = String(ctx.last_user_utterance||'').match(/\b(product|sku)\s*([A-Za-z0-9\-]+)\b/i);
  const sku = m ? m[2] : undefined;
  const name = !sku ? (ctx.last_user_utterance||'').replace(/[^A-Za-z ]/g,'').trim() : undefined;
  const r = await callToolWithFallback(req, "inventory_lookup", { sku, name });
  const item = r.items?.[0] || { sku: sku||"X-001", name: name||"Product X", available: 36, on_hand: 42, reserved:6 };
  const facts = { type:"inventory", item: item.name, available: item.available };
  const hum = await humanizeBursts({ facts, nextChoices:{ question:"Want me to hold stock or suggest alternatives?", options:[{id:"hold_24h",label:"Hold 24h"},{id:"suggest_alts",label:"Suggest alternatives"}] } });
  steps.push("Checked inventory.");
  return {
    script: hum.bursts.map((t,i)=>({ text:t, delay_ms:300, show_role:i===0 })),
    cards: [
      { format:"table", summary:"Inventory", value:{ columns:["SKU","Product","On Hand","Reserved","Available"], rows:[[item.sku, item.name, item.on_hand||0, item.reserved||0, item.available||0]] } }
    ],
    ask: hum.ask
  };
}

/* ───────────── Executions (after confirmation) ───────────── */
async function executeSendEmail(req, ctx, steps){
  const to = ctx.email.to || (ctx.current_contact || "contact");
  const payload = {
    to,
    subject: ctx.email.subject,
    html: `<p>${(ctx.email.body||"").replace(/\n/g,"<br/>")}</p>`,
    attachments: ctx.email.attachments || []
  };
  if (CAP.email){
    const r = await callToolWithFallback(req, "email_send", payload);
    if (r.ok){ steps.push("Email sent via provider."); return { ok:true }; }
    steps.push(`Email provider failed; demo-sent.`);
  } else {
    steps.push("Email provider not connected — demo-sent.");
  }
  return { ok:true, demo:true };
}
async function executeCreateEvent(req, ctx, steps){
  const payload = { title: ctx.calendar.title, start_iso: ctx.calendar.start, end_iso: ctx.calendar.end, attendees: [] };
  if (CAP.calendar){
    const r = await callToolWithFallback(req, "calendar_create_event", payload);
    if (r.ok){ steps.push("Calendar event created."); return { ok:true, event_id:r.event_id }; }
    steps.push(`Calendar provider failed; demo-created.`);
  } else {
    steps.push("Calendar provider not connected — demo-created.");
  }
  return { ok:true, demo:true };
}
async function executeCRMLog(req, ctx, steps, extraNote=null){
  const contact = ctx.current_contact || ctx.quote.contact || "your client";
  const note = extraNote || ctx.crm.notes || "Follow-up recorded.";
  if (CAP.crm){
    const r = await callToolWithFallback(req, "crm_log_activity", { contact, note, type: ctx.crm.type||"follow_up", due: ctx.crm.due });
    if (r.ok){ steps.push("CRM updated with latest activity."); return { ok:true }; }
    steps.push(`CRM update failed; demo-logged.`);
  } else {
    steps.push("CRM not connected — demo logged.");
  }
  return { ok:true, demo:true };
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
    ctx.last_user_utterance = utterance || "";
    ingestUtterance(utterance, ctx);

    // Optional: fetch KB via tenant/token (kept compatible)
    if (tenant && token && (!kb_json || !company_system_prompt)) {
      try {
        const proto = req.headers["x-forwarded-proto"] || "https";
        const baseUrl = `${proto}://${req.headers.host}`;
        const r = await fetch(`${baseUrl}/api/tenantGet?tenant=${encodeURIComponent(tenant)}&token=${encodeURIComponent(token)}`);
        const j = await r.json();
        if (j?.ok && j.tenant) {
          kb_json = j.tenant.kb_json || kb_json;
          company_system_prompt = j.tenant.company_system_prompt || company_system_prompt;
        }
      } catch {}
    }

    // 1) Analyze
    const analysis = await analyzeUtteranceNLU(utterance, ctx);

    // 2) Sanitize (respect negations etc.)
    sanitizeContextForNewTask(analysis, ctx);

    // 3) Derive plan
    const plan = derivePlanFromAnalysis(analysis, ctx);
    const steps = [`Analyzer: ${analysis.primary_intent} (score ${analysis.score})`, `Plan: ${plan.join(' → ')}`];

    // 4) Execute plan
    let script = [], cards = [], ask = null;
    let grounding = null, slotsFound = null, slots = null;

    // Front-load plan statement if multi-step
    if (plan.length > 1 && !(plan.length===1 && plan[0]==="general_question")){
      script.push(...bursts(`Plan: ${plan.map(p => p.replace(/_/g,' ')).join(' → ')}.`));
      steps.push(`Planner: ${plan.join(' -> ')}`);
    }

    for (const step of plan) {
      let out = null;

      if (step === "probe_context") {
        grounding = await step_probe_context(req, analysis, ctx, steps);
        // Humanized grounding bursts for follow-up
        if (analysis.primary_intent === "follow_up") {
          const lastNote = grounding?.crm?.items?.[0] || null;
          const lastMail = grounding?.mailbox?.threads?.[0] || null;
          const hum = await humanizeBursts({ facts: { type:"follow_up_context", contact: analysis.slots.contact, lastNote, lastMail }});
          script.push(...hum.bursts.map((t,i)=>({ text:t, delay_ms:300, show_role:i===0 && script.length===0 })));
        }
      }
      else if (step === "decide_channel") {
        const dec = await step_decide_channel(req, analysis, ctx, steps);
        if (!dec.channel) {
          ask = { question: "Draft an email or book a call?", options:[{id:"draft_email",label:"Draft email"},{id:"book_call",label:"Book call"}] };
        }
      }
      else if (step === "prepare_comms") {
        out = await step_prepare_comms(req, analysis, ctx, steps, grounding);
      }
      else if (step === "prepare_email") {
        out = await step_prepare_email(req, analysis, ctx, steps, grounding);
      }
      else if (step === "summarize_context") {
        out = await step_summarize_context(req, analysis, ctx, steps, grounding);
      }
      else if (step === "find_slots") {
        slotsFound = await step_find_slots(req, analysis, ctx, steps);
      }
      else if (step === "propose_slot") {
        out = await step_propose_slot(req, analysis, ctx, steps, slotsFound);
      }
      else if (step === "search_or_scrape") {
        out = await step_search_or_scrape(req, analysis, ctx, steps);
      }
      else if (step === "prepare_invoice") {
        out = await step_prepare_invoice(req, analysis, ctx, steps);
      }
      else if (step === "prepare_quote") {
        out = await step_prepare_quote(req, analysis, ctx, steps);
      }
      else if (step === "check_inventory") {
        out = await step_check_inventory(req, analysis, ctx, steps);
      }
      else if (step === "general_question") {
        const g = await handleGeneralQuestion(utterance, kb_json, company_system_prompt);
        out = g;
      }

      if (out){
        if (out.script) script.push(...out.script);
        if (out.cards)  cards.push(...out.cards);
        if (out.ask)    ask = out.ask;
      }
    }

    // Persist context
    ctx.last_plan = plan;
    saveCtx(session_id, ctx);

    // Fallback if nothing
    if (plan.length === 0){
      const fallback = await handleGeneralQuestion(utterance, kb_json, company_system_prompt);
      script.push(...fallback.script);
      steps.push(...(fallback.steps||[]));
    }

    return okJSON(res, {
      mode,
      script,
      cards,
      ask,
      meta: {
        intent: analysis.primary_intent,
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
