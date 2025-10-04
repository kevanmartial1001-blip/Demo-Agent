// /api/demoAgent.js
// Demo agent that *explains* and can *do actions* (email / WhatsApp / call)
// It calls your routes: /api/sendMailgun, /api/sendWhatsApp, /api/call

module.exports.config = { runtime: "nodejs18.x" };

function pick(arr) { return arr[Math.floor(Math.random()*arr.length)]; }
function trace() { return "demo_" + Math.random().toString(36).slice(2, 10); }
function mkTable(columns, rows) { return { format: "table", summary: "Simulated data based on your KB.", value: { columns, rows } }; }

function detectIntent(utterance = "") {
  const u = utterance.toLowerCase();
  const wantsEmail   = /email|mail|correo/.test(u);
  const wantsWA      = /whatsapp|wa/.test(u);
  const wantsCall    = /call|phone me|llam(a|e)me|ring/.test(u);
  const wantsSend    = /send|share|env[ií]a|enviame|enviar/.test(u);

  const wantsReport  = /report|informe|summary|resumen/.test(u);
  const wantsRevenue = /revenue|sales|ventas|ingresos/.test(u);
  const wantsInv     = /inventory|stock|existencias/.test(u);
  const wantsHR      = /vacation|pto|holiday|vacaciones/.test(u);

  if ((wantsSend && (wantsEmail || wantsWA)) || wantsEmail || wantsWA) {
    return { intent: wantsWA ? "send_whatsapp" : "send_email", topic:
      (wantsInv && "inventory") || (wantsHR && "hr") || (wantsRevenue && "revenue") || (wantsReport && "report") || "generic" };
  }
  if (wantsCall) return { intent: "place_call", topic: "generic" };

  if (wantsInv) return { intent: "inventory_lookup", topic: "inventory" };
  if (wantsHR)  return { intent: "hr_schedule", topic: "hr" };
  if (wantsRevenue || wantsReport) return { intent: "sales_report", topic: "revenue" };

  return { intent: "generic_question", topic: "generic" };
}

function buildAnswer(topic, kb) {
  switch (topic) {
    case "inventory":
      return mkTable(
        ["SKU", "Product", "On Hand", "Reserved", "Available"],
        [
          ["UH-001", kb?.example_top_product || "Ultra Hoodie", 820, 120, 700],
          ["BT-099", "Basic Tee", 1450, 260, 1190],
          ["CP-223", "Classic Polo", 680, 90, 590]
        ]
      );
    case "hr":
      return mkTable(
        ["Employee", "From", "To", "Type"],
        [
          [kb?.example_employee_1 || "C. Alvarez", "2025-07-08", "2025-07-16", "Vacation"],
          [kb?.example_employee_2 || "M. Duarte", "2025-07-11", "2025-07-12", "PTO"],
          [kb?.example_employee_3 || "S. Ruiz",    "2025-07-22", "2025-07-29", "Vacation"]
        ]
      );
    case "revenue":
    case "report":
      return mkTable(
        ["Week", "Region", "Channel", "Revenue (€)"],
        [
          ["W-2", kb?.example_top_region || "Andalucía", "Online",  58210],
          ["W-2", kb?.primary_region     || "Marbella",  "Retail",  39400],
          ["W-1", kb?.example_top_region || "Andalucía", "Online",  54730]
        ]
      );
    default:
      return { format: "text", value: `Here’s how this would work once connected to your systems.` };
  }
}

function howItWorked(intent) {
  const steps = [
    "Planner identified your intent.",
    "Would select the right workflow/tool.",
    "Would call the necessary systems & APIs.",
    "Would validate results and summarize."
  ];
  if (intent === "send_email") steps.splice(2, 0, "Would format content into an email and send it.");
  if (intent === "send_whatsapp") steps.splice(2, 0, "Would compose a WhatsApp message and send it.");
  if (intent === "place_call") steps.splice(2, 0, "Would initiate an outbound phone call via your provider.");
  return steps;
}

function whyItMatters(topic) {
  const base = ["Time saved", "Reduced errors", "Faster decisions"];
  if (topic === "revenue") base.unshift("Everyone sees the same numbers");
  if (topic === "inventory") base.unshift("Live stock visibility");
  if (topic === "hr") base.unshift("Team visibility and planning");
  return base;
}

function htmlReportFromAnswer(answer) {
  if (answer?.format === "table") {
    const cols = answer.value.columns;
    const rows = answer.value.rows;
    const rowsHtml = rows.map(r => `<tr>${r.map(v => `<td>${String(v)}</td>`).join("")}</tr>`).join("");
    return `
      <h2>Your AI Employee — Requested Report</h2>
      <p>Here is the report you asked for.</p>
      <table border="1" cellpadding="6" cellspacing="0">
        <thead><tr>${cols.map(c=>`<th align="left">${c}</th>`).join("")}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <p style="margin-top:12px;color:#666">Demo data — connect your systems for live numbers.</p>
    `;
  }
  return `<p>${answer?.value || "Here is the information you requested."}</p>`;
}

async function postJSON(baseUrl, path, payload) {
  const r = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(()=>({ ok:false, error:"Bad JSON" }));
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { utterance = "", kb = {}, demo = true, history = [], client = {} } = body;

    const clientPhone = client.phone || kb?.demo_client?.phone || "";
    const clientEmail = client.email || kb?.demo_client?.email || "";

    const { intent, topic } = detectIntent(utterance);
    const answer = buildAnswer(topic, kb);

    let nl = "";
    if (intent === "send_email") {
      nl = `Got it. I’ll email the ${topic === "generic" ? "information" : `${topic} report`} right away to ${clientEmail || "[no email on file]"}.`;
    } else if (intent === "send_whatsapp") {
      nl = `Sure. I’ll send a WhatsApp message with the ${topic === "generic" ? "details" : `${topic} report`} to ${clientPhone || "[no phone on file]"}.`;
    } else if (intent === "place_call") {
      nl = `Okay. I’ll place a quick follow-up call to ${clientPhone || "[no phone on file]"}.`;
    } else {
      nl = `Here’s a ${topic} view using demo data.`;
    }

    const proto = req.headers["x-forwarded-proto"] || "https";
    const baseUrl = `${proto}://${req.headers.host}`;

    let performed = null;
    try {
      if (intent === "send_email") {
        if (!clientEmail) throw new Error("Missing recipient email");
        const subject = `Your ${topic} report`;
        const html = htmlReportFromAnswer(answer);
        await postJSON(baseUrl, "/api/sendMailgun", { to: clientEmail, subject, html });
        performed = { type:"email", to: clientEmail };
      } else if (intent === "send_whatsapp") {
        if (!clientPhone) throw new Error("Missing recipient phone");
        const txt = `Here is your ${topic} report:\n\n` +
          (answer.format === "table"
            ? answer.value.rows.map(r => r.join(" | ")).join("\n")
            : (answer.value || "See details in your portal."));
        await postJSON(baseUrl, "/api/sendWhatsApp", { to: clientPhone, body: txt });
        performed = { type:"whatsapp", to: clientPhone };
      } else if (intent === "place_call") {
        if (!clientPhone) throw new Error("Missing recipient phone");
        const message = `This is your AI Employee with your ${topic} update. I just sent details to your inbox.`;
        await postJSON(baseUrl, "/api/call", { to: clientPhone, message });
        performed = { type:"call", to: clientPhone };
      }
    } catch (actErr) {
      nl += ` (Action note: ${actErr.message})`;
    }

    return res.status(200).json({
      nl,
      answer,
      explain: { steps: howItWorked(intent) },
      impact: { bullets: whyItMatters(topic) },
      meta: { intent, template_id: topic + "_demo", trace_id: trace(), performed }
    });

  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
};
