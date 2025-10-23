// tools/crm_log_activity.js
// UNIVERSAL CRM ACTIVITY / TASK LOGGER
// (HubSpot, Salesforce, Pipedrive, Zoho CRM, Close.com, Freshsales, Copper) + Demo
// ---------------------------------------------------------------------------------
//
// Auto-detected providers (first match wins; or force with CRM_PROVIDER):
//   • HubSpot       → HUBSPOT_API_KEY or HUBSPOT_ACCESS_TOKEN
//   • Salesforce    → SALESFORCE_ACCESS_TOKEN
//   • Pipedrive     → PIPEDRIVE_API_KEY
//   • Zoho CRM      → ZOHO_ACCESS_TOKEN
//   • Close.com     → CLOSE_API_KEY
//   • Freshsales    → FRESHSALES_API_KEY + FRESHSALES_DOMAIN
//   • Copper CRM    → COPPER_API_KEY + COPPER_EMAIL
//
// Common env:
//   CRM_PROVIDER  = "hubspot"|"salesforce"|"pipedrive"|"zoho"|"close"|"freshsales"|"copper"
//   CRM_DRY_RUN   = "1"
//   CRM_DEMO      = "1"
//
// Input:
//   {
//     type: string,           // e.g., "call", "email", "note", "meeting"
//     subject?: string,       // e.g., "Follow-up call"
//     description?: string,   // optional text body
//     contactId?: string,     // optional linked contact
//     dealId?: string,        // optional linked deal
//     timestamp?: string      // optional ISO date
//   }
//
// Output:
//   { data: { provider, id?: string|null, status?: string, link?: string } }

const DRY_RUN = String(process.env.CRM_DRY_RUN || "") === "1";
const DEMO = String(process.env.CRM_DEMO || "") === "1";

function detectProvider() {
  const forced = (process.env.CRM_PROVIDER || "").toLowerCase().trim();
  if (forced) return forced;
  if (process.env.HUBSPOT_API_KEY || process.env.HUBSPOT_ACCESS_TOKEN) return "hubspot";
  if (process.env.SALESFORCE_ACCESS_TOKEN) return "salesforce";
  if (process.env.PIPEDRIVE_API_KEY) return "pipedrive";
  if (process.env.ZOHO_ACCESS_TOKEN) return "zoho";
  if (process.env.CLOSE_API_KEY) return "close";
  if (process.env.FRESHSALES_API_KEY && process.env.FRESHSALES_DOMAIN) return "freshsales";
  if (process.env.COPPER_API_KEY && process.env.COPPER_EMAIL) return "copper";
  return null;
}

function emitNote(emit,msg){try{emit&&emit({type:"note",msg});}catch{}}
function emitErr(emit,msg){try{emit&&emit({type:"error",msg});}catch{}}
function toJSON(o){return JSON.stringify(o,null,2);}

// -------------- HUBSPOT --------------
async function viaHubSpot({ type, subject, description, contactId }) {
  const key = process.env.HUBSPOT_ACCESS_TOKEN || process.env.HUBSPOT_API_KEY;
  if (!key) throw new Error("Missing HubSpot credentials");
  const activityType = {
    call: "CALL",
    email: "EMAIL",
    meeting: "MEETING",
    note: "NOTE",
  }[type.toLowerCase()] || "NOTE";
  const r = await fetch("https://api.hubapi.com/crm/v3/objects/engagements", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: toJSON({
      properties: {
        hs_timestamp: new Date().toISOString(),
        hs_engagement_type: activityType,
        hs_note_body: description || "",
        hs_subject: subject || type,
      },
      associations: contactId ? [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 4 }] }] : [],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `HubSpot HTTP ${r.status}`);
  return { id: j.id, link: `https://app.hubspot.com/activities/${j.id}`, status: "logged" };
}

// -------------- SALESFORCE --------------
async function viaSalesforce({ type, subject, description, contactId, dealId, timestamp }) {
  const token = process.env.SALESFORCE_ACCESS_TOKEN;
  const instance = process.env.SALESFORCE_INSTANCE_URL;
  if (!token || !instance) throw new Error("Missing Salesforce credentials");
  const body = {
    Subject: subject || type,
    Description: description || "",
    ActivityDate: (timestamp || new Date().toISOString()).slice(0, 10),
    WhoId: contactId || null,
    WhatId: dealId || null,
    Status: "Completed",
  };
  const r = await fetch(`${instance}/services/data/v59.0/sobjects/Task/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Salesforce HTTP ${r.status}`);
  return { id: j.id, link: `${instance}/${j.id}`, status: "logged" };
}

// -------------- PIPEDRIVE --------------
async function viaPipedrive({ type, subject, description, contactId, dealId }) {
  const key = process.env.PIPEDRIVE_API_KEY;
  if (!key) throw new Error("Missing Pipedrive API key");
  const body = {
    subject: subject || type,
    type: type || "note",
    deal_id: dealId,
    person_id: contactId,
    note: description || "",
  };
  const r = await fetch(`https://api.pipedrive.com/v1/activities?api_token=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Pipedrive HTTP ${r.status}`);
  return { id: j.data?.id, link: `https://app.pipedrive.com/activity/${j.data?.id}`, status: "logged" };
}

// -------------- ZOHO CRM --------------
async function viaZoho({ type, subject, description }) {
  const token = process.env.ZOHO_ACCESS_TOKEN;
  if (!token) throw new Error("Missing Zoho CRM token");
  const body = { data: [{ Subject: subject || type, Description: description || "", Activity_Type: type || "Note" }] };
  const r = await fetch("https://www.zohoapis.com/crm/v2/Tasks", {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Zoho CRM HTTP ${r.status}`);
  return { id: j.data?.[0]?.details?.id, link: `https://crm.zoho.com/crm/org/tasks/${j.data?.[0]?.details?.id}`, status: "logged" };
}

// -------------- CLOSE.COM --------------
async function viaClose({ type, subject, description, contactId }) {
  const key = process.env.CLOSE_API_KEY;
  if (!key) throw new Error("Missing Close API key");
  const r = await fetch("https://api.close.com/api/v1/activity/note/", {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(key + ":").toString("base64")}`, "Content-Type": "application/json" },
    body: toJSON({ lead_id: contactId, note: `${subject || type}\n\n${description || ""}` }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Close.com HTTP ${r.status}`);
  return { id: j.id, link: `https://app.close.com/activity/${j.id}`, status: "logged" };
}

// -------------- FRESHSALES --------------
async function viaFreshsales({ type, subject, description }) {
  const key = process.env.FRESHSALES_API_KEY;
  const domain = process.env.FRESHSALES_DOMAIN;
  if (!key || !domain) throw new Error("Missing Freshsales credentials");
  const body = { note: { title: subject || type, description: description || "" } };
  const r = await fetch(`https://${domain}.freshsales.io/api/notes`, {
    method: "POST",
    headers: { Authorization: `Token token=${key}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Freshsales HTTP ${r.status}`);
  return { id: j.note?.id, link: `https://${domain}.freshsales.io/notes/${j.note?.id}`, status: "logged" };
}

// -------------- COPPER --------------
async function viaCopper({ type, subject, description, contactId }) {
  const key = process.env.COPPER_API_KEY;
  const email = process.env.COPPER_EMAIL;
  if (!key || !email) throw new Error("Missing Copper credentials");
  const body = { parent: { type: "person", id: contactId }, type: type || "note", text: `${subject || type}\n\n${description || ""}` };
  const r = await fetch(`https://api.prosperworks.com/developer_api/v1/activities`, {
    method: "POST",
    headers: { "X-PW-AccessToken": key, "X-PW-Application": "developer_api", "X-PW-UserEmail": email, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Copper HTTP ${r.status}`);
  return { id: j.id, link: `https://app.copper.com/activity/${j.id}`, status: "logged" };
}

// -------------- MAIN ENTRY --------------
export async function run({ input = {}, emit }) {
  const provider = detectProvider();
  const { type } = input;
  if (!type) {
    emitErr(emit, "crm_log_activity: type is required");
    return { data: { error: "missing_type" } };
  }

  if (DRY_RUN) {
    emitNote(emit, `crm_log_activity[DRY_RUN]: provider=${provider || "n/a"} type=${type}`);
    return { data: { provider: provider || "dry-run", status: "dry-run" } };
  }

  if (!provider) {
    if (DEMO) {
      const fake = "activity_" + Math.random().toString(36).slice(2, 9);
      emitNote(emit, "crm_log_activity[DEMO]: returning mock log");
      return {
        data: { provider: "demo", id: fake, status: "logged", link: `about:blank#demo-activity-${fake}` },
        link: `about:blank#demo-activity-${fake}`,
      };
    }
    emitErr(emit, "crm_log_activity: no provider configured.");
    return { data: { error: "no_provider_configured" } };
  }

  emitNote(emit, `crm_log_activity: via ${provider}`);
  try {
    let out;
    switch (provider) {
      case "hubspot": out = await viaHubSpot(input); break;
      case "salesforce": out = await viaSalesforce(input); break;
      case "pipedrive": out = await viaPipedrive(input); break;
      case "zoho": out = await viaZoho(input); break;
      case "close": out = await viaClose(input); break;
      case "freshsales": out = await viaFreshsales(input); break;
      case "copper": out = await viaCopper(input); break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return { data: { provider, id: out?.id, link: out?.link, status: out?.status || "logged" }, link: out?.link };
  } catch (e) {
    const err = String(e?.message || e);
    emitErr(emit, `crm_log_activity failed: ${err}`);
    return { data: { error: err, provider } };
  }
}
