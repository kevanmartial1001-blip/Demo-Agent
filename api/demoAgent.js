// /api/demoAgent.js
// Universal assistant with context, planner, and slot-aware handlers (demo-ready).

module.exports.config = { runtime: "nodejs" };

/* ─────────── Utilities ─────────── */
function traceId(){ return "trc_" + Math.random().toString(36).slice(2,10); }
function nowISO(){ return new Date().toISOString(); }
function currencyEUR(n){ try { return new Intl.NumberFormat('en-US',{style:'currency',currency:'EUR'}).format(n); } catch { return `€${(+n||0).toFixed(2)}`; } }
function okJSON(res, obj){ try{ res.setHeader("Content-Type","application/json"); }catch{} return res.status(200).json(obj); }
function errJSON(res, msg){ try{ res.setHeader("Content-Type","application/json"); }catch{} return res.status(200).json({
  mode:"text",
  script:[{ text:"Something went wrong — switched to demo mode.", delay_ms:0, show_role:true }],
  cards:[{ format:"text", summary:"Error", value:String(msg) }],
  meta:{ error:true, trace_id: traceId(), steps:["Caught error in /api/demoAgent, returned fallback."] }
});}
function readBody(req){
  try{
    if (req && typeof req.body === "object" && req.body !== null) return req.body;
    if (req && typeof req.body === "string") return JSON.parse(req.body || "{}");
  }catch{}
  return {};
}
function bursts(...lines){
  return lines.map((text,i)=>({ text, delay_ms: 300, show_role: i===0 }));
}

/* ─────────── Context store (in-memory; demo-safe) ─────────── */
// For production, back this with Redis/Upstash or your DB. This demo uses a process Map.
// Vercel serverless can cold start and lose state; acceptable for demo UX.
const CTX = new Map();
function defaultCtx(){
  return {
    people: [],                // [{ name, email?, id? }]
    current_contact: null,     // "Mr Robinson"
    email: { to:null, subject:null, body:null, attachments:[] },
    quote: { contact:null, amount:null, currency:"EUR", pdf_url:null, id:null },
    crm: { action:null, type:null, notes:null, due:null, status:"Open" },
    requested: { email:false, quote:false, crm:false },
    last_updated: nowISO(),
  };
}
function loadCtx(session_id){
  if (!CTX.has(session_id)) CTX.set(session_id, defaultCtx());
  return CTX.get(session_id);
}
function saveCtx(session_id, ctx){ ctx.last_updated = nowISO(); CTX.set(session_id, ctx); }

/* ─────────── Lightweight LLM (optional for general Q&A) ─────────── */
const MODEL = process.env.OPENAI_AGENT_MODEL || "gpt-4o-mini";
async function maybeLLMAnswer({ company_system_prompt, user }){
  if (!process.env.OPENAI_API_KEY) return null;
  if (!user) return null;
  const messages = [
    { role:"system", content: company_system_prompt || "You are a concise, helpful assistant. Prefer short, actionable answers." },
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

/* ─────────── NER / Slot extraction ─────────── */
function extractName(utt=""){
  const m = utt.match(/\b(Mr\.|Mrs\.|Ms\.|Dr\.)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/);
  return m ? `${m[1]} ${m[2]}` : null;
}
function extractAmountEUR(utt=""){
  const m = String(utt).match(/(\d[\d.,]*)\s*€|€\s*(\d[\d.,]*)/);
  if (!m) return null;
  const raw = (m[1] || m[2] || "").trim();
  const n = Number(raw.replace(/[.,](?=\d{3}\b)/g,"").replace(",","."));
  return isFinite(n) && n>0 ? Math.round(n*100)/100 : null;
}
function resolvePronounToContact(utt, ctx){
  const lower = utt.toLowerCase();
  if (/\b(him|her|them)\b/.test(lower) && ctx.current_contact) return ctx.current_contact;
  return null;
}

/* ─────────── Intent detection ─────────── */
function detect(utt=""){
  const u = utt.toLowerCase();
  const intents = [];
  // email prep/send
  if (/\b(email|e-mail|mail)\b/.test(u) && /\b(prepare|draft|write|compose|send)\b/.test(u)) intents.push("email_prepare");
  // quote
  if (/\b(quote|proposal|estimate)\b/.test(u)) intents.push("quote_create");
  // invoice (not used in example but supported)
  if (/\b(invoice|bill)\b/.test(u)) intents.push("invoice_create");
  // crm log/update
  if (/\b(crm|update crm|log|activity|follow[- ]?up|note)\b/.test(u)) intents.push("crm_update");
  // calendar
  if (/\b(schedule|meeting|calendar|book)\b/.test(u)) intents.push("calendar_create_event");
  // small talk
  if (/\b(hi|hello|hey|what can you do|who are you)\b/.test(u)) intents.push("small_talk");
  // default general Q
  if (intents.length===0) intents.push("general_question");
  return intents;
}

/* ─────────── Context updater from utterance ─────────── */
function ingestUtteranceIntoCtx(utt, ctx){
  const name = extractName(utt) || resolvePronounToContact(utt, ctx);
  if (name){
    // upsert
    if (!ctx.people.find(p => p.name.toLowerCase() === name.toLowerCase())) {
      ctx.people.push({ name });
    }
    ctx.current_contact = name;
    if (!ctx.email.to) ctx.email.to = null; // keep null until we know email
    if (!ctx.quote.contact) ctx.quote.contact = name;
  }
  const amt = extractAmountEUR(utt);
  if (amt){ ctx.quote.amount = amt; }

  // requested flags
  const intents = detect(utt);
  ctx.requested.email = ctx.requested.email || intents.includes("email_prepare");
  ctx.requested.quote = ctx.requested.quote || intents.includes("quote_create");
  ctx.requested.crm   = ctx.requested.crm   || intents.includes("crm_update");
  return ctx;
}

/* ─────────── Slot-aware handlers ─────────── */
function handleEmailPrepare(ctx){
  const contact = ctx.current_contact || ctx.quote.contact || "your client";
  // sensible defaults
  if (!ctx.email.subject) ctx.email.subject = `Follow-up on our last conversation`;
  if (!ctx.email.body){
    ctx.email.body =
`Hi ${contact.replace(/^(Mr\.|Mrs\.|Ms\.|Dr\.)\s*/,'')},

Just following up as promised. I’ve attached the document for your review.
If everything looks good, I can proceed right away.

Best regards,
Your AI Employee`;
  }

  const steps = [
    `Prepared email draft to ${contact}.`,
    "Inserted suggested subject and short, professional body.",
  ];

  // if quote already exists and has PDF, ensure attached
  if (ctx.quote?.pdf_url && !ctx.email.attachments.find(a => a.url === ctx.quote.pdf_url)){
    ctx.email.attachments.push({ name: `${ctx.quote.id||'Quote'}.pdf`, url: ctx.quote.pdf_url });
    steps.push("Attached the quote PDF to the email.");
  }

  const cardHtml = [
    `<strong>To:</strong> ${ctx.email.to || `${contact} (email pending)`}`,
    `<strong>Subject:</strong> ${ctx.email.subject}`,
    `<pre style="white-space:pre-wrap;margin:8px 0 0 0">${ctx.email.body}</pre>`,
    ctx.email.attachments.length ? (`<div style="margin-top:8px"><strong>Attachments:</strong> ${ctx.email.attachments.map(a=>a.name).join(", ")}</div>`) : ""
  ].join("<br/>");

  return {
    script: bursts(
      `On it — I’ll draft the email to ${contact}.`,
      "Here’s a concise draft — edit anything and I’ll update."
    ),
    cards: [{ format:"text", summary:"Email Draft", value: cardHtml }],
    ask: {
      context_id: traceId(),
      question: "Send the email now?",
      options: [{id:"send",label:"Send"}, {id:"edit_subject",label:"Edit subject"}, {id:"edit_body",label:"Edit body"}]
    },
    steps
  };
}

function handleQuoteCreate(ctx){
  const contact = ctx.current_contact || ctx.quote.contact || "your client";
  // keep demo deterministic per session by storing id once
  if (!ctx.quote.id) ctx.quote.id = "Q-" + Math.random().toString(36).slice(2,7).toUpperCase();
  if (!ctx.quote.amount) ctx.quote.amount = 3500;
  if (!ctx.quote.currency) ctx.quote.currency = "EUR";
  if (!ctx.quote.pdf_url) ctx.quote.pdf_url = `https://placehold.co/980x1380/pdf?text=Quote%20${ctx.quote.id}%20for%20${encodeURIComponent(contact)}`;

  const steps = [
    "Loaded quote template (demo).",
    `Set customer: ${contact}.`,
    `Amount: ${currencyEUR(ctx.quote.amount)}.`,
    "Generated PDF preview (demo)."
  ];

  const cards = [
    {
      format:"table",
      summary:"Draft Quote",
      value:{
        columns:["Quote #","Customer","Date","Subtotal","Tax","Total"],
        rows:[[ctx.quote.id, contact, nowISO().slice(0,10), currencyEUR(ctx.quote.amount), currencyEUR(0), currencyEUR(ctx.quote.amount)]]
      }
    },
    { format:"file", summary:"Quote PDF", value:{ url: ctx.quote.pdf_url, name: `${ctx.quote.id}.pdf` } }
  ];

  // also attach to email draft if exists
  if (!ctx.email.attachments.find(a => a.url === ctx.quote.pdf_url)){
    ctx.email.attachments.push({ name: `${ctx.quote.id}.pdf`, url: ctx.quote.pdf_url });
  }

  return {
    script: bursts(
      `Got it — creating a quote for ${contact}.`,
      `Assuming total ${currencyEUR(ctx.quote.amount)} — change if needed.`,
      "Quote is ready and attached to the email draft."
    ),
    cards,
    ask: {
      context_id: traceId(),
      question: "Next step?",
      options:[{id:"email_prepare",label:"Open email draft"}, {id:"send_now",label:"Send quote via email"}, {id:"edit_amount",label:"Edit amount"}]
    },
    steps
  };
}

function handleCRMUpdate(ctx){
  const contact = ctx.current_contact || ctx.quote.contact || "your client";
  if (!ctx.crm.type) ctx.crm.type = "follow_up";
  if (!ctx.crm.notes) ctx.crm.notes = "Follow-up email prepared; quote attached.";
  if (!ctx.crm.due){
    const due = new Date(Date.now() + 2*24*3600*1000); // +2 days
    ctx.crm.due = due.toISOString().slice(0,10);
  }

  const steps = [
    `Prepared CRM ${ctx.crm.type.replace('_',' ')} activity.`,
    `Contact: ${contact}.`,
    `Notes: ${ctx.crm.notes}.`,
    `Due: ${ctx.crm.due}.`,
  ];

  const card = {
    format:"table",
    summary:"CRM Activity (demo)",
    value:{
      columns:["Type","Contact","Notes","Due","Status"],
      rows:[[ctx.crm.type, contact, ctx.crm.notes, ctx.crm.due, ctx.crm.status]]
    }
  };

  return {
    script: bursts(
      `I’ll log a ${ctx.crm.type.replace('_',' ')} for ${contact}.`,
      "I’ve included the email + quote context and set a reminder."
    ),
    cards:[card],
    ask:{
      context_id: traceId(),
      question:"Keep the reminder for 2 days?",
      options:[{id:"keep_2d",label:"Yes"}, {id:"today",label:"Today"}, {id:"next_week",label:"Next week"}]
    },
    steps
  };
}

/* Optional: simple calendar demo */
function handleCalendarEvent(ctx){
  const start = new Date(Date.now()+36e5); // in 1h
  const end = new Date(start.getTime()+30*60*1000);
  const steps = [
    "Proposed 30-min slot.",
    "Added virtual meeting link (demo)."
  ];
  return {
    script: bursts("I can set that up.","Here’s a 30-minute slot with a Meet link."),
    cards:[{
      format:"table",
      summary:"Draft Calendar Event (demo)",
      value:{
        columns:["Title","Start","End","Location"],
        rows:[["Follow-up with client", start.toLocaleString(), end.toLocaleString(), "Google Meet (auto)"]]
      }
    }],
    ask:{ context_id: traceId(), question:"Create event & invite?", options:[{id:"create",label:"Create"}, {id:"edit",label:"Edit details"}] },
    steps
  };
}

/* General question handler (KB/LLM or demo) */
async function handleGeneralQuestion({ utterance, kb_json, company_system_prompt }){
  let text = await maybeLLMAnswer({ company_system_prompt, user: utterance });
  if (!text) {
    const co = kb_json?.meta?.company?.name || "your business";
    text = `Here’s a quick answer based on what I know about ${co}. If you want, I can also take action for you.`;
  }
  return {
    script: bursts(text),
    cards: [],
    ask: null,
    steps:["Answered via KB/LLM (or demo fallback)."]
  };
}
function handleSmallTalk(){
  return {
    script: bursts("Hey! I’m here — what can I do for you?","Ask me to create, send, schedule, or look up anything."),
    cards: [],
    ask: null,
    steps:["Greeted user"]
  };
}

/* ─────────── Planner ─────────── */
/**
 * Build a simple plan from the current utterance + context.
 * Returns array of step ids we will execute sequentially.
 */
function buildPlan(intents, ctx){
  const plan = [];
  const wantsEmail = intents.includes("email_prepare");
  const wantsQuote = intents.includes("quote_create");
  const wantsCRM   = intents.includes("crm_update");
  const wantsCal   = intents.includes("calendar_create_event");
  const wantsInvoice = intents.includes("invoice_create"); // not wired below but kept for extension

  // Orchestrations
  if (wantsEmail && wantsQuote){
    plan.push("quote_create");      // create quote first
    plan.push("email_prepare");     // then attach into email
  } else if (wantsQuote){
    plan.push("quote_create");
  }
  if (wantsEmail && !plan.includes("email_prepare")) plan.push("email_prepare");

  if (wantsCRM) plan.push("crm_update");
  if (wantsCal) plan.push("calendar_create_event");

  if (intents.includes("small_talk")) plan.push("small_talk");
  if (intents.includes("general_question") && plan.length===0) plan.push("general_question");

  // If user said “him/her” and we have contact => ensure email/quote target correct
  return plan;
}

/* ─────────── Main route ─────────── */
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

    let {
      utterance = "",
      mode = "text",
      history = [],
      // optional multi-tenant artifacts (unused in demo flow but accepted)
      tenant = null, token = null,
      kb_json = null, company_system_prompt = null,
      // NEW: session id to persist context between turns
      session_id = "demo"
    } = readBody(req);

    const ctx = loadCtx(session_id);
    ingestUtteranceIntoCtx(utterance, ctx);

    const intents = detect(utterance);
    const plan = buildPlan(intents, ctx);

    // Execute plan sequentially, aggregating bursts/cards/steps
    const finalScript = [];
    const finalCards  = [];
    const finalSteps  = [];

    // Small guidance burst when we have a multi-step orchestration
    if (plan.length > 1 && !(plan.length===1 && plan[0]==="general_question")){
      finalScript.push(...bursts(`Plan: ${plan.map(p => p.replace(/_/g,' ')).join(' → ')}.`));
      finalSteps.push(`Planner: ${plan.join(' -> ')}`);
    }

    // Execute steps
    for (const step of plan){
      let result = null;
      if (step === "email_prepare"){
        result = handleEmailPrepare(ctx);
      } else if (step === "quote_create"){
        result = handleQuoteCreate(ctx);
      } else if (step === "crm_update"){
        result = handleCRMUpdate(ctx);
      } else if (step === "calendar_create_event"){
        result = handleCalendarEvent(ctx);
      } else if (step === "small_talk"){
        result = handleSmallTalk();
      } else if (step === "general_question"){
        result = await handleGeneralQuestion({ utterance, kb_json, company_system_prompt });
      } else {
        // unknown step → ignore
        continue;
      }

      // merge
      if (Array.isArray(result?.script)) finalScript.push(...result.script);
      if (Array.isArray(result?.cards))  finalCards.push(...result.cards);
      if (Array.isArray(result?.steps))  finalSteps.push(...result.steps);

      // attach ask only from the last actionable step (store for later)
      var lastAsk = result?.ask || null;
    }

    // Persist context for the next turn
    saveCtx(session_id, ctx);

    // If nothing planned (edge case), default to small talk
    if (plan.length === 0){
      const fallback = handleSmallTalk();
      finalScript.push(...fallback.script);
      finalSteps.push(...fallback.steps);
    }

    return okJSON(res, {
      mode,
      script: finalScript,
      cards: finalCards,
      ask: lastAsk || null,
      meta: {
        intent: plan[0] || "general",
        trace_id: traceId(),
        steps: finalSteps,
        plan,
        session_id
      }
    });

  } catch (e) {
    return errJSON(res, e?.message || e);
  }
};
