// tools/search_web.js
// UNIVERSAL WEB SEARCH (Google, Bing, DuckDuckGo, Brave, SerpApi, Tavily, Perplexity, Firecrawl) + Demo
// ----------------------------------------------------------------------------------------------------
//
// Auto-detected providers (first match wins; or force with SEARCH_PROVIDER):
//   • Google Custom Search → GOOGLE_API_KEY + GOOGLE_CX
//   • Bing Web Search      → BING_API_KEY
//   • DuckDuckGo (free)    → no key
//   • Brave Search         → BRAVE_API_KEY
//   • SerpApi              → SERPAPI_KEY
//   • Tavily               → TAVILY_API_KEY
//   • Perplexity.ai        → PERPLEXITY_API_KEY
//   • Firecrawl Search     → FIRECRAWL_API_KEY
//
// Common env:
//   SEARCH_PROVIDER  = "google"|"bing"|"duckduckgo"|"brave"|"serpapi"|"tavily"|"perplexity"|"firecrawl"
//   SEARCH_DRY_RUN   = "1"
//   SEARCH_DEMO      = "1"
//   SEARCH_TIMEOUT_MS = "15000"
//
// Input:
//   {
//     query: string,           // required
//     numResults?: number,     // default 5
//     locale?: string,         // optional e.g. "en-US"
//   }
//
// Output:
//   { data: { provider, query, results: [{ title, link, snippet }], status }, status }

const DRY_RUN = String(process.env.SEARCH_DRY_RUN || "") === "1";
const DEMO = String(process.env.SEARCH_DEMO || "") === "1";
const TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS || 15000);

function emitNote(emit,msg){try{emit&&emit({type:"note",msg});}catch{}}
function emitErr(emit,msg){try{emit&&emit({type:"error",msg});}catch{}}
function toJSON(o){return JSON.stringify(o,null,2);}

function detectProvider(){
  const forced = (process.env.SEARCH_PROVIDER || "").toLowerCase().trim();
  if(forced) return forced;
  if(process.env.GOOGLE_API_KEY && process.env.GOOGLE_CX) return "google";
  if(process.env.BING_API_KEY) return "bing";
  if(process.env.BRAVE_API_KEY) return "brave";
  if(process.env.SERPAPI_KEY) return "serpapi";
  if(process.env.TAVILY_API_KEY) return "tavily";
  if(process.env.PERPLEXITY_API_KEY) return "perplexity";
  if(process.env.FIRECRAWL_API_KEY) return "firecrawl";
  return "duckduckgo";
}

// --------- PROVIDERS ---------
async function viaGoogle({query,numResults,locale}){
  const key = process.env.GOOGLE_API_KEY;
  const cx = process.env.GOOGLE_CX;
  const u = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${key}&cx=${cx}&num=${numResults||5}&lr=${locale?`lang_${locale}`:""}`;
  const r = await fetch(u);
  const j = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message || `Google HTTP ${r.status}`);
  const results = (j.items||[]).map(it=>({title:it.title,link:it.link,snippet:it.snippet}));
  return {provider:"google",query,results,status:"ok"};
}

async function viaBing({query,numResults}){
  const key = process.env.BING_API_KEY;
  const r = await fetch(`https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${numResults||5}`,{
    headers:{OcpApimSubscriptionKey:key}
  });
  const j = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`Bing HTTP ${r.status}`);
  const results = (j.webPages?.value||[]).map(it=>({title:it.name,link:it.url,snippet:it.snippet||it.description}));
  return {provider:"bing",query,results,status:"ok"};
}

async function viaDuckDuckGo({query,numResults}){
  const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1`);
  const j = await r.json().catch(()=>({}));
  const results=[];
  if(j.RelatedTopics){
    for(const t of j.RelatedTopics.slice(0,numResults||5)){
      if(t.Text && t.FirstURL) results.push({title:t.Text,link:t.FirstURL,snippet:""});
    }
  }
  return {provider:"duckduckgo",query,results,status:"ok"};
}

async function viaBrave({query,numResults}){
  const key=process.env.BRAVE_API_KEY;
  const r=await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${numResults||5}`,{
    headers:{Accept:"application/json",Authorization:`Bearer ${key}`}
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`Brave HTTP ${r.status}`);
  const results=(j.web?.results||[]).map(it=>({title:it.title,link:it.url,snippet:it.description}));
  return {provider:"brave",query,results,status:"ok"};
}

async function viaSerpApi({query,numResults}){
  const key=process.env.SERPAPI_KEY;
  const r=await fetch(`https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&num=${numResults||5}&api_key=${key}`);
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`SerpApi HTTP ${r.status}`);
  const results=(j.organic_results||[]).map(it=>({title:it.title,link:it.link,snippet:it.snippet}));
  return {provider:"serpapi",query,results,status:"ok"};
}

async function viaTavily({query,numResults}){
  const key=process.env.TAVILY_API_KEY;
  const r=await fetch("https://api.tavily.com/search",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({query,max_results:numResults||5})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`Tavily HTTP ${r.status}`);
  const results=(j.results||[]).map(it=>({title:it.title,link:it.url,snippet:it.content}));
  return {provider:"tavily",query,results,status:"ok"};
}

async function viaPerplexity({query}){
  const key=process.env.PERPLEXITY_API_KEY;
  const r=await fetch("https://api.perplexity.ai/chat/completions",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({model:"sonar-small-online",messages:[{role:"user",content:`Search: ${query}`}]})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`Perplexity HTTP ${r.status}`);
  const text=j.choices?.[0]?.message?.content||"";
  return {provider:"perplexity",query,results:[{title:"Summary",link:"https://perplexity.ai",snippet:text}],status:"ok"};
}

async function viaFirecrawl({query,numResults}){
  const key=process.env.FIRECRAWL_API_KEY;
  const r=await fetch("https://api.firecrawl.dev/v1/search",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({query,num:numResults||5})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`Firecrawl HTTP ${r.status}`);
  const results=(j.results||[]).map(it=>({title:it.title,link:it.url,snippet:it.snippet}));
  return {provider:"firecrawl",query,results,status:"ok"};
}

// --------- MAIN ENTRY ---------
export async function run({input={},emit}){
  const provider=detectProvider();
  const {query,numResults=5,locale}=input;
  if(!query){
    emitErr(emit,"search_web: query required");
    return {data:{error:"missing_query"}};
  }

  if(DRY_RUN){
    emitNote(emit,`search_web[DRY_RUN]: provider=${provider} query=${query}`);
    return {data:{provider,status:"dry-run"}};
  }

  if(DEMO){
    emitNote(emit,"search_web[DEMO]: returning mock results");
    return {
      data:{
        provider:"demo",
        query,
        results:[
          {title:`Demo result 1 for "${query}"`,link:"https://example.com/1",snippet:"Example snippet 1"},
          {title:`Demo result 2 for "${query}"`,link:"https://example.com/2",snippet:"Example snippet 2"}
        ],
        status:"ok"
      },
      status:"ok"
    };
  }

  emitNote(emit,`search_web: via ${provider} for "${query}"`);
  try{
    let out;
    switch(provider){
      case "google": out=await viaGoogle(input);break;
      case "bing": out=await viaBing(input);break;
      case "duckduckgo": out=await viaDuckDuckGo(input);break;
      case "brave": out=await viaBrave(input);break;
      case "serpapi": out=await viaSerpApi(input);break;
      case "tavily": out=await viaTavily(input);break;
      case "perplexity": out=await viaPerplexity(input);break;
      case "firecrawl": out=await viaFirecrawl(input);break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return {data:out,status:"ok"};
  }catch(e){
    const err=String(e?.message||e);
    emitErr(emit,`search_web failed: ${err}`);
    return {data:{provider,query,error:err,status:"error"}};
  }
}
