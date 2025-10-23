// /api/demoAgent.js
module.exports.config = { runtime: "nodejs18.x" };

const MAX_JSON_CHARS = 120000;
const MODEL = process.env.OPENAI_AGENT_MODEL || "gpt-4o-mini";

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

/** Tasks that should go straight to an autonomous agent (proactive behavior). */
function needsAgent(utterance = "") {
  const u = utterance.toLowerCase();
  const intentWords = [
    "invoice", "bill", "quote", "proposal",
    "schedule", "meeting", "calendar",
    "send", "email", "whatsapp",
    "generate", "draft", "prepare",
    "create document", "create slide", "presentation",
    "crawl", "scrape", "research", "upload", "export",
  ];
  return intentWords.some(w => u.includes(w));
}

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
    } = body;

    const proto = req.headers["x-forwarded-proto"] || "https";
    const baseUrl = `${proto}://${req.headers.host}`;

    // pull KB quickly if needed
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

    // If task needs proactive execution → skip KB chit-chat and plan an agent immediately.
    if (needsAgent(utterance)) {
      const planResp = await fetch(`${baseUrl}/api/assistant/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenant_id: tenant || "tenant_demo",
          user_id,
          task_text: utterance,
          mode,
        }),
      });
      if (!planResp.ok) {
        const err = await planResp.text();
        return res.status(500).json({ ok: false, error: `planner_error: ${err}` });
      }
      const plan = await planResp.json();
      return res.status(200).json({
        type: "planned",
        agent_id: plan.agent_id,
        run_url: plan.run_url,
        // Short acknowledgment to display immediately in the UI (proactive feel)
        ack: "Ok—give me 1 min. I’ll create the invoice, pull Mr. Martin’s service from the CRM, and bring you a draft to review.",
        meta: { used_llm: false },
      });
    }

    // Otherwise try fast KB-answer
    let llmText = null;
    try { llmText = await kbAnswerWithLLM({ kb_json, company_system_prompt, user: utterance, history, mode }); } catch {}
    if (llmText) return res.status(200).json({ type: "answer", text: llmText, meta: { used_llm: true } });

    // If still nothing, fall back to planning an agent anyway (keeps initiative high)
    const planResp = await fetch(`${baseUrl}/api/assistant/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: tenant || "tenant_demo", user_id, task_text: utterance, mode }),
    });
    if (!planResp.ok) {
      const err = await planResp.text();
      return res.status(500).json({ ok: false, error: `planner_error: ${err}` });
    }
    const plan = await planResp.json();
    return res.status(200).json({
      type: "planned",
      agent_id: plan.agent_id,
      run_url: plan.run_url,
      ack: "Ok—give me a moment, I’ll take care of this.",
      meta: { used_llm: false },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
