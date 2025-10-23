// tools/tasks_create.js
// UNIVERSAL TASK CREATOR (ClickUp, Asana, Notion, Monday, Trello, Jira, Linear, HubSpot, Todoist, Google Tasks) + Demo
// -------------------------------------------------------------------------------------------------------------------
//
// Auto-detected providers (first match wins; or force with TASK_PROVIDER):
//   • ClickUp     → CLICKUP_API_KEY
//   • Asana       → ASANA_ACCESS_TOKEN
//   • Notion      → NOTION_API_KEY + NOTION_DB_TASKS_ID
//   • Monday.com  → MONDAY_API_TOKEN
//   • Trello      → TRELLO_KEY + TRELLO_TOKEN + TRELLO_LIST_ID
//   • Jira        → JIRA_API_TOKEN + JIRA_EMAIL + JIRA_BASE_URL
//   • Linear      → LINEAR_API_KEY
//   • HubSpot     → HUBSPOT_API_KEY
//   • Todoist     → TODOIST_API_TOKEN
//   • Google Tasks→ GOOGLE_ACCESS_TOKEN
//
// Common env:
//   TASK_PROVIDER  = "clickup"|"asana"|"notion"|"monday"|"trello"|"jira"|"linear"|"hubspot"|"todoist"|"google"
//   TASK_DRY_RUN   = "1"
//   TASK_DEMO      = "1"
//
// Input:
//   {
//     title: string,           // required
//     description?: string,    // optional
//     dueDate?: string,        // optional (ISO string)
//     assignee?: string,       // optional user email or ID
//     priority?: string,       // optional (low|medium|high|urgent)
//   }
//
// Output:
//   { data: { provider, id?: string|null, link?: string, status }, link?: string }

const DRY_RUN = String(process.env.TASK_DRY_RUN || "") === "1";
const DEMO = String(process.env.TASK_DEMO || "") === "1";

function emitNote(emit,msg){try{emit&&emit({type:"note",msg});}catch{}}
function emitErr(emit,msg){try{emit&&emit({type:"error",msg});}catch{}}
function toJSON(o){return JSON.stringify(o,null,2);}

function detectProvider(){
  const forced=(process.env.TASK_PROVIDER||"").toLowerCase().trim();
  if(forced) return forced;
  if(process.env.CLICKUP_API_KEY) return "clickup";
  if(process.env.ASANA_ACCESS_TOKEN) return "asana";
  if(process.env.NOTION_API_KEY) return "notion";
  if(process.env.MONDAY_API_TOKEN) return "monday";
  if(process.env.TRELLO_KEY) return "trello";
  if(process.env.JIRA_API_TOKEN) return "jira";
  if(process.env.LINEAR_API_KEY) return "linear";
  if(process.env.HUBSPOT_API_KEY) return "hubspot";
  if(process.env.TODOIST_API_TOKEN) return "todoist";
  if(process.env.GOOGLE_ACCESS_TOKEN) return "google";
  return null;
}

// -------- PROVIDERS --------
async function viaClickUp({title,description,dueDate,priority}){
  const key=process.env.CLICKUP_API_KEY;
  const listId=process.env.CLICKUP_LIST_ID;
  const body={name:title,description,due_date:dueDate?Date.parse(dueDate):undefined,priority};
  const r=await fetch(`https://api.clickup.com/api/v2/list/${listId}/task`,{
    method:"POST",
    headers:{Authorization:key,"Content-Type":"application/json"},
    body:toJSON(body)
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.err||`ClickUp HTTP ${r.status}`);
  return {id:j.id,link:`https://app.clickup.com/t/${j.id}`,status:"created"};
}

async function viaAsana({title,description,dueDate,assignee}){
  const key=process.env.ASANA_ACCESS_TOKEN;
  const workspace=process.env.ASANA_WORKSPACE_ID;
  const body={data:{name:title,notes:description,assignee,due_on:dueDate,workspace}};
  const r=await fetch("https://app.asana.com/api/1.0/tasks",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON(body)
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.errors?.[0]?.message||`Asana HTTP ${r.status}`);
  return {id:j.data?.gid,link:`https://app.asana.com/0/${workspace}/${j.data?.gid}`,status:"created"};
}

async function viaNotion({title,description,dueDate}){
  const key=process.env.NOTION_API_KEY;
  const db=process.env.NOTION_DB_TASKS_ID;
  const r=await fetch("https://api.notion.com/v1/pages",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Notion-Version":"2022-06-28","Content-Type":"application/json"},
    body:toJSON({
      parent:{database_id:db},
      properties:{
        Name:{title:[{text:{content:title}}]},
        Description:description?{rich_text:[{text:{content:description}}]}:undefined,
        Due:dueDate?{date:{start:dueDate}}:undefined
      }
    })
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`Notion HTTP ${r.status}`);
  return {id:j.id,link:`https://notion.so/${j.id.replace(/-/g,"")}`,status:"created"};
}

async function viaMonday({title,description,assignee,priority}){
  const key=process.env.MONDAY_API_TOKEN;
  const board=process.env.MONDAY_BOARD_ID;
  const q=`mutation { create_item (board_id:${board}, item_name:"${title}", column_values:"{\\"text\\":\\"${description||""}\\",\\"person\\":\\"${assignee||""}\\",\\"priority\\":\\"${priority||"Medium"}\\"}") { id } }`;
  const r=await fetch("https://api.monday.com/v2",{
    method:"POST",
    headers:{Authorization:key,"Content-Type":"application/json"},
    body:toJSON({query:q})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`Monday HTTP ${r.status}`);
  return {id:j.data?.create_item?.id,link:`https://monday.com/board/${board}`,status:"created"};
}

async function viaTrello({title,description,dueDate}){
  const key=process.env.TRELLO_KEY;
  const token=process.env.TRELLO_TOKEN;
  const list=process.env.TRELLO_LIST_ID;
  const r=await fetch(`https://api.trello.com/1/cards?idList=${list}&key=${key}&token=${token}&name=${encodeURIComponent(title)}&desc=${encodeURIComponent(description||"")}&due=${encodeURIComponent(dueDate||"")}`);
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`Trello HTTP ${r.status}`);
  return {id:j.id,link:j.url,status:"created"};
}

async function viaJira({title,description,priority}){
  const base=process.env.JIRA_BASE_URL;
  const email=process.env.JIRA_EMAIL;
  const token=process.env.JIRA_API_TOKEN;
  const project=process.env.JIRA_PROJECT_KEY;
  const r=await fetch(`${base}/rest/api/3/issue`,{
    method:"POST",
    headers:{Authorization:`Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,"Content-Type":"application/json"},
    body:toJSON({fields:{project:{key:project},summary:title,description,priority:{name:priority||"Medium"},issuetype:{name:"Task"}}})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.errors?.summary||`Jira HTTP ${r.status}`);
  return {id:j.key,link:`${base}/browse/${j.key}`,status:"created"};
}

async function viaLinear({title,description}){
  const key=process.env.LINEAR_API_KEY;
  const team=process.env.LINEAR_TEAM_ID;
  const r=await fetch("https://api.linear.app/graphql",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({query:`mutation { issueCreate(input:{title:"${title}",description:"${description||""}",teamId:"${team}"}) { issue { id identifier } } }`})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.errors?.[0]?.message||`Linear HTTP ${r.status}`);
  return {id:j.data?.issueCreate?.issue?.identifier,link:`https://linear.app/issue/${j.data?.issueCreate?.issue?.identifier}`,status:"created"};
}

async function viaHubSpot({title,description,dueDate}){
  const key=process.env.HUBSPOT_API_KEY;
  const r=await fetch("https://api.hubapi.com/crm/v3/objects/tasks",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({properties:{hs_task_body:description,hs_task_subject:title,hs_timestamp:dueDate}})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`HubSpot HTTP ${r.status}`);
  return {id:j.id,link:`https://app.hubspot.com/tasks/${j.id}`,status:"created"};
}

async function viaTodoist({title,description,dueDate,priority}){
  const token=process.env.TODOIST_API_TOKEN;
  const r=await fetch("https://api.todoist.com/rest/v2/tasks",{
    method:"POST",
    headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
    body:toJSON({content:title,description,due_datetime:dueDate,priority})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`Todoist HTTP ${r.status}`);
  return {id:j.id,link:`https://todoist.com/showTask?id=${j.id}`,status:"created"};
}

async function viaGoogle({title,description,dueDate}){
  const token=process.env.GOOGLE_ACCESS_TOKEN;
  const tasklist=process.env.GOOGLE_TASKS_LIST_ID;
  const r=await fetch(`https://tasks.googleapis.com/tasks/v1/lists/${tasklist}/tasks`,{
    method:"POST",
    headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
    body:toJSON({title,notes:description,due:dueDate})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Google Tasks HTTP ${r.status}`);
  return {id:j.id,link:j.selfLink,status:"created"};
}

// -------- MAIN ENTRY --------
export async function run({input={},emit}){
  const provider=detectProvider();
  const {title}=input;
  if(!title){
    emitErr(emit,"tasks_create: title required");
    return {data:{error:"missing_title"}};
  }

  if(DRY_RUN){
    emitNote(emit,`tasks_create[DRY_RUN]: provider=${provider}`);
    return {data:{provider,status:"dry-run"}};
  }

  if(DEMO){
    emitNote(emit,"tasks_create[DEMO]: returning mock task");
    const fake="tsk_"+Math.random().toString(36).slice(2,9);
    return {data:{provider:"demo",id:fake,link:`about:blank#demo-task-${fake}`,status:"created"}};
  }

  emitNote(emit,`tasks_create: via ${provider}`);
  try{
    let out;
    switch(provider){
      case "clickup": out=await viaClickUp(input);break;
      case "asana": out=await viaAsana(input);break;
      case "notion": out=await viaNotion(input);break;
      case "monday": out=await viaMonday(input);break;
      case "trello": out=await viaTrello(input);break;
      case "jira": out=await viaJira(input);break;
      case "linear": out=await viaLinear(input);break;
      case "hubspot": out=await viaHubSpot(input);break;
      case "todoist": out=await viaTodoist(input);break;
      case "google": out=await viaGoogle(input);break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return {data:{provider,id:out?.id,link:out?.link,status:out?.status||"created"},link:out?.link};
  }catch(e){
    const err=String(e?.message||e);
    emitErr(emit,`tasks_create failed: ${err}`);
    return {data:{provider,error:err,status:"error"}};
  }
}
