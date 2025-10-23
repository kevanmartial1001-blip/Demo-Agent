// /api/demoAgent.js
// Enhanced human-like assistant with phase tracking (progress bar + status feed)

module.exports.config = { runtime: "nodejs" };

/* ──────────────── Utils ──────────────── */
function traceId(){ return "trc_" + Math.random().toString(36).slice(2,10); }
function nowISO(){ return new Date().toISOString(); }
function fmtEUR(n){ try { return new Intl.NumberFormat('en-US',{style:'currency',currency:'EUR'}).format(n); } catch { return `€${(+n||0).toFixed(2)}`; } }
function okJSON(res,obj){ try{res.setHeader("Content-Type","application/json");}catch{} return res.status(200).json(obj); }
function errJSON(res,msg){
  try{res.setHeader("Content-Type","application/json");}catch{}
  return res.status(200).json({
    mode:"text",
    script:[{text:"Something went wrong — fallback mode.",delay_ms:0,show_role:true}],
    cards:[{format:"text",summary:"Error",value:String(msg)}],
    meta:{error:true,trace_id:traceId(),steps:["Caught error in /api/demoAgent; fallback."]}
  });
}
function readBody(req){
  try{
    if(typeof req.body==="object") return req.body;
    if(typeof req.body==="string") return JSON.parse(req.body||"{}");
  }catch{}
  return {};
}
function bursts(...lines){return lines.map((text,i)=>({text,delay_ms:300,show_role:i===0}));}
function clamp(n,min,max){return Math.min(max,Math.max(min,n));}

/* ──────────────── Phase helpers ──────────────── */
function newPhases(){return [];}
function pushPhase(arr,text,pct){arr.push({text,progress:pct});}

/* ──────────────── Tool auto-detection ──────────────── */
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
  kb:       !!process.env.KB_PROVIDER
};

async function tryToolCall(req,path,payload,timeoutMs=9000){
  const proto=req.headers["x-forwarded-proto"]||"https";
  const baseUrl=`${proto}://${req.headers.host}`;
  const ac=new AbortController();
  const t=setTimeout(()=>ac.abort("timeout"),timeoutMs);
  try{
    const r=await fetch(`${baseUrl}${path}`,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(payload||{}),
      signal:ac.signal
    });
    clearTimeout(t);
    const j=await r.json().catch(()=>({ok:false,error:"Bad JSON"}));
    if(!r.ok||j.ok===false) return {ok:false,error:j.error||`HTTP ${r.status}`};
    return j;
  }catch(e){clearTimeout(t);return{ok:false,error:String(e?.message||e)};}
}

/* ──────────────── Visual mocks ──────────────── */
function imgEmailPreview({to,subject}){const t=encodeURIComponent(`Email to ${to||"Contact"}`);const s=encodeURIComponent(subject||"Follow-up");return`https://placehold.co/980x520/png?text=${t}%0A${s}`;}
function imgPDFMock(kind,id,who){const t=encodeURIComponent(`${kind} ${id} · ${who||"Contact"}`);return`https://placehold.co/980x1380/png?text=${t}`;}
function imgCalendarCard({title,when}){const t=encodeURIComponent(`${title||"Event"}%0A${when||nowISO().slice(0,10)}`);return`https://placehold.co/980x360/png?text=${t}`;}
function imgCRMCard({contact,note}){const t=encodeURIComponent(`${contact||"Contact"}%0A${note||"Activity logged"}`);return`https://placehold.co/980x400/png?text=${t}`;}
function imgListingsGrid({title="Marbella · 5-bed · Sea view · 2000m²+"}={}){const t=encodeURIComponent(title);return`https://placehold.co/980x640/png?text=${t}`;}

/* ──────────────── Context store ──────────────── */
const CTX=new Map();
function newCtx(){return{
  people:[],current_contact:null,tone:"professional",
  email:{to:null,subject:null,body:null,attachments:[]},
  quote:{contact:null,amount:null,currency:"EUR",pdf_url:null,id:null},
  crm:{action:null,type:null,notes:null,due:null,status:"Open"},
  calendar:{title:null,start:null,end:null,location:"Google Meet"},
  requested:{},last_plan:[],pending:null,last_updated:nowISO()
};}
function loadCtx(session_id){if(!CTX.has(session_id))CTX.set(session_id,newCtx());return CTX.get(session_id);}
function saveCtx(session_id,ctx){ctx.last_updated=nowISO();CTX.set(session_id,ctx);}

/* ──────────────── LLM helper (unchanged) ──────────────── */
const MODEL=process.env.OPENAI_AGENT_MODEL||"gpt-4o-mini";
async function maybeLLMAnswer({company_system_prompt,kb_json,user}){
  if(!process.env.OPENAI_API_KEY) return null;
  const sys=[];
  if(company_system_prompt) sys.push(company_system_prompt);
  const co=kb_json?.meta?.company;
  if(co) sys.push(`Company profile: ${JSON.stringify(co).slice(0,800)}`);
  const messages=[
    {role:"system",content:sys.join("\n\n")||"You are a concise, helpful assistant."},
    {role:"user",content:user}
  ];
  try{
    const r=await fetch("https://api.openai.com/v1/chat/completions",{
      method:"POST",
      headers:{"Authorization":`Bearer ${process.env.OPENAI_API_KEY}`,"Content-Type":"application/json"},
      body:JSON.stringify({model:MODEL,temperature:0.2,messages})
    });
    if(!r.ok) return null;
    const j=await r.json().catch(()=>null);
    return j?.choices?.[0]?.message?.content?.trim()||null;
  }catch{return null;}
}
/* ──────────────── Main route (with thinking phases) ──────────────── */
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST")
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });

    let {
      utterance = "",
      mode = "text",
      history = [],
      tenant = null,
      token = null,
      kb_json = null,
      company_system_prompt = null,
      session_id = "demo"
    } = readBody(req);

    const ctx = loadCtx(session_id);
    const phases = newPhases();       // NEW: live progress tracker
    const steps = [];
    const script = [];
    const cards  = [];
    let ask = null;

    pushPhase(phases, "Understanding your request…", 8);

    /* ─────── Parse intents ─────── */
    ingestUtterance(utterance, ctx);
    const intents = detect(utterance);
    const plan = buildPlan(intents, ctx, utterance);
    pushPhase(phases, "Planning the best next action…", 18);

    /* ─────── Context enrichment ─────── */
    if (
      (plan.includes("email_prepare") ||
       plan.includes("quote_create") ||
       plan.includes("crm_update") ||
       plan.includes("calendar_create_event")) &&
      (ctx.current_contact || ctx.quote.contact)
    ) {
      pushPhase(phases, "Checking CRM for context…", 28);
      await enrichFromCRM(req, ctx, steps);
    }

    /* ─────── Execute plan steps ─────── */
    if (plan.length) {
      pushPhase(phases, "Executing tasks…", 45);
    } else {
      pushPhase(phases, "No clear task — engaging in chat…", 45);
    }

    for (const step of plan) {
      pushPhase(phases, `→ ${step.replace(/_/g, " ")}`, clamp(45 + Math.random() * 30, 46, 80));

      let out = null;
      if (step === "quote_create") {
        out = handleQuoteCreate(ctx, steps);
        ctx.pending = { type: "send_email" };

      } else if (step === "email_prepare") {
        out = handleEmailPrepare(ctx, steps);
        ctx.pending = { type: "send_email" };

      } else if (step === "crm_update") {
        out = handleCRMUpdate(ctx, steps);

      } else if (step === "calendar_create_event") {
        const m = utterance.toLowerCase().match(/\bin\s+(\d+)\s+day/);
        const days = m ? clamp(parseInt(m[1], 10), 0, 365) : 3;
        out = handleCalendarEvent(ctx, steps, days, !!m);
        ctx.pending = { type: "create_event" };

      } else if (step === "search_web") {
        out = await handleSearchWeb(req, ctx, utterance, steps);

      } else if (step === "confirm_action") {
        out = await handleConfirmation(req, ctx, steps, utterance);

      } else if (step === "small_talk") {
        out = handleSmallTalk();

      } else if (step === "general_question") {
        out = await handleGeneralQuestion(utterance, kb_json, company_system_prompt);
      }

      if (out) {
        if (out.script) script.push(...out.script);
        if (out.cards)  cards.push(...out.cards);
        if (out.ask)    ask = out.ask;
      }
    }

    pushPhase(phases, "Finalizing results…", 92);
    await new Promise(r => setTimeout(r, 300)); // small delay for realism
    pushPhase(phases, "Preparing human-friendly answer…", 100);

    /* ─────── Save context ─────── */
    ctx.last_plan = plan;
    saveCtx(session_id, ctx);

    if (plan.length === 0) {
      const fallback = handleSmallTalk();
      script.push(...fallback.script);
      steps.push(...fallback.steps);
    }

    /* ─────── Return enhanced payload ─────── */
    return okJSON(res, {
      mode,
      phases,      // NEW: array of { text, progress }
      script,      // final burst messages
      cards,       // visual results
      ask,         // confirmation options
      meta: {
        trace_id: traceId(),
        session_id,
        intent: plan[0] || "general",
        steps,
        plan,
        tools_connected: CAP
      }
    });
  } catch (e) {
    return errJSON(res, e?.message || e);
  }
};
