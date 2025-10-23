// tools/ai_extract.js
// UNIVERSAL STRUCTURED DATA EXTRACTION (OpenAI, Anthropic, Mistral, Gemini, Cohere) + Demo
// ----------------------------------------------------------------------------------------
//
// Auto-detected providers (first match wins; or force with EXTRACT_PROVIDER):
//   • OpenAI     → OPENAI_API_KEY
//   • Anthropic  → ANTHROPIC_API_KEY
//   • Mistral    → MISTRAL_API_KEY
//   • Gemini     → GEMINI_API_KEY
//   • Cohere     → COHERE_API_KEY
//
// Common env:
//   EXTRACT_PROVIDER = "openai"|"anthropic"|"mistral"|"gemini"|"cohere"
//   EXTRACT_DRY_RUN  = "1"
//   EXTRACT_DEMO     = "1"
//
// Input:
//   {
//     text: string,                 // required text to analyze
//     schema?: object,              // optional target schema (e.g. {name:"string",date:"string"})
//     language?: string,            // default "English"
//     output_format?: "json"|"yaml" // default "json"
//   }
//
// Output:
//   { data: { provider, fields, raw, status }, status }

const DRY_RUN = String(process.env.EXTRACT_DRY_RUN || "") === "1";
const DEMO = String(process.env.EXTRACT_DEMO || "") === "1";

function emitNote(emit,msg){try{emit&&emit({type:"note",msg});}catch{}}
function emitErr(emit,msg){try{emit&&emit({type:"error",msg});}catch{}}
function toJSON(o){return JSON.stringify(o,null,2);}

function detectProvider(){
  const forced=(process.env.EXTRACT_PROVIDER||"").toLowerCase().trim();
  if(forced) return forced;
  if(process.env.OPENAI_API_KEY) return "openai";
  if(process.env.ANTHROPIC_API_KEY) return "anthropic";
  if(process.env.MISTRAL_API_KEY) return "mistral";
  if(process.env.GEMINI_API_KEY) return "gemini";
  if(process.env.COHERE_API_KEY) return "cohere";
  return "openai";
}

// -------- PROVIDERS --------
async function viaOpenAI({text,schema,language,output_format}){
  const key=process.env.OPENAI_API_KEY;
  const model=process.env.OPENAI_EXTRACT_MODEL||"gpt-4o-mini";
  const prompt=`Extract the following structured information in ${language||"English"} using the schema below.
Return valid ${output_format||"JSON"} ONLY.

Schema:
${toJSON(schema||{name:"string",date:"string",amount:"number",email:"string"})}

Text:
${text}`;
  const r=await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({model,messages:[{role:"user",content:prompt}],temperature:0})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`OpenAI HTTP ${r.status}`);
  const content=j.choices?.[0]?.message?.content?.trim();
  let parsed=null;
  try{ parsed=JSON.parse(content); }catch{ parsed={raw:content}; }
  return {provider:"openai",fields:parsed,raw:content,status:"ok"};
}

async function viaAnthropic({text,schema,language,output_format}){
  const key=process.env.ANTHROPIC_API_KEY;
  const prompt=`Extract structured data (${output_format||"JSON"}) from the text below following this schema:\n${toJSON(schema)}\n\n${text}`;
  const r=await fetch("https://api.anthropic.com/v1/messages",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({model:"claude-3-haiku-20240307",max_tokens:512,messages:[{role:"user",content:prompt}]})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Anthropic HTTP ${r.status}`);
  const content=j.content?.[0]?.text?.trim();
  let parsed=null;
  try{ parsed=JSON.parse(content); }catch{ parsed={raw:content}; }
  return {provider:"anthropic",fields:parsed,raw:content,status:"ok"};
}

async function viaMistral({text,schema,language,output_format}){
  const key=process.env.MISTRAL_API_KEY;
  const prompt=`Extract structured data (${output_format||"JSON"}) from this text following the schema:\n${toJSON(schema)}\n\n${text}`;
  const r=await fetch("https://api.mistral.ai/v1/chat/completions",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({model:"mistral-small",messages:[{role:"user",content:prompt}],temperature:0})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Mistral HTTP ${r.status}`);
  const content=j.choices?.[0]?.message?.content?.trim();
  let parsed=null;
  try{ parsed=JSON.parse(content); }catch{ parsed={raw:content}; }
  return {provider:"mistral",fields:parsed,raw:content,status:"ok"};
}

async function viaGemini({text,schema,language,output_format}){
  const key=process.env.GEMINI_API_KEY;
  const prompt=`Extract fields in ${output_format||"JSON"} following this schema:\n${toJSON(schema)}\n\nText:\n${text}`;
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${key}`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:toJSON({contents:[{parts:[{text:prompt}]}]})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Gemini HTTP ${r.status}`);
  const content=j.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  let parsed=null;
  try{ parsed=JSON.parse(content); }catch{ parsed={raw:content}; }
  return {provider:"gemini",fields:parsed,raw:content,status:"ok"};
}

async function viaCohere({text,schema}){
  const key=process.env.COHERE_API_KEY;
  const r=await fetch("https://api.cohere.ai/v1/extract",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({texts:[text],examples:[{text:"Order #123: John Doe - $250",labels:{name:"John Doe",amount:250}}]})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`Cohere HTTP ${r.status}`);
  return {provider:"cohere",fields:j.results?.[0]?.labels||{},raw:j,status:"ok"};
}

// -------- MAIN ENTRY --------
export async function run({input={},emit}){
  const provider=detectProvider();
  const {text}=input;
  if(!text){
    emitErr(emit,"ai_extract: text required");
    return {data:{error:"missing_text"}};
  }

  if(DRY_RUN){
    emitNote(emit,`ai_extract[DRY_RUN]: provider=${provider}`);
    return {data:{provider,status:"dry-run"}};
  }

  if(DEMO){
    emitNote(emit,"ai_extract[DEMO]: returning mock fields");
    return {
      data:{
        provider:"demo",
        fields:{name:"John Doe",email:"john@company.com",amount:450,date:"2025-10-23"},
        raw:"{name:'John Doe',email:'john@company.com',amount:450,date:'2025-10-23'}",
        status:"ok"
      },
      status:"ok"
    };
  }

  emitNote(emit,`ai_extract: via ${provider}`);
  try{
    let out;
    switch(provider){
      case "openai": out=await viaOpenAI(input);break;
      case "anthropic": out=await viaAnthropic(input);break;
      case "mistral": out=await viaMistral(input);break;
      case "gemini": out=await viaGemini(input);break;
      case "cohere": out=await viaCohere(input);break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return {data:out,status:"ok"};
  }catch(e){
    const err=String(e?.message||e);
    emitErr(emit,`ai_extract failed: ${err}`);
    return {data:{provider,error:err,status:"error"}};
  }
}
