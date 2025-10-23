// /api/demoAgent.js
// Fast, non-blocking proactive demo agent. Always returns immediately.
// Switch to the real tool runner by setting AGENT_REAL_TOOLS=1 later.

module.exports.config = { runtime: "nodejs18.x" };

const MODEL = process.env.OPENAI_AGENT_MODEL || "gpt-4o-mini";
const MAX_JSON_CHARS = 120000;
const REAL_TOOLS = String(process.env.AGENT_REAL_TOOLS || "") === "1";

const traceId = () => "trc_" + Math.random().toString(36).slice(2, 10);

// --- helpers ----------------------------------------------------------------
function protectBurst(text) {
  if (!text) return [];
  const protectedAbbrevs = ["Mr\\.", "Mrs\\.", "Ms\\.", "Dr\\.", "Sr\\.", "Sra\\.", "Prof\\.", "St\\.", "vs\\."];
  const guard = new RegExp(`^(?:${protectedAbbrevs.join("|")})$`);
  const out = [];
  let buf = "";
  for (const part of text.split(/(\.|\?|!)/)) {
    if (!part) continue;
    buf += part;
    if (/[.!?]$/.test(buf)) {
      const tail = (buf.trim().split(/\s+/).slice(-1)[0] || "");
      if (guard.test(tail)) continue;
      out.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf.trim());
  // soft reflow to keep messages short
  const bursts = [];
  for (const s of out) {
    if (s.length <= 180) { bursts.push(s); continue; }
    const bits = s.split(/, /);
    let acc = "";
    for (const b of bits) {
      const next = acc ? acc + ", " + b : b;
      if (next.length > 180) { if (acc) bursts.push(acc + "."); acc = b; }
      else acc = next;
    }
    if (acc) bursts.push(acc + ".");
  }
  return bursts.slice(0, 6);
}

function extractClientName(utterance = "") {
  const m = utterance.match(/\b(Mr\.|Mrs\.|Ms\.|Dr\.)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/);
  return m ? `${m[1]} ${m[2]}` : "Mr. Martin";
}

function needsAgent(utterance = "") {
  const u = utterance.toLowerCase();
  const verbs = ["invoice","bill","quote","proposal","schedule","meeting","calendar","send","email","whatsapp","generate","draft","prepare","create","presentation","research","upload","export","order","payment","ship","delivery"];
  return verbs.some(v => u.includes(v));
}

function demoDoc({ customer = "Mr. Martin", amount = 1250, currency = "€", kind = "Invoice" } = {}) {
  const id = (kind === "Quote" ? "Q-" : "INV-") + Math.random().toString(36).slice(2, 7).toUpperCase();
  const dateStr = new Date().toISOString().slice(0, 10);
  return {
    id, kind, customer, date: dateStr, subtotal: amount, tax: 0, total: amount, currency,
    items: [{ description: `${kind} for services`, qty: 1, unit_price: amount, total: amount }],
    pdf_url: `https://placehold.co/980x1380/pdf?text=${encodeURIComponent(kind)}%20${encodeURIComponent(id)}%20for%20${encodeURIComponent(customer)}`
  };
}

function mkTableCard(doc) {
  return {
    format: "table",
    summary: `Draft ${doc.kind} (demo)`,
    value: {
      columns: [`${doc.kind} #`, "Customer", "Date", "Subtotal", "Tax", "Total"],
      rows: [[doc.id, doc.customer, doc.date, `${doc.currency}${doc.subtotal}`, `${doc.currency}${doc.tax}`, `${doc.currency}${doc.total}`]]
    }
  };
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

// --- MAIN -------------------------------------------------------------------
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
    } = body;

    const trace = traceId();

    // PROACTIVE (no I/O; immediate demo)
    if (needsAgent(utterance) || !process.env.OPENAI_API_KEY) {
      const name = extractClientName(utterance);
      const kind = /quote|proposal/i.test(utterance) ? "Quote" : "Invoice";
      // detect amount if present
      const m = utterance.match(/(\d[\d.,]*)\s*€|€\s*(\d[\d.,]*)/);
      const rawAmt = m ? (m[1] || m[2]) : "1250";
      const amt = Number(String(rawAmt).replace(/[.,](?=\d{3}\b)/g, "").replace(",", "."));
      const amount = isFinite(amt) && amt > 0 ? Math.round(amt * 100) / 100 : 1250;

      const doc = demoDoc({ customer: name, amount, currency: "€", kind });
      const cards = [
        mkTableCard(doc),
        { format: "file", summary: `${kind} PDF`, value: { url: doc.pdf_url, name: `${doc.id}.pdf` } }
      ];

      const bursts = [
        `I’ve prepared a ${kind.toLowerCase()} for ${name}.`,
        `Total: ${doc.currency}${doc.total}.`,
        "I used our standard template and the latest service details.",
        "Tell me if you want any edits — items, amounts, or tax.",
        "If it looks good, I can also draft the email and attach the PDF."
      ];

      const script = bursts.map((t, i) => ({ text: t, delay_ms: i === 0 ? 0 : 320, show_role: i === 0 }));

      // Optional: expose actions
      const ask = {
        context_id: trace,
        question: "Next step?",
        options: [
          { id: "email", label: "Prepare email draft" },
          { id: "send_now", label: `Send ${kind.toLowerCase()} now` },
          { id: "edit", label: "Modify details" }
        ]
      };

      return res.status(200).json({
        mode,
        script,
        cards,
        ask,
        meta: { intent: kind === "Quote" ? "create_quote" : "create_invoice", topic: "billing", trace_id: trace, used_llm: false, fast_demo: true }
      });
    }

    // If not proactive and OpenAI is available → concise KB answer
    const llmText = await kbAnswerWithLLM({ kb_json, company_system_prompt, user: utterance, history, mode });
    if (llmText) {
      const script = protectBurst(llmText).map((t, i) => ({ text: t, delay_ms: i === 0 ? 0 : 280, show_role: i === 0 }));
      return res.status(200).json({ mode, script, cards: [], meta: { intent: "kb_answer", topic: "generic", trace_id: trace, used_llm: true } });
    }

    // Fallback (shouldn’t happen, but just in case)
    return res.status(200).json({
      mode,
      script: [{ text: "Ok — I’ll take care of this right away.", delay_ms: 0, show_role: true }],
      cards: [{ format: "text", value: "Demo mode active. Ask me to create a quote or invoice to see a full example." }],
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
