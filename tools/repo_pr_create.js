// tools/repo_pr_create.js
// UNIVERSAL PULL REQUEST CREATOR (GitHub, GitLab, Bitbucket, Gitea) + Demo
// -----------------------------------------------------------------------
//
// Auto-detected providers (first match wins; or force with REPO_PROVIDER):
//   • GitHub     → GITHUB_TOKEN
//   • GitLab     → GITLAB_TOKEN
//   • Bitbucket  → BITBUCKET_USER + BITBUCKET_APP_PASSWORD
//   • Gitea      → GITEA_TOKEN + GITEA_URL
//
// Common env:
//   REPO_PROVIDER = "github"|"gitlab"|"bitbucket"|"gitea"
//   REPO_DRY_RUN  = "1"
//   REPO_DEMO     = "1"
//
// Input:
//   {
//     repo: string,                 // required, e.g. "kevanmartial/ai-factory"
//     branch: string,               // required, e.g. "feature/auto-agent"
//     title: string,                // required
//     body?: string,                // PR/MR description
//     changes?: [                   // optional array of file changes
//       { path: string, content: string, message?: string }
//     ],
//     base?: string,                // base branch (default "main" or "master")
//     draft?: boolean
//   }
//
// Output:
//   { data: { provider, pr_url?, pr_id?, status, mock? }, status }

const DRY_RUN = String(process.env.REPO_DRY_RUN || "") === "1";
const DEMO = String(process.env.REPO_DEMO || "") === "1";

function emitNote(emit,msg){try{emit&&emit({type:"note",msg});}catch{}}
function emitErr(emit,msg){try{emit&&emit({type:"error",msg});}catch{}}
function toJSON(o){return JSON.stringify(o,null,2);}

function detectProvider(){
  const forced=(process.env.REPO_PROVIDER||"").toLowerCase().trim();
  if(forced) return forced;
  if(process.env.GITHUB_TOKEN) return "github";
  if(process.env.GITLAB_TOKEN) return "gitlab";
  if(process.env.BITBUCKET_USER && process.env.BITBUCKET_APP_PASSWORD) return "bitbucket";
  if(process.env.GITEA_TOKEN) return "gitea";
  return "github";
}

// -------- PROVIDERS --------
async function viaGitHub({repo,branch,base="main",title,body,changes=[],draft}){
  const token=process.env.GITHUB_TOKEN;
  const headers={Authorization:`Bearer ${token}`,"Content-Type":"application/json","Accept":"application/vnd.github+json"};

  // Optional: commit file changes if provided
  if(changes.length){
    emitNote(null,`repo_pr_create: committing ${changes.length} files to ${branch}`);
    for(const ch of changes){
      const encoded=Buffer.from(ch.content).toString("base64");
      await fetch(`https://api.github.com/repos/${repo}/contents/${ch.path}`,{
        method:"PUT",headers,
        body:toJSON({message:ch.message||`update ${ch.path}`,content:encoded,branch})
      });
    }
  }

  // Create PR
  const prRes=await fetch(`https://api.github.com/repos/${repo}/pulls`,{
    method:"POST",headers,
    body:toJSON({title,head:branch,base,body,draft})
  });
  const prJson=await prRes.json().catch(()=>({}));
  if(!prRes.ok) throw new Error(prJson.message||`GitHub PR HTTP ${prRes.status}`);
  return {provider:"github",pr_url:prJson.html_url,pr_id:prJson.number,status:"ok"};
}

async function viaGitLab({repo,branch,base="main",title,body,draft}){
  const token=process.env.GITLAB_TOKEN;
  const baseUrl=process.env.GITLAB_URL||"https://gitlab.com";
  const r=await fetch(`${baseUrl}/api/v4/projects/${encodeURIComponent(repo)}/merge_requests`,{
    method:"POST",
    headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
    body:toJSON({source_branch:branch,target_branch:base,title,description:body,draft})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`GitLab MR HTTP ${r.status}`);
  return {provider:"gitlab",pr_url:j.web_url,pr_id:j.iid,status:"ok"};
}

async function viaBitbucket({repo,branch,base="main",title,body}){
  const [user,slug]=repo.split("/");
  const auth=Buffer.from(`${process.env.BITBUCKET_USER}:${process.env.BITBUCKET_APP_PASSWORD}`).toString("base64");
  const r=await fetch(`https://api.bitbucket.org/2.0/repositories/${user}/${slug}/pullrequests`,{
    method:"POST",
    headers:{Authorization:`Basic ${auth}`,"Content-Type":"application/json"},
    body:toJSON({title,source:{branch:{name:branch}},destination:{branch:{name:base}},description:body})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Bitbucket PR HTTP ${r.status}`);
  return {provider:"bitbucket",pr_url:j.links?.html?.href,pr_id:j.id,status:"ok"};
}

async function viaGitea({repo,branch,base="main",title,body}){
  const token=process.env.GITEA_TOKEN;
  const baseUrl=process.env.GITEA_URL||"https://gitea.com";
  const r=await fetch(`${baseUrl}/api/v1/repos/${repo}/pulls`,{
    method:"POST",
    headers:{Authorization:`token ${token}`,"Content-Type":"application/json"},
    body:toJSON({head:branch,base,title,body})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`Gitea PR HTTP ${r.status}`);
  return {provider:"gitea",pr_url:j.html_url,pr_id:j.number,status:"ok"};
}

// -------- MAIN ENTRY --------
export async function run({input={},emit}){
  const provider=detectProvider();
  const {repo,branch,title}=input;
  if(!repo||!branch||!title){
    emitErr(emit,"repo_pr_create: repo, branch, and title required");
    return {data:{error:"missing_fields"}};
  }

  if(DRY_RUN){
    emitNote(emit,`repo_pr_create[DRY_RUN]: provider=${provider}`);
    return {data:{provider,status:"dry-run"}};
  }

  if(DEMO){
    emitNote(emit,"repo_pr_create[DEMO]: returning mock PR URL");
    return {
      data:{
        provider:"demo",
        pr_url:`https://github.com/${repo}/pull/123`,
        pr_id:123,
        mock:true,
        status:"ok"
      },
      status:"ok"
    };
  }

  emitNote(emit,`repo_pr_create: via ${provider}`);
  try{
    let out;
    switch(provider){
      case "github": out=await viaGitHub(input);break;
      case "gitlab": out=await viaGitLab(input);break;
      case "bitbucket": out=await viaBitbucket(input);break;
      case "gitea": out=await viaGitea(input);break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return {data:out,status:"ok"};
  }catch(e){
    const err=String(e?.message||e);
    emitErr(emit,`repo_pr_create failed: ${err}`);
    return {data:{provider,error:err,status:"error"}};
  }
}
