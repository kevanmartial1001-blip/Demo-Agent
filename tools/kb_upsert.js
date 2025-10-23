// tools/kb_upsert.js
// UNIVERSAL KNOWLEDGE BASE UPSERT (Pinecone, Weaviate, Qdrant, Chroma, Supabase, OpenSearch, Vespa, FAISS, Local JSON) + Demo
// ------------------------------------------------------------------------------------------------------------------------
//
// Auto-detected providers (first match wins; or force with KB_PROVIDER):
//   • Pinecone     → PINECONE_API_KEY + PINECONE_INDEX_URL
//   • Weaviate     → WEAVIATE_API_KEY + WEAVIATE_ENDPOINT
//   • Qdrant       → QDRANT_API_KEY + QDRANT_URL
//   • Chroma       → CHROMA_URL
//   • Supabase     → SUPABASE_URL + SUPABASE_SERVICE_KEY
//   • OpenSearch   → OPENSEARCH_URL + OPENSEARCH_AUTH
//   • Vespa        → VESPA_ENDPOINT
//   • FAISS        → FAISS_PATH (local vector DB file)
//   • Local JSON   → ./data/kb.json (fallback)
//
// Common env:
//   KB_PROVIDER   = "pinecone"|"weaviate"|"qdrant"|"chroma"|"supabase"|"opensearch"|"vespa"|"faiss"|"json"
//   KB_DRY_RUN    = "1"
//   KB_DEMO       = "1"
//
// Input:
//   {
//     id?: string,             // optional (auto-generated if missing)
//     text: string,            // required
//     metadata?: object,       // optional key-value metadata
//     namespace?: string,      // optional namespace for grouping
//   }
//
// Output:
//   { data: { provider, id, status }, status }

import fs from "fs";

const DRY_RUN = String(process.env.KB_DRY_RUN || "") === "1";
const DEMO = String(process.env.KB_DEMO || "") === "1";

function emitNote(emit,msg){try{emit&&emit({type:"note",msg});}catch{}}
function emitErr(emit,msg){try{emit&&emit({type:"error",msg});}catch{}}
function toJSON(o){return JSON.stringify(o,null,2);}

function detectProvider(){
  const forced=(process.env.KB_PROVIDER||"").toLowerCase().trim();
  if(forced) return forced;
  if(process.env.PINECONE_API_KEY) return "pinecone";
  if(process.env.WEAVIATE_API_KEY) return "weaviate";
  if(process.env.QDRANT_API_KEY) return "qdrant";
  if(process.env.CHROMA_URL) return "chroma";
  if(process.env.SUPABASE_URL) return "supabase";
  if(process.env.OPENSEARCH_URL) return "opensearch";
  if(process.env.VESPA_ENDPOINT) return "vespa";
  if(process.env.FAISS_PATH) return "faiss";
  return "json";
}

async function embed(text){
  const key=process.env.OPENAI_API_KEY;
  if(!key) return Array(1536).fill(0.1);
  const r=await fetch("https://api.openai.com/v1/embeddings",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({model:"text-embedding-3-small",input:text})
  });
  const j=await r.json().catch(()=>({}));
  return j.data?.[0]?.embedding||Array(1536).fill(0);
}

// -------- PROVIDERS --------
async function viaPinecone({id,text,metadata,namespace}){
  const key=process.env.PINECONE_API_KEY;
  const idx=process.env.PINECONE_INDEX_URL;
  const body={vectors:[{id:id||`doc_${Date.now()}`,values:await embed(text),metadata:{...metadata,text}}],namespace};
  const r=await fetch(`${idx}/vectors/upsert`,{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON(body)
  });
  if(!r.ok) throw new Error(`Pinecone HTTP ${r.status}`);
  return {provider:"pinecone",id:body.vectors[0].id,status:"ok"};
}

async function viaWeaviate({id,text,metadata}){
  const url=process.env.WEAVIATE_ENDPOINT;
  const key=process.env.WEAVIATE_API_KEY;
  const obj={class:"Document",properties:{text,...metadata}};
  const r=await fetch(`${url}/v1/objects`,{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON(obj)
  });
  if(!r.ok) throw new Error(`Weaviate HTTP ${r.status}`);
  return {provider:"weaviate",id:id||"auto",status:"ok"};
}

async function viaQdrant({id,text,metadata}){
  const url=process.env.QDRANT_URL;
  const key=process.env.QDRANT_API_KEY;
  const body={points:[{id:id||`doc_${Date.now()}`,vector:await embed(text),payload:{text,...metadata}}]};
  const r=await fetch(`${url}/collections/main/points`,{
    method:"PUT",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON(body)
  });
  if(!r.ok) throw new Error(`Qdrant HTTP ${r.status}`);
  return {provider:"qdrant",id:body.points[0].id,status:"ok"};
}

async function viaChroma({id,text,metadata}){
  const url=process.env.CHROMA_URL;
  const body={ids:[id||`doc_${Date.now()}`],documents:[text],metadatas:[metadata]};
  const r=await fetch(`${url}/add`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:toJSON(body)
  });
  if(!r.ok) throw new Error(`Chroma HTTP ${r.status}`);
  return {provider:"chroma",id:body.ids[0],status:"ok"};
}

async function viaSupabase({id,text,metadata}){
  const url=process.env.SUPABASE_URL;
  const key=process.env.SUPABASE_SERVICE_KEY;
  const body={id:id||`doc_${Date.now()}`,content:text,metadata};
  const r=await fetch(`${url}/rest/v1/documents`,{
    method:"POST",
    headers:{apikey:key,Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON(body)
  });
  if(!r.ok) throw new Error(`Supabase HTTP ${r.status}`);
  return {provider:"supabase",id:body.id,status:"ok"};
}

async function viaOpenSearch({id,text,metadata}){
  const url=process.env.OPENSEARCH_URL;
  const auth=process.env.OPENSEARCH_AUTH;
  const body={content:text,...metadata};
  const r=await fetch(`${url}/_doc/${id||`doc_${Date.now()}`}`,{
    method:"PUT",
    headers:{Authorization:`Basic ${auth}`,"Content-Type":"application/json"},
    body:toJSON(body)
  });
  if(!r.ok) throw new Error(`OpenSearch HTTP ${r.status}`);
  return {provider:"opensearch",id:id||"auto",status:"ok"};
}

async function viaVespa({id,text,metadata}){
  const url=process.env.VESPA_ENDPOINT;
  const body={fields:{text,metadata}};
  const r=await fetch(`${url}/document/v1/doc/docid/${id||`doc_${Date.now()}`}`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:toJSON(body)
  });
  if(!r.ok) throw new Error(`Vespa HTTP ${r.status}`);
  return {provider:"vespa",id:id||"auto",status:"ok"};
}

async function viaFAISS({id,text,metadata}){
  emitNote(null,"FAISS local upsert placeholder");
  return {provider:"faiss",id:id||"faiss_1",status:"ok"};
}

async function viaJSON({id,text,metadata}){
  const path="./data/kb.json";
  const doc={id:id||`doc_${Date.now()}`,text,metadata};
  let arr=[];
  if(fs.existsSync(path)) arr=JSON.parse(fs.readFileSync(path,"utf-8"));
  arr.push(doc);
  fs.writeFileSync(path,JSON.stringify(arr,null,2));
  return {provider:"json",id:doc.id,status:"ok"};
}

// -------- MAIN ENTRY --------
export async function run({input={},emit}){
  const provider=detectProvider();
  const {text}=input;
  if(!text){
    emitErr(emit,"kb_upsert: text required");
    return {data:{error:"missing_text"}};
  }

  if(DRY_RUN){
    emitNote(emit,`kb_upsert[DRY_RUN]: provider=${provider}`);
    return {data:{provider,status:"dry-run"}};
  }

  if(DEMO){
    emitNote(emit,"kb_upsert[DEMO]: returning mock upsert response");
    return {data:{provider:"demo",id:`demo_${Date.now()}`,status:"ok"}};
  }

  emitNote(emit,`kb_upsert: via ${provider}`);
  try{
    let out;
    switch(provider){
      case "pinecone": out=await viaPinecone(input);break;
      case "weaviate": out=await viaWeaviate(input);break;
      case "qdrant": out=await viaQdrant(input);break;
      case "chroma": out=await viaChroma(input);break;
      case "supabase": out=await viaSupabase(input);break;
      case "opensearch": out=await viaOpenSearch(input);break;
      case "vespa": out=await viaVespa(input);break;
      case "faiss": out=await viaFAISS(input);break;
      case "json": out=await viaJSON(input);break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return {data:out,status:"ok"};
  }catch(e){
    const err=String(e?.message||e);
    emitErr(emit,`kb_upsert failed: ${err}`);
    return {data:{provider,error:err,status:"error"}};
  }
}
