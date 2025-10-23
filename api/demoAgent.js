// /api/demoAgent.js
// Proactive, tool-aware demo agent with burst-style replies and full demo fallbacks.
// Works even if tools have no keys (all tools return realistic demo responses).
module.exports.config = { runtime: "nodejs18.x" };

const MODEL = process.env.OPENAI_AGENT_MODEL || "gpt-4o-mini";
const MAX_JSON_CHARS = 120000;

// ---- utilities -------------------------------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const traceId = () => "trc_" + Math.random().toString(36).slice(2, 10);

// Prevent splitting on abbreviations like "Mr.", "Mrs.", "Dr.", "Sr.", "Sra.", etc.
function splitForBurst(text) {
  if (!text) return [];
  const protectedAbbrevs = ["Mr\\.", "Mrs\\.", "Ms\\.", "Dr\\.", "Sr\\.", "Sra\\.", "Prof\\.", "St\\.", "vs\\."];
  const guard = new RegExp(`\\b(?:${protectedAbbrevs.join("|")})$`);
  const chunks = [];
  let buff = "";
  for (const part of text.split(/(\.|\?|!)/)) {
    if (!part) continue;
    buff += part;
    if (/[.!?]$/.test(buff)) {
      // avoid splitting if buffer ends with "Mr." etc.
      const tail = buff.trim().split(/\s+/).slice(-1)[0] || "";
      if (guard.test(tail)) continue;
      chunks.push(buff.trim());
      buff = "";
    }
  }
  if (buff.trim()) chunks.push(buff.trim());
  // keep bursts short; re-chunk long sentences
  const out = [];
  for (const s of chunks) {
    if (s.length <= 180) { out.push(s); continue; }
    // soft break on commas
    const bits = s.split(/, /);
    let acc = "";
    for (const b of bits) {
      const next = acc ? acc + ", " + b : b;
      if (next.length > 180) { if (acc) out.push(acc + "."); acc = b; }
      else acc = next;
    }
    if (acc) out.push(acc + ".");
  }
  return out.slice(0, 6); // keep it snappy
}

function briefFromKB(kb) {
  if (!kb || typeof kb !== "object") return "No KB loaded.";
  const meta = kb.meta || {};
  const co = meta.company || {};
  const sections = kb.sections || {};
  const counts = Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]));
  return [
    `Company: ${co.name || "unknown"} (${co.domain || "unknown"})`,
    `Homepage: ${co.homepage_url || co.url || "unknown"}`,
    `KB version: ${meta.kb_version || "unknown"}`,
    `Sections: ${Object.entries(counts).map(([k, n]) => `${k}(${n})`).join(", ") || "none"}`,
  ].join("\n");
}

async function kbAnswerWithLLM({ kb_json, company_system_prompt, user, history = [], mode = "text" }) {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!kb_json || !company_system_prompt) return null;

  const kbRaw = JSON.stringify(kb_json);
  const kbTrunc = kbRaw.length > MAX_JSON_CHARS ? kbRaw.slice(0, MAX_JSON_CHARS) + "\n/*[truncated]*/" : kbRaw;
  const kbBrief = briefFromKB(kb_json);

  const histMsgs = (Array.isArray(history) ? history : [])
    .slice(-8)
    .map((h) => (h.role === "user" ? { role: "user", content: h.text || "" } : { role: "assistant", content: "OK." }));

  const messages = [
    { role: "system", content: String(company_system_prompt) },
    { role: "system", content: "KB_BRIEF:\n" + kbBrief },
    { role: "system", content: "KB_JSON:\n" + kbTrunc },
    ...histMsgs,
    { role: "user", content: `User mode: ${mode}\n\n${user}` },
    { role: "system", content: "Rules: Prefer KB facts. If unsure, keep it short. Output 2–4 short sentences max." },
  ];

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, temperature: 0.2, messages }),
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j?.choices?.[0]?.message?.content?.trim() || null;
}

function needsAgent(utterance = "") {
  const u = utterance.toLowerCase();
  const verbs = ["invoice","bill","quote","proposal","schedule","meeting","calendar","send","email","whatsapp","generate","draft","prepare","create document","create slide","presentation","crawl","scrape","research","upload","export","pay","payment","ship","delivery","order"];
  return verbs.some(w => u.includes(w));
}

function extractClientName(utterance="") {
  // Quick heuristic for names after titles; default to "Mr. Martin"
  const m = utterance.match(/\b(Mr\.|Mrs\.|Ms\.|Dr\.)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/);
  return m ? `${m[1]} ${m[2]}` : "Mr. Martin";
}

// ---- tool runner ------------------------------------------------
async function runTool(tool, input, emit) {
  // dynamic import from /tools without version pinning; tools return { data, status }
  const mod = await import(process.cwd().replace(/\\/g, "/") + `/tools/${tool}.js`);
  if (!mod || typeof mod.run !== "function") throw new Error(`tool_not_found:${tool}`);
  return await mod.run({ input, emit });
}

// Collect notes/errors from tools to surface in UI if desired
function mkEmitter(logs=[]) {
  return (evt) => {
    if (!evt) return;
    logs.push(evt);
  };
}

// ---- canned demo artifacts -------------------------------------
function demoInvoice({ customer="Mr. Martin", amount=1250, currency="€" } = {}) {
  const id = "INV-" + Math.random().toString(36).slice(2,7).toUpperCase();
  const dateStr = new Date().toISOString().slice(0,10);
  return {
    id,
    customer,
    items: [{ description: "Consulting Services — July", qty: 1, unit_price: amount, total: amount }],
    subtotal: amount, tax: 0, total: amount, currency, date: dateStr,
    pdf_url: `https://placehold.co/980x1380/pdf?text=${encodeURIComponent(id)}%20for%20${encodeURIComponent(customer)}`
  };
}

function mkInvoiceTableCard(inv){
  return {
    format: "table",
    summary: "Draft invoice (demo)",
    value: {
      columns: ["Invoice #", "Customer", "Date", "Subtotal", "Tax", "Total"],
      rows: [[inv.id, inv.customer, inv.date, `${inv.currency}${inv.subtotal}`, `${inv.currency}${inv.tax}`, `${inv.currency}${inv.total}`]]
    }
  };
}

// ---- main handler ----------------------------------------------
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    let {
      utterance = "",
      mode = "text",
      history = [],
      tenant = null, token = null,
      kb_json = null, company_system_prompt = null,
      user_id = "u_demo",
      client = {}
    } = body;

    const proto = req.headers["x-forwarded-proto"] || "https";
    const baseUrl = `${proto}://${req.headers.host}`;
    const trace = traceId();

    // If tenant + token provided, try to pull KB quickly
    if (tenant && token && (!kb_json || !company_system_prompt)) {
      try {
        const r = await fetch(`${baseUrl}/api/tenantGet?tenant=${encodeURIComponent(tenant)}&token=${encodeURIComponent(token)}`);
        const j = await r.json();
        if (j?.ok && j.tenant) {
          kb_json = j.tenant.kb_json || kb_json;
          company_system_prompt = j.tenant.company_system_prompt || company_system_prompt;
        }
      } catch {}
    }

    // If proactive task → run a mini-plan immediately (no background).
    if (needsAgent(utterance)) {
      const logs = [];
      const emit = mkEmitter(logs);
      const name = extractClientName(utterance);

      // Acknowledge fast (first bubble of the burst shows "Your AI Employee")
      const script = [];
      const say = (t, delay = 0, showRole = false) => script.push({ text: t, delay_ms: delay, show_role: !!showRole });

      say("Ok — give me 1 min and let me see how I can help with this.", 0, true);

      // STEP 1: find or create an invoice template (memory + doc)
      let templateFound = false;
      try {
        await runTool("memory_get", { query: "invoice template", top_k: 3, namespace: tenant || "demo" }, emit);
        templateFound = true; // with DEMO mode we act as if we found something
      } catch { templateFound = false; }

      if (!templateFound) {
        await runTool("doc_create", {
          title: "Invoice Template",
          body_md: "# Invoice\nCustomer: {{customer}}\nItems:\n{{items}}\nTotal: {{total}} {{currency}}",
          folder: "Templates"
        }, emit);
        say("I couldn’t find an invoice template, so I created a fresh one.", 350);
      } else {
        say("I located our invoice template.", 350);
      }

      // STEP 2: fetch CRM info about the customer
      let serviceDesc = "Consulting Services — July";
      try {
        await runTool("crm_find_contact", { query: name }, emit);
        say(`I pulled ${name}’s details from the CRM and identified the last service.`, 350);
      } catch {
        say(`CRM lookup is not connected yet, so I used the latest service on file.`, 350);
      }

      // STEP 3: create invoice data (and simulate PDF)
      const inv = demoInvoice({ customer: name, amount: 1250, currency: "€" });
      try {
        await runTool("invoice_create", {
          customer_name: name,
          line_items: [{ description: serviceDesc, qty: 1, unit_price: inv.total }],
          currency: "EUR"
        }, emit);
      } catch {}

      // Try to generate a PDF (tools have DEMO mode so we’ll get a mock URL)
      let pdfUrl = inv.pdf_url;
      try {
        const pdf = await runTool("pdf_generate", {
          html: `<h1>Invoice ${inv.id}</h1><p>Customer: ${inv.customer}</p><p>Total: ${inv.currency}${inv.total}</p>`,
          filename: `${inv.id}.pdf`
        }, emit);
        if (pdf?.data?.url) pdfUrl = pdf.data.url;
      } catch {}

      // STEP 4: present the result and offer next actions
      const cards = [
        mkInvoiceTableCard(inv),
        { format: "file", summary: "Invoice PDF", value: { url: pdfUrl, name: `${inv.id}.pdf` } }
      ];

      // Burst explanation (without repeating "Your AI Employee" label on every bubble – your UI already handles it)
      const explain = [
        "I set up the invoice with the latest service details and today’s date.",
        `Customer: ${name}.`,
        `Total: ${inv.currency}${inv.total}.`,
        "Tell me if you want any changes — I can update items, amounts, or tax."
      ];
      for (const msg of explain) say(msg, 350);

      // Offer next step (assistant should take initiative)
      say("If it looks good, I can prepare an email draft and attach the PDF for your review.", 350);

      // Ask action options for UI
      const ask = {
        context_id: trace,
        question: "Next step?",
        options: [
          { id: "email", label: "Prepare email draft" },
          { id: "send_now", label: "Send invoice now" },
          { id: "edit", label: "Modify invoice" }
        ]
      };

      return res.status(200).json({
        mode,
        script,
        cards,
        ask,
        meta: { intent: "create_invoice", topic: "billing", trace_id: trace, logs, used_llm: false }
      });
    }

    // Not a proactive task → try fast KB answer
    let llmText = null;
    try {
      llmText = await kbAnswerWithLLM({ kb_json, company_system_prompt, user: utterance, history, mode });
    } catch {}

    if (llmText) {
      // split into bursts and return
      const bursts = splitForBurst(llmText);
      const script = [];
      bursts.forEach((b, i) => {
        script.push({ text: b, delay_ms: i === 0 ? 0 : 280 });
      });
      return res.status(200).json({
        mode,
        script,
        cards: [],
        meta: { intent: "kb_answer", topic: "generic", trace_id: trace, used_llm: true }
      });
    }

    // Still nothing → be proactive with a general plan (demo)
    const script = [
      { text: "Ok — let me take care of this.", delay_ms: 0, show_role: true },
      { text: "I’ll check our knowledge base and run the right tools.", delay_ms: 300 },
      { text: "I’ll be back with a result and next steps.", delay_ms: 300 }
    ];
    return res.status(200).json({
      mode,
      script,
      cards: [{ format: "text", value: "Demo mode: tools will simulate results so you can preview the flow." }],
      meta: { intent: "generic_plan", topic: "generic", trace_id: trace, used_llm: false }
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
