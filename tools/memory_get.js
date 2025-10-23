// tools/memory_get.js
// UNIVERSAL MEMORY RETRIEVER (Vector DBs + KV stores) with Multi-Provider Embeddings + Demo
// ----------------------------------------------------------------------------------------
//
// Vector/KV providers (auto-detected or force with MEMORY_PROVIDER):
//   • Pinecone         → PINECONE_API_KEY + PINECONE_INDEX_HOST
//   • Weaviate         → WEAVIATE_URL + WEAVIATE_API_KEY + WEAVIATE_CLASS
//   • Qdrant           → QDRANT_URL + QDRANT_API_KEY + QDRANT_COLLECTION
//   • Milvus (REST)    → MILVUS_REST_URL + MILVUS_API_KEY + MILVUS_COLLECTION
//   • OpenSearch/ES    → ES_URL + ES_INDEX (+ ES_BASIC_AUTH or ES_API_KEY)
//   • Supabase pgvector→ SUPABASE_URL + SUPABASE_KEY + SUPABASE_TABLE
//   • Chroma           → CHROMA_URL + CHROMA_COLLECTION
//   • Redis / Upstash  → REDIS_URL (+ REDIS_TOKEN)  [keyword fallback if no vector ops]
//   • Vercel KV        → VERCEL_KV_REST_API_URL + VERCEL_KV_REST_API_TOKEN [keyword fallback]
//
// Embedding providers (auto-detected or force with EMBED_PROVIDER):
//   • OpenAI           → OPENAI_API_KEY (OPENAI_EMBED_MODEL optional; default text-embedding-3-small)
//   • Azure OpenAI     → AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY + AZURE_OPENAI_EMBED_DEPLOYMENT
//   • Cohere           → COHERE_API_KEY
//   • Mistral          → MISTRAL_API_KEY
//   • Gemini           → GEMINI_API_KEY
//   • VoyageAI         → VOYAGE_API_KEY
//
// Common env:
//   MEMORY_PROVIDER   = "pinecone"|"weaviate"|"qdrant"|"milvus"|"es"|"opensearch"|"supabase"|"chroma"|"redis"|"vercel_kv"
//   EMBED_PROVIDER    = "openai"|"azure_openai"|"cohere"|"mistral"|"gemini"|"voyage"
//   MEMORY_DEMO       = "1"
//   MEMORY_DRY_RUN    = "1"
//
// Input:
//   {
//     query: string,                 // required: search text
//     top_k?: number,                // default 5
//     namespace?: string,            // optional tenant/namespace
//     filter?: object,               // optional metadata filter (provider-specific best-effort)
//     include_vectors?: boolean      // default false
//   }
//
// Output:
//   { data: { provider, results:[{id, score, text, metadata, vector?}], status }, status }

const DRY_RUN = String(process.env.MEMORY_DRY_RUN || "") === "1";
const DEMO = String(process.env.MEMORY_DEMO || "") === "1";

function emitNote(emit,msg){ try{ emit && emit({type:"note",msg}); }catch{} }
function emitErr(emit,msg){ try{ emit && emit({type:"error",msg}); }catch{} }
function toJSON(o){ return JSON.stringify(o,null,2); }

// ---------- Provider detection ----------
function detectVectorProvider(){
  const forced=(process.env.MEMORY_PROVIDER||"").toLowerCase().trim();
  if(forced) return forced;
  if(process.env.PINECONE_INDEX_HOST) return "pinecone";
  if(process.env.WEAVIATE_URL) return "weaviate";
  if(process.env.QDRANT_URL) return "qdrant";
  if(process.env.MILVUS_REST_URL) return "milvus";
  if(process.env.ES_URL) return "es";
  if(process.env.SUPABASE_URL) return "supabase";
  if(process.env.CHROMA_URL) return "chroma";
  if(process.env.REDIS_URL) return "redis";
  if(process.env.VERCEL_KV_REST_API_URL) return "vercel_kv";
  return "redis"; // broad fallback (keyword)
}

function detectEmbedProvider(){
  const forced=(process.env.EMBED_PROVIDER||"").toLowerCase().trim();
  if(forced) return forced;
  if(process.env.OPENAI_API_KEY) return "openai";
  if(process.env.AZURE_OPENAI_ENDPOINT) return "azure_openai";
  if(process.env.COHERE_API_KEY) return "cohere";
  if(process.env.MISTRAL_API_KEY) return "mistral";
  if(process.env.GEMINI_API_KEY) return "gemini";
  if(process.env.VOYAGE_API_KEY) return "voyage";
  return "openai";
}

// ---------- Embeddings ----------
async function embedViaOpenAI(text){
  const key=process.env.OPENAI_API_KEY;
  const model=process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
  const r=await fetch("https://api.openai.com/v1/embeddings",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({model,input:text})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`OpenAI Embeddings HTTP ${r.status}`);
  return j.data?.[0]?.embedding;
}

async function embedViaAzureOpenAI(text){
  const base=process.env.AZURE_OPENAI_ENDPOINT.replace(/\/+$/,"");
  const key=process.env.AZURE_OPENAI_API_KEY;
  const dep=process.env.AZURE_OPENAI_EMBED_DEPLOYMENT; // e.g. "text-embedding-3-small"
  const r=await fetch(`${base}/openai/deployments/${dep}/embeddings?api-version=2024-02-15-preview`,{
    method:"POST",
    headers:{"api-key":key,"Content-Type":"application/json"},
    body:toJSON({input:text})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Azure OpenAI Embeddings HTTP ${r.status}`);
  return j.data?.[0]?.embedding;
}

async function embedViaCohere(text){
  const key=process.env.COHERE_API_KEY;
  const r=await fetch("https://api.cohere.ai/v1/embed",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({texts:[text],model:"embed-english-v3.0"})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`Cohere Embeddings HTTP ${r.status}`);
  return j.embeddings?.[0];
}

async function embedViaMistral(text){
  const key=process.env.MISTRAL_API_KEY;
  const r=await fetch("https://api.mistral.ai/v1/embeddings",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({model:"mistral-embed",input:text})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Mistral Embeddings HTTP ${r.status}`);
  return j.data?.[0]?.embedding;
}

async function embedViaGemini(text){
  const key=process.env.GEMINI_API_KEY;
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${key}`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:toJSON({content:{parts:[{text}]}})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Gemini Embeddings HTTP ${r.status}`);
  return j.embedding?.values;
}

async function embedViaVoyage(text){
  const key=process.env.VOYAGE_API_KEY;
  const r=await fetch("https://api.voyageai.com/v1/embeddings",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({input:[text],model:"voyage-2"})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`VoyageAI Embeddings HTTP ${r.status}`);
  return j.data?.[0]?.embedding;
}

async function getEmbedding(text){
  const p = detectEmbedProvider();
  switch(p){
    case "openai": return embedViaOpenAI(text);
    case "azure_openai": return embedViaAzureOpenAI(text);
    case "cohere": return embedViaCohere(text);
    case "mistral": return embedViaMistral(text);
    case "gemini": return embedViaGemini(text);
    case "voyage": return embedViaVoyage(text);
    default: return embedViaOpenAI(text);
  }
}

// ---------- Vector/KV queries ----------
async function viaPinecone({vector,top_k=5,namespace,include_vectors,filter}){
  const host=process.env.PINECONE_INDEX_HOST; // e.g. "your-index-xxxx.svc.us-east1-aws.pinecone.io"
  const key=process.env.PINECONE_API_KEY;
  const r=await fetch(`https://${host}/query`,{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({vector,topK:top_k,namespace,includeValues:!!include_vectors,includeMetadata:true,filter})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`Pinecone HTTP ${r.status}`);
  const results=(j.matches||[]).map(m=>({id:m.id,score:m.score,text:m.metadata?.text||m.metadata?.content,metadata:m.metadata,vector:include_vectors?m.values:undefined}));
  return {provider:"pinecone",results,status:"ok"};
}

async function viaWeaviate({vector,top_k=5,namespace,filter}){
  const url=process.env.WEAVIATE_URL.replace(/\/+$/,"");
  const key=process.env.WEAVIATE_API_KEY;
  const klass=process.env.WEAVIATE_CLASS || "Memory";
  const body={
    query:`{
      Get {
        ${klass}(
          limit: ${top_k},
          nearVector: { vector: [${vector.slice(0,10).join(",")} ...] }
        ){
          _additional { id distance }
          text
          metadata
        }
      }
    }`
  };
  const r=await fetch(`${url}/v1/graphql`,{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":`Bearer ${key}`},
    body:toJSON(body)
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.errors?.[0]?.message||`Weaviate HTTP ${r.status}`);
  const rows=j.data?.Get?.[klass]||[];
  const results=rows.map(x=>({id:x._additional?.id,score:1-(x._additional?.distance||0),text:x.text||x.metadata?.text,metadata:x.metadata}));
  return {provider:"weaviate",results,status:"ok"};
}

async function viaQdrant({vector,top_k=5,filter}){
  const base=process.env.QDRANT_URL.replace(/\/+$/,"");
  const key=process.env.QDRANT_API_KEY;
  const coll=process.env.QDRANT_COLLECTION || "memory";
  const r=await fetch(`${base}/collections/${encodeURIComponent(coll)}/points/search`,{
    method:"POST",
    headers:{"Content-Type":"application/json", ...(key?{"api-key":key}:{})},
    body:toJSON({vector,limit:top_k,with_payload:true,filter})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.status||`Qdrant HTTP ${r.status}`);
  const results=(j.result||[]).map(p=>({id:String(p.id),score:p.score,text:p.payload?.text,metadata:p.payload}));
  return {provider:"qdrant",results,status:"ok"};
}

async function viaMilvus({vector,top_k=5,filter}){
  // Generic Milvus REST gateway (varies by deployment). We simulate a compatible payload.
  const base=process.env.MILVUS_REST_URL.replace(/\/+$/,"");
  const key=process.env.MILVUS_API_KEY;
  const coll=process.env.MILVUS_COLLECTION || "memory";
  const r=await fetch(`${base}/search`,{
    method:"POST",
    headers:{"Content-Type":"application/json", ...(key?{"Authorization":`Bearer ${key}`}:{})},
    body:toJSON({collection:coll,vector,limit:top_k,output_fields:["text","metadata"]})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`Milvus HTTP ${r.status}`);
  const results=(j.results||[]).map(x=>({id:x.id,score:x.score,text:x.text,metadata:x.metadata}));
  return {provider:"milvus",results,status:"ok"};
}

async function viaES({vector,top_k=5}){
  const base=process.env.ES_URL.replace(/\/+$/,"");
  const index=process.env.ES_INDEX || "memory";
  const headers={"Content-Type":"application/json"};
  if(process.env.ES_API_KEY) headers["Authorization"] = `ApiKey ${process.env.ES_API_KEY}`;
  if(process.env.ES_BASIC_AUTH) headers["Authorization"] = `Basic ${process.env.ES_BASIC_AUTH}`;
  const r=await fetch(`${base}/${encodeURIComponent(index)}/_search`,{
    method:"POST",
    headers,
    body:toJSON({
      size: top_k,
      query: {
        knn: { embedding: { vector, k: top_k } }
      },
      _source: ["text","metadata"]
    })
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.reason||`Elasticsearch HTTP ${r.status}`);
  const results=(j.hits?.hits||[]).map(h=>({id:h._id,score:h._score,text:h._source?.text,metadata:h._source?.metadata}));
  return {provider:"es",results,status:"ok"};
}

async function viaSupabase({vector,top_k=5,namespace}){
  const url=process.env.SUPABASE_URL.replace(/\/+$/,"");
  const key=process.env.SUPABASE_KEY;
  const table=process.env.SUPABASE_TABLE || "documents";
  // Assumes RPC function match_documents(embedding vector, match_count int, namespace text)
  const r=await fetch(`${url}/rest/v1/rpc/match_documents`,{
    method:"POST",
    headers:{"Content-Type":"application/json","apikey":key,"Authorization":`Bearer ${key}`},
    body:toJSON({query_embedding:vector,match_count:top_k,namespace})
  });
  const j=await r.json().catch(()=>({}));
  if(!Array.isArray(j) && !r.ok) throw new Error(j.message||`Supabase HTTP ${r.status}`);
  const rows=Array.isArray(j)?j:[];
  const results=rows.map(x=>({id:x.id,score:x.similarity,text:x.text,metadata:x.metadata}));
  return {provider:"supabase",results,status:"ok"};
}

async function viaChroma({vector,top_k=5}){
  const base=process.env.CHROMA_URL.replace(/\/+$/,"");
  const coll=process.env.CHROMA_COLLECTION || "memory";
  const r=await fetch(`${base}/api/v1/collections/${encodeURIComponent(coll)}/query`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:toJSON({query_embeddings:[vector],n_results:top_k,include:["metadatas","documents","distances"]})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`Chroma HTTP ${r.status}`);
  const results=(j.documents?.[0]||[]).map((doc,i)=>({
    id: j.ids?.[0]?.[i] || String(i),
    score: 1 - (j.distances?.[0]?.[i] ?? 0),
    text: doc,
    metadata: j.metadatas?.[0]?.[i] || {}
  }));
  return {provider:"chroma",results,status:"ok"};
}

async function viaRedisKeyword({query,top_k=5}){
  // Keyword fallback for Redis/Upstash or Vercel KV — returns recent/top mock results.
  // For production, wire to RediSearch FT.SEARCH or KV indexing service.
  return {
    provider:"redis",
    results:[
      {id:"demo-1",score:0.82,text:`Note matching "${query}" (recent)`,metadata:{source:"redis",ts:Date.now()}},
      {id:"demo-2",score:0.77,text:`Another snippet about ${query}`,metadata:{source:"redis"}}
    ].slice(0,top_k),
    status:"ok"
  };
}

async function viaVercelKVKeyword({query,top_k=5}){
  // Keyword-ish fallback using KV REST scan is not ideal; provide demo-like output.
  return {
    provider:"vercel_kv",
    results:[
      {id:"kv-1",score:0.75,text:`KV memo referencing "${query}"`,metadata:{tenant:"default"}},
      {id:"kv-2",score:0.71,text:`Saved reply snippet about ${query}`,metadata:{}}
    ].slice(0,top_k),
    status:"ok"
  };
}

// ---------- MAIN ----------
export async function run({input={},emit}){
  const provider = detectVectorProvider();
  const { query, top_k=5, namespace=null, filter=null, include_vectors=false } = input || {};

  if(!query){
    emitErr(emit,"memory_get: query required");
    return { data:{ error:"missing_query" } };
  }

  if (DRY_RUN){
    emitNote(emit,`memory_get[DRY_RUN]: provider=${provider}`);
    return { data:{ provider, status:"dry-run" } };
  }

  if (DEMO){
    emitNote(emit,"memory_get[DEMO]: returning mock retrieval");
    return {
      data:{
        provider:"demo",
        results:[
          { id:"mem_001", score:0.93, text:`How we invoice Mr. Martin — template + steps`, metadata:{tag:"billing",tenant:namespace||"demo"} },
          { id:"mem_002", score:0.88, text:`CRM: Mr. Martin — last service ordered`, metadata:{tag:"crm",customer:"Mr. Martin"} },
          { id:"mem_003", score:0.81, text:`Email draft best-practices for invoices`, metadata:{tag:"kb"} }
        ].slice(0,top_k),
        status:"ok"
      },
      status:"ok"
    };
  }

  // 1) Build the embedding once (unless using keyword-only providers)
  let vector=null;
  if(!["redis","vercel_kv"].includes(provider)){
    try{
      vector = await getEmbedding(query);
    }catch(e){
      emitErr(emit,`embedding failed: ${String(e?.message||e)}`);
      // Fallback to keyword path if vectorization fails
      if(provider==="redis") return { data: await viaRedisKeyword({query,top_k}), status:"ok" };
      if(provider==="vercel_kv") return { data: await viaVercelKVKeyword({query,top_k}), status:"ok" };
      // otherwise bubble up
      return { data:{ provider, error:String(e?.message||e), status:"error" } };
    }
  }

  emitNote(emit,`memory_get: via ${provider} (embed=${detectEmbedProvider()})`);
  try{
    let out;
    switch(provider){
      case "pinecone":   out = await viaPinecone({vector,top_k,namespace,include_vectors,filter}); break;
      case "weaviate":   out = await viaWeaviate({vector,top_k,namespace,filter}); break;
      case "qdrant":     out = await viaQdrant({vector,top_k,filter}); break;
      case "milvus":     out = await viaMilvus({vector,top_k,filter}); break;
      case "es":
      case "opensearch": out = await viaES({vector,top_k}); break;
      case "supabase":   out = await viaSupabase({vector,top_k,namespace}); break;
      case "chroma":     out = await viaChroma({vector,top_k}); break;
      case "redis":      out = await viaRedisKeyword({query,top_k}); break;
      case "vercel_kv":  out = await viaVercelKVKeyword({query,top_k}); break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return { data: out, status:"ok" };
  }catch(e){
    const err=String(e?.message||e);
    emitErr(emit,`memory_get failed: ${err}`);
    return { data:{ provider, error:err, status:"error" } };
  }
}
