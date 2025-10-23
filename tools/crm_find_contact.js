// tools/crm_find_contact.js
// UNIVERSAL CRM CONTACT FINDER (HubSpot, Salesforce, Pipedrive, Zoho CRM, Close.com, Freshsales, Copper) + Demo
// ------------------------------------------------------------------------------------------------------------
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
//     query: string,                // required (email, phone, or name)
//     limit?: number                // optional max results
//   }
//
// Output:
//   { data: { provider, results: [...], status: string }, results: [...] }

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
async function viaHubSpot({ query, limit }) {
  const key = process.env.HUBSPOT_ACCESS_TOKEN || process.env.HUBSPOT_API_KEY;
  if (!key) throw new Error("Missing HubSpot credentials");
  const url = `https://api.hubapi.com/crm/v3/objects/contacts/search`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: toJSON({
      filterGroups: [{ filters: [{ propertyName: "email", operator: "CONTAINS_TOKEN", value: query }] }],
      limit: limit || 5,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `HubSpot HTTP ${r.status}`);
  return (j.results || []).map(c => ({
    id: c.id,
    name: c.properties.firstname + " " + c.properties.lastname,
    email: c.properties.email,
    phone: c.properties.phone,
  }));
}

// -------------- SALESFORCE --------------
async function viaSalesforce({ query, limit }) {
  const token = process.env.SALESFORCE_ACCESS_TOKEN;
  const instance = process.env.SALESFORCE_INSTANCE_URL;
  if (!token || !instance) throw new Error("Missing Salesforce credentials");
  const soql = `SELECT Id, Name, Email, Phone FROM Contact WHERE Name LIKE '%${query}%' LIMIT ${limit || 5}`;
  const r = await fetch(`${instance}/services/data/v59.0/query/?q=${encodeURIComponent(soql)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Salesforce HTTP ${r.status}`);
  return (j.records || []).map(c => ({
    id: c.Id,
    name: c.Name,
    email: c.Email,
    phone: c.Phone,
  }));
}

// -------------- PIPEDRIVE --------------
async function viaPipedrive({ query, limit }) {
  const key = process.env.PIPEDRIVE_API_KEY;
  if (!key) throw new Error("Missing Pipedrive API key");
  const url = `https://api.pipedrive.com/v1/persons/search?term=${encodeURIComponent(query)}&limit=${limit || 5}&api_token=${key}`;
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Pipedrive HTTP ${r.status}`);
  return (j.data?.items || []).map(i => ({
    id: i.item.id,
    name: i.item.name,
    email: i.item.emails?.[0],
    phone: i.item.phones?.[0],
  }));
}

// -------------- ZOHO CRM --------------
async function viaZoho({ query, limit }) {
  const token = process.env.ZOHO_ACCESS_TOKEN;
  if (!token) throw new Error("Missing Zoho CRM access token");
  const r = await fetch(`https://www.zohoapis.com/crm/v2/Contacts/search?word=${encodeURIComponent(query)}&per_page=${limit || 5}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Zoho CRM HTTP ${r.status}`);
  return (j.data || []).map(c => ({
    id: c.id,
    name: `${c.Full_Name || ""}`,
    email: c.Email,
    phone: c.Phone,
  }));
}

// -------------- CLOSE.COM --------------
async function viaClose({ query, limit }) {
  const key = process.env.CLOSE_API_KEY;
  if (!key) throw new Error("Missing Close API key");
  const r = await fetch(`https://api.close.com/api/v1/contact/?_limit=${limit || 5}&query=${encodeURIComponent(query)}`, {
    headers: { Authorization: `Basic ${Buffer.from(key + ":").toString("base64")}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Close.com HTTP ${r.status}`);
  return (j.data || []).map(c => ({
    id: c.id,
    name: c.display_name,
    email: c.emails?.[0]?.email,
    phone: c.phones?.[0]?.phone,
  }));
}

// -------------- FRESHSALES --------------
async function viaFreshsales({ query, limit }) {
  const key = process.env.FRESHSALES_API_KEY;
  const domain = process.env.FRESHSALES_DOMAIN;
  if (!key || !domain) throw new Error("Missing Freshsales credentials");
  const r = await fetch(`https://${domain}.freshsales.io/api/contacts/view/10?filter=${encodeURIComponent(query)}&per_page=${limit || 5}`, {
    headers: { Authorization: `Token token=${key}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Freshsales HTTP ${r.status}`);
  return (j.contacts || []).map(c => ({
    id: c.id,
    name: c.display_name,
    email: c.email,
    phone: c.work_number,
  }));
}

// -------------- COPPER CRM --------------
async function viaCopper({ query, limit }) {
  const key = process.env.COPPER_API_KEY;
  const email = process.env.COPPER_EMAIL;
  if (!key || !email) throw new Error("Missing Copper credentials");
  const r = await fetch(`https://api.prosperworks.com/developer_api/v1/people/search`, {
    method: "POST",
    headers: { "X-PW-AccessToken": key, "X-PW-Application": "developer_api", "X-PW-UserEmail": email, "Content-Type": "application/json" },
    body: toJSON({ name: query, page_size: limit || 5 }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Copper HTTP ${r.status}`);
  return (j || []).map(c => ({
    id: c.id,
    name: c.name,
    email: c.emails?.[0]?.email,
    phone: c.phone_numbers?.[0]?.number,
  }));
}

// -------------- MAIN ENTRY --------------
export async function run({ input = {}, emit }) {
  const provider = detectProvider();
  const { query, limit } = input;
  if (!query) {
    emitErr(emit, "crm_find_contact: query is required");
    return { data: { error: "missing_query" } };
  }

  if (DRY_RUN) {
    emitNote(emit, `crm_find_contact[DRY_RUN]: provider=${provider || "n/a"} query=${query}`);
    return { data: { provider: provider || "dry-run", results: [], status: "dry-run" } };
  }

  if (!provider) {
    if (DEMO) {
      emitNote(emit, "crm_find_contact[DEMO]: returning mock contact");
      const fake = [
        { id: "demo_001", name: "Mr. Alex Rivera", email: "alex@demo.com", phone: "+1 555 100 200" },
        { id: "demo_002", name: "Ms. Jamie Lee", email: "jamie@demo.com", phone: "+44 7700 900900" }
      ];
      return { data: { provider: "demo", results: fake, status: "demo" }, results: fake };
    }
    emitErr(emit, "crm_find_contact: no provider configured.");
    return { data: { error: "no_provider_configured" } };
  }

  emitNote(emit, `crm_find_contact: via ${provider}`);
  try {
    let results = [];
    switch (provider) {
      case "hubspot": results = await viaHubSpot(input); break;
      case "salesforce": results = await viaSalesforce(input); break;
      case "pipedrive": results = await viaPipedrive(input); break;
      case "zoho": results = await viaZoho(input); break;
      case "close": results = await viaClose(input); break;
      case "freshsales": results = await viaFreshsales(input); break;
      case "copper": results = await viaCopper(input); break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return { data: { provider, results, status: "ok" }, results };
  } catch (e) {
    const err = String(e?.message || e);
    emitErr(emit, `crm_find_contact failed: ${err}`);
    return { data: { error: err, provider } };
  }
}
