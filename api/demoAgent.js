// /api/demoAgent.js
// Proactive, tool-aware demo agent with robust tool loading and demo fallbacks.
module.exports.config = { runtime: "nodejs18.x" };

const path = require("path");
const fs = require("fs");

const MODEL = process.env.OPENAI_AGENT_MODEL || "gpt-4o-mini";
const MAX_JSON_CHARS = 120000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const traceId = () => "trc_" + Math.random().toString(36).slice(2, 10);

// ---- burst splitting (protects "Mr.", "Dr.", etc.) -------------------------
function splitForBurst(text) {
  if (!text) return [];
  const protectedAbbrevs = ["Mr\\.", "Mrs\\.", "Ms\\.", "Dr\\.", "Sr\\.", "Sra\\.", "Prof\\.", "St\\.", "vs\\."];
  const guard = new RegExp(`^(?:${protectedAbbrevs.join("|")})$`);
  const chunks = [];
  let buf = "";
  const parts = text.split(/(\.|\?|!)/);
  for (const p of parts) {
    if (!p) continue;
    buf += p;
    if (/[.!?]$/.test(buf)) {
      const tail = (buf.trim().split(/\s+/).slice(-1)[0] || "");
      if (guard.test(tail)) continue; // don't cut after "Mr."
      chunks.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  const out = [];
  for (const s of chunks) {
    if (s.length <= 180) { out.push(s); continue; }
    const bits = s.split(/, /);
    let acc = "";
    for (const b of bits) {
      const next = acc ? acc + ", " + b : b;
      if (next.length > 180) { if (acc) out.push(acc + "."); acc = b; }
      else acc = next;
    }
    if (acc) out.push(acc + ".");
  }
  return out.slice(0, 6);
}

// ---- KB helper -------------------------------------------------------------
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

// ---- intent / parsing -------------------------------------------------------
function needsAgent(utterance = "") {
  const u = utterance.toLowerCase();
  const verbs = [
    "invoice","bill","quote","proposal","schedule","meeting","calendar","send",
    "email","whatsapp","generate","draft","prepare","create document","create slide",
    "presentation","crawl","scrape","research","upload","export","pay","payment","ship","delivery","order"
  ];
  return verbs.some((w) => u.includes(w));
}
function extractClientName(utterance = "") {
  const m = utterance.match(/\b(Mr\.|Mrs\.|Ms\.|Dr\.)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/);
  return m ? `${m[1]} ${m[2]}` : "Mr. Martin";
}

// ---- robust tool runner (never throws back to caller) ----------------------
async function safeRunTool(toolName, input, emit) {
  const logs = emit ? [] : null;
  const push = (t, msg) => { try { emit && emit({ type: t, msg }); } catch {} };

  // Try CJS require first, then dynamic import. If both fail → demo stub.
  const filePath = path.join(process.cwd(), "tools", `${toolName}.js`);
  let mod = null;

  try {
    if (fs.existsSync(filePath)) {
      // Try require (CJS)
      try { mod = require(filePath); } catch {}
      // If ESM export, require returns an object that might not contain run; try dynamic import
      if (!mod || typeof mod.run !== "function") {
        try { mod = await import(filePath + `?t=${Date.now()}`); } catch {}
      }
    }
  } catch {}

  if (!mod || typeof mod.run !== "function") {
    push("note", `safeRunTool: ${toolName} not found — returning demo response`);
    // universal demo stub
    return {
      data: { provider: "demo", status: "ok", mock: true, info: `Demo ${toolName} executed`, url: "https://example.com/demo" },
      status: "ok"
    };
  }

  try {
    return await mod.run({ input, emit });
  } catch (e) {
    push("error", `safeRunTool: ${toolName} failed (${String(e?.message || e)}). Using demo fallback.`);
    return {
      data: { provider: "demo", status: "ok", mock: true, info: `Demo ${toolName} executed (fallback)` },
      status: "ok"
    };
  }
}

// ---- demo helpers ----------------------------------------------------------
function demoInvoice({ customer = "Mr. Martin", amount = 1250, currency = "€" } = {}) {
  const id = "INV-" + Math.random().toString(36).slice(2, 7).toUpperCase();
  const dateStr = new Date().toISOString().slice(0, 10);
  return {
    id, customer,
    items: [{ description: "Consulting Services — July", qty: 1, unit_price: amount, total: amount }],
    subtotal: amount, tax: 0, total: amount, currency, date: dateStr,
    pdf_url: `https://placehold.co/980x1380/pdf?text=${encodeURIComponent(id)}%20for%20${encodeURIComponent(customer)}`
  };
}
function mkInvoiceTableCard(inv) {
  return {
    format: "table",
    summary: "Draft invoice (demo)",
    value: {
      columns: ["Invoice #", "Customer", "Date", "Subtotal", "Tax", "Total"],
      rows: [[inv.id, inv.customer, inv.date, `${inv.currency}${inv.subtotal}`, `${inv.currency}${inv.tax}`, `${inv.currency}${inv.total}`]]
    }
  };
}

// ---- main handler ----------------------------------------------------------
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

    // Pull tenant KB if provided
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

    // PROACTIVE PATH
    if (needsAgent(utterance)) {
      const logs = [];
      const emit = (evt) => { try { logs.push(evt); } catch {} };
      const name = extractClientName(utterance);

      const script = [];
      const say = (t, delay = 0, showRole = false) => script.push({ text: t, delay_ms: delay, show_role: !!showRole });

      say("Ok — give me 1 min and let me see how I can help with this.", 0, true);

      // 1) memory/template
      let templateFound = false;
      try {
        await safeRunTool("memory_get", { query: "invoice or quote template", top_k: 3, namespace: tenant || "demo" }, emit);
        templateFound = true;
      } catch { templateFound = false; }
      if (!templateFound) {
        await safeRunTool("doc_create", {
          title: "Invoice/Quote Template",
          body_md: "# Document\nCustomer: {{customer}}\nItems:\n{{items}}\nTotal: {{total}} {{currency}}",
          folder: "Templates"
        }, emit);
        say("I couldn’t find a template, so I created a fresh one.", 320);
      } else {
        say("I located our template.", 320);
      }

      // 2) CRM lookup
      let serviceDesc = "Consulting Services — July";
      await safeRunTool("crm_find_contact", { query: name }, emit);
      say(`I pulled ${name}’s details from the CRM and identified the last service.`, 320);

      // 3) Build artifact (invoice or quote demo) + PDF
      const amount = (() => {
        const m = utterance.match(/(\d{2,})\s?€|\€\s?(\d{2,})/);
        const n = m ? Number(m[1] || m[2]) : 1250;
        return isFinite(n) ? n : 1250;
      })();
      const inv = demoInvoice({ customer: name, amount, currency: "€" });

      await safeRunTool("invoice_create", {
        customer_name: name,
        line_items: [{ description: serviceDesc, qty: 1, unit_price: inv.total }],
        currency: "EUR"
      }, emit);

      let pdfUrl = inv.pdf_url;
      const pdf = await safeRunTool("pdf_generate", {
        html: `<h1>Invoice ${inv.id}</h1><p>Customer: ${inv.customer}</p><p>Total: ${inv.currency}${inv.total}</p>`,
        filename: `${inv.id}.pdf`
      }, emit);
      if (pdf?.data?.url) pdfUrl = pdf.data.url;

      const cards = [
        mkInvoiceTableCard(inv),
        { format: "file", summary: "Invoice PDF", value: { url: pdfUrl, name: `${inv.id}.pdf` } }
      ];

      const explain = [
        "I set up the document with the latest service details and today’s date.",
        `Customer: ${name}.`,
        `Total: ${inv.currency}${inv.total}.`,
        "Tell me if you want any changes — I can update items, amounts, or tax."
      ];
      for (const msg of explain) say(msg, 320);
      say("If it looks good, I can prepare an email draft and attach the PDF for your review.", 320);

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
        mode, script, cards, ask,
        meta: { intent: "create_invoice", topic: "billing", trace_id: trace, logs, used_llm: false }
      });
    }

    // KB ANSWER PATH
    let llmText = null;
    try {
      llmText = await kbAnswerWithLLM({ kb_json, company_system_prompt, user: utterance, history, mode });
    } catch {}

    if (llmText) {
      const bursts = splitForBurst(llmText);
      const script = bursts.map((b, i) => ({ text: b, delay_ms: i === 0 ? 0 : 280, show_role: i === 0 }));
      return res.status(200).json({
        mode, script, cards: [],
        meta: { intent: "kb_answer", topic: "generic", trace_id: trace, used_llm: true }
      });
    }

    // DEFAULT PLAN (safe demo)
    const script = [
      { text: "Ok — let me take care of this.", delay_ms: 0, show_role: true },
      { text: "I’ll check our knowledge base and run the right tools.", delay_ms: 300 },
      { text: "I’ll be back with a result and next steps.", delay_ms: 300 }
    ];
    return res.status(200).json({
      mode, script,
      cards: [{ format: "text", value: "Demo mode: tools will simulate results so you can preview the flow." }],
      meta: { intent: "generic_plan", topic: "generic", trace_id: trace, used_llm: false }
    });

  } catch (e) {
    return res.status(200).json({
      mode: "text",
      script: [{ text: "Something went wrong, but I’ve switched to demo mode.", delay_ms: 0, show_role: true }],
      cards: [{ format: "text", value: String(e?.message || e) }],
      meta: { error: true }
    });
  }
};
