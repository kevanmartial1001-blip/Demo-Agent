// /api/demoAgent.js
// Safe standalone demo route — CJS export, runtime "nodejs", no external I/O.

module.exports.config = { runtime: "nodejs" };

function traceId(){ return "trc_" + Math.random().toString(36).slice(2,10); }
function getAmount(text){
  if(!text) return 1250;
  const m = String(text).match(/(\d[\d.,]*)\s*€|€\s*(\d[\d.,]*)/);
  const raw = m ? (m[1] || m[2]) : "1250";
  const n = Number(String(raw).replace(/[.,](?=\d{3}\b)/g,"").replace(",","."));
  return (isFinite(n) && n>0) ? Math.round(n*100)/100 : 1250;
}
function extractName(text=""){
  const m = text.match(/\b(Mr\.|Mrs\.|Ms\.|Dr\.)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/);
  return m ? `${m[1]} ${m[2]}` : "Mr. Martin";
}
function looksProactive(utt=""){
  const u = String(utt||"").toLowerCase();
  const verbs = ["invoice","bill","quote","proposal","schedule","meeting","calendar","send","email","whatsapp","generate","draft","prepare","create","presentation","order","payment","ship","delivery"];
  return verbs.some(v => u.includes(v));
}
function makeDoc({kind="Quote", customer="Mr. Martin", amount=1250, currency="€"}={}){
  const id = (kind==="Quote"?"Q-":"INV-") + Math.random().toString(36).slice(2,7).toUpperCase();
  const date = new Date().toISOString().slice(0,10);
  return {
    id, kind, customer, date,
    subtotal: amount, tax: 0, total: amount, currency,
    items: [{ description: `${kind} for services`, qty: 1, unit_price: amount, total: amount }],
    pdf_url: `https://placehold.co/980x1380/pdf?text=${encodeURIComponent(kind)}%20${encodeURIComponent(id)}%20for%20${encodeURIComponent(customer)}`
  };
}
function tableCard(doc){
  return {
    format: "table",
    summary: `Draft ${doc.kind} (demo)`,
    value: {
      columns: [`${doc.kind} #`, "Customer", "Date", "Subtotal", "Tax", "Total"],
      rows: [[doc.id, doc.customer, doc.date, `${doc.currency}${doc.subtotal}`, `${doc.currency}${doc.tax}`, `${doc.currency}${doc.total}`]]
    }
  };
}

module.exports = async (req, res) => {
  try {
    res.setHeader("Content-Type", "application/json");
    if (req.method !== "POST") {
      return res.status(405).json({ ok:false, error:"Method Not Allowed" });
    }

    // robust body parsing
    let body = {};
    try {
      if (typeof req.body === "string") body = JSON.parse(req.body || "{}");
      else if (req.body && typeof req.body === "object") body = req.body;
    } catch { body = {}; }

    const utterance = String(body.utterance || "");
    const trace = traceId();

    if (looksProactive(utterance)) {
      const kind = /quote|proposal/i.test(utterance) ? "Quote" : "Invoice";
      const customer = extractName(utterance);
      const amount = getAmount(utterance);
      const doc = makeDoc({ kind, customer, amount });

      const script = [
        { text: "Ok — give me 1 min and let me see how I can help with this.", delay_ms: 0, show_role: true },
        { text: `I’ve prepared a ${kind.toLowerCase()} for ${customer}.`, delay_ms: 320 },
        { text: `Total: ${doc.currency}${doc.total}.`, delay_ms: 300 },
        { text: "I used our standard template and the latest service details.", delay_ms: 300 },
        { text: "Tell me if you want any edits — items, amounts, or tax.", delay_ms: 300 },
        { text: `If it looks good, I can draft the email and attach the PDF to send to ${customer}.`, delay_ms: 300 }
      ];

      const cards = [
        tableCard(doc),
        { format: "file", summary: `${kind} PDF`, value: { url: doc.pdf_url, name: `${doc.id}.pdf` } }
      ];

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
        mode: "text",
        script,
        cards,
        ask,
        meta: { intent: kind==="Quote"?"create_quote":"create_invoice", topic:"billing", trace_id: trace, fast_demo:true }
      });
    }

    const script = [
      { text: "Got it.", delay_ms: 0, show_role: true },
      { text: "Tell me what you want to create or send, and I’ll take care of it.", delay_ms: 300 }
    ];
    return res.status(200).json({ mode:"text", script, cards:[], meta:{ intent:"generic", trace_id: trace, fast_demo:true } });

  } catch (err) {
    return res.status(200).json({
      mode:"text",
      script:[
        { text:"Something went wrong, but I’ve switched to demo mode.", delay_ms:0, show_role:true },
        { text:"You can try again now." }
      ],
      cards:[{ format:"text", summary:"Error", value:String(err?.message || err) }],
      meta:{ error:true, fast_demo:true }
    });
  }
};
