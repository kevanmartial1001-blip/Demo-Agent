// tools/calendar_create_event.js
// UNIVERSAL CALENDAR EVENT CREATOR (Google, Outlook, CalDAV, Cronofy, Nylas) + Demo
// -------------------------------------------------------------------------------
// Auto-detected providers (first match wins; or force with CAL_PROVIDER):
//   • Google Calendar     → GOOGLE_API_KEY, GOOGLE_ACCESS_TOKEN, or GOOGLE_SERVICE_ACCOUNT_JSON
//   • Microsoft Outlook   → MS_GRAPH_TOKEN or OAUTH_MS_TOKEN
//   • CalDAV              → CALDAV_URL, CALDAV_USERNAME, CALDAV_PASSWORD
//   • Cronofy             → CRONOFY_ACCESS_TOKEN
//   • Nylas               → NYLAS_ACCESS_TOKEN
//
// Common env:
//   CAL_PROVIDER   = "google"|"outlook"|"caldav"|"cronofy"|"nylas"
//   CAL_DRY_RUN    = "1"   // logs only
//   CAL_DEMO       = "1"   // mocked success when no provider
//
// Input:
//   {
//     title: string,               // meeting title
//     start: string|Date,          // ISO8601 or RFC3339
//     end: string|Date,            // ISO8601 or RFC3339
//     attendees?: string[],        // optional list of emails
//     description?: string,        // optional body text
//     location?: string,
//     timezone?: string,           // e.g., "Europe/Madrid"
//     conference?: boolean,        // request video link if possible
//   }
//
// Output:
//   { data: { provider, id?: string|null, htmlLink?: string, status?: string }, link?: string }
//
// Notes:
//   • Entirely HTTP-based, Edge-safe (no SDKs).
//   • Automatically adapts to whichever calendar tokens are configured per tenant.
//   • Demo mode returns a fake event link to show UI flow pre-integration.

const DRY_RUN = String(process.env.CAL_DRY_RUN || "") === "1";
const DEMO    = String(process.env.CAL_DEMO || "") === "1";

function detectProvider() {
  const forced = (process.env.CAL_PROVIDER || "").toLowerCase().trim();
  if (forced) return forced;
  if (process.env.GOOGLE_ACCESS_TOKEN || process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return "google";
  if (process.env.MS_GRAPH_TOKEN || process.env.OAUTH_MS_TOKEN) return "outlook";
  if (process.env.CALDAV_URL && process.env.CALDAV_USERNAME && process.env.CALDAV_PASSWORD) return "caldav";
  if (process.env.CRONOFY_ACCESS_TOKEN) return "cronofy";
  if (process.env.NYLAS_ACCESS_TOKEN) return "nylas";
  return null;
}

function emitNote(emit,msg){try{emit&&emit({type:"note",msg});}catch{}}
function emitErr(emit,msg){try{emit&&emit({type:"error",msg});}catch{}}
function toJSON(o){return JSON.stringify(o,null,2);}
function iso(x){return typeof x==="string"?x:new Date(x).toISOString();}

// -------------- GOOGLE CALENDAR --------------
async function viaGoogle({title,start,end,attendees,description,location,timezone,conference}) {
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  if(!token) throw new Error("Missing GOOGLE_ACCESS_TOKEN");
  const ev = {
    summary: title,
    description,
    location,
    start: { dateTime: iso(start), timeZone: timezone||"UTC" },
    end: { dateTime: iso(end), timeZone: timezone||"UTC" },
    attendees: (attendees||[]).map(e=>({email:e})),
  };
  if(conference) ev.conferenceData = { createRequest:{requestId:`req-${Date.now()}`}};
  const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1",{
    method:"POST",
    headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
    body:toJSON(ev)
  });
  const j = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Google Calendar HTTP ${r.status}`);
  return {id:j.id,htmlLink:j.htmlLink,status:j.status};
}

// -------------- OUTLOOK / MICROSOFT GRAPH --------------
async function viaOutlook({title,start,end,attendees,description,location,timezone,conference}) {
  const token = process.env.MS_GRAPH_TOKEN || process.env.OAUTH_MS_TOKEN;
  if(!token) throw new Error("Missing MS_GRAPH_TOKEN");
  const ev = {
    subject:title,
    body:{contentType:"HTML",content:description||""},
    start:{dateTime:iso(start),timeZone:timezone||"UTC"},
    end:{dateTime:iso(end),timeZone:timezone||"UTC"},
    location:{displayName:location||""},
    attendees:(attendees||[]).map(e=>({emailAddress:{address:e},type:"required"})),
    isOnlineMeeting:!!conference,
    onlineMeetingProvider: conference?"teamsForBusiness":undefined
  };
  const r = await fetch("https://graph.microsoft.com/v1.0/me/events",{
    method:"POST",
    headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
    body:toJSON(ev)
  });
  const j = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Outlook HTTP ${r.status}`);
  return {id:j.id,htmlLink:j.webLink,status:j.responseStatus?.response||"created"};
}

// -------------- CalDAV --------------
async function viaCalDAV({title,start,end,attendees,description,location,timezone}) {
  const url = process.env.CALDAV_URL;
  const user = process.env.CALDAV_USERNAME;
  const pass = process.env.CALDAV_PASSWORD;
  if(!url||!user||!pass) throw new Error("Missing CalDAV credentials");
  const id = "evt-"+Date.now();
  const ics =
`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//AI Factory//EN
BEGIN:VEVENT
UID:${id}
SUMMARY:${title}
DTSTART:${new Date(start).toISOString().replace(/[-:]/g,"").split(".")[0]}Z
DTEND:${new Date(end).toISOString().replace(/[-:]/g,"").split(".")[0]}Z
DESCRIPTION:${description||""}
LOCATION:${location||""}
END:VEVENT
END:VCALENDAR`;
  const r = await fetch(url,{
    method:"PUT",
    headers:{Authorization:"Basic "+Buffer.from(`${user}:${pass}`).toString("base64"),"Content-Type":"text/calendar"},
    body:ics
  });
  if(!r.ok) throw new Error(`CalDAV HTTP ${r.status}`);
  return {id,htmlLink:url,status:"created"};
}

// -------------- Cronofy --------------
async function viaCronofy({title,start,end,attendees,description,location,timezone}) {
  const token = process.env.CRONOFY_ACCESS_TOKEN;
  if(!token) throw new Error("Missing CRONOFY_ACCESS_TOKEN");
  const payload={event:{summary:title,description,location:{description:location||""},start:iso(start),end:iso(end),tzid:timezone||"UTC"}};
  const r = await fetch("https://api.cronofy.com/v1/calendars/user/events",{
    method:"POST",
    headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
    body:toJSON(payload)
  });
  const j = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Cronofy HTTP ${r.status}`);
  return {id:j.event?.event_id||null,htmlLink:j.event?.url,status:"created"};
}

// -------------- Nylas --------------
async function viaNylas({title,start,end,attendees,description,location}) {
  const token = process.env.NYLAS_ACCESS_TOKEN;
  if(!token) throw new Error("Missing NYLAS_ACCESS_TOKEN");
  const ev={title,when:{start_time:Math.floor(new Date(start).getTime()/1000),end_time:Math.floor(new Date(end).getTime()/1000)},
    participants:(attendees||[]).map(e=>({email:e})),location,description};
  const r=await fetch("https://api.nylas.com/events",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:toJSON(ev)});
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`Nylas HTTP ${r.status}`);
  return {id:j.id,htmlLink:j.htmlLink||j.browser_link,status:"created"};
}

// -------------- MAIN ENTRY --------------
export async function run({ input={}, emit }) {
  const provider = detectProvider();
  if (!input.start || !input.end || !input.title) {
    emitErr(emit,"calendar_create_event: title,start,end are required");
    return {data:{error:"missing_fields"}};
  }

  if (DRY_RUN) {
    emitNote(emit,`calendar_create_event[DRY_RUN]: provider=${provider||"n/a"} title=${input.title}`);
    return {data:{provider:provider||"dry-run",status:"dry-run"}};
  }

  if (!provider) {
    if (DEMO) {
      const fake="demo_"+Math.random().toString(36).slice(2,9);
      emitNote(emit,`calendar_create_event[DEMO]: no provider configured; returning fake`);
      return {data:{provider:"demo",id:fake,htmlLink:`about:blank#demo-event-${fake}`,status:"created"}};
    }
    emitErr(emit,"calendar_create_event: no calendar provider configured.");
    return {data:{error:"no_provider_configured"}};
  }

  emitNote(emit,`calendar_create_event: via ${provider} → ${input.title}`);
  try{
    let out;
    switch(provider){
      case "google": out=await viaGoogle(input); break;
      case "outlook": out=await viaOutlook(input); break;
      case "caldav": out=await viaCalDAV(input); break;
      case "cronofy": out=await viaCronofy(input); break;
      case "nylas": out=await viaNylas(input); break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return {data:{provider,id:out?.id||null,htmlLink:out?.htmlLink,status:out?.status||"created"},link:out?.htmlLink};
  }catch(e){
    const err=String(e?.message||e);
    emitErr(emit,`calendar_create_event failed: ${err}`);
    return {data:{error:err,provider}};
  }
}
