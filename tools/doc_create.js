// tools/doc_create.js
// UNIVERSAL DOCUMENT CREATOR (Google Docs, Microsoft Word/Graph, Notion, Coda, Zoho Writer) + Demo
// -----------------------------------------------------------------------------------------------
// Auto-detected providers (first match wins; or force with DOC_PROVIDER):
//   • Google Docs       → GOOGLE_ACCESS_TOKEN or GOOGLE_SERVICE_ACCOUNT_JSON
//   • Microsoft Word    → MS_GRAPH_TOKEN or OAUTH_MS_TOKEN
//   • Notion            → NOTION_API_KEY
//   • Coda              → CODA_API_KEY
//   • Zoho Writer       → ZOHO_ACCESS_TOKEN
//
// Common env:
//   DOC_PROVIDER  = "google"|"outlook"|"notion"|"coda"|"zoho"
//   DOC_DRY_RUN   = "1"
//   DOC_DEMO      = "1"
//
// Input:
//   {
//     title: string,            // required
//     content?: string,         // optional plain text or HTML
//     folderId?: string,        // optional (Google, Coda, Zoho)
//     shareWith?: string[],     // optional array of emails for permissions
//     tags?: string[],          // optional metadata tags
//   }
//
// Output:
//   { data: { provider, id?: string|null, link?: string, status?: string }, link?: string }

const DRY_RUN = String(process.env.DOC_DRY_RUN || "") === "1";
const DEMO = String(process.env.DOC_DEMO || "") === "1";

function detectProvider() {
  const forced = (process.env.DOC_PROVIDER || "").toLowerCase().trim();
  if (forced) return forced;
  if (process.env.GOOGLE_ACCESS_TOKEN || process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return "google";
  if (process.env.MS_GRAPH_TOKEN || process.env.OAUTH_MS_TOKEN) return "outlook";
  if (process.env.NOTION_API_KEY) return "notion";
  if (process.env.CODA_API_KEY) return "coda";
  if (process.env.ZOHO_ACCESS_TOKEN) return "zoho";
  return null;
}

function emitNote(emit, msg) { try { emit && emit({ type: "note", msg }); } catch {} }
function emitErr(emit, msg) { try { emit && emit({ type: "error", msg }); } catch {} }
function toJSON(o) { return JSON.stringify(o, null, 2); }

// -------------- GOOGLE DOCS --------------
async function viaGoogle({ title, content }) {
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  if (!token) throw new Error("Missing GOOGLE_ACCESS_TOKEN");

  // Create empty document
  const r = await fetch("https://docs.googleapis.com/v1/documents", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Google Docs HTTP ${r.status}`);

  const docId = j.documentId;
  const link = `https://docs.google.com/document/d/${docId}/edit`;

  // Insert text (if provided)
  if (content) {
    await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{ insertText: { text: content, endOfSegmentLocation: {} } }],
      }),
    });
  }

  return { id: docId, link, status: "created" };
}

// -------------- MICROSOFT WORD / GRAPH --------------
async function viaOutlook({ title, content }) {
  const token = process.env.MS_GRAPH_TOKEN || process.env.OAUTH_MS_TOKEN;
  if (!token) throw new Error("Missing MS_GRAPH_TOKEN");
  const body = { name: `${title}.docx`, file: { contentBytes: Buffer.from(content || "").toString("base64") } };
  const r = await fetch("https://graph.microsoft.com/v1.0/me/drive/root/children", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Outlook HTTP ${r.status}`);
  return { id: j.id, link: j.webUrl, status: "created" };
}

// -------------- NOTION --------------
async function viaNotion({ title, content }) {
  const key = process.env.NOTION_API_KEY;
  if (!key) throw new Error("Missing NOTION_API_KEY");
  const r = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: toJSON({
      parent: { type: "workspace" },
      properties: { title: [{ type: "text", text: { content: title } }] },
      children: content ? [{ object: "block", type: "paragraph", paragraph: { text: [{ type: "text", text: { content } }] } }] : [],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Notion HTTP ${r.status}`);
  return { id: j.id, link: j.url, status: "created" };
}

// -------------- CODA --------------
async function viaCoda({ title, content }) {
  const key = process.env.CODA_API_KEY;
  if (!key) throw new Error("Missing CODA_API_KEY");
  const r = await fetch("https://coda.io/apis/v1/docs", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: toJSON({ title, content: content || "" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Coda HTTP ${r.status}`);
  return { id: j.id, link: j.browserLink || `https://coda.io/d/${j.id}`, status: "created" };
}

// -------------- ZOHO WRITER --------------
async function viaZoho({ title, content }) {
  const token = process.env.ZOHO_ACCESS_TOKEN;
  if (!token) throw new Error("Missing ZOHO_ACCESS_TOKEN");
  const r = await fetch("https://writer.zoho.com/writer/api/v1/documents", {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: toJSON({ title, content }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Zoho Writer HTTP ${r.status}`);
  return { id: j.document_id, link: j.url, status: "created" };
}

// -------------- MAIN ENTRY --------------
export async function run({ input = {}, emit }) {
  const provider = detectProvider();
  if (!input.title) {
    emitErr(emit, "doc_create: title is required");
    return { data: { error: "missing_title" } };
  }

  if (DRY_RUN) {
    emitNote(emit, `doc_create[DRY_RUN]: provider=${provider || "n/a"} title=${input.title}`);
    return { data: { provider: provider || "dry-run", status: "dry-run" } };
  }

  if (!provider) {
    if (DEMO) {
      const fake = "demo_" + Math.random().toString(36).slice(2, 9);
      emitNote(emit, `doc_create[DEMO]: returning fake doc`);
      return {
        data: {
          provider: "demo",
          id: fake,
          link: `about:blank#demo-doc-${fake}`,
          status: "created",
        },
        link: `about:blank#demo-doc-${fake}`,
      };
    }
    emitErr(emit, "doc_create: no provider configured.");
    return { data: { error: "no_provider_configured" } };
  }

  emitNote(emit, `doc_create: via ${provider} → ${input.title}`);
  try {
    let out;
    switch (provider) {
      case "google": out = await viaGoogle(input); break;
      case "outlook": out = await viaOutlook(input); break;
      case "notion": out = await viaNotion(input); break;
      case "coda": out = await viaCoda(input); break;
      case "zoho": out = await viaZoho(input); break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return { data: { provider, id: out?.id || null, link: out?.link, status: out?.status || "created" }, link: out?.link };
  } catch (e) {
    const err = String(e?.message || e);
    emitErr(emit, `doc_create failed: ${err}`);
    return { data: { error: err, provider } };
  }
}
