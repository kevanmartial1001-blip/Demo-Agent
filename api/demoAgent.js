// /api/demoAgent.js
// Human-like demo assistant. Now supports:
// 1) Direct KB (kb_json + company_system_prompt)  OR
// 2) tenant + token  -> fetch KB from Google Sheets.

module.exports.config = { runtime: "nodejs" };

const crypto = require("node:crypto");
const { google } = require("googleapis");

const MAX_JSON_CHARS = 120000;
const MODEL = process.env.OPENAI_AGENT_MODEL || "gpt-4o-mini";

// ---------- token verify ----------
function verifyToken(token) {
  if (!token) return null;
  const [tenant, expStr, sig] = String(token).split(".");
  const exp = parseInt(expStr, 10);
  if (!tenant || !exp || exp < Math.floor(Date.now() / 1000)) return null;
  const raw = `${tenant}.${exp}.${process.env.DEMO_SECRET}`;
  const chk = crypto.createHash("sha256").update(raw).digest("base64url");
  return chk === sig ? tenant : null;
}

// ---------- Google Sheets helpers ----------
function serviceAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!email || !key) throw new Error("Google SA missing");
  key = key.replace(/\\n/g, "\n");
  return new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}
async function readTenantsSheetAll() {
  const spreadsheetId = process.env.SHEET_ID;
  if (!spreadsheetId) throw new Error("SHEET_ID missing");
  const auth = serviceAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Tenants!A1:ZZ10000",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = data.values || [];
  const headers = rows[0] || [];
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
  const items = rows.slice(1).map((r) => {
    const get = (k) => (idx[k] != null ? (r[idx[k]] ?? "") : "");
    const obj = {};
    headers.forEach((h) => (obj[h] = get(h)));
    return obj;
  });
  return { headers, items };
}
function parseJSONSafe(s) { try { return s ? JSON.parse(String(s)) : null; } catch { return null; } }
function reassembleKbJson(headers, rowObj) {
  const kbCols = headers
    .filter((h) => /^kb_json(_\d+)?$/i.test(h))
    .sort((a, b) => {
      const na = a === "kb_json" ? 0 : parseInt(a.split("_")[2] || a.split("_")[1] || "0", 10);
      const nb = b === "kb_json" ? 0 : parseInt(b.split("_")[2] || b.split("_")[1] || "0", 10);
      return na - nb;
    });
  const joined = kbCols.map((h) => String(rowObj[h] || "")).join("");
  return parseJSONSafe(joined) || parseJSONSafe(rowObj.kb_json) || {};
}

// ---------- Demo tables (fallbacks) ----------
const mkTable = (columns, rows) => ({ format: "table", summary: "Demo numbers (connect for live data).", value: { columns, rows } });
function buildAnswer(topic, kb) {
  switch (topic) {
    case "inventory":
      return mkTable(["SKU","Product","On Hand","Reserved","Available"],[
        ["UH-001", kb?.example_top_product || "Ultra Hoodie", 820,120,700],
        ["BT-099","Basic Tee",1450,260,1190],
        ["CP-223","Classic Polo",680,90,590]
      ]);
    case "hr":
      return mkTable(["Employee","From","To","Type"],[
        [kb?.example_employee_1||"C. Alvarez","2025-07-08","2025-07-16","Vacation"],
        [kb?.example_employee_2||"M. Duarte","2025-07-11","2025-07-12","PTO"],
        [kb?.example_employee_3||"S. Ruiz",   "2025-07-22","2025-07-29","Vacation"]
      ]);
    case "revenue":
    case "report":
      return mkTable(["Week","Region","Channel","Revenue (€)"],[
        ["W-2", kb?.example_top_region||"Andalucía","Online",58210],
        ["W-2", kb?.primary_region    ||"Marbella", "Retail",39400],
        ["W-1", kb?.example_top_region||"Andalucía","Online",54730]
      ]);
    default:
      return { format:"text", value:"Once connected, I’d pull this live and complete the task automatically." };
  }
}
function textFromAnswer(a){
  if (a?.format === "table") {
    const { columns, rows } = a.value;
    return rows.map(r=>r.map((v,i)=>`${columns[i]}: ${v}`).join(" | ")).join("\n");
  }
  return a?.value || "";
}

// ---------- Intent ----------
function detect(utterance=""){
  const u = utterance.toLowerCase();
  const wantsEmail   = /email|mail|correo/.test(u);
  const wantsWA      = /whatsapp|wa\b/.test(u);
  const wantsCall    = /\bcall|ring|phone me|ll[aá]m/.test(u);
  const wantsSend    = /\bsend|share|env[ií]a|enviar/.test(u);

  const wantsReport  = /\breport|informe|summary|resumen/.test(u);
  const wantsRevenue = /\brevenue|sales|ventas|ingresos/.test(u);
  const wantsInv     = /\binventory|stock|existencias/.test(u);
  const wantsHR      = /\bvacation|pto|holiday|vacaciones/.test(u);
  const wantsInvoice = /\binvoice|bill|factura/.test(u);

  if ((wantsSend && (wantsEmail||wantsWA)) || wantsEmail || wantsWA)
    return { intent: wantsWA ? "send_whatsapp" : "send_email", topic:
      (wantsInv&&"inventory")||(wantsHR&&"hr")||(wantsRevenue&&"revenue")||(wantsReport&&"report")||"generic" };

  if (wantsCall)     return { intent:"place_call", topic:"generic" };
  if (wantsInvoice)  return { intent:"create_invoice", topic:"billing" };
  if (wantsInv)      return { intent:"inventory_lookup", topic:"inventory" };
  if (wantsHR)       return { intent:"hr_schedule", topic:"hr" };
  if (wantsRevenue||wantsReport) return { intent:"sales_report", topic:"revenue" };
  return { intent:"generic_question", topic:"generic" };
}

// ---------- LLM ----------
function briefFromKB(kb) {
  if (!kb || typeof kb !== "object") return "No KB loaded.";
  const meta = kb.meta || {};
  const co = meta.company || {};
  const sections = kb.sections || {};
  const counts = Object.fromEntries(Object.entries(sections).map(([k,v]) => [k, Array.isArray(v)? v.length:0]));
  const lines = [
    `Company: ${co.name || "unknown"} (${co.domain || "unknown"})`,
    `Homepage: ${co.homepage_url || "unknown"}`,
    `KB version: ${meta.kb_version || "unknown"}`,
    `Sections: ${Object.entries(counts).map(([k,n]) => `${k}(${n})`).join(", ") || "none"}`
  ];
  return lines.join("\n");
}
async function kbAnswerWithLLM({ kb_json, company_system_prompt, user, history=[], mode="text" }) {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!kb_json || !company_system_prompt) return null;

  const kbRaw = JSON.stringify(kb_json);
  const kbTrunc = kbRaw.length > MAX_JSON_CHARS ? (kbRaw.slice(0, MAX_JSON_CHARS) + "\n/*[truncated]*/") : kbRaw;
  const kbBrief = briefFromKB(kb_json);

  const histMsgs = (Array.isArray(history)? history:[]).slice(-10).map(h=>{
    if (h.role === "user") return { role:"user", content:h.text || "" };
    if (h.role === "assistant") return { role:"assistant", content:"OK." };
    return null;
  }).filter(Boolean);

  const messages = [
    { role:"system", content: String(company_system_prompt) },
    { role:"system", content: "KB_BRIEF:\n" + kbBrief },
    { role:"system", content: "KB_JSON:\n" + kbTrunc },
    ...histMsgs,
    { role:"user", content: `User mode: ${mode}\n\n${user}` },
    { role:"system", content: "Rules: Use ONLY KB evidence where possible; if missing, state a careful inference with confidence (high/medium/low). Keep answers concise and practical. Cite section keys / URLs used." }
  ];

  const r = await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{ "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type":"application/json" },
    body: JSON.stringify({ model: MODEL, temperature: 0.2, messages })
  });
  if (!r.ok) return null;
  const j = await r.json().catch(()=>null);
  const text = j?.choices?.[0]?.message?.content?.trim();
  if (!text) return null;
  return text;
}

// ---------- Helpers ----------
async function postJSON(baseUrl, path, payload){
  const r = await fetch(`${baseUrl}${path}`,{
    method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(payload)
  });
  const j = await r.json().catch(()=>({ ok:false, error:"Bad JSON" }));
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// ---------- Main ----------
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

  try{
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body||{});
    let {
      utterance="", kb={}, client={}, mode="text", response_to,
      kb_json=null, company_system_prompt=null, history=[],
      tenant=null, token=null
    } = body;

    // If tenant+token provided, fetch KB from sheet (UI can send just tenant+token)
    if ((!kb_json || !company_system_prompt) && tenant && token) {
      const validT = verifyToken(token);
      if (validT === tenant) {
        const { headers, items } = await readTenantsSheetAll();
        const row = items.find((r) => String(r.tenant_id) === String(tenant));
        if (row) {
          kb_json = reassembleKbJson(headers, row);
          company_system_prompt = row.company_system_prompt || company_system_prompt;
        }
      }
    }

    // Try LLM first if KB + system prompt are present
    const { intent, topic } = detect(utterance);
    let llmText = null;
    try {
      llmText = await kbAnswerWithLLM({ kb_json, company_system_prompt, user: utterance, history, mode });
    } catch (_) {}

    if (llmText) {
      return res.status(200).json({
        mode,
        script: [{ text: llmText }],
        cards: [],
        meta: { intent: "kb_answer", topic, trace_id: "demo_" + Math.random().toString(36).slice(2,10), used_llm: true }
      });
    }

    // ---- FALLBACK deterministic demo flow ----
    const answer = buildAnswer(topic, kb);
    const proto = req.headers["x-forwarded-proto"] || "https";
    const baseUrl = `${proto}://${req.headers.host}`;

    const script = [];
    const cards  = [];
    const say = (text, delay=0) => script.push({ text, delay_ms: delay });

    if (intent === "inventory_lookup") {
      say("Sure — opening Inventory → Stock Check…", 0);
      say("Give me a second to pull live counts…", 600);
      say(`Found it.`, 700);
      cards.push(answer);
    } else if (intent === "sales_report") {
      say("On it — fetching Sales → Weekly Revenue…", 0);
      say("Compiling the last two weeks…", 700);
      say("Ready.", 600);
      cards.push(answer);
    } else if (intent === "hr_schedule") {
      say("Opening HR → Time Off…", 0);
      say("Checking upcoming vacations…", 600);
      cards.push(answer);
    } else if (intent === "create_invoice") {
      const ctx = "demo_" + Math.random().toString(36).slice(2,10);
      say("Absolutely — I’ll prepare the invoice for Mr. Martin.", 0);
      say("I’ll grab recent work items and fill the template.", 700);
      say("Where should I send it?", 600);
      return res.status(200).json({
        mode,
        script,
        ask: {
          context_id: ctx,
          question: "Send the invoice via…",
          options: [
            { id:"whatsapp", label:"WhatsApp" },
            { id:"email",    label:"Email" }
          ],
          requires: {}
        },
        meta: { intent, topic, trace_id: ctx }
      });
    }

    // Deliver actions
    const phone = (client.phone || kb?.demo_client?.phone || "").trim();
    const email = (client.email || kb?.demo_client?.email || "").trim();
    let performed = null;
    try{
      if (intent === "send_email") {
        if (!email) throw new Error("No email on file");
        say("Sure — packaging the report and sending email…", 0);
        await postJSON(baseUrl, "/api/sendMailgun", {
          to: email, subject: `Your ${topic} report`, html: htmlFrom(answer, "email")
        });
        say(`Done — sent to ${email}.`, 900);
        performed = { ok:true, type:"email", to:email };
      } else if (intent === "send_whatsapp") {
        if (!phone) throw new Error("No phone on file");
        say("Got it — composing WhatsApp message…", 0);
        await postJSON(baseUrl, "/api/sendWhatsApp", {
          to: phone, body: `Your ${topic} report:\n\n${textFromAnswer(answer)}`
        });
        say(`Sent on WhatsApp to ${phone}.`, 900);
        performed = { ok:true, type:"whatsapp", to:phone };
      } else if (intent === "place_call") {
        if (!phone) throw new Error("No phone on file");
        say("Okay — placing a quick follow-up call…", 0);
        await postJSON(baseUrl, "/api/call", {
          to: phone, message: `This is your AI Employee with your ${topic} update. I also sent details to your inbox.`
        });
        say(`Calling ${phone} now.`, 900);
        performed = { ok:true, type:"call", to:phone };
      }
    } catch (e) {
      say(`Action failed: ${String(e.message||e)}.`, 0);
      performed = { ok:false, error:String(e.message||e) };
    }

    const response = {
      mode,
      script: script.length ? script : [{ text:"Here’s what I found.", delay_ms:0 }],
      cards:  (mode==="call") ? [] : (cards.length ? cards : [answer]),
      meta: { intent, topic, trace_id: "demo_" + Math.random().toString(36).slice(2,10), performed, used_llm: false }
    };
    return res.status(200).json(response);

  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
};

// --- helpers for email HTML
function htmlFrom(answer, title="Report"){
  if (answer?.format === "table") {
    const { columns, rows } = answer.value;
    const rowsHtml = rows.map(r=>`<tr>${r.map(v=>`<td>${String(v)}</td>`).join("")}</tr>`).join("");
    return `<h2>Your AI Employee — ${title}</h2>
      <table border="1" cellpadding="6" cellspacing="0">
        <thead><tr>${columns.map(c=>`<th align="left">${c}</th>`).join("")}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <p style="color:#666">Demo data — connect for live numbers.</p>`;
  }
  return `<p>${answer?.value || ""}</p>`;
}
