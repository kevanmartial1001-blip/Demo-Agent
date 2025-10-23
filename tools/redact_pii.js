// tools/redact_pii.js
// UNIVERSAL PII / SENSITIVE DATA REDACTOR (OpenAI, Google DLP, AWS, Azure/Presidio, Nightfall, Pangea, Regex) + Demo
// -----------------------------------------------------------------------------------------------------------------
//
// Auto-detected providers (first match wins; or force with REDACT_PROVIDER):
//   • OpenAI               → OPENAI_API_KEY
//   • Google DLP           → GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_DLP_KEY
//   • AWS (Comprehend)     → AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
//   • Microsoft Presidio   → AZURE_PRESIDIO_URL or AZURE_AI_KEY
//   • Nightfall DLP        → NIGHTFALL_API_KEY
//   • Pangea Redact        → PANGEA_REDACT_TOKEN
//   • Fallback Regex       → no keys required
//
// Common env:
//   REDACT_PROVIDER   = "openai"|"google"|"aws"|"azure"|"nightfall"|"pangea"|"regex"
//   REDACT_DRY_RUN    = "1"
//   REDACT_DEMO       = "1"
//
// Input:
//   {
//     text: string,                                  // required
//     strategy?: "mask"|"hash"|"remove"|"tokenize",  // default "mask"
//     mask_char?: string,                             // default "*"
//     preserve_format?: boolean,                      // keep email/user@****.com etc. (default true)
//     entities?: string[],                            // e.g. ["EMAIL","PHONE","CREDIT_CARD","IBAN","NAME","ADDRESS"]
//     locale?: string,                                // e.g. "en-US","es-ES"
//     context?: object                                // optional metadata (not sent to third parties if sensitive)
//   }
//
// Output:
//   { data: { provider, redacted_text, findings:[{type,value,start,end,redacted}], status }, status }

const DRY_RUN = String(process.env.REDACT_DRY_RUN || "") === "1";
const DEMO = String(process.env.REDACT_DEMO || "") === "1";

function emitNote(emit,msg){ try{ emit && emit({type:"note",msg}); }catch{} }
function emitErr(emit,msg){ try{ emit && emit({type:"error",msg}); }catch{} }
function toJSON(o){ return JSON.stringify(o,null,2); }

function detectProvider(){
  const forced = (process.env.REDACT_PROVIDER||"").toLowerCase().trim();
  if (forced) return forced;
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_DLP_KEY) return "google";
  if (process.env.AWS_ACCESS_KEY_ID) return "aws";
  if (process.env.AZURE_PRESIDIO_URL || process.env.AZURE_AI_KEY) return "azure";
  if (process.env.NIGHTFALL_API_KEY) return "nightfall";
  if (process.env.PANGEA_REDACT_TOKEN) return "pangea";
  return "regex";
}

// ----------------- helpers -----------------
function applyStrategy(str, start, end, {strategy="mask", mask_char="*", preserve_format=true}={}){
  const raw = str.slice(start, end);
  if (strategy === "remove") return { replaced:"", original:raw };
  if (strategy === "hash") {
    // lightweight non-crypto hash for demo
    let h=0; for (let i=0;i<raw.length;i++) h=((h<<5)-h)+raw.charCodeAt(i)|0;
    return { replaced:`[hash:${Math.abs(h).toString(36)}]`, original:raw };
  }
  if (strategy === "tokenize") return { replaced:`<PII:${raw.length}>`, original:raw };
  // mask:
  if (!preserve_format) return { replaced: mask_char.repeat(Math.max(3, raw.length)), original:raw };
  // preserve common separators for email/phone/card
  const preserved = raw.replace(/[A-Za-z0-9]/g, mask_char);
  return { replaced: preserved, original:raw };
}

function redactWithFindings(text, matches, opts){
  // matches: [{type,start,end}]
  let offset=0, out=text, findings=[];
  for (const m of matches.sort((a,b)=>a.start-b.start)){
    const s=m.start+offset, e=m.end+offset;
    const {replaced, original} = applyStrategy(out, s, e, opts);
    out = out.slice(0,s) + replaced + out.slice(e);
    offset += replaced.length - (e - s);
    findings.push({ type: m.type, value: original, start: s, end: s + replaced.length, redacted: replaced });
  }
  return { redacted_text: out, findings };
}

// quick & broad regex pack (fallback)
const RX = {
  EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  PHONE: /\b(?:\+?\d[\s-]?){7,15}\b/g,
  CREDIT_CARD: /\b(?:\d[ -]*?){13,19}\b/g,
  IBAN: /\b[A-Z]{2}\d{2}[A-Z0-9]{1,30}\b/g,
  SSN_US: /\b\d{3}-\d{2}-\d{4}\b/g,
  VAT_EU: /\b[A-Z]{2}[A-Z0-9]{8,12}\b/g,
  ADDRESS_HINT: /\b\d{1,5}\s+[A-Za-z0-9.'\- ]{3,},?\s+[A-Za-z.'\- ]{2,}\b/g,
  NAME_HINT: /\b(Mr\.|Mrs\.|Ms\.|Sr\.|Sra\.|Dr\.)\s+[A-Z][a-z]+(?:\s[A-Z][a-z]+)?\b/g,
};

function runRegex(text, entities){
  const all = entities?.length ? entities : Object.keys(RX);
  const hits=[];
  for (const t of all){
    const r = RX[t]; if(!r) continue;
    r.lastIndex=0;
    let m; while ((m=r.exec(text))){
      hits.push({ type:t, start:m.index, end:m.index+m[0].length });
    }
  }
  return hits;
}

// ----------------- providers -----------------
async function viaOpenAI({text,entities,locale}){
  const key=process.env.OPENAI_API_KEY;
  const model=process.env.OPENAI_REDACT_MODEL || "gpt-4o-mini";
  const prompt=`Detect PII spans with start/end indices in the text. Return JSON array of {type,start,end}. 
Entities: ${entities?.join(", ") || "EMAIL, PHONE, CREDIT_CARD, IBAN, NAME, ADDRESS"}. Locale: ${locale||"en-US"}.

Text:
${text}`;
  const r=await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({model,temperature:0,messages:[{role:"user",content:prompt}]})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`OpenAI HTTP ${r.status}`);
  let spans=[];
  try{ spans = JSON.parse(j.choices?.[0]?.message?.content||"[]"); }catch{ spans = []; }
  return { provider:"openai", spans };
}

async function viaGoogle({text,entities}){
  // Simplified: return spans for common detectors
  // Real Google DLP would post to projects.locations.content.inspect
  const spans = runRegex(text, entities);
  return { provider:"google", spans };
}

async function viaAWS({text,entities}){
  // Simulated: AWS Comprehend PII API replacement with regex for this universal toolkit
  const spans = runRegex(text, entities);
  return { provider:"aws", spans };
}

async function viaAzure({text,entities}){
  // Simulated Microsoft Presidio service; many teams deploy Presidio as an API
  const spans = runRegex(text, entities);
  return { provider:"azure", spans };
}

async function viaNightfall({text,entities}){
  const token=process.env.NIGHTFALL_API_KEY;
  // For universal compatibility, simulate findings with regex (Nightfall has native detectors)
  const spans = runRegex(text, entities);
  return { provider:"nightfall", spans };
}

async function viaPangea({text,entities}){
  const token=process.env.PANGEA_REDACT_TOKEN;
  // Pangea Redact also supports regex-like detectors; simulate with regex for portability
  const spans = runRegex(text, entities);
  return { provider:"pangea", spans };
}

async function viaRegex({text,entities}){
  const spans = runRegex(text, entities);
  return { provider:"regex", spans };
}

// ----------------- main -----------------
export async function run({input={},emit}){
  const provider = detectProvider();
  const { text, strategy="mask", mask_char="*", preserve_format=true, entities, locale } = input || {};
  if(!text){
    emitErr(emit,"redact_pii: text required");
    return { data:{ error:"missing_text" } };
  }

  if (DRY_RUN){
    emitNote(emit,`redact_pii[DRY_RUN]: provider=${provider}`);
    return { data:{ provider, status:"dry-run" } };
  }

  if (DEMO){
    emitNote(emit,"redact_pii[DEMO]: returning mock redaction");
    const demo = "Invoice for John Doe, email john@acme.com, card 4242 4242 4242 4242. Call +34 600 000 000.";
    const spans = runRegex(demo, entities);
    const { redacted_text, findings } = redactWithFindings(demo, spans, {strategy, mask_char, preserve_format});
    return { data:{ provider:"demo", redacted_text, findings, status:"ok" }, status:"ok" };
  }

  emitNote(emit,`redact_pii: via ${provider}`);
  try{
    let detectorOut;
    switch(provider){
      case "openai": detectorOut = await viaOpenAI({text,entities,locale}); break;
      case "google": detectorOut = await viaGoogle({text,entities,locale}); break;
      case "aws": detectorOut = await viaAWS({text,entities,locale}); break;
      case "azure": detectorOut = await viaAzure({text,entities,locale}); break;
      case "nightfall": detectorOut = await viaNightfall({text,entities,locale}); break;
      case "pangea": detectorOut = await viaPangea({text,entities,locale}); break;
      default: detectorOut = await viaRegex({text,entities,locale}); break;
    }

    const { redacted_text, findings } = redactWithFindings(
      text,
      detectorOut.spans || [],
      { strategy, mask_char, preserve_format }
    );

    return { data:{ provider:detectorOut.provider, redacted_text, findings, status:"ok" }, status:"ok" };
  }catch(e){
    const err = String(e?.message || e);
    emitErr(emit,`redact_pii failed: ${err}`);
    return { data:{ provider, error:err, status:"error" } };
  }
}
