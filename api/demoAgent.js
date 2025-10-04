// /api/demoAgent.js
// Universal Demo Agent — KB-personalized, connectorless simulation
// Env: OPENAI_API_KEY (optional — regex fallback exists)

module.exports.config = { runtime: 'nodejs18.x' };

// ---- safe imports
let OpenAI;
try { OpenAI = require('openai'); } catch (_) {}

// ---- simple seeded RNG (stable per session)
function mulberry32(a) {
  return function() {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- tiny templater: {{var}} + helpers {{randomInt(a,b)}}
function renderTemplate(str, ctx, rng) {
  return String(str).replace(/\{\{\s*([^\}]+)\s*\}\}/g, (_, expr) => {
    expr = expr.trim();
    if (expr.startsWith('randomInt(')) {
      const m = expr.match(/randomInt\((\-?\d+)\s*,\s*(\-?\d+)\)/);
      if (!m) return '';
      const [_, a, b] = m;
      const lo = parseInt(a, 10), hi = parseInt(b, 10);
      return String(lo + Math.floor(rng() * (hi - lo + 1)));
    }
    // nested prop support: a.b.c
    const parts = expr.split('.');
    let v = ctx;
    for (const p of parts) { if (v && p in v) v = v[p]; else { v = ''; break; } }
    return (v === undefined || v === null) ? '' : String(v);
  });
}

// ---- load templates (inline fallback)
const DEFAULT_TEMPLATES = [
  {
    id: "get_inventory_v1",
    intent: "get_inventory",
    matchers: ["inventory", "stock", "in stock", "units", "warehouse", "SKU"],
    answer_template:
      "Based on your {{kb.primary_region || 'main'}} operations, you have approximately {{randomInt(180,520)}} units of {{entities.product || 'the requested product'}} available across {{randomInt(2,4)}} locations. A typical weekly sell-through for {{entities.product || 'this item'}} at {{kb.company_name}} is ~{{randomInt(60,140)}} units.",
    workflow_trace: [
      "Parsed your request and identified an Inventory Lookup intent.",
      "Resolved the product using your catalog (name/SKU) from the company KB.",
      "Queried the (simulated) Inventory Service across all active locations.",
      "Validated totals against last week’s snapshot to catch anomalies.",
      "Consolidated warehouse-level quantities and computed coverage days."
    ],
    benefits: [
      "Reduces manual stock checks by ~80–90%.",
      "Prevents stockouts and overstock via automated low-stock alerts.",
      "Frees Ops to focus on replenishment planning and priority SKUs."
    ],
    presentation: {
      columns: ["Location", "Quantity", "Last Updated"],
      rows: [
        ["WH-{{randomInt(1,3)}}", "{{randomInt(60,220)}}", "Today"],
        ["WH-{{randomInt(4,6)}}", "{{randomInt(40,180)}}", "Today"],
        ["Store-{{randomInt(1,2)}}", "{{randomInt(20,120)}}", "Today"]
      ]
    }
  },
  {
    id: "get_revenue_last_week_v1",
    intent: "get_revenue_last_week",
    matchers: ["revenue", "sales", "turnover", "last week", "GMV", "income"],
    answer_template:
      "From {{kb.primary_region || 'your main market'}}, estimated revenue for last week is €{{randomInt(50000,150000)}}. Top drivers: {{kb.example_top_product || 'your best-selling product'}}, and {{kb.example_top_region || 'primary region'}}.",
    workflow_trace: [
      "Detected a Revenue Reporting intent.",
      "Aligned time window to last Monday→Sunday in the company timezone.",
      "Pulled (simulated) transactions and grouped by product/region.",
      "Computed totals, growth vs prior week, and standout segments.",
      "Prepared a concise leadership summary."
    ],
    benefits: [
      "Delivers a weekly CFO-grade snapshot in seconds.",
      "Highlights growth pockets and under-performance automatically.",
      "Feeds a 1-click ‘Friday Brief’ that nudges owners to act."
    ],
    presentation: {
      columns: ["Metric", "Value"],
      rows: [
        ["Total Revenue (LW)", "€{{randomInt(50000,150000)}}"],
        ["WoW Change", "{{randomInt(-8,18)}}%"],
        ["Top Product", "{{kb.example_top_product || 'Flagship SKU'}}"]
      ]
    }
  },
  {
    id: "get_upcoming_vacations_v1",
    intent: "get_upcoming_vacations",
    matchers: ["vacation", "time off", "OOO", "PTO", "leave"],
    answer_template:
      "Upcoming time-off (simulated) for the {{entities.team || 'selected team'}}: {{randomInt(2,6)}} employees have PTO within the next 30 days.",
    workflow_trace: [
      "Recognized a Time-Off Overview intent.",
      "Scoped to the requested team/department from the KB.",
      "Checked OOO entries and pending approvals (simulated HRIS).",
      "Detected any coverage risk windows.",
      "Compiled a 30-day forward calendar."
    ],
    benefits: [
      "Prevents coverage gaps by surfacing risk periods.",
      "Saves managers hours per week consolidating calendars.",
      "Feeds staffing and customer-promise decisions."
    ],
    presentation: {
      columns: ["Employee", "Dates", "Reason"],
      rows: [
        ["{{kb.example_employee_1 || 'A. Garcia'}}", "Oct {{randomInt(6,10)}}–{{randomInt(11,15)}}", "Vacation"],
        ["{{kb.example_employee_2 || 'L. Rossi'}}", "Oct {{randomInt(18,22)}}–{{randomInt(23,28)}}", "Family"],
        ["{{kb.example_employee_3 || 'N. Smith'}}", "Oct {{randomInt(25,26)}}", "Appointment"]
      ]
    }
  }
];

// ---- naive intent detection (regex) if no LLM
function detectIntentHeuristic(text, templates) {
  const t = text.toLowerCase();
  for (const tpl of templates) {
    if ((tpl.matchers || []).some(m => t.includes(m.toLowerCase()))) return tpl.intent;
  }
  // fallbacks
  if (/inventory|stock|sku|warehouse/i.test(text)) return "get_inventory";
  if (/revenue|sales|turnover|gmv|last week/i.test(text)) return "get_revenue_last_week";
  if (/vacation|pto|leave|ooo|time off/i.test(text)) return "get_upcoming_vacations";
  return "generic_question";
}

// ---- LLM planner (optional)
async function planWithLLM(utterance, kb) {
  if (!OpenAI || !process.env.OPENAI_API_KEY) return null;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const sys = [
    "You classify the user's request for a demo agent.",
    "Return strict JSON with fields: intent, entities (object), confidence (0..1).",
    "Intents: get_inventory, get_revenue_last_week, get_upcoming_vacations, simulate_inbound_call, generic_question."
  ].join(' ');
  const user = JSON.stringify({ utterance, kb_preview: { company_name: kb?.company_name, sector: kb?.sector } });
  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    response_format: { type: "json_object" },
    temperature: 0.1
  });
  try { return JSON.parse(res.choices[0].message.content); } catch { return null; }
}

function chooseTemplate(intent, templates) {
  return templates.find(t => t.intent === intent) || null;
}

function buildContext(kb = {}, entities = {}) {
  // Normalize a minimal KB shape
  return {
    kb: {
      company_name: kb.company_name || kb.name || "Your Company",
      sector: kb.sector || kb.industry || "General",
      primary_region: kb.primary_region || kb.region || kb.hq_region || "your main region",
      example_top_product: kb.example_top_product,
      example_top_region: kb.example_top_region,
      example_employee_1: kb.example_employee_1,
      example_employee_2: kb.example_employee_2,
      example_employee_3: kb.example_employee_3,
    },
    entities
  };
}

function tableFromTemplate(pres, ctx, rng) {
  if (!pres || !pres.columns || !pres.rows) return null;
  const columns = pres.columns.map(c => renderTemplate(c, ctx, rng));
  const rows = pres.rows.map(r => r.map(cell => renderTemplate(cell, ctx, rng)));
  return { columns, rows };
}

async function readJsonTemplates() {
  // If you move templates to /templates/intents.demo.json you can load here with fs.
  // In serverless environments without fs, rely on DEFAULT_TEMPLATES.
  return DEFAULT_TEMPLATES;
}

function mkTraceId() {
  return 'demo_' + Math.random().toString(36).slice(2, 10);
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { utterance, kb = {}, actor = {}, seed, demo = true } = body;
    if (!utterance || typeof utterance !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing "utterance" (string).' });
    }

    // seed → consistent randomness per session/company
    const seedBase = seed ?? (kb.company_id?.length ? kb.company_id.split('').reduce((a,c)=>a+c.charCodeAt(0),0) : 12345);
    const rng = mulberry32(seedBase);

    const templates = await readJsonTemplates();

    // Try LLM planner, fallback to heuristic
    let plan = await planWithLLM(utterance, kb);
    if (!plan) {
      plan = { intent: detectIntentHeuristic(utterance, templates), entities: {}, confidence: 0.51 };
    }

    // Simple entity sniffers (if LLM didn't fill)
    if (!plan.entities) plan.entities = {};
    if (!plan.entities.product) {
      const m = utterance.match(/(?:for|of)\s+([A-Za-z0-9\-\s]{2,40})$/i);
      if (m) plan.entities.product = m[1].trim();
    }
    if (!plan.entities.team && /(team|sales|support|ops|hr)/i.test(utterance)) {
      const m = utterance.match(/(sales|support|ops|operations|hr|marketing|engineering)/i);
      if (m) plan.entities.team = m[1].toLowerCase();
    }

    const tpl = chooseTemplate(plan.intent, templates) || chooseTemplate('generic_question', templates);
    if (!tpl) {
      return res.status(200).json({
        ok: true,
        answer: { title: "Demo Answer", format: "text", value: "Here’s how this would work once connected to your systems." },
        explain: { steps: ["Planner identified your intent.", "Would route to the right workflow.", "Would call the necessary systems.", "Would validate and summarize results."] },
        impact: { bullets: ["Time saved", "Reduced errors", "Faster decisions"] },
        meta: { intent: plan.intent, trace_id: mkTraceId(), demo }
      });
    }

    const ctx = buildContext(kb, plan.entities);

    // Compose Answer
    const answerText = renderTemplate(tpl.answer_template, ctx, rng);
    const table = tableFromTemplate(tpl.presentation, ctx, rng);

    const answer = table
      ? { title: "Answer", format: "table", value: table, summary: answerText }
      : { title: "Answer", format: "text", value: answerText };

    // Explain (workflow trace)
    const explain = { steps: (tpl.workflow_trace || []).map(s => renderTemplate(s, ctx, rng)) };

    // Impact (benefits)
    const impact = { bullets: (tpl.benefits || []).map(b => renderTemplate(b, ctx, rng)),
      ctas: [{ label: "Connect to my real systems", action: "request_integration", requires_confirm: false }]
    };

    const resp = {
      ok: true,
      answer,
      explain,
      impact,
      meta: {
        intent: tpl.intent,
        template_id: tpl.id,
        confidence: plan.confidence ?? 0.5,
        demo,
        trace_id: mkTraceId(),
        data_sources: ["Company KB (simulated)"]
      }
    };

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).json(resp);
  } catch (err) {
    console.error('demoAgent error', err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
};
