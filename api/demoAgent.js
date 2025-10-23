// /api/demoAgent.js
// Universal agent router (demo-ready): detects intent, runs the right tool handler,
// and returns bursts + cards + ask + meta.steps so the UI Status HUD can show progress.

module.exports.config = { runtime: "nodejs" };

/* -------------------- Utilities -------------------- */
function traceId(){ return "trc_" + Math.random().toString(36).slice(2,10); }
function nowISO(){ return new Date().toISOString(); }
function currency(amount){ return new Intl.NumberFormat('en-US',{ style:'currency', currency:'EUR' }).format(amount); }
function pickName(utterance=""){
  const m = utterance.match(/\b(Mr\.|Mrs\.|Ms\.|Dr\.)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/);
  return m ? `${m[1]} ${m[2]}` : "Mr. Martin";
}
function pickAmount(utterance=""){
  const m = String(utterance).match(/(\d[\d.,]*)\s*€|€\s*(\d[\d.,]*)/);
  const raw = m ? (m[1] || m[2]) : "1250";
  const n = Number(String(raw).replace(/[.,](?=\d{3}\b)/g,"").replace(",","."));
  return (isFinite(n) && n>0) ? Math.round(n*100)/100 : 1250;
}
function okJSON(res, obj){ try{ res.setHeader("Content-Type","application/json"); }catch{} return res.status(200).json(obj); }
function errJSON(res, msg){ try{ res.setHeader("Content-Type","application/json"); }catch{} return res.status(200).json({ mode:"text", script:[{text:"Switched to demo mode.", show_role:true}], cards:[{format:"text", summary:"Error", value:String(msg)}], meta:{ error:true }}); }
function readBody(req){
  try{
    if (req && typeof req.body === "object" && req.body !== null) return req.body;
    if (req && typeof req.body === "string") return JSON.parse(req.body || "{}");
  }catch{}
  return {};
}

/* -------------------- Lightweight LLM (optional) -------------------- */
const MODEL = process.env.OPENAI_AGENT_MODEL || "gpt-4o-mini";
async function maybeLLMAnswer({ kb_json, company_system_prompt, user, history = [], mode = "text" }){
  if (!process.env.OPENAI_API_KEY) return null;
  if (!user) return null;

  const sys = company_system_prompt || "You are a helpful, concise assistant.";
  const messages = [
    { role:"system", content: sys },
    { role:"user", content: `Mode: ${mode}\n\n${user}` }
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

/* -------------------- Intent detection -------------------- */
/** Returns { type, entities } */
function detectIntent(utterance=""){
  const u = utterance.toLowerCase();
  const ents = {};

  const isSmallTalk = /\b(hi|hello|hey|how are you|who are you|what can you do)\b/i.test(u);
  if (isSmallTalk) return { type:"small_talk", entities:ents };

  // payments / billing
  if (/\b(quote|proposal|estimate)\b/.test(u)) return { type:"create_quote", entities:ents };
  if (/\b(invoice|bill)\b/.test(u)) return { type:"create_invoice", entities:ents };
  if (/\b(payment link|paylink|link to pay|stripe link)\b/.test(u)) return { type:"payment_link", entities:ents };

  // comms
  if (/\b(send|email|e-mail)\b/.test(u) && /\bemail|mail\b/.test(u)) return { type:"email_send", entities:ents };
  if (/\b(whatsapp|wa\b)\b/.test(u)) return { type:"whatsapp_send", entities:ents };
  if (/\b(sms|text message)\b/.test(u)) return { type:"sms_send", entities:ents };

  // calendar
  if (/\b(schedule|book|meeting|calendar|call)\b/.test(u)) return { type:"calendar_create_event", entities:ents };

  // knowledge / search
  if (/\b(search|google|research|find info|look up|scrape|crawl)\b/.test(u)) return { type:"search_web", entities:ents };

  // docs
  if (/\b(document|doc|file|template)\b/.test(u) && /\b(create|generate|draft|fill)\b/.test(u))
    return { type:"doc_create", entities:ents };

  // tasks/tickets
  if (/\b(task|todo|to-do|follow up|assign)\b/.test(u)) return { type:"tasks_create", entities:ents };
  if (/\b(ticket|support|issue|bug)\b/.test(u)) return { type:"ticket_create", entities:ents };

  // CRM
  if (/\b(contact|lead|deal|opportunity)\b/.test(u)) return { type:"crm_action", entities:ents };

  // default: general Q&A (KB/LLM)
  return { type:"general_question", entities:ents };
}

/* -------------------- Tool Handlers (demo-capable) -------------------- */
// All handlers return { mode, script[], cards[], ask?, meta:{steps[], intent, trace_id} }

function bursts(...lines){
  // Convert array of strings to burst messages with small delays; first shows role
  return lines.map((text,i)=>({ text, delay_ms: 300, show_role: i===0 }));
}

/* --- Quote / Invoice --- */
function handleQuote(utterance){
  const name = pickName(utterance);
  const amt = pickAmount(utterance);
  const id = "Q-" + Math.random().toString(36).slice(2,7).toUpperCase();
  const pdf = `https://placehold.co/980x1380/pdf?text=Quote%20${id}%20for%20${encodeURIComponent(name)}`;
  return {
    mode:"text",
    script: bursts(
      "Ok — give me 1 min and let me see how I can help with this.",
      `I’ve prepared a quote for ${name}.`,
      `Total: ${currency(amt)}.`,
      "I used our standard template and the latest service details.",
      "Tell me if you want any edits — items, amounts, or tax.",
      `If it looks good, I can draft the email and attach the PDF to send to ${name}.`
    ),
    cards: [
      {
        format:"table",
        summary:"Draft Quote (demo)",
        value:{
          columns:["Quote #", "Customer", "Date", "Subtotal", "Tax", "Total"],
          rows:[[id, name, nowISO().slice(0,10), currency(amt), currency(0), currency(amt)]]
        }
      },
      { format:"file", summary:"Quote PDF", value:{ url: pdf, name:`${id}.pdf` } }
    ],
    ask:{
      context_id: traceId(),
      question:"Next step?",
      options:[
        { id:"email", label:"Prepare email draft" },
        { id:"send_now", label:"Send quote now" },
        { id:"edit", label:"Modify details" }
      ]
    },
    meta:{ intent:"create_quote", trace_id: traceId(), steps:[
      "Checked for template (none found) → created one.",
      `Fetched customer: ${name}.`,
      "Compiled line items and totals.",
      "Generated PDF preview."
    ]}
  };
}
function handleInvoice(utterance){
  const name = pickName(utterance);
  const amt = pickAmount(utterance);
  const id = "INV-" + Math.random().toString(36).slice(2,7).toUpperCase();
  const pdf = `https://placehold.co/980x1380/pdf?text=Invoice%20${id}%20for%20${encodeURIComponent(name)}`;
  return {
    mode:"text",
    script: bursts(
      "Absolutely — I’ll handle this.",
      `I drafted an invoice for ${name}.`,
      `Total: ${currency(amt)}.`,
      "Used our standard invoice template.",
      "Want me to send it now or prepare an email draft?"
    ),
    cards: [
      {
        format:"table",
        summary:"Draft Invoice (demo)",
        value:{
          columns:["Invoice #", "Customer", "Date", "Subtotal", "Tax", "Total"],
          rows:[[id, name, nowISO().slice(0,10), currency(amt), currency(0), currency(amt)]]
        }
      },
      { format:"file", summary:"Invoice PDF", value:{ url: pdf, name:`${id}.pdf` } }
    ],
    ask:{
      context_id: traceId(),
      question:"Next step?",
      options:[
        { id:"email", label:"Prepare email draft" },
        { id:"send_now", label:"Send invoice now" },
        { id:"edit", label:"Modify details" }
      ]
    },
    meta:{ intent:"create_invoice", trace_id: traceId(), steps:[
      "Loaded invoice template.",
      `Fetched customer: ${name}.`,
      "Added items based on service notes.",
      "Generated PDF preview."
    ]}
  };
}

/* --- Payment link --- */
function handlePaymentLink(utterance){
  const name = pickName(utterance);
  const amt = pickAmount(utterance);
  const link = `https://pay.example.demo/${Math.random().toString(36).slice(2,10)}`;
  return {
    mode:"text",
    script: bursts(
      "Sure — I’ll create a payment link.",
      `Amount: ${currency(amt)} for ${name}.`,
      "This link can be paid by card or Apple/Google Pay."
    ),
    cards:[
      { format:"text", summary:"Payment Link (demo)", value: link }
    ],
    ask:{
      context_id: traceId(),
      question:"Share the link via…",
      options:[ {id:"email",label:"Email"}, {id:"whatsapp",label:"WhatsApp"}, {id:"copy",label:"Copy to clipboard"} ]
    },
    meta:{ intent:"payment_link", trace_id: traceId(), steps:[
      "Prepared one-time payment intent (demo).",
      "Generated public payment URL."
    ]}
  };
}

/* --- Email send --- */
function handleEmailSend(utterance){
  return {
    mode:"text",
    script: bursts(
      "On it — I’ll draft the email.",
      "Pulled your signature and brand styling.",
      "Ready for your review."
    ),
    cards:[
      { format:"text", summary:"Email Draft (demo)", value:"Subject: Quick update\n\nHi there —\n\nHere’s the info you asked for. Let me know if I should proceed.\n\nBest,\nYour AI Employee" }
    ],
    ask:{ context_id: traceId(), question:"Send it now?", options:[{id:"send",label:"Send"}, {id:"edit",label:"Edit draft"}] },
    meta:{ intent:"email_send", trace_id: traceId(), steps:[
      "Composed subject & body from your request.",
      "Inserted signature and footer.",
      "Prepared draft for review."
    ]}
  };
}

/* --- WhatsApp / SMS --- */
function handleWhatsApp(utterance){
  return {
    mode:"text",
    script: bursts("Composing a WhatsApp message…","I’ll include a brief summary and the link."),
    cards:[{ format:"text", summary:"WhatsApp (demo)", value:"Message: Hey! Quick update — see details: https://example.demo/abc123" }],
    ask:{ context_id: traceId(), question:"Send message?", options:[{id:"send",label:"Send"}, {id:"edit",label:"Edit first"}] },
    meta:{ intent:"whatsapp_send", trace_id: traceId(), steps:["Drafted message","Attached reference link"] }
  };
}
function handleSMS(utterance){
  return {
    mode:"text",
    script: bursts("Drafting a short SMS…","Kept it under 160 chars."),
    cards:[{ format:"text", summary:"SMS (demo)", value:"Hi! Quick update — details sent to your email. Reply STOP to opt out." }],
    ask:{ context_id: traceId(), question:"Send SMS?", options:[{id:"send",label:"Send"}, {id:"edit",label:"Edit first"}] },
    meta:{ intent:"sms_send", trace_id: traceId(), steps:["Shortened message","Checked deliverability length"] }
  };
}

/* --- Calendar create event --- */
function handleCalendarEvent(utterance){
  const start = new Date(Date.now()+36e5); // in 1h
  const end = new Date(start.getTime()+30*60*1000);
  return {
    mode:"text",
    script: bursts(
      "I can set this up.",
      "I’ll propose a 30-minute slot and include a Meet link."
    ),
    cards:[
      {
        format:"table",
        summary:"Draft Calendar Event (demo)",
        value:{
          columns:["Title","Start","End","Location"],
          rows:[["Catch-up call", start.toLocaleString(), end.toLocaleString(), "Google Meet (auto)"]]
        }
      }
    ],
    ask:{ context_id: traceId(), question:"Create the event and invite?", options:[{id:"create",label:"Create & Invite"}, {id:"edit",label:"Edit details"}] },
    meta:{ intent:"calendar_create_event", trace_id: traceId(), steps:[
      "Looked up your default calendar.",
      "Prepared event object with virtual room.",
      "Ready to send invites."
    ]}
  };
}

/* --- Document create/fill --- */
function handleDocCreate(utterance){
  const url = `https://docs.example.demo/${Math.random().toString(36).slice(2,9)}`;
  return {
    mode:"text",
    script: bursts(
      "I’ll create a document using your brand style.",
      "Added a cover and a short executive summary."
    ),
    cards:[{ format:"file", summary:"Document (demo)", value:{ url, name:"Proposal_Draft.docx" } }],
    ask:{ context_id: traceId(), question:"Next step?", options:[{id:"open",label:"Open draft"}, {id:"export_pdf",label:"Export as PDF"}] },
    meta:{ intent:"doc_create", trace_id: traceId(), steps:[
      "Loaded doc template (demo).",
      "Inserted title and author.",
      "Saved to your workspace (demo URL)."
    ]}
  };
}

/* --- Web search / research --- */
function handleSearchWeb(utterance){
  return {
    mode:"text",
    script: bursts(
      "I’ll do a quick research pass.",
      "Summarized the top results for you."
    ),
    cards:[
      {
        format:"table",
        summary:"Top Results (demo)",
        value:{
          columns:["Source","Snippet"],
          rows:[
            ["Example News","Market shows steady growth in Q4…"],
            ["Docs Site","How to integrate the API step by step…"],
            ["Community","Tips & gotchas collected by power users…"]
          ]
        }
      }
    ],
    ask:{ context_id: traceId(), question:"Want a deeper dive?", options:[{id:"deep",label:"Yes — dive deeper"}, {id:"no",label:"This is enough"}] },
    meta:{ intent:"search_web", trace_id: traceId(), steps:[
      "Parsed your query.",
      "Fetched top-ranked pages (demo).",
      "Summarized key points."
    ]}
  };
}

/* --- Tasks / Tickets --- */
function handleTaskCreate(utterance){
  const id = "TASK-" + Math.random().toString(36).slice(2,6).toUpperCase();
  return {
    mode:"text",
    script: bursts("I’ll create a task and assign it.","Set the due date for tomorrow."),
    cards:[{ format:"table", summary:"Task (demo)", value:{ columns:["ID","Title","Assignee","Due"], rows:[[id,"Follow up on request","You", new Date(Date.now()+86400000).toLocaleDateString()]] } }],
    ask:{ context_id: traceId(), question:"Mark as high priority?", options:[{id:"prio",label:"Yes — High"}, {id:"ok",label:"Keep as normal"}] },
    meta:{ intent:"tasks_create", trace_id: traceId(), steps:["Parsed task title","Assigned to default user","Set due date"] }
  };
}
function handleTicketCreate(utterance){
  const id = "TCK-" + Math.random().toString(36).slice(2,6).toUpperCase();
  return {
    mode:"text",
    script: bursts("I’ll log a support ticket.","Added your description and set status to Open."),
    cards:[{ format:"table", summary:"Ticket (demo)", value:{ columns:["ID","Title","Status"], rows:[[id,"Customer issue","Open"]] } }],
    ask:{ context_id: traceId(), question:"Escalate to Tier 2?", options:[{id:"yes",label:"Escalate"}, {id:"no",label:"Keep Tier 1"}] },
    meta:{ intent:"ticket_create", trace_id: traceId(), steps:["Created ticket","Attached context","Tagged product area"] }
  };
}

/* --- CRM generic action (find contact / create deal) --- */
function handleCRM(utterance){
  return {
    mode:"text",
    script: bursts("Checking the CRM…","Found a matching contact and created a follow-up deal draft."),
    cards:[{ format:"table", summary:"CRM (demo)", value:{ columns:["Contact","Email","Deal"], rows:[["Mr. Martin","martin@example.com","Deal #D-123 (Draft)"]] } }],
    ask:{ context_id: traceId(), question:"Convert draft to active deal?", options:[{id:"activate",label:"Yes"}, {id:"edit",label:"Edit first"}] },
    meta:{ intent:"crm_action", trace_id: traceId(), steps:["Searched contact by name","Created deal draft","Linked to account"] }
  };
}

/* --- Small talk --- */
function handleSmallTalk(){
  return {
    mode:"text",
    script: bursts(
      "Hey! I’m here — what can I do for you?",
      "Ask me to create, send, schedule, or look up anything."
    ),
    cards: [],
    meta:{ intent:"small_talk", trace_id: traceId(), steps:["Greeted user"] }
  };
}

/* --- General question (KB/LLM or demo) --- */
async function handleGeneralQuestion({ utterance, kb_json, company_system_prompt, history, mode }){
  let text = await maybeLLMAnswer({ kb_json, company_system_prompt, user: utterance, history, mode });
  if (!text) {
    // demo fallback using KB meta if available
    const co = kb_json?.meta?.company?.name || "your company";
    text = `Here’s a quick answer based on what I know about ${co}. If you want, I can also take action for you.`;
  }
  return {
    mode:"text",
    script: bursts(text),
    cards: [],
    meta:{ intent:"general_question", trace_id: traceId(), steps:["Answered via KB/LLM (or demo)."] }
  };
}

/* -------------------- Handler registry -------------------- */
const INTENT_HANDLERS = {
  create_quote:      (ctx) => handleQuote(ctx.utterance),
  create_invoice:    (ctx) => handleInvoice(ctx.utterance),
  payment_link:      (ctx) => handlePaymentLink(ctx.utterance),
  email_send:        (ctx) => handleEmailSend(ctx.utterance),
  whatsapp_send:     (ctx) => handleWhatsApp(ctx.utterance),
  sms_send:          (ctx) => handleSMS(ctx.utterance),
  calendar_create_event:(ctx) => handleCalendarEvent(ctx.utterance),
  doc_create:        (ctx) => handleDocCreate(ctx.utterance),
  search_web:        (ctx) => handleSearchWeb(ctx.utterance),
  tasks_create:      (ctx) => handleTaskCreate(ctx.utterance),
  ticket_create:     (ctx) => handleTicketCreate(ctx.utterance),
  crm_action:        (ctx) => handleCRM(ctx.utterance),
  small_talk:        (ctx) => handleSmallTalk(ctx.utterance),
  general_question:  (ctx) => handleGeneralQuestion(ctx),
};

/* -------------------- Main route -------------------- */
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

    let {
      utterance = "",
      mode = "text",
      history = [],
      tenant = null, token = null,
      kb_json = null, company_system_prompt = null,
    } = readBody(req);

    // NOTE: keep zero external deps; if you need to fetch tenant KB here later, re-add a fetch.

    const { type } = detectIntent(utterance);
    const handler = INTENT_HANDLERS[type] || INTENT_HANDLERS.general_question;

    const payload = await handler({ utterance, mode, history, kb_json, company_system_prompt, tenant, token });

    // Guarantee structure for the UI
    payload.mode = payload.mode || "text";
    payload.script = Array.isArray(payload.script) ? payload.script : [];
    payload.cards  = Array.isArray(payload.cards)  ? payload.cards  : [];
    payload.meta   = Object(payload.meta);
    if (!payload.meta.trace_id) payload.meta.trace_id = traceId();
    if (!Array.isArray(payload.meta.steps)) payload.meta.steps = [];

    return okJSON(res, payload);
  } catch (e) {
    return errJSON(res, e?.message || e);
  }
};
