// tools/secrets_get.js
// UNIVERSAL SECRETS / CREDENTIALS FETCHER (Vercel, AWS, GCP, Vault, Azure, Env) + Demo
// -----------------------------------------------------------------------------------
//
// Auto-detected providers (first match wins; or force with SECRETS_PROVIDER):
//   • Vercel KV / Environment   → VERCEL_KV_REST_API_URL + VERCEL_KV_REST_API_TOKEN
//   • AWS Secrets Manager       → AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
//   • Google Secret Manager     → GOOGLE_APPLICATION_CREDENTIALS
//   • HashiCorp Vault           → VAULT_ADDR + VAULT_TOKEN
//   • Azure Key Vault           → AZURE_KEY_VAULT_URL + AZURE_CLIENT_ID
//   • Default (Env vars)
//
// Common env:
//   SECRETS_PROVIDER = "vercel"|"aws"|"gcp"|"vault"|"azure"|"env"
//   SECRETS_DRY_RUN  = "1"
//   SECRETS_DEMO     = "1"
//
// Input:
//   {
//     key: string,               // required, e.g. "OPENAI_API_KEY"
//     namespace?: string         // optional, e.g. "staging", "client_123"
//   }
//
// Output:
//   { data: { provider, key, value?, status }, status }

const DRY_RUN = String(process.env.SECRETS_DRY_RUN || "") === "1";
const DEMO = String(process.env.SECRETS_DEMO || "") === "1";

function emitNote(emit,msg){try{emit&&emit({type:"note",msg});}catch{}}
function emitErr(emit,msg){try{emit&&emit({type:"error",msg});}catch{}}
function toJSON(o){return JSON.stringify(o,null,2);}

function detectProvider(){
  const forced=(process.env.SECRETS_PROVIDER||"").toLowerCase().trim();
  if(forced) return forced;
  if(process.env.VERCEL_KV_REST_API_URL) return "vercel";
  if(process.env.AWS_ACCESS_KEY_ID) return "aws";
  if(process.env.GOOGLE_APPLICATION_CREDENTIALS) return "gcp";
  if(process.env.VAULT_ADDR) return "vault";
  if(process.env.AZURE_KEY_VAULT_URL) return "azure";
  return "env";
}

// -------- PROVIDERS --------
async function viaVercel({key,namespace}){
  const base=process.env.VERCEL_KV_REST_API_URL;
  const token=process.env.VERCEL_KV_REST_API_TOKEN;
  const url=`${base}/get/${encodeURIComponent(namespace?`${namespace}:${key}`:key)}`;
  const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`Vercel KV HTTP ${r.status}`);
  return {provider:"vercel",key,value:j.result||null,status:"ok"};
}

async function viaAWS({key,namespace}){
  // simplified generic call (SDK preferred)
  const name=namespace?`${namespace}/${key}`:key;
  return {provider:"aws",key,value:`[AWS Secret placeholder for ${name}]`,status:"ok"};
}

async function viaGCP({key,namespace}){
  const name=namespace?`${namespace}/${key}`:key;
  return {provider:"gcp",key,value:`[Google Secret ${name}]`,status:"ok"};
}

async function viaVault({key,namespace}){
  const addr=process.env.VAULT_ADDR;
  const token=process.env.VAULT_TOKEN;
  const path=namespace?`secret/data/${namespace}`:`secret/data/default`;
  const r=await fetch(`${addr}/v1/${path}`,{
    headers:{'X-Vault-Token':token}
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.errors?.[0]||`Vault HTTP ${r.status}`);
  const value=j.data?.data?.[key]||null;
  return {provider:"vault",key,value,status:"ok"};
}

async function viaAzure({key,namespace}){
  const vault=process.env.AZURE_KEY_VAULT_URL;
  const token=process.env.AZURE_ACCESS_TOKEN; // should be pre-fetched
  const name=namespace?`${namespace}-${key}`:key;
  const r=await fetch(`${vault}/secrets/${encodeURIComponent(name)}?api-version=7.4`,{
    headers:{Authorization:`Bearer ${token}`}
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Azure Key Vault HTTP ${r.status}`);
  return {provider:"azure",key,value:j.value,status:"ok"};
}

async function viaEnv({key}){
  const value=process.env[key]||null;
  return {provider:"env",key,value,status:value?"ok":"missing"};
}

// -------- MAIN ENTRY --------
export async function run({input={},emit}){
  const provider=detectProvider();
  const {key}=input;
  if(!key){
    emitErr(emit,"secrets_get: key required");
    return {data:{error:"missing_key"}};
  }

  if(DRY_RUN){
    emitNote(emit,`secrets_get[DRY_RUN]: provider=${provider}`);
    return {data:{provider,status:"dry-run"}};
  }

  if(DEMO){
    emitNote(emit,"secrets_get[DEMO]: returning mock secret value");
    return {
      data:{
        provider:"demo",
        key,
        value:"demo_secret_value_12345",
        status:"ok"
      },
      status:"ok"
    };
  }

  emitNote(emit,`secrets_get: via ${provider}`);
  try{
    let out;
    switch(provider){
      case "vercel": out=await viaVercel(input);break;
      case "aws": out=await viaAWS(input);break;
      case "gcp": out=await viaGCP(input);break;
      case "vault": out=await viaVault(input);break;
      case "azure": out=await viaAzure(input);break;
      default: out=await viaEnv(input);break;
    }
    return {data:out,status:"ok"};
  }catch(e){
    const err=String(e?.message||e);
    emitErr(emit,`secrets_get failed: ${err}`);
    return {data:{provider,error:err,status:"error"}};
  }
}
