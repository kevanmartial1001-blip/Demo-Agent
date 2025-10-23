// tools/ops_run_job.js
// UNIVERSAL DEVOPS JOB RUNNER (GitHub Actions, GitLab CI, Jenkins, CircleCI, n8n, Airflow, Webhook) + Demo
// ------------------------------------------------------------------------------------------------------
//
// Auto-detected providers (first match wins; or force with OPS_PROVIDER):
//   • GitHub Actions   → GITHUB_TOKEN
//   • GitLab CI        → GITLAB_TOKEN
//   • Jenkins          → JENKINS_URL + JENKINS_USER + JENKINS_TOKEN
//   • CircleCI         → CIRCLECI_TOKEN
//   • n8n              → N8N_WEBHOOK_URL
//   • Airflow          → AIRFLOW_URL + AIRFLOW_TOKEN
//   • Generic Webhook  → JOB_WEBHOOK_URL
//
// Common env:
//   OPS_PROVIDER = "github"|"gitlab"|"jenkins"|"circleci"|"n8n"|"airflow"|"webhook"
//   OPS_DRY_RUN  = "1"
//   OPS_DEMO     = "1"
//
// Input:
//   {
//     job_name: string,                 // required
//     parameters?: object,              // optional job parameters (e.g. {env:"prod",version:"1.2.3"})
//     repo?: string,                    // e.g. for GitHub/GitLab CI
//     branch?: string,                  // optional
//     wait?: boolean                    // whether to wait for job result (default false)
//   }
//
// Output:
//   { data: { provider, job_url?, job_id?, status, message? }, status }

const DRY_RUN = String(process.env.OPS_DRY_RUN || "") === "1";
const DEMO = String(process.env.OPS_DEMO || "") === "1";

function emitNote(emit,msg){try{emit&&emit({type:"note",msg});}catch{}}
function emitErr(emit,msg){try{emit&&emit({type:"error",msg});}catch{}}
function toJSON(o){return JSON.stringify(o,null,2);}

function detectProvider(){
  const forced=(process.env.OPS_PROVIDER||"").toLowerCase().trim();
  if(forced) return forced;
  if(process.env.GITHUB_TOKEN) return "github";
  if(process.env.GITLAB_TOKEN) return "gitlab";
  if(process.env.JENKINS_URL) return "jenkins";
  if(process.env.CIRCLECI_TOKEN) return "circleci";
  if(process.env.N8N_WEBHOOK_URL) return "n8n";
  if(process.env.AIRFLOW_URL) return "airflow";
  if(process.env.JOB_WEBHOOK_URL) return "webhook";
  return "n8n";
}

// -------- PROVIDERS --------
async function viaGitHub({job_name,repo,branch="main",parameters={}}){
  const token=process.env.GITHUB_TOKEN;
  const r=await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${job_name}.yml/dispatches`,{
    method:"POST",
    headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
    body:toJSON({ref:branch,inputs:parameters})
  });
  if(!r.ok) throw new Error(`GitHub Actions HTTP ${r.status}`);
  return {provider:"github",job_id:Date.now(),status:"ok"};
}

async function viaGitLab({job_name,repo,branch="main",parameters={}}){
  const token=process.env.GITLAB_TOKEN;
  const baseUrl=process.env.GITLAB_URL||"https://gitlab.com";
  const r=await fetch(`${baseUrl}/api/v4/projects/${encodeURIComponent(repo)}/trigger/pipeline`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:toJSON({token,ref:branch,variables:parameters})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`GitLab CI HTTP ${r.status}`);
  return {provider:"gitlab",job_id:j.id,job_url:j.web_url,status:"ok"};
}

async function viaJenkins({job_name,parameters={}}){
  const url=process.env.JENKINS_URL;
  const user=process.env.JENKINS_USER;
  const token=process.env.JENKINS_TOKEN;
  const auth=Buffer.from(`${user}:${token}`).toString("base64");
  const r=await fetch(`${url}/job/${encodeURIComponent(job_name)}/buildWithParameters`,{
    method:"POST",
    headers:{Authorization:`Basic ${auth}`},
    body:new URLSearchParams(parameters)
  });
  if(!r.ok) throw new Error(`Jenkins HTTP ${r.status}`);
  return {provider:"jenkins",job_url:`${url}/job/${job_name}`,status:"ok"};
}

async function viaCircleCI({job_name,repo,branch="main",parameters={}}){
  const token=process.env.CIRCLECI_TOKEN;
  const [vcs,user,project]=repo.split("/");
  const r=await fetch(`https://circleci.com/api/v2/project/${vcs}/${user}/${project}/pipeline`,{
    method:"POST",
    headers:{"Circle-Token":token,"Content-Type":"application/json"},
    body:toJSON({branch,parameters})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`CircleCI HTTP ${r.status}`);
  return {provider:"circleci",job_id:j.id,status:"ok"};
}

async function viaN8n({job_name,parameters={}}){
  const base=process.env.N8N_WEBHOOK_URL.replace(/\/+$/,"");
  const r=await fetch(`${base}/${encodeURIComponent(job_name)}`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:toJSON(parameters)
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`n8n HTTP ${r.status}`);
  return {provider:"n8n",job_id:Date.now(),job_url:base+"/"+job_name,status:"ok"};
}

async function viaAirflow({job_name,parameters={}}){
  const url=process.env.AIRFLOW_URL;
  const token=process.env.AIRFLOW_TOKEN;
  const r=await fetch(`${url}/api/v1/dags/${encodeURIComponent(job_name)}/dagRuns`,{
    method:"POST",
    headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
    body:toJSON({conf:parameters})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`Airflow HTTP ${r.status}`);
  return {provider:"airflow",job_id:j.dag_run_id,status:"ok"};
}

async function viaWebhook({job_name,parameters={}}){
  const base=process.env.JOB_WEBHOOK_URL;
  const r=await fetch(base,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:toJSON({job_name,parameters})
  });
  if(!r.ok) throw new Error(`Webhook HTTP ${r.status}`);
  return {provider:"webhook",status:"ok"};
}

// -------- MAIN ENTRY --------
export async function run({input={},emit}){
  const provider=detectProvider();
  const {job_name}=input;
  if(!job_name){
    emitErr(emit,"ops_run_job: job_name required");
    return {data:{error:"missing_job_name"}};
  }

  if(DRY_RUN){
    emitNote(emit,`ops_run_job[DRY_RUN]: provider=${provider}`);
    return {data:{provider,status:"dry-run"}};
  }

  if(DEMO){
    emitNote(emit,"ops_run_job[DEMO]: returning mock job trigger");
    return {
      data:{
        provider:"demo",
        job_url:`https://ci.example.com/job/${encodeURIComponent(job_name)}`,
        job_id:Date.now(),
        status:"ok"
      },
      status:"ok"
    };
  }

  emitNote(emit,`ops_run_job: via ${provider}`);
  try{
    let out;
    switch(provider){
      case "github": out=await viaGitHub(input);break;
      case "gitlab": out=await viaGitLab(input);break;
      case "jenkins": out=await viaJenkins(input);break;
      case "circleci": out=await viaCircleCI(input);break;
      case "n8n": out=await viaN8n(input);break;
      case "airflow": out=await viaAirflow(input);break;
      case "webhook": out=await viaWebhook(input);break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return {data:out,status:"ok"};
  }catch(e){
    const err=String(e?.message||e);
    emitErr(emit,`ops_run_job failed: ${err}`);
    return {data:{provider,error:err,status:"error"}};
  }
}
