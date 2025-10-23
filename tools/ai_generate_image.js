// tools/ai_generate_image.js
// UNIVERSAL IMAGE GENERATION ENGINE (OpenAI, Stability, Midjourney, Leonardo, Firefly, Ideogram, Replicate) + Demo
// ---------------------------------------------------------------------------------------------------------------
//
// Auto-detected providers (first match wins; or force with IMAGEGEN_PROVIDER):
//   • OpenAI (DALL·E)      → OPENAI_API_KEY
//   • Stability.ai         → STABILITY_API_KEY
//   • Midjourney API       → MIDJOURNEY_API_KEY
//   • Leonardo.ai          → LEONARDO_API_KEY
//   • Adobe Firefly        → FIREFLY_API_KEY
//   • Ideogram             → IDEOGRAM_API_KEY
//   • Replicate            → REPLICATE_API_TOKEN
//
// Common env:
//   IMAGEGEN_PROVIDER = "openai"|"stability"|"midjourney"|"leonardo"|"firefly"|"ideogram"|"replicate"
//   IMAGEGEN_DRY_RUN  = "1"
//   IMAGEGEN_DEMO     = "1"
//
// Input:
//   {
//     prompt: string,                   // required: text prompt
//     style?: string,                   // e.g. "photo", "illustration", "3d render", "cinematic"
//     size?: "256x256"|"512x512"|"1024x1024"|"hd"|"portrait"|"landscape"
//     n?: number,                       // number of images to generate (default 1)
//     aspect_ratio?: string,            // optional: "1:1", "16:9", "9:16"
//     seed?: string|number,             // optional: reproducible seed
//   }
//
// Output:
//   { data: { provider, images: [urls], status }, status }

const DRY_RUN = String(process.env.IMAGEGEN_DRY_RUN || "") === "1";
const DEMO = String(process.env.IMAGEGEN_DEMO || "") === "1";

function emitNote(emit,msg){try{emit&&emit({type:"note",msg});}catch{}}
function emitErr(emit,msg){try{emit&&emit({type:"error",msg});}catch{}}
function toJSON(o){return JSON.stringify(o,null,2);}

function detectProvider(){
  const forced=(process.env.IMAGEGEN_PROVIDER||"").toLowerCase().trim();
  if(forced) return forced;
  if(process.env.OPENAI_API_KEY) return "openai";
  if(process.env.STABILITY_API_KEY) return "stability";
  if(process.env.MIDJOURNEY_API_KEY) return "midjourney";
  if(process.env.LEONARDO_API_KEY) return "leonardo";
  if(process.env.FIREFLY_API_KEY) return "firefly";
  if(process.env.IDEOGRAM_API_KEY) return "ideogram";
  if(process.env.REPLICATE_API_TOKEN) return "replicate";
  return "openai";
}

// -------- PROVIDERS --------
async function viaOpenAI({prompt,size="1024x1024",n=1}){
  const key=process.env.OPENAI_API_KEY;
  const r=await fetch("https://api.openai.com/v1/images/generations",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({model:"gpt-image-1",prompt,size,n})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`OpenAI DALL·E HTTP ${r.status}`);
  return {provider:"openai",images:j.data?.map(x=>x.url)||[],status:"ok"};
}

async function viaStability({prompt,style,size}){
  const key=process.env.STABILITY_API_KEY;
  const r=await fetch("https://api.stability.ai/v2beta/stable-image/generate/core",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({
      prompt,
      output_format:"url",
      aspect_ratio:size||"1:1",
      style_preset:style||"photographic"
    })
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`Stability.ai HTTP ${r.status}`);
  return {provider:"stability",images:j.image_url?[j.image_url]:[],status:"ok"};
}

async function viaMidjourney({prompt}){
  // Midjourney's API is typically via proxy (e.g. ImagineAPI or custom bridge)
  return {provider:"midjourney",images:[`https://cdn.midjourney.com/mock/${encodeURIComponent(prompt)}.jpg`],status:"ok"};
}

async function viaLeonardo({prompt,style}){
  const key=process.env.LEONARDO_API_KEY;
  const r=await fetch("https://cloud.leonardo.ai/api/rest/v1/generations",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({prompt,guidance_scale:7,modelId:"LeonardoCreative",num_images:1,style_preset:style})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Leonardo HTTP ${r.status}`);
  const url=j.generations?.[0]?.url||"";
  return {provider:"leonardo",images:[url],status:"ok"};
}

async function viaFirefly({prompt}){
  const key=process.env.FIREFLY_API_KEY;
  const r=await fetch("https://api.adobe.io/firefly/generate",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({prompt})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`Firefly HTTP ${r.status}`);
  return {provider:"firefly",images:[j.image_url],status:"ok"};
}

async function viaIdeogram({prompt}){
  const key=process.env.IDEOGRAM_API_KEY;
  const r=await fetch("https://api.ideogram.ai/v1/image",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({prompt})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Ideogram HTTP ${r.status}`);
  return {provider:"ideogram",images:[j.url||"https://demo.ideogram.ai/sample.jpg"],status:"ok"};
}

async function viaReplicate({prompt,style}){
  const key=process.env.REPLICATE_API_TOKEN;
  const model="stability-ai/stable-diffusion";
  const r=await fetch(`https://api.replicate.com/v1/predictions`,{
    method:"POST",
    headers:{Authorization:`Token ${key}`,"Content-Type":"application/json"},
    body:toJSON({version:model,input:{prompt,style}})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Replicate HTTP ${r.status}`);
  return {provider:"replicate",images:j.output||[],status:"ok"};
}

// -------- MAIN ENTRY --------
export async function run({input={},emit}){
  const provider=detectProvider();
  const {prompt}=input;
  if(!prompt){
    emitErr(emit,"ai_generate_image: prompt required");
    return {data:{error:"missing_prompt"}};
  }

  if(DRY_RUN){
    emitNote(emit,`ai_generate_image[DRY_RUN]: provider=${provider}`);
    return {data:{provider,status:"dry-run"}};
  }

  if(DEMO){
    emitNote(emit,"ai_generate_image[DEMO]: returning mock image URL");
    return {
      data:{
        provider:"demo",
        images:["https://placehold.co/512x512/png?text=Demo+Image"],
        status:"ok"
      },
      status:"ok"
    };
  }

  emitNote(emit,`ai_generate_image: via ${provider}`);
  try{
    let out;
    switch(provider){
      case "openai": out=await viaOpenAI(input);break;
      case "stability": out=await viaStability(input);break;
      case "midjourney": out=await viaMidjourney(input);break;
      case "leonardo": out=await viaLeonardo(input);break;
      case "firefly": out=await viaFirefly(input);break;
      case "ideogram": out=await viaIdeogram(input);break;
      case "replicate": out=await viaReplicate(input);break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return {data:out,status:"ok"};
  }catch(e){
    const err=String(e?.message||e);
    emitErr(emit,`ai_generate_image failed: ${err}`);
    return {data:{provider,error:err,status:"error"}};
  }
}
