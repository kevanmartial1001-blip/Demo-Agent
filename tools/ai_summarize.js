// tools/ai_summarize.js
// UNIVERSAL AI SUMMARIZATION ENGINE (OpenAI, Anthropic, Mistral, Gemini, Cohere) + Demo
// ------------------------------------------------------------------------------------
//
// Auto-detected providers (first match wins; or force with SUMMARIZE_PROVIDER):
//   • OpenAI     → OPENAI_API_KEY
//   • Anthropic  → ANTHROPIC_API_KEY
//   • Mistral    → MISTRAL_API_KEY
//   • Gemini     → GEMINI_API_KEY
//   • Cohere     → COHERE_API_KEY
//
// Common env:
//   SUMMARIZE_PROVIDER = "openai"|"anthropic"|"mistral"|"gemini"|"cohere"
//   SUMMARIZE_DRY_RUN  = "1"
//   SUMMARIZE_DEMO     = "1"
//
// Input:
//   {
//     text: string,              // required: any text or transcript
//     style?: "brief"|"detailed"|"bullet"|"executive", // default "brief"
//     max_words?: number,        // optional limit
//     language?: string          // default English
//   }
//
// Output:
//   { data: { provider, summary, tokens?, status }, status }

const DRY_RUN = String(process.env.SUMMARIZE_DRY_RUN || "") === "1";
const DEMO = String(process.env.SUMMARIZE_DEMO || "") === "1";

function emitNote(emit,msg){try{emit&&emit({type:"note",msg});}catch{}}
function emitErr(emit,msg){try{emit&&emit({type:"error",msg});}catch{}}
function toJSON(o){return JSON.stringify(o,null,2);}

function detectProvider(){
  const forced=(process.env.SUMMARIZE_PROVIDER||"").toLowerCase().trim();
  if(forced) return forced;
  if(process.env.OPENAI_API_KEY) return "openai";
  if(process.env.ANTHROPIC_API_KEY) return "anthropic";
  if(process.env.MISTRAL_API_KEY) return "mistral";
  if(process.env.GEMINI_API_KEY) return "gemini";
  if(process.env.COHERE_API_KEY) return "cohere";
  return "openai";
}

// -------- PROVIDERS --------
async function viaOpenAI({text,style,max_words,language}){
  const key=process.env.OPENAI_API_KEY;
  const model=process.env.OPENAI_SUMMARIZE_MODEL||"gpt-4o-mini";
  const prompt=`Summarize the following text in a ${style||"brief"} way in ${language||"English"}${max_words?` (max ${max_words} words)`:""}:\n\n${text}`;
  const r=await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({model,messages:[{role:"user",content:prompt}],temperature:0.3})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`OpenAI HTTP ${r.status}`);
  const summary=j.choices?.[0]?.message?.content?.trim();
  return {provider:"openai",summary,tokens:j.usage?.total_tokens,status:"ok"};
}

async function viaAnthropic({text,style,max_words,language}){
  const key=process.env.ANTHROPIC_API_KEY;
  const prompt=`Summarize the following text in a ${style||"brief"} way in ${language||"English"}${max_words?` (max ${max_words} words)`:""}:\n\n${text}`;
  const r=await fetch("https://api.anthropic.com/v1/messages",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({model:"claude-3-haiku-20240307",max_tokens:512,messages:[{role:"user",content:prompt}]})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Anthropic HTTP ${r.status}`);
  const summary=j.content?.[0]?.text?.trim();
  return {provider:"anthropic",summary,status:"ok"};
}

async function viaMistral({text,style,max_words,language}){
  const key=process.env.MISTRAL_API_KEY;
  const prompt=`Summarize in ${style||"brief"} style (${language||"English"}): ${text}`;
  const r=await fetch("https://api.mistral.ai/v1/chat/completions",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({model:"mistral-small",messages:[{role:"user",content:prompt}]})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Mistral HTTP ${r.status}`);
  const summary=j.choices?.[0]?.message?.content?.trim();
  return {provider:"mistral",summary,status:"ok"};
}

async function viaGemini({text,style,max_words,language}){
  const key=process.env.GEMINI_API_KEY;
  const prompt=`Summarize in ${language||"English"} (${style||"brief"} style, max ${max_words||200} words):\n${text}`;
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${key}`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:toJSON({contents:[{parts:[{text:prompt}]}]})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Gemini HTTP ${r.status}`);
  const summary=j.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  return {provider:"gemini",summary,status:"ok"};
}

async function viaCohere({text,style,max_words,language}){
  const key=process.env.COHERE_API_KEY;
  const r=await fetch("https://api.cohere.ai/v1/summarize",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({text,length:style||"short",format:"paragraph",temperature:0.3})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`Cohere HTTP ${r.status}`);
  return {provider:"cohere",summary:j.summary,status:"ok"};
}

// -------- MAIN ENTRY --------
export async function run({input={},emit}){
  const provider=detectProvider();
  const {text}=input;
  if(!text){
    emitErr(emit,"ai_summarize: text required");
    return {data:{error:"missing_text"}};
  }

  if(DRY_RUN){
    emitNote(emit,`ai_summarize[DRY_RUN]: provider=${provider}`);
    return {data:{provider,status:"dry-run"}};
  }

  if(DEMO){
    emitNote(emit,"ai_summarize[DEMO]: returning mock summary");
    return {
      data:{
        provider:"demo",
        summary:"This is a concise summary of the provided text, demonstrating how the AI summarizer condenses content into a human-readable executive version.",
        status:"ok"
      },
      status:"ok"
    };
  }

  emitNote(emit,`ai_summarize: via ${provider}`);
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
    emitErr(emit,`ai_summarize failed: ${err}`);
    return {data:{provider,error:err,status:"error"}};
  }
}
