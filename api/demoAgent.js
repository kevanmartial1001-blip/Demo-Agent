// /api/demoAgent.js
// Universal Demo Agent — "ChatGPT for your business" (demo/simulated)
// Produces: natural-language reply + 3 cards (Answer / How / Why)
// Works without OPENAI_API_KEY (heuristics), but shines with it.

module.exports.config = { runtime: 'nodejs18.x' };

let OpenAI;
try { OpenAI = require('openai'); } catch (_) {}
const fs = require('fs');
const path = require('path');

// =============== Utilities ===============
function mulberry32(a){return function(){let t=(a+=0x6D2B79F5);t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}
function renderTemplate(str, ctx, rng){
  return String(str).replace(/\{\{\s*([^\}]+)\s*\}\}/g,(_,expr)=>{
    expr=expr.trim();
    if(expr.startsWith('randomInt(')){
      const m=expr.match(/randomInt\((\-?\d+)\s*,\s*(\-?\d+)\)/);
      if(!m) return '';
      const lo=parseInt(m[1],10), hi=parseInt(m[2],10);
      return String(lo+Math.floor(rng()*(hi-lo+1)));
    }
    const parts=expr.split('.'); let v=ctx;
    for(const p of parts){ if(v && p in v) v=v[p]; else {v=''; break;} }
    return (v==null)?'':String(v);
  });
}
function mkTraceId(){ return 'demo_'+Math.random().toString(36).slice(2,10); }

// =============== KB Normalize ===============
function normalizeKB(kb={}){
  return {
    company_name: kb.company_name || kb.name || "Your Company",
    sector: kb.sector || kb.industry || "General",
    primary_region: kb.primary_region || kb.region || kb.hq_region || "your main region",
    example_top_product: kb.example_top_product,
    example_top_region: kb.example_top_region,
    example_employee_1: kb.example_employee_1 || "A. Garcia",
    example_employee_2: kb.example_employee_2 || "L. Rossi",
    example_employee_3: kb.example_employee_3 || "N. Smith",
    tone: kb.tone || "professional",
    brand_voice: kb.brand_voice || "helpful and concise"
  };
}

// =============== Template Library (fallback) ===============
const DEFAULT_TEMPLATES = [
  {
    id:"get_inventory_v1", intent:"get_inventory",
    matchers:["inventory","stock","sku","warehouse","units","in stock"],
    answer_template:"Approximate stock for {{entities.product || 'the requested product'}} across {{kb.primary_region}} is {{randomInt(180,520)}} units (simulated).",
    workflow_trace:[
      "Parsed your request and identified Inventory Lookup.",
      "Resolved product name/SKU from your KB.",
      "Queried the simulated Inventory Service across locations.",
      "Validated totals vs last week snapshot.",
      "Summarized per-location and overall coverage."
    ],
    benefits:[
      "Cuts manual checks by 80–90%.",
      "Prevents stockouts with proactive alerts.",
      "Frees Ops to plan replenishment."
    ],
    presentation:{ columns:["Location","Quantity","Updated"],
      rows:[["WH-{{randomInt(1,3)}}","{{randomInt(60,220)}}","Today"],
            ["WH-{{randomInt(4,6)}}","{{randomInt(40,180)}}","Today"],
            ["Store-{{randomInt(1,2)}}","{{randomInt(20,120)}}","Today"]] }
  },
  {
    id:"get_revenue_last_week_v1", intent:"get_revenue_last_week",
    matchers:["revenue","sales","turnover","gmv","last week","past week"],
    answer_template:"Estimated revenue last week (simulated) in {{kb.primary_region}}: €{{randomInt(50000,150000)}}. Top driver: {{kb.example_top_product || 'Flagship SKU'}}.",
    workflow_trace:[
      "Detected Revenue Reporting intent.",
      "Aligned window to Mon→Sun.",
      "Grouped transactions by product/region (simulated).",
      "Calculated totals and WoW delta.",
      "Prepared a concise summary."
    ],
    benefits:[
      "Weekly CFO snapshot in seconds.",
      "Highlights growth/decline pockets.",
      "Feeds next actions for Sales/Marketing."
    ],
    presentation:{ columns:["Metric","Value"],
      rows:[["Total Revenue (LW)","€{{randomInt(50000,150000)}}"],
            ["WoW Change","{{randomInt(-8,18)}}%"],
            ["Top Product","{{kb.example_top_product || 'Flagship SKU'}}"]] }
  },
  {
    id:"get_upcoming_vacations_v1", intent:"get_upcoming_vacations",
    matchers:["vacation","pto","ooo","leave","time off"],
    answer_template:"Upcoming PTO (simulated) for {{entities.team || 'the selected team'}}: {{randomInt(2,6)}} employees in the next 30 days.",
    workflow_trace:[
      "Recognized Time-Off Overview intent.",
      "Scoped to team/department from KB.",
      "Checked OOO and approvals (simulated HRIS).",
      "Flagged coverage risk windows.",
      "Built a 30-day view."
    ],
    benefits:[
      "Prevents coverage gaps.",
      "Saves managers hours each week.",
      "Improves planning reliability."
    ],
    presentation:{ columns:["Employee","Dates","Reason"],
      rows:[[ "{{kb.example_employee_1}}","Oct {{randomInt(6,10)}}–{{randomInt(11,15)}}","Vacation" ],
            [ "{{kb.example_employee_2}}","Oct {{randomInt(18,22)}}–{{randomInt(23,28)}}","Family" ],
            [ "{{kb.example_employee_3}}","Oct {{randomInt(25,26)}}","Appointment" ]] }
  },
  {
    id:"simulate_inbound_call_v1", intent:"simulate_inbound_call",
    matchers:["simulate call","customer call","role play","roleplay","phone script"],
    answer_template:"Here’s a realistic {{kb.sector}} call script about {{entities.topic || 'a product inquiry'}} (simulated).",
    workflow_trace:[
      "Detected Call Simulation intent.",
      "Pulled tone/brand voice & FAQs from KB.",
      "Generated opening, probing, objection handling, close.",
      "Included follow-up for SMS/email.",
      "Added compliance hints."
    ],
    benefits:[
      "Standardizes CX and accelerates training.",
      "Lifts conversion with guided prompts.",
      "Consistent data capture for CRM."
    ],
    presentation:{ columns:["Speaker","Line"],
      rows:[
        ["Customer","Hi, I’m calling about {{entities.topic || 'pricing and availability'}}."],
        ["Agent","Thanks for calling {{kb.company_name}} — I can help. Which {{entities.topic || 'product'}} are you looking at?"],
        ["Customer","The {{kb.example_top_product || 'main product'}}."],
        ["Agent","Great choice. We can deliver in {{randomInt(2,5)}} business days. Would you like me to email a quote after this call?"]
      ] }
  },
  {
    id:"generic_question_v2", intent:"generic_question",
    matchers:["how","what","why","when","where","help","?"],
    answer_template:"Here’s a recommended approach for {{kb.company_name}} in {{kb.primary_region}} (simulated).",
    workflow_trace:[
      "Parsed your objective and constraints.",
      "Referenced your KB for sector-specific context.",
      "Outlined a 3-step plan and data needed.",
      "Mapped the plan to a future workflow.",
      "Prepared next best actions."
    ],
    benefits:[
      "Gives a clear, repeatable method.",
      "Reduces back-and-forth.",
      "Ready to convert into an automated playbook."
    ],
    presentation:{ columns:["Step","Action"],
      rows:[["1","Clarify success criteria & guardrails."],
            ["2","Draft a minimal template/playbook; test on one case."],
            ["3","Operationalize: triggers, owners, alerts."]] }
  }
];

// load optional /templates/intents.demo.json
function loadTemplates(){
  try {
    const p = path.join(process.cwd(),'templates','intents.demo.json');
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p,'utf8'));
      if (Array.isArray(data) && data.length) return data;
    }
  } catch {}
  return DEFAULT_TEMPLATES;
}

// =============== Intent Detection ===============
function detectIntentHeuristic(utterance, templates){
  const t=utterance.toLowerCase();
  for(const tpl of templates){
    if((tpl.matchers||[]).some(m=>t.includes(String(m).toLowerCase()))) return tpl.intent;
  }
  // domain hints:
  if(/inventory|stock|sku|warehouse/.test(t)) return 'get_inventory';
  if(/revenue|sales|turnover|gmv|last week|past week/.test(t)) return 'get_revenue_last_week';
  if(/vacation|pto|leave|ooo|time off/.test(t)) return 'get_upcoming_vacations';
  if(/call|role ?play|phone script/.test(t)) return 'simulate_inbound_call';
  return 'generic_question';
}

function guessEntities(utterance, plan){
  if(!plan.entities) plan.entities={};
  if(!plan.entities.product){
    const m = utterance.match(/(?:for|of)\s+([A-Za-z0-9\-'\s]{2,60})$/i);
    if(m) plan.entities.product=m[1].trim();
  }
  if(!plan.entities.team){
    const m = utterance.match(/\b(sales|support|ops|operations|hr|marketing|engineering|finance)\b/i);
    if(m) plan.entities.team=m[1].toLowerCase();
  }
  if(!plan.entities.topic){
    const m = utterance.match(/\b(pricing|refunds|availability|delivery|returns|billing|contract)\b/i);
    if(m) plan.entities.topic=m[1].toLowerCase();
  }
  return plan;
}

// =============== LLM Planner + Synthesizer ===============
async function planWithLLM(utterance, kb){
  if(!OpenAI || !process.env.OPENAI_API_KEY) return null;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const sys = [
    "You classify a user's business request for a DEMO agent (no real connectors).",
    "Return strict JSON: { intent, entities, confidence }",
    "Intents: get_inventory, get_revenue_last_week, get_upcoming_vacations, simulate_inbound_call, generic_question."
  ].join(' ');
  const user = JSON.stringify({ utterance, kb_preview: { company_name: kb.company_name, sector: kb.sector } });
  const r = await client.chat.completions.create({
    model:"gpt-4o-mini",
    messages:[{role:"system",content:sys},{role:"user",content:user}],
    response_format:{type:"json_object"},
    temperature:0.1
  });
  try { return JSON.parse(r.choices[0].message.content); } catch { return null; }
}

// **NEW**: LLM Synthesizer — crafts rich NL answer + cards for ANY request
async function synthesizeWithLLM(utterance, kbNorm, plan){
  if(!OpenAI || !process.env.OPENAI_API_KEY) return null;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const sys = `
You are a universal business assistant in DEMO mode.
- Speak as a helpful, senior operator for ${kbNorm.company_name} (${kbNorm.sector}) in ${kbNorm.primary_region}.
- No real system access. Produce PLAUSIBLE values and clearly mark them as simulated.
- Output strict JSON:
{
  "nl": "natural language reply (2-5 short paragraphs)",
  "answer": { "title": "string", "format": "text|table|json", "value": any, "summary": "optional string" },
  "explain": { "steps": ["5-7 short steps of how it would work with real systems"] },
  "impact": { "bullets": ["2-4 benefits"], "ctas": [{"label":"string","action":"string","requires_confirm":false}] }
}
Keep it professional, concise, and tailored to the KB. If tables help, use them.
`.trim();

  const user = JSON.stringify({
    utterance,
    intent: plan.intent,
    entities: plan.entities,
    kb: kbNorm
  });

  const r = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role:"system", content: sys }, { role:"user", content: user }],
    response_format: { type:"json_object" },
    temperature: 0.6
  });

  try { return JSON.parse(r.choices[0].message.content); }
  catch { return null; }
}

// =============== Heuristic Synthesizer (no LLM) ===============
function synthesizeHeuristic(utterance, kbNorm, plan, tpl, rng){
  // NL summary tailored per intent
  let nl;
  switch(plan.intent){
    case 'get_inventory':
      nl = `Here’s a simulated view of stock for ${plan.entities.product||'the item'} across ${kbNorm.primary_region}. These numbers are illustrative for the demo; when connected to your ERP, the results will be live and exact.`;
      break;
    case 'get_revenue_last_week':
      nl = `Below is a demo weekly revenue snapshot for ${kbNorm.company_name}. Once connected to Stripe/Shop/ERP, we’ll produce this automatically every week, with drill-downs by product and region.`;
      break;
    case 'get_upcoming_vacations':
      nl = `Here’s a simulated view of upcoming PTO for ${plan.entities.team||'the team'}. In production we’ll pull this from your HRIS and flag coverage risks in real time.`;
      break;
    case 'simulate_inbound_call':
      nl = `Here’s a realistic call script in your brand voice. In production we can route calls, transcribe, and push outcomes to CRM automatically.`;
      break;
    default:
      nl = `I drafted a practical approach tailored to ${kbNorm.company_name}. This is a demo with plausible values; the live version uses your connected systems.`;
  }

  // Build cards from template
  const ctx = { kb: kbNorm, entities: plan.entities };
  const table = tpl.presentation ? {
    columns: tpl.presentation.columns.map(c=>renderTemplate(c, ctx, rng)),
    rows: tpl.presentation.rows.map(r=>r.map(cell=>renderTemplate(cell, ctx, rng)))
  } : null;

  const answer = table
    ? { title:"Answer", format:"table", value: table, summary: renderTemplate(tpl.answer_template, ctx, rng) }
    : { title:"Answer", format:"text", value: renderTemplate(tpl.answer_template, ctx, rng) };

  const explain = { steps: (tpl.workflow_trace||[]).map(s=>renderTemplate(s, ctx, rng)) };
  const impact = { bullets: (tpl.benefits||[]).map(b=>renderTemplate(b, ctx, rng)),
    ctas: [{ label:"Connect to my real systems", action:"request_integration", requires_confirm:false }]
  };

  return { nl, answer, explain, impact };
}

// =============== Handler ===============
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS'){
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
    return res.status(204).end();
  }
  if (req.method !== 'POST'){
    return res.status(405).json({ ok:false, error:'Method Not Allowed' });
  }

  try{
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { utterance, kb={}, seed, demo=true } = body;
    if (!utterance || typeof utterance !== 'string'){
      return res.status(400).json({ ok:false, error:'Missing "utterance" (string).' });
    }

    const kbNorm = normalizeKB(kb);
    const rng = mulberry32( seed ?? (kb.company_id?.split('').reduce((a,c)=>a+c.charCodeAt(0),0) || 12345) );
    const templates = loadTemplates();

    // PLAN
    let plan = await planWithLLM(utterance, kb).catch(()=>null);
    if(!plan){
      plan = { intent: detectIntentHeuristic(utterance, templates), entities: {}, confidence: 0.51 };
    }
    plan = guessEntities(utterance, plan);

    // TEMPLATE
    let tpl = templates.find(t=>t.intent===plan.intent);
    if(!tpl){ tpl = templates.find(t=>t.intent==='generic_question') || DEFAULT_TEMPLATES[DEFAULT_TEMPLATES.length-1]; }

    // SYNTHESIZE
    let synth = await synthesizeWithLLM(utterance, kbNorm, plan).catch(()=>null);
    if(!synth){
      synth = synthesizeHeuristic(utterance, kbNorm, plan, tpl, rng);
    }

    const response = {
      ok:true,
      nl: synth.nl, // natural-language top reply
      answer: synth.answer,
      explain: synth.explain,
      impact: synth.impact,
      meta:{
        intent: plan.intent,
        template_id: tpl.id,
        confidence: plan.confidence ?? 0.5,
        demo,
        trace_id: mkTraceId(),
        data_sources:["Company KB (simulated)"]
      }
    };

    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Content-Type','application/json; charset=utf-8');
    return res.status(200).json(response);
  } catch (e){
    console.error('demoAgent error', e);
    return res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
};
