// /api/demoAgent.js
// Human-like, action-first demo assistant with multi-bubble script & follow-ups.

module.exports.config = { runtime: "nodejs18.x" };

const trace = () => "demo_" + Math.random().toString(36).slice(2, 10);

// --- Demo data builders -------------------------------------------------------
const mkTable = (columns, rows) => ({ format:"table", summary:"Demo numbers (connect for live data).", value:{ columns, rows }});
function buildAnswer(topic, kb){
  switch(topic){
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

// --- Intent detection ---------------------------------------------------------
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

  // hard actions:
  if ((wantsSend && (wantsEmail||wantsWA)) || wantsEmail || wantsWA)
    return { intent: wantsWA ? "send_whatsapp" : "send_email", topic:
      (wantsInv&&"inventory")||(wantsHR&&"hr")||(wantsRevenue&&"revenue")||(wantsReport&&"report")||"generic" };

  if (wantsCall)     return { intent:"place_call", topic:"generic" };
  if (wantsInvoice)  return { intent:"create_invoice", topic:"billing" };

  // info lookups:
  if (wantsInv)      return { intent:"inventory_lookup", topic:"inventory" };
  if (wantsHR)       return { intent:"hr_schedule", topic:"hr" };
  if (wantsRevenue||wantsReport) return { intent:"sales_report", topic:"revenue" };

  return { intent:"generic_question", topic:"generic" };
}

// --- Utility ------------------------------------------------------------------
async function postJSON(baseUrl, path, payload){
  const r = await fetch(`${baseUrl}${path}`,{
    method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(payload)
  });
  const j = await r.json().catch(()=>({ ok:false, error:"Bad JSON" }));
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// --- Main handler -------------------------------------------------------------
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

  try{
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body||{});
    const { utterance="", kb={}, client={}, mode="text", response_to } = body;

    // client contact resolution (footer → KB demo_client fallback)
    const phone = (client.phone || kb?.demo_client?.phone || "").trim();
    const email = (client.email || kb?.demo_client?.email || "").trim();

    const { intent, topic } = detect(utterance);
    const answer = buildAnswer(topic, kb);

    const proto = req.headers["x-forwarded-proto"] || "https";
    const baseUrl = `${proto}://${req.headers.host}`;

    // A "script" is a list of short bubbles we play in order (with delays client-side).
    const script = [];
    const cards  = []; // optional card to show the data (not in call mode)
    const follow = null; // place-holder

    // Helper to narrate like a human operator
    const say = (text, delay=0) => script.push({ text, delay_ms: delay });

    // --- Flows ----------------------------------------------------------------

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
      // 2-step follow-up: ask where to deliver it
      const ctx = trace(); // context id for this question
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
          requires: { whatsapp: !!phone, email: !!email }
        },
        meta: { intent, topic, trace_id: ctx }
      });
    }

    // Deliver actions (explicit “send me by …”)
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

    // Compose response
    const response = {
      mode,
      // In call mode, we speak only the script (no cards). In text/vn, show cards.
      script: script.length ? script : [{ text:"Here’s what I found.", delay_ms:0 }],
      cards:  (mode==="call") ? [] : (cards.length ? cards : [answer]),
      meta: { intent, topic, trace_id: trace(), performed }
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
