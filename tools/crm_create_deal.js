// tools/crm_create_deal.js
// UNIVERSAL CRM DEAL / OPPORTUNITY CREATOR
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
//     title: string,                // required
//     amount?: number,              // optional deal value
//     stage?: string,               // optional stage name
//     contactId?: string,           // optional linked contact
//     orgId?: string,               // optional organization ID
//     pipelineId?: string           // optional pipeline
//   }
//
// Output:
//   { data: { provider, id?: string|null, link?: string, status?: string } }

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
async function viaHubSpot({ title, amount, stage, contactId }) {
  const key = process.env.HUBSPOT_ACCESS_TOKEN || process.env.HUBSPOT_API_KEY;
  if (!key) throw new Error("Missing HubSpot credentials");
  const r = await fetch("https://api.hubapi.com/crm/v3/objects/deals", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: toJSON({
      properties: {
        dealname: title,
        amount: amount || null,
        dealstage: stage || "appointmentscheduled",
      },
      associations: contactId ? [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }] }] : [],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `HubSpot HTTP ${r.status}`);
  return { id: j.id, link: `https://app.hubspot.com/contacts/${j.portalId}/deal/${j.id}`, status: "created" };
}

// -------------- SALESFORCE --------------
async function viaSalesforce({ title, amount, stage }) {
  const token = process.env.SALESFORCE_ACCESS_TOKEN;
  const instance = process.env.SALESFORCE_INSTANCE_URL;
  if (!token || !instance) throw new Error("Missing Salesforce credentials");
  const r = await fetch(`${instance}/services/data/v59.0/sobjects/Opportunity/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: toJSON({ Name: title, Amount: amount || 0, StageName: stage || "Prospecting", CloseDate: new Date().toISOString().slice(0,10) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Salesforce HTTP ${r.status}`);
  return { id: j.id, link: `${instance}/${j.id}`, status: "created" };
}

// -------------- PIPEDRIVE --------------
async function viaPipedrive({ title, amount, stage, contactId, orgId, pipelineId }) {
  const key = process.env.PIPEDRIVE_API_KEY;
  if (!key) throw new Error("Missing Pipedrive API key");
  const body = { title, value: amount || 0, person_id: contactId, org_id: orgId, pipeline_id: pipelineId };
  const r = await fetch(`https://api.pipedrive.com/v1/deals?api_token=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Pipedrive HTTP ${r.status}`);
  return { id: j.data?.id, link: `https://app.pipedrive.com/deal/${j.data?.id}`, status: "created" };
}

// -------------- ZOHO CRM --------------
async function viaZoho({ title, amount, stage }) {
  const token = process.env.ZOHO_ACCESS_TOKEN;
  if (!token) throw new Error("Missing Zoho CRM access token");
  const body = { data: [{ Deal_Name: title, Amount: amount || 0, Stage: stage || "Qualification" }] };
  const r = await fetch("https://www.zohoapis.com/crm/v2/Deals", {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Zoho CRM HTTP ${r.status}`);
  const id = j.data?.[0]?.details?.id;
  return { id, link: `https://crm.zoho.com/crm/org/${id}`, status: "created" };
}

// -------------- CLOSE.COM --------------
async function viaClose({ title, amount, contactId }) {
  const key = process.env.CLOSE_API_KEY;
  if (!key) throw new Error("Missing Close API key");
  const body = { name: title, value: amount || 0, contact_id: contactId };
  const r = await fetch("https://api.close.com/api/v1/opportunity/", {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(key + ":").toString("base64")}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Close.com HTTP ${r.status}`);
  return { id: j.id, link: `https://app.close.com/opportunity/${j.id}`, status: "created" };
}

// -------------- FRESHSALES --------------
async function viaFreshsales({ title, amount }) {
  const key = process.env.FRESHSALES_API_KEY;
  const domain = process.env.FRESHSALES_DOMAIN;
  if (!key || !domain) throw new Error("Missing Freshsales credentials");
  const r = await fetch(`https://${domain}.freshsales.io/api/deals`, {
    method: "POST",
    headers: { Authorization: `Token token=${key}`, "Content-Type": "application/json" },
    body: toJSON({ deal: { name: title, amount: amount || 0 } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Freshsales HTTP ${r.status}`);
  return { id: j.deal?.id, link: `https://${domain}.freshsales.io/deals/${j.deal?.id}`, status: "created" };
}

// -------------- COPPER --------------
async function viaCopper({ title, amount, stage }) {
  const key = process.env.COPPER_API_KEY;
  const email = process.env.COPPER_EMAIL;
  if (!key || !email) throw new Error("Missing Copper credentials");
  const body = { name: title, monetary_value: amount || 0, pipeline_stage_id: stage || null };
  const r = await fetch(`https://api.prosperworks.com/developer_api/v1/opportunities`, {
    method: "POST",
    headers: { "X-PW-AccessToken": key, "X-PW-Application": "developer_api", "X-PW-UserEmail": email, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Copper HTTP ${r.status}`);
  return { id: j.id, link: `https://app.copper.com/opportunity/${j.id}`, status: "created" };
}

// -------------- MAIN ENTRY --------------
export async function run({ input = {}, emit }) {
  const provider = detectProvider();
  const { title } = input;
  if (!title) {
    emitErr(emit, "crm_create_deal: title is required");
    return { data: { error: "missing_title" } };
  }

  if (DRY_RUN) {
    emitNote(emit, `crm_create_deal[DRY_RUN]: provider=${provider || "n/a"} title=${title}`);
    return { data: { provider: provider || "dry-run", status: "dry-run" } };
  }

  if (!provider) {
    if (DEMO) {
      emitNote(emit, "crm_create_deal[DEMO]: returning mock deal");
      const fake = "deal_" + Math.random().toString(36).slice(2, 9);
      return {
        data: { provider: "demo", id: fake, link: `about:blank#demo-deal-${fake}`, status: "created" },
        link: `about:blank#demo-deal-${fake}`,
      };
    }
    emitErr(emit, "crm_create_deal: no provider configured.");
    return { data: { error: "no_provider_configured" } };
  }

  emitNote(emit, `crm_create_deal: via ${provider}`);
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
    return { data: { provider, id: out?.id || null, link: out?.link, status: out?.status || "created" }, link: out?.link };
  } catch (e) {
    const err = String(e?.message || e);
    emitErr(emit, `crm_create_deal failed: ${err}`);
    return { data: { error: err, provider } };
  }
}
