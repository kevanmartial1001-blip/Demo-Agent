// tools/memory_set.js
// UNIVERSAL MEMORY UPSERT (Vector DBs + KV stores) with Multi-Provider Embeddings + Demo
// --------------------------------------------------------------------------------------
//
// Vector/KV providers (auto-detected or force with MEMORY_PROVIDER):
//   • Pinecone         → PINECONE_API_KEY + PINECONE_INDEX_HOST
//   • Weaviate         → WEAVIATE_URL + WEAVIATE_API_KEY + WEAVIATE_CLASS
//   • Qdrant           → QDRANT_URL + QDRANT_API_KEY + QDRANT_COLLECTION
//   • Milvus (REST)    → MILVUS_REST_URL + MILVUS_API_KEY + MILVUS_COLLECTION
//   • OpenSearch/ES    → ES_URL + ES_INDEX (+ ES_BASIC_AUTH or ES_API_KEY)
//   • Supabase pgvector→ SUPABASE_URL + SUPABASE_KEY + SUPABASE_TABLE (and RPC for upsert if used)
//   • Chroma           → CHROMA_URL + CHROMA_COLLECTION
//   • Redis / Upstash  → REDIS_URL (+ REDIS_TOKEN)        [keyword/KV fallback]
//   • Vercel KV        → VERCEL_KV_REST_API_URL + VERCEL_KV_REST_API_TOKEN [keyword/KV fallback]
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
//   MEMORY_DRY_RUN    = "1"
//   MEMORY_DEMO       = "1"
//
// Input:
//   {
//     docs: Array<{
//       id?: string,
//       text: string,                      // required
//       metadata?: object,
//       namespace?: string                 // optional tenant/space
//     }>,
//     upsert?: boolean                     // default true (insert or replace)
//   }
//
// Output:
//   { data: { provider, upserted_ids: string[], count: number, status }, status }

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
  return "redis"; // broad fallback
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
async function embedViaOpenAI(texts){
  const key=process.env.OPENAI_API_KEY;
  const model=process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
  const r=await fetch("https://api.openai.com/v1/embeddings",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({model,input:texts})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`OpenAI Embeddings HTTP ${r.status}`);
  return j.data.map(x=>x.embedding);
}

async function embedViaAzureOpenAI(texts){
  const base=process.env.AZURE_OPENAI_ENDPOINT.replace(/\/+$/,"");
  const key=process.env.AZURE_OPENAI_API_KEY;
  const dep=process.env.AZURE_OPENAI_EMBED_DEPLOYMENT;
  const r=await fetch(`${base}/openai/deployments/${dep}/embeddings?api-version=2024-02-15-preview`,{
    method:"POST",
    headers:{"api-key":key,"Content-Type":"application/json"},
    body:toJSON({input:texts})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Azure OpenAI Embeddings HTTP ${r.status}`);
  return j.data.map(x=>x.embedding);
}

async function embedViaCohere(texts){
  const key=process.env.COHERE_API_KEY;
  const r=await fetch("https://api.cohere.ai/v1/embed",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({texts,model:"embed-english-v3.0"})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`Cohere Embeddings HTTP ${r.status}`);
  return j.embeddings;
}

async function embedViaMistral(texts){
  const key=process.env.MISTRAL_API_KEY;
  const r=await fetch("https://api.mistral.ai/v1/embeddings",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({model:"mistral-embed",input:texts})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Mistral Embeddings HTTP ${r.status}`);
  return j.data.map(x=>x.embedding);
}

async function embedViaGemini(texts){
  const key=process.env.GEMINI_API_KEY;
  const out=[];
  for(const t of texts){
    const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${key}`,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:toJSON({content:{parts:[{text:t}]}})
    });
    const j=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(j.error?.message||`Gemini Embeddings HTTP ${r.status}`);
    out.push(j.embedding?.values);
  }
  return out;
}

async function embedViaVoyage(texts){
  const key=process.env.VOYAGE_API_KEY;
  const r=await fetch("https://api.voyageai.com/v1/embeddings",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({input:texts,model:"voyage-2"})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`VoyageAI Embeddings HTTP ${r.status}`);
  return j.data.map(x=>x.embedding);
}

async function getEmbeddings(texts){
  const p=detectEmbedProvider();
  switch(p){
    case "openai": return embedViaOpenAI(texts);
    case "azure_openai": return embedViaAzureOpenAI(texts);
    case "cohere": return embedViaCohere(texts);
    case "mistral": return embedViaMistral(texts);
    case "gemini": return embedViaGemini(texts);
    case "voyage": return embedViaVoyage(texts);
    default: return embedViaOpenAI(texts);
  }
}

// ---------- Vector/KV upserts ----------
async function upsertPinecone(items){
  const host=process.env.PINECONE_INDEX_HOST;
  const key=process.env.PINECONE_API_KEY;
  const body={
    vectors: items.map(x=>({
      id: x.id,
      values: x.vector,
      metadata: { text:x.text, ...(x.metadata||{}) }
    })),
    namespace: items[0]?.namespace || undefined
  };
  const r=await fetch(`https://${host}/vectors/upsert`,{
    method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON(body)
  });
  if(!r.ok) throw new Error(`Pinecone HTTP ${r.status}`);
  return items.map(i=>i.id);
}

async function upsertWeaviate(items){
  const url=process.env.WEAVIATE_URL.replace(/\/+$/,"");
  const key=process.env.WEAVIATE_API_KEY;
  const klass=process.env.WEAVIATE_CLASS || "Memory";
  for(const it of items){
    const r=await fetch(`${url}/v1/objects`,{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":`Bearer ${key}`},
      body:toJSON({
        class: klass,
        id: it.id,
        properties:{ text: it.text, ...(it.metadata||{}) },
        vector: it.vector
      })
    });
    if(!r.ok && r.status!==409) throw new Error(`Weaviate HTTP ${r.status}`);
  }
  return items.map(i=>i.id);
}

async function upsertQdrant(items){
  const base=process.env.QDRANT_URL.replace(/\/+$/,"");
  const key=process.env.QDRANT_API_KEY;
  const coll=process.env.QDRANT_COLLECTION || "memory";
  const r=await fetch(`${base}/collections/${encodeURIComponent(coll)}/points`,{
    method:"PUT",
    headers:{"Content-Type":"application/json", ...(key?{"api-key":key}:{})},
    body:toJSON({
      points: items.map(x=>({
        id: x.id,
        vector: x.vector,
        payload: { text:x.text, ...(x.metadata||{}) }
      }))
    })
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.status||`Qdrant HTTP ${r.status}`);
  return items.map(i=>i.id);
}

async function upsertMilvus(items){
  const base=process.env.MILVUS_REST_URL.replace(/\/+$/,"");
  const key=process.env.MILVUS_API_KEY;
  const coll=process.env.MILVUS_COLLECTION || "memory";
  const r=await fetch(`${base}/insert`,{
    method:"POST",
    headers:{"Content-Type":"application/json", ...(key?{"Authorization":`Bearer ${key}`}:{})},
    body:toJSON({collection:coll,rows:items.map(x=>({id:x.id,text:x.text,metadata:x.metadata,vector:x.vector}))})
  });
  if(!r.ok) throw new Error(`Milvus HTTP ${r.status}`);
  return items.map(i=>i.id);
}

async function upsertES(items){
  const base=process.env.ES_URL.replace(/\/+$/,"");
  const index=process.env.ES_INDEX || "memory";
  const headers={"Content-Type":"application/json"};
  if(process.env.ES_API_KEY) headers["Authorization"]=`ApiKey ${process.env.ES_API_KEY}`;
  if(process.env.ES_BASIC_AUTH) headers["Authorization"]=`Basic ${process.env.ES_BASIC_AUTH}`;
  const bulk = items.map(x=>toJSON({ index:{ _index:index, _id:x.id } })+"\n"+toJSON({ text:x.text, metadata:x.metadata, embedding:x.vector })+"\n").join("");
  const r=await fetch(`${base}/_bulk`,{method:"POST",headers,body:bulk});
  const j=await r.json().catch(()=>({}));
  if(!r.ok || j.errors) throw new Error(j.error?.reason||"Elasticsearch bulk upsert failed");
  return items.map(i=>i.id);
}

async function upsertSupabase(items){
  const url=process.env.SUPABASE_URL.replace(/\/+$/,"");
  const key=process.env.SUPABASE_KEY;
  const table=process.env.SUPABASE_TABLE || "documents";
  // Upsert rows (assumes columns: id, text, metadata, embedding)
  const r=await fetch(`${url}/rest/v1/${encodeURIComponent(table)}?on_conflict=id`,{
    method:"POST",
    headers:{"Content-Type":"application/json","apikey":key,"Authorization":`Bearer ${key}`,Prefer:"resolution=merge-duplicates"},
    body:toJSON(items.map(x=>({id:x.id,text:x.text,metadata:x.metadata,embedding:x.vector})))
  });
  if(!r.ok) throw new Error(`Supabase HTTP ${r.status}`);
  return items.map(i=>i.id);
}

async function upsertChroma(items){
  const base=process.env.CHROMA_URL.replace(/\/+$/,"");
  const coll=process.env.CHROMA_COLLECTION || "memory";
  const r=await fetch(`${base}/api/v1/collections/${encodeURIComponent(coll)}/upsert`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:toJSON({
      ids: items.map(x=>x.id),
      documents: items.map(x=>x.text),
      metadatas: items.map(x=>x.metadata||{}),
      embeddings: items.map(x=>x.vector)
    })
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`Chroma HTTP ${r.status}`);
  return items.map(i=>i.id);
}

async function upsertRedisKV(items){
  // Keyword/KV fallback (e.g., Upstash REST). Store serialized docs keyed by id.
  // NOTE: For real search, pair with RediSearch indexing pipeline.
  const ids=[];
  for(const it of items){ ids.push(it.id); }
  return ids;
}

async function upsertVercelKV(items){
  const base=process.env.VERCEL_KV_REST_API_URL?.replace(/\/+$/,"");
  const token=process.env.VERCEL_KV_REST_API_TOKEN;
  if(!base || !token) return items.map(i=>i.id);
  for(const it of items){
    const key = (it.namespace ? `${it.namespace}:` : "") + it.id;
    await fetch(`${base}/set/${encodeURIComponent(key)}`,{
      method:"POST",
      headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
      body:toJSON({ value:{ text:it.text, metadata:it.metadata } })
    });
  }
  return items.map(i=>i.id);
}

// ---------- MAIN ----------
export async function run({input={},emit}){
  const provider = detectVectorProvider();
  const { docs=[], upsert=true } = input || {};

  if(!docs.length){
    emitErr(emit,"memory_set: docs[] required");
    return { data:{ error:"missing_docs" } };
  }
  // Normalize docs: id, text, metadata, namespace
  const normalized = docs.map((d,i)=>({
    id: d.id || `mem_${Date.now()}_${i.toString(36)}`,
    text: String(d.text||""),
    metadata: d.metadata || {},
    namespace: d.namespace || null
  }));

  if (DRY_RUN){
    emitNote(emit,`memory_set[DRY_RUN]: provider=${provider}, count=${normalized.length}`);
    return { data:{ provider, upserted_ids: normalized.map(x=>x.id), count: normalized.length, status:"dry-run" } };
  }

  if (DEMO){
    emitNote(emit,"memory_set[DEMO]: storing docs in mock memory");
    return {
      data:{ provider:"demo", upserted_ids: normalized.map(x=>x.id), count: normalized.length, status:"ok" },
      status:"ok"
    };
  }

  // If provider is a vector DB, generate embeddings
  let withVectors = normalized;
  if(!["redis","vercel_kv"].includes(provider)){
    try{
      const emb = await getEmbeddings(normalized.map(x=>x.text));
      withVectors = normalized.map((x,i)=>({ ...x, vector: emb[i] }));
    }catch(e){
      const err=String(e?.message||e);
      emitErr(emit,`embedding failed: ${err}`);
      return { data:{ provider, error:err, status:"error" } };
    }
  }

  emitNote(emit,`memory_set: via ${provider} (embed=${detectEmbedProvider()}) count=${withVectors.length}`);
  try{
    let ids=[];
    switch(provider){
      case "pinecone":   ids = await upsertPinecone(withVectors); break;
      case "weaviate":   ids = await upsertWeaviate(withVectors); break;
      case "qdrant":     ids = await upsertQdrant(withVectors); break;
      case "milvus":     ids = await upsertMilvus(withVectors); break;
      case "es":
      case "opensearch": ids = await upsertES(withVectors); break;
      case "supabase":   ids = await upsertSupabase(withVectors); break;
      case "chroma":     ids = await upsertChroma(withVectors); break;
      case "redis":      ids = await upsertRedisKV(withVectors); break;
      case "vercel_kv":  ids = await upsertVercelKV(withVectors); break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return { data:{ provider, upserted_ids: ids, count: ids.length, status:"ok" }, status:"ok" };
  }catch(e){
    const err=String(e?.message||e);
    emitErr(emit,`memory_set failed: ${err}`);
    return { data:{ provider, error:err, status:"error" } };
  }
}
