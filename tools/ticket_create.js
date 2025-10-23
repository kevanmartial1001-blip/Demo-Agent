// tools/ticket_create.js
// UNIVERSAL TICKET CREATOR (Zendesk, Freshdesk, HubSpot, Intercom, Zoho Desk, Front, HelpScout, Crisp, Groove, Gmail) + Demo
// ------------------------------------------------------------------------------------------------------------------------
//
// Auto-detected providers (first match wins; or force with TICKET_PROVIDER):
//   • Zendesk        → ZENDESK_SUBDOMAIN + ZENDESK_EMAIL + ZENDESK_API_TOKEN
//   • Freshdesk      → FRESHDESK_DOMAIN + FRESHDESK_API_KEY
//   • HubSpot        → HUBSPOT_API_KEY
//   • Intercom       → INTERCOM_ACCESS_TOKEN
//   • Zoho Desk      → ZOHO_DESK_ORG_ID + ZOHO_ACCESS_TOKEN
//   • Front          → FRONT_API_TOKEN
//   • HelpScout      → HELPSCOUT_API_KEY
//   • Crisp          → CRISP_IDENTIFIER + CRISP_KEY
//   • Groove         → GROOVE_API_KEY
//   • Gmail fallback → GMAIL_SERVICE_EMAIL + GMAIL_API_KEY
//
// Common env:
//   TICKET_PROVIDER   = "zendesk"|"freshdesk"|"hubspot"|"intercom"|"zoho"|"front"|"helpscout"|"crisp"|"groove"|"gmail"
//   TICKET_DRY_RUN    = "1"
//   TICKET_DEMO       = "1"
//
// Input:
//   {
//     subject: string,           // required
//     description?: string,      // optional
//     priority?: string,         // "low"|"medium"|"high"|"urgent"
//     requester?: { name?: string, email?: string },
//     tags?: string[],           // optional
//   }
//
// Output:
//   { data: { provider, id?: string|null, link?: string, status }, link?: string }

const DRY_RUN = String(process.env.TICKET_DRY_RUN || "") === "1";
const DEMO = String(process.env.TICKET_DEMO || "") === "1";

function emitNote(emit,msg){try{emit&&emit({type:"note",msg});}catch{}}
function emitErr(emit,msg){try{emit&&emit({type:"error",msg});}catch{}}
function toJSON(o){return JSON.stringify(o,null,2);}

function detectProvider(){
  const forced=(process.env.TICKET_PROVIDER||"").toLowerCase().trim();
  if(forced) return forced;
  if(process.env.ZENDESK_SUBDOMAIN) return "zendesk";
  if(process.env.FRESHDESK_DOMAIN) return "freshdesk";
  if(process.env.HUBSPOT_API_KEY) return "hubspot";
  if(process.env.INTERCOM_ACCESS_TOKEN) return "intercom";
  if(process.env.ZOHO_DESK_ORG_ID) return "zoho";
  if(process.env.FRONT_API_TOKEN) return "front";
  if(process.env.HELPSCOUT_API_KEY) return "helpscout";
  if(process.env.CRISP_IDENTIFIER) return "crisp";
  if(process.env.GROOVE_API_KEY) return "groove";
  if(process.env.GMAIL_SERVICE_EMAIL) return "gmail";
  return null;
}

// -------- PROVIDERS --------
async function viaZendesk({subject,description,priority,requester,tags}){
  const sub=process.env.ZENDESK_SUBDOMAIN;
  const email=process.env.ZENDESK_EMAIL;
  const token=process.env.ZENDESK_API_TOKEN;
  const r=await fetch(`https://${sub}.zendesk.com/api/v2/tickets.json`,{
    method:"POST",
    headers:{
      Authorization:`Basic ${Buffer.from(`${email}/token:${token}`).toString("base64")}`,
      "Content-Type":"application/json"
    },
    body:toJSON({ticket:{subject,comment:{body:description},priority,requester,tags}})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`Zendesk HTTP ${r.status}`);
  return {id:j.ticket?.id,link:`https://${sub}.zendesk.com/agent/tickets/${j.ticket?.id}`,status:"created"};
}

async function viaFreshdesk({subject,description,priority,requester,tags}){
  const domain=process.env.FRESHDESK_DOMAIN;
  const key=process.env.FRESHDESK_API_KEY;
  const r=await fetch(`https://${domain}.freshdesk.com/api/v2/tickets`,{
    method:"POST",
    headers:{
      Authorization:`Basic ${Buffer.from(`${key}:X`).toString("base64")}`,
      "Content-Type":"application/json"
    },
    body:toJSON({subject,description,priority,requester,tags})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`Freshdesk HTTP ${r.status}`);
  return {id:j.id,link:`https://${domain}.freshdesk.com/a/tickets/${j.id}`,status:"created"};
}

async function viaHubSpot({subject,description,priority,requester}){
  const key=process.env.HUBSPOT_API_KEY;
  const r=await fetch("https://api.hubapi.com/crm/v3/objects/tickets",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({properties:{
      subject,content:description,hs_pipeline_stage:"open",hs_ticket_priority:priority,hs_ticket_source:"AI Assistant"
    }})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`HubSpot HTTP ${r.status}`);
  return {id:j.id,link:`https://app.hubspot.com/contacts/${j.portalId}/ticket/${j.id}`,status:"created"};
}

async function viaIntercom({subject,description,requester}){
  const token=process.env.INTERCOM_ACCESS_TOKEN;
  const r=await fetch("https://api.intercom.io/conversations",{
    method:"POST",
    headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
    body:toJSON({from:{type:"user",email:requester?.email},body:`${subject}\n\n${description}`})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`Intercom HTTP ${r.status}`);
  return {id:j.id,link:`https://app.intercom.com/a/apps/${j.app?.id}/inbox/conversation/${j.id}`,status:"created"};
}

async function viaZoho({subject,description,priority,requester}){
  const org=process.env.ZOHO_DESK_ORG_ID;
  const token=process.env.ZOHO_ACCESS_TOKEN;
  const r=await fetch("https://desk.zoho.com/api/v1/tickets",{
    method:"POST",
    headers:{Authorization:`Zoho-oauthtoken ${token}`,"orgId":org,"Content-Type":"application/json"},
    body:toJSON({subject,description,priority,email:requester?.email})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`Zoho HTTP ${r.status}`);
  return {id:j.id,link:`https://desk.zoho.com/support/tickets/${j.id}`,status:"created"};
}

async function viaFront({subject,description,requester}){
  const token=process.env.FRONT_API_TOKEN;
  const r=await fetch("https://api2.frontapp.com/conversations",{
    method:"POST",
    headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
    body:toJSON({subject,body:description,contacts:[requester?.email]})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`Front HTTP ${r.status}`);
  return {id:j.id,link:`https://app.frontapp.com/open/${j.id}`,status:"created"};
}

async function viaHelpScout({subject,description,requester}){
  const key=process.env.HELPSCOUT_API_KEY;
  const r=await fetch("https://api.helpscout.net/v2/conversations",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({type:"email",subject,customer:{email:requester?.email},threads:[{type:"customer",body:description}]})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`HelpScout HTTP ${r.status}`);
  return {id:j.id,link:`https://secure.helpscout.net/conversation/${j.id}`,status:"created"};
}

async function viaCrisp({subject,description,requester}){
  const id=process.env.CRISP_IDENTIFIER;
  const key=process.env.CRISP_KEY;
  const r=await fetch(`https://api.crisp.chat/v1/website/${id}/conversations`,{
    method:"POST",
    headers:{Authorization:`Basic ${Buffer.from(`${id}:${key}`).toString("base64")}`,"Content-Type":"application/json"},
    body:toJSON({segments:["support"],email:requester?.email,subject,message:description})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`Crisp HTTP ${r.status}`);
  return {id:j.data?.session_id,link:`https://app.crisp.chat/conversation/${j.data?.session_id}`,status:"created"};
}

async function viaGroove({subject,description,requester}){
  const key=process.env.GROOVE_API_KEY;
  const r=await fetch("https://api.groovehq.com/v1/tickets",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({state:"open",assigned_group:"Support",from:{email:requester?.email},subject,body:description})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`Groove HTTP ${r.status}`);
  return {id:j.ticket?.number,link:`https://app.groovehq.com/tickets/${j.ticket?.number}`,status:"created"};
}

async function viaGmail({subject,description,requester}){
  const email=process.env.GMAIL_SERVICE_EMAIL;
  const key=process.env.GMAIL_API_KEY;
  const r=await fetch(`https://gmail.googleapis.com/gmail/v1/users/${email}/messages/send`,{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({raw:Buffer.from(`To: support@company.com\nSubject: ${subject}\n\n${description}`).toString("base64")})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Gmail HTTP ${r.status}`);
  return {id:j.id,link:`https://mail.google.com/mail/u/0/#inbox/${j.id}`,status:"created"};
}

// -------- MAIN ENTRY --------
export async function run({input={},emit}){
  const provider=detectProvider();
  const {subject}=input;
  if(!subject){
    emitErr(emit,"ticket_create: subject required");
    return {data:{error:"missing_subject"}};
  }

  if(DRY_RUN){
    emitNote(emit,`ticket_create[DRY_RUN]: provider=${provider}`);
    return {data:{provider,status:"dry-run"}};
  }

  if(DEMO){
    emitNote(emit,"ticket_create[DEMO]: returning mock ticket");
    const fake="tkt_"+Math.random().toString(36).slice(2,9);
    return {data:{provider:"demo",id:fake,link:`about:blank#demo-ticket-${fake}`,status:"created"}};
  }

  emitNote(emit,`ticket_create: via ${provider}`);
  try{
    let out;
    switch(provider){
      case "zendesk": out=await viaZendesk(input);break;
      case "freshdesk": out=await viaFreshdesk(input);break;
      case "hubspot": out=await viaHubSpot(input);break;
      case "intercom": out=await viaIntercom(input);break;
      case "zoho": out=await viaZoho(input);break;
      case "front": out=await viaFront(input);break;
      case "helpscout": out=await viaHelpScout(input);break;
      case "crisp": out=await viaCrisp(input);break;
      case "groove": out=await viaGroove(input);break;
      case "gmail": out=await viaGmail(input);break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return {data:{provider,id:out?.id,link:out?.link,status:out?.status||"created"},link:out?.link};
  }catch(e){
    const err=String(e?.message||e);
    emitErr(emit,`ticket_create failed: ${err}`);
    return {data:{provider,error:err,status:"error"}};
  }
}
