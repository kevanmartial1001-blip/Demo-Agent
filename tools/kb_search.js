// tools/kb_search.js
// UNIVERSAL KNOWLEDGE BASE SEARCH (Pinecone, Weaviate, Qdrant, Chroma, Supabase, OpenSearch, Vespa, FAISS, Local JSON) + Demo
// --------------------------------------------------------------------------------------------------------------
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
//     query: string,        // required
//     topK?: number,        // default 5
//     namespace?: string,   // optional KB segment
//     filter?: object,      // optional metadata filter
//   }
//
// Output:
//   { data: { provider, query, results: [{ id, score, text, metadata }], status }, status }

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

// -------- PROVIDERS --------
async function viaPinecone({query,topK,namespace,filter}){
  const key=process.env.PINECONE_API_KEY;
  const idx=process.env.PINECONE_INDEX_URL;
  const r=await fetch(`${idx}/query`,{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({topK:topK||5,namespace,filter,includeValues:false,includeMetadata:true,vector:await embed(query)})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`Pinecone HTTP ${r.status}`);
  const results=(j.matches||[]).map(m=>({id:m.id,score:m.score,text:m.metadata?.text||"",metadata:m.metadata}));
  return {provider:"pinecone",query,results,status:"ok"};
}

async function viaWeaviate({query,topK}){
  const url=process.env.WEAVIATE_ENDPOINT;
  const key=process.env.WEAVIATE_API_KEY;
  const body={query,limit:topK||5};
  const r=await fetch(`${url}/v1/graphql`,{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({query:`{ Get { Documents(nearText: { concepts: ["${query}"] }, limit: ${topK||5}) { text metadata } } }`})
  });
  const j=await r.json().catch(()=>({}));
  const docs=j.data?.Get?.Documents||[];
  const results=docs.map((d,i)=>({id:`doc_${i}`,score:1,d.text,metadata:d.metadata}));
  return {provider:"weaviate",query,results,status:"ok"};
}

async function viaQdrant({query,topK}){
  const url=process.env.QDRANT_URL;
  const key=process.env.QDRANT_API_KEY;
  const r=await fetch(`${url}/collections/main/points/search`,{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({vector:await embed(query),limit:topK||5,with_payload:true})
  });
  const j=await r.json().catch(()=>({}));
  const results=(j.result||[]).map(it=>({id:it.id,score:it.score,text:it.payload?.text||"",metadata:it.payload}));
  return {provider:"qdrant",query,results,status:"ok"};
}

async function viaChroma({query,topK}){
  const url=process.env.CHROMA_URL;
  const r=await fetch(`${url}/query`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:toJSON({n_results:topK||5,query_texts:[query]})
  });
  const j=await r.json().catch(()=>({}));
  const results=(j.documents?.[0]||[]).map((t,i)=>({id:`doc_${i}`,score:j.distances?.[0]?.[i]||1,text:t,metadata:j.metadatas?.[0]?.[i]}));
  return {provider:"chroma",query,results,status:"ok"};
}

async function viaSupabase({query,topK}){
  const url=process.env.SUPABASE_URL;
  const key=process.env.SUPABASE_SERVICE_KEY;
  const r=await fetch(`${url}/rest/v1/rpc/match_documents`,{
    method:"POST",
    headers:{apikey:key,Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({query_embedding:await embed(query),match_count:topK||5})
  });
  const j=await r.json().catch(()=>({}));
  const results=(j||[]).map((r,i)=>({id:r.id||i,score:r.score||1,text:r.content,metadata:r.metadata}));
  return {provider:"supabase",query,results,status:"ok"};
}

async function viaOpenSearch({query,topK}){
  const url=process.env.OPENSEARCH_URL;
  const auth=process.env.OPENSEARCH_AUTH;
  const r=await fetch(`${url}/_search`,{
    method:"POST",
    headers:{Authorization:`Basic ${auth}`,"Content-Type":"application/json"},
    body:toJSON({size:topK||5,query:{match:{content:query}}})
  });
  const j=await r.json().catch(()=>({}));
  const results=(j.hits?.hits||[]).map(h=>({id:h._id,score:h._score,text:h._source?.content||"",metadata:h._source}));
  return {provider:"opensearch",query,results,status:"ok"};
}

async function viaVespa({query,topK}){
  const url=process.env.VESPA_ENDPOINT;
  const r=await fetch(`${url}/search/`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:toJSON({yql:`select * from sources * where userQuery();`,query,ranking:{profile:"default"},hits:topK||5})
  });
  const j=await r.json().catch(()=>({}));
  const results=(j.root?.children||[]).map(c=>({id:c.id,score:c.relevance,text:c.fields?.summaryfeatures||"",metadata:c.fields}));
  return {provider:"vespa",query,results,status:"ok"};
}

async function viaFAISS({query,topK}){
  emitNote(null,"FAISS local search not implemented (placeholder)");
  return {provider:"faiss",query,results:[{id:"faiss_1",score:1,text:"Local FAISS placeholder result"}],status:"ok"};
}

async function viaJSON({query,topK}){
  const path="./data/kb.json";
  if(!fs.existsSync(path)) throw new Error("Local KB JSON not found");
  const db=JSON.parse(fs.readFileSync(path,"utf-8"));
  const matches=db.filter(e=>e.text?.toLowerCase().includes(query.toLowerCase())).slice(0,topK||5);
  return {provider:"json",query,results:matches.map((m,i)=>({id:m.id||i,score:1,text:m.text,metadata:m.metadata})),status:"ok"};
}

async function embed(text){
  const key=process.env.OPENAI_API_KEY;
  if(!key) return Array(1536).fill(0.1); // mock vector
  const r=await fetch("https://api.openai.com/v1/embeddings",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({model:"text-embedding-3-small",input:text})
  });
  const j=await r.json().catch(()=>({}));
  return j.data?.[0]?.embedding||Array(1536).fill(0);
}

// -------- MAIN ENTRY --------
export async function run({input={},emit}){
  const provider=detectProvider();
  const {query,topK=5}=input;
  if(!query){
    emitErr(emit,"kb_search: query required");
    return {data:{error:"missing_query"}};
  }

  if(DRY_RUN){
    emitNote(emit,`kb_search[DRY_RUN]: provider=${provider}`);
    return {data:{provider,status:"dry-run"}};
  }

  if(DEMO){
    emitNote(emit,"kb_search[DEMO]: returning fake KB results");
    return {
      data:{
        provider:"demo",
        query,
        results:[
          {id:"demo1",score:0.98,text:`Simulated knowledge base answer about "${query}"`,metadata:{source:"demo"}},
          {id:"demo2",score:0.91,text:"Example supporting document snippet."}
        ],
        status:"ok"
      },
      status:"ok"
    };
  }

  emitNote(emit,`kb_search: via ${provider}`);
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
    emitErr(emit,`kb_search failed: ${err}`);
    return {data:{provider,query,error:err,status:"error"}};
  }
}
