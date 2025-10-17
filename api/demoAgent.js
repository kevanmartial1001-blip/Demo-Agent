// /api/demoAgent.js
// Fetches KB (with the same per-chunk dequoting), then uses LLM only if sections exist.

module.exports.config = { runtime: "nodejs" };

const crypto = require("node:crypto");
const { google } = require("googleapis");

const MAX_JSON_CHARS = 120000;
const MODEL = process.env.OPENAI_AGENT_MODEL || "gpt-4o-mini";

// ---------- token ----------
function verifyToken(token) {
  if (!token) return null;
  const [tenant, expStr, sig] = String(token).split(".");
  const exp = parseInt(expStr, 10);
  if (!tenant || !exp || exp < Math.floor(Date.now() / 1000)) return null;
  const raw = `${tenant}.${exp}.${process.env.DEMO_SECRET}`;
  const chk = crypto.createHash("sha256").update(raw).digest("base64url");
  return chk === sig ? tenant : null;
}

// ---------- Sheets ----------
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
async function readSheet() {
  const spreadsheetId = process.env.SHEET_ID;
  if (!spreadsheetId) throw new Error("SHEET_ID missing");
  const auth = serviceAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Tenants!A1:ZZ100000",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const headers = (data.values && data.values[0]) || [];
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
  const rows = (data.values || []).slice(1).map((r) => {
    const o = {};
    headers.forEach((h) => (o[h] = idx[h] != null ? (r[idx[h]] ?? "") : ""));
    return o;
  });
  return { headers, rows };
}

// ---------- reassembler (same as tenantGet) ----------
function parseJSONSafe(s){ try { return s ? JSON.parse(String(s)) : null; } catch { return null; } }
function hardClean(str){
  return String(str || "")
    .replace(/^\uFEFF/, "")
    .replace(/\u0000/g, "")
    .replace(/\u201C|\u201D/g, '"')
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\r/g, "");
}
function dequoteChunk(raw){
  let s = hardClean(String(raw||"")).trim();
  if (s.startsWith("=")) s = s.slice(1).trim();
  if (s.startsWith('"') && !s.startsWith('""')) s = s.slice(1);
  if (s.endsWith('"')   && !s.endsWith('\\"'))  s = s.slice(0, -1);
  s = s.replace(/""/g, '"');
  return s;
}
function unwrapIfDoubleEncoded(s){
  const first = parseJSONSafe(s);
  if (typeof first === "string") {
    const second = parseJSONSafe(first);
    if (second && typeof second === "object") return second;
  }
  return null;
}
function extractBracedJSON(s){
  const start = s.indexOf("{");
  const end   = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sub = s.slice(start, end + 1);
    const obj = parseJSONSafe(sub);
    if (obj && typeof obj === "object") return obj;
  }
  return null;
}
function reassembleKb(headers, row){
  const cols = headers
    .filter((h) => /^kb_json(?:_\d+)?$/i.test(h))
    .sort((a, b) => {
      const na = a === "kb_json" ? 0 : parseInt(a.split("_")[2] || a.split("_")[1] || "0", 10);
      const nb = b === "kb_json" ? 0 : parseInt(b.split("_")[2] || b.split("_")[1] || "0", 10);
      return na - nb;
    });
  const joined = hardClean(cols.map((c)=>dequoteChunk(row[c]||"")).join("")).trim();
  let kb = parseJSONSafe(joined) || unwrapIfDoubleEncoded(joined) || extractBracedJSON(joined);
  if (!kb || typeof kb !== "object") kb = parseJSONSafe(hardClean(dequoteChunk(row.kb_json)));
  if (!kb || typeof kb !== "object") kb = {};
  return kb;
}

// ---------- demo fallbacks ----------
const mkTable = (columns, rows) => ({ format:"table", summary:"Demo numbers (connect for live data).", value:{ columns, rows }});
function buildAnswer(topic, kb){
  switch(topic){
    case "inventory": return mkTable(["SKU","Product","On Hand","Reserved","Available"],[
      ["UH-001", kb?.example_top_product || "Ultra Hoodie", 820,120,700],
      ["BT-099","Basic Tee",1450,260,1190],
      ["CP-223","Classic Polo",680,90,590]
    ]);
    case "hr": return mkTable(["Employee","From","To","Type"],[
      [kb?.example_employee_1||"C. Alvarez","2025-07-08","2025-07-16","Vacation"],
      [kb?.example_employee_2||"M. Duarte","2025-07-11","2025-07-12","PTO"],
      [kb?.example_employee_3||"S. Ruiz","2025-07-22","2025-07-29","Vacation"]
    ]);
    case "revenue":
    case "report": return mkTable(["Week","Region","Channel","Revenue (€)"],[
      ["W-2", kb?.example_top_region||"Andalucía","Online",58210],
      ["W-2", kb?.primary_region    ||"Marbella","Retail",39400],
      ["W-1", kb?.example_top_region||"Andalucía","Online",54730]
    ]);
    default: return { format:"text", value:"Once connected, I’d pull this live and complete the task automatically." };
  }
}
function textFromAnswer(a){
  if (a?.format === "table") {
    const { columns, rows } = a.value;
    return rows.map(r=>r.map((v,i)=>`${columns[i]}: ${v}`).join(" | ")).join("\n");
  }
  return a?.value || "";
}

// ---------- intent ----------
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
function kbLooksPopulated(kb){
  if (!kb || typeof kb !== "object") return false;
  const s = kb.sections || {};
  return Object.values(s).some((arr) => Array.isArray(arr) && arr.length > 0);
}
function briefFromKB(kb) {
  const meta = kb?.meta || {};
  const co = meta.company || {};
  const sections = kb?.sections || {};
  const counts = Object.fromEntries(Object.entries(sections).map(([k,v]) => [k, Array.isArray(v)? v.length:0]));
  return [
    `Company: ${co.name || "unknown"} (${co.domain || "unknown"})`,
    `Homepage: ${co.homepage_url || "unknown"}`,
    `KB version: ${meta.kb_version || "unknown"}`,
    `Sections: ${Object.entries(counts).map(([k,n]) => `${k}(${n})`).join(", ") || "none"}`,
  ].join("\n");
}
async function kbAnswerWithLLM({ kb_json, company_system_prompt, user, history=[], mode="text" }) {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!company_system_prompt) return null;
  if (!kbLooksPopulated(kb_json)) return null;

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
    { role:"system", content: "Use ONLY the KB evidence. If a fact is missing, say so. Cite section keys and include fragment.src_url when available." }
  ];

  const r = await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{ "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type":"application/json" },
    body: JSON.stringify({ model: MODEL, temperature: 0.2, messages })
  });
  if (!r.ok) return null;
  const j = await r.json().catch(()=>null);
  const text = j?.choices?.[0]?.message?.content?.trim();
  return text || null;
}

// ---------- helpers ----------
async function postJSON(baseUrl, path, payload){
  const r = await fetch(`${baseUrl}${path}`,{
    method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(payload)
  });
  const j = await r.json().catch(()=>({ ok:false, error:"Bad JSON" }));
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
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

// ---------- main ----------
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

  try{
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body||{});
    let {
      utterance="", kb={}, client={}, mode="text", history=[],
      kb_json=null, company_system_prompt=null, tenant=null, token=null
    } = body;

    // Fetch KB from sheet if needed
    if (tenant && token && (!kb_json || !company_system_prompt)) {
      const v = verifyToken(token);
      if (v === tenant) {
        const { headers, rows } = await readSheet();
        const row = rows.find((r) => String(r.tenant_id) === String(tenant));
        if (row) {
          kb_json = reassembleKb(headers, row);
          company_system_prompt = row.company_system_prompt || company_system_prompt;
        }
      }
    }

    const { intent, topic } = detect(utterance);

    // LLM path (only if KB has sections)
    let llmText = null;
    try { llmText = await kbAnswerWithLLM({ kb_json, company_system_prompt, user: utterance, history, mode }); } catch {}
    if (llmText) {
      return res.status(200).json({
        mode,
        script: [{ text: llmText }],
        cards: [],
        meta: { intent: "kb_answer", topic, trace_id: "demo_"+Math.random().toString(36).slice(2,10), used_llm: true }
      });
    }

    // FALLBACK demo flows
    const answer = buildAnswer(topic, kb);
    const proto = req.headers["x-forwarded-proto"] || "https";
    const baseUrl = `${proto}://${req.headers.host}`;

    const script = [];
    const cards  = [];
    const say = (t, d=0) => script.push({ text:t, delay_ms:d });

    if (intent === "inventory_lookup") { say("Sure — opening Inventory → Stock Check…", 0); say("Give me a second to pull live counts…", 600); say(`Found it.`, 700); cards.push(answer); }
    else if (intent === "sales_report") { say("On it — fetching Sales → Weekly Revenue…", 0); say("Compiling the last two weeks…", 700); say("Ready.", 600); cards.push(answer); }
    else if (intent === "hr_schedule") { say("Opening HR → Time Off…", 0); say("Checking upcoming vacations…", 600); cards.push(answer); }

    const phone = (client.phone || kb?.demo_client?.phone || "").trim();
    const email = (client.email || kb?.demo_client?.email || "").trim();
    let performed = null;
    try {
      if (intent === "send_email") {
        if (!email) throw new Error("No email on file");
        say("Sure — packaging the report and sending email…", 0);
        await postJSON(baseUrl, "/api/sendMailgun", { to: email, subject: `Your ${topic} report`, html: htmlFrom(answer, "email") });
        say(`Done — sent to ${email}.`, 900);
        performed = { ok:true, type:"email", to:email };
      } else if (intent === "send_whatsapp") {
        if (!phone) throw new Error("No phone on file");
        say("Got it — composing WhatsApp message…", 0);
        await postJSON(baseUrl, "/api/sendWhatsApp", { to: phone, body: `Your ${topic} report:\n\n${textFromAnswer(answer)}` });
        say(`Sent on WhatsApp to ${phone}.`, 900);
        performed = { ok:true, type:"whatsapp", to:phone };
      } else if (intent === "place_call") {
        if (!phone) throw new Error("No phone on file");
        say("Okay — placing a quick follow-up call…", 0);
        await postJSON(baseUrl, "/api/call", { to: phone, message: `This is your AI Employee with your ${topic} update. I also sent details to your inbox.` });
        say(`Calling ${phone} now.`, 900);
        performed = { ok:true, type:"call", to:phone };
      }
    } catch (e) {
      say(`Action failed: ${String(e.message||e)}.`, 0);
      performed = { ok:false, error:String(e.message||e) };
    }

    return res.status(200).json({
      mode,
      script: script.length ? script : [{ text:"Here’s what I found.", delay_ms:0 }],
      cards:  (mode==="call") ? [] : (cards.length ? cards : [answer]),
      meta: { intent, topic, trace_id: "demo_"+Math.random().toString(36).slice(2,10), performed, used_llm: false }
    });

  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
};
