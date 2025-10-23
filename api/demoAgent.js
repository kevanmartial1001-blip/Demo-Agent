// /api/demoAgent.js
// Ultra-thin brain: (A) fast KB-LLM answer if possible; else (B) plan an agent and return run_url for streaming.
//
// Keep your existing /api/assistant/ingest and /api/agent/run endpoints from the meta-agent layer.

module.exports.config = { runtime: "nodejs18.x" };

const MAX_JSON_CHARS = 120000;
const MODEL = process.env.OPENAI_AGENT_MODEL || "gpt-4o-mini";

function briefFromKB(kb) {
  if (!kb || typeof kb !== "object") return "No KB loaded.";
  const meta = kb.meta || {};
  const co = meta.company || {};
  const sections = kb.sections || {};
  const counts = Object.fromEntries(
    Object.entries(sections).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])
  );
  const lines = [
    `Company: ${co.name || "unknown"} (${co.domain || "unknown"})`,
    `Homepage: ${co.homepage_url || co.url || "unknown"}`,
    `KB version: ${meta.kb_version || "unknown"}`,
    `Sections: ${Object.entries(counts).map(([k, n]) => `${k}(${n})`).join(", ") || "none"}`,
  ];
  return lines.join("\n");
}

async function kbAnswerWithLLM({ kb_json, company_system_prompt, user, history = [], mode = "text" }) {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!kb_json || !company_system_prompt) return null;

  const kbRaw = JSON.stringify(kb_json);
  const kbTrunc = kbRaw.length > MAX_JSON_CHARS ? kbRaw.slice(0, MAX_JSON_CHARS) + "\n/*[truncated]*/" : kbRaw;
  const kbBrief = briefFromKB(kb_json);

  const histMsgs = (Array.isArray(history) ? history : [])
    .slice(-8)
    .map((h) => {
      if (h.role === "user") return { role: "user", content: h.text || "" };
      if (h.role === "assistant") return { role: "assistant", content: "OK." };
      return null;
    })
    .filter(Boolean);

  const messages = [
    { role: "system", content: String(company_system_prompt) },
    { role: "system", content: "KB_BRIEF:\n" + kbBrief },
    { role: "system", content: "KB_JSON:\n" + kbTrunc },
    ...histMsgs,
    { role: "user", content: `User mode: ${mode}\n\n${user}` },
    {
      role: "system",
      content:
        "Rules: Prefer direct answers using KB. If uncertain, keep it short and note confidence (high/medium/low). Output 2–4 tight sentences max.",
    },
  ];

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, temperature: 0.2, messages }),
  });

  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const text = j?.choices?.[0]?.message?.content?.trim();
  return text || null;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    let {
      utterance = "",
      mode = "text",
      history = [],
      // tenant path (fast)
      tenant = null,
      token = null,
      // fallback direct inject
      kb_json = null,
      company_system_prompt = null,
      user_id = "u_demo",
    } = body;

    const proto = req.headers["x-forwarded-proto"] || "https";
    const baseUrl = `${proto}://${req.headers.host}`;

    // If tenant+token provided, fetch KB quickly (keeps UI snappy)
    if (tenant && token && (!kb_json || !company_system_prompt)) {
      try {
        const r = await fetch(
          `${baseUrl}/api/tenantGet?tenant=${encodeURIComponent(tenant)}&token=${encodeURIComponent(token)}`
        );
        const j = await r.json();
        if (j?.ok && j.tenant) {
          kb_json = j.tenant.kb_json || kb_json;
          company_system_prompt = j.tenant.company_system_prompt || company_system_prompt;
        }
      } catch (_) {}
    }

    // (A) FAST PATH — try to answer via KB+LLM for speed
    let llmText = null;
    try {
      llmText = await kbAnswerWithLLM({ kb_json, company_system_prompt, user: utterance, history, mode });
    } catch (_) {}

    if (llmText) {
      // Return a compact "answer" type; UI will split into bursts.
      return res.status(200).json({
        type: "answer",
        text: llmText,
        meta: { used_llm: true },
      });
    }

    // (B) META-AGENT PATH — plan agent & return run_url for UI to stream
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
      run_url: plan.run_url, // UI will open SSE on this
      meta: { used_llm: false },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
