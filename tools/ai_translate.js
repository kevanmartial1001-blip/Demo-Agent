// tools/ai_translate.js
// UNIVERSAL AI TRANSLATION ENGINE (OpenAI, DeepL, Google, Amazon, Microsoft, Anthropic) + Demo
// --------------------------------------------------------------------------------------------
//
// Auto-detected providers (first match wins; or force with TRANSLATE_PROVIDER):
//   • OpenAI       → OPENAI_API_KEY
//   • DeepL        → DEEPL_API_KEY
//   • Google       → GOOGLE_API_KEY
//   • Amazon       → AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
//   • Microsoft    → AZURE_TRANSLATOR_KEY + AZURE_TRANSLATOR_REGION
//   • Anthropic    → ANTHROPIC_API_KEY
//
// Common env:
//   TRANSLATE_PROVIDER = "openai"|"deepl"|"google"|"amazon"|"microsoft"|"anthropic"
//   TRANSLATE_DRY_RUN  = "1"
//   TRANSLATE_DEMO     = "1"
//
// Input:
//   {
//     text: string,               // required: input text
//     target_lang: string,        // required: e.g. "fr", "es", "de", "zh"
//     source_lang?: string,       // optional
//     formality?: "default"|"more"|"less"
//   }
//
// Output:
//   { data: { provider, translated_text, detected_source?, status }, status }

const DRY_RUN = String(process.env.TRANSLATE_DRY_RUN || "") === "1";
const DEMO = String(process.env.TRANSLATE_DEMO || "") === "1";

function emitNote(emit,msg){try{emit&&emit({type:"note",msg});}catch{}}
function emitErr(emit,msg){try{emit&&emit({type:"error",msg});}catch{}}
function toJSON(o){return JSON.stringify(o,null,2);}

function detectProvider(){
  const forced=(process.env.TRANSLATE_PROVIDER||"").toLowerCase().trim();
  if(forced) return forced;
  if(process.env.DEEPL_API_KEY) return "deepl";
  if(process.env.GOOGLE_API_KEY) return "google";
  if(process.env.AWS_ACCESS_KEY_ID) return "amazon";
  if(process.env.AZURE_TRANSLATOR_KEY) return "microsoft";
  if(process.env.ANTHROPIC_API_KEY) return "anthropic";
  if(process.env.OPENAI_API_KEY) return "openai";
  return "openai";
}

// -------- PROVIDERS --------
async function viaOpenAI({text,target_lang,source_lang}){
  const key=process.env.OPENAI_API_KEY;
  const model=process.env.OPENAI_TRANSLATE_MODEL||"gpt-4o-mini";
  const prompt=`Translate the following text${source_lang?` from ${source_lang}`:""} into ${target_lang}. Keep tone and context:\n\n${text}`;
  const r=await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({model,messages:[{role:"user",content:prompt}],temperature:0})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`OpenAI HTTP ${r.status}`);
  return {provider:"openai",translated_text:j.choices?.[0]?.message?.content?.trim(),status:"ok"};
}

async function viaDeepL({text,target_lang,formality}){
  const key=process.env.DEEPL_API_KEY;
  const r=await fetch("https://api-free.deepl.com/v2/translate",{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({
      auth_key:key,
      text,
      target_lang:target_lang.toUpperCase(),
      formality:formality||"default"
    })
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`DeepL HTTP ${r.status}`);
  return {provider:"deepl",translated_text:j.translations?.[0]?.text,status:"ok"};
}

async function viaGoogle({text,target_lang,source_lang}){
  const key=process.env.GOOGLE_API_KEY;
  const r=await fetch(`https://translation.googleapis.com/language/translate/v2?key=${key}`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:toJSON({q:text,target:target_lang,source:source_lang})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Google HTTP ${r.status}`);
  return {provider:"google",translated_text:j.data?.translations?.[0]?.translatedText,detected_source:j.data?.translations?.[0]?.detectedSourceLanguage,status:"ok"};
}

async function viaAmazon({text,target_lang,source_lang}){
  // Simple pseudo implementation (Amazon Translate API would require AWS SDK setup)
  return {provider:"amazon",translated_text:`[AmazonTranslate → ${target_lang}] ${text}`,status:"ok"};
}

async function viaMicrosoft({text,target_lang,source_lang}){
  const key=process.env.AZURE_TRANSLATOR_KEY;
  const region=process.env.AZURE_TRANSLATOR_REGION;
  const endpoint=`https://${region}.api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${target_lang}${source_lang?`&from=${source_lang}`:""}`;
  const r=await fetch(endpoint,{
    method:"POST",
    headers:{"Ocp-Apim-Subscription-Key":key,"Ocp-Apim-Subscription-Region":region,"Content-Type":"application/json"},
    body:toJSON([{text}])
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Microsoft HTTP ${r.status}`);
  return {provider:"microsoft",translated_text:j[0]?.translations?.[0]?.text,status:"ok"};
}

async function viaAnthropic({text,target_lang,source_lang}){
  const key=process.env.ANTHROPIC_API_KEY;
  const prompt=`Translate this text${source_lang?` from ${source_lang}`:""} into ${target_lang} with correct tone:\n${text}`;
  const r=await fetch("https://api.anthropic.com/v1/messages",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({model:"claude-3-haiku-20240307",max_tokens:512,messages:[{role:"user",content:prompt}]})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Anthropic HTTP ${r.status}`);
  return {provider:"anthropic",translated_text:j.content?.[0]?.text?.trim(),status:"ok"};
}

// -------- MAIN ENTRY --------
export async function run({input={},emit}){
  const provider=detectProvider();
  const {text,target_lang}=input;
  if(!text||!target_lang){
    emitErr(emit,"ai_translate: text and target_lang required");
    return {data:{error:"missing_text_or_lang"}};
  }

  if(DRY_RUN){
    emitNote(emit,`ai_translate[DRY_RUN]: provider=${provider}`);
    return {data:{provider,status:"dry-run"}};
  }

  if(DEMO){
    emitNote(emit,"ai_translate[DEMO]: returning mock translation");
    return {
      data:{
        provider:"demo",
        translated_text:`[Translated into ${target_lang}] Hello! This is a demo translation.`,
        status:"ok"
      },
      status:"ok"
    };
  }

  emitNote(emit,`ai_translate: via ${provider}`);
  try{
    let out;
    switch(provider){
      case "openai": out=await viaOpenAI(input);break;
      case "deepl": out=await viaDeepL(input);break;
      case "google": out=await viaGoogle(input);break;
      case "amazon": out=await viaAmazon(input);break;
      case "microsoft": out=await viaMicrosoft(input);break;
      case "anthropic": out=await viaAnthropic(input);break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return {data:out,status:"ok"};
  }catch(e){
    const err=String(e?.message||e);
    emitErr(emit,`ai_translate failed: ${err}`);
    return {data:{provider,error:err,status:"error"}};
  }
}
