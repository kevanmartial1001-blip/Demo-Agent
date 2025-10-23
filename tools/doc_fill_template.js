// tools/doc_fill_template.js
// UNIVERSAL DOCUMENT TEMPLATE FILLER (Google Docs, DocuSign, PandaDoc, PDF.co, Zoho Writer) + Demo
// ----------------------------------------------------------------------------------------------
// Auto-detected providers (first match wins; or force with DOC_PROVIDER):
//   • Google Docs     → GOOGLE_ACCESS_TOKEN or GOOGLE_SERVICE_ACCOUNT_JSON
//   • DocuSign        → DOCUSIGN_ACCESS_TOKEN
//   • PandaDoc        → PANDADOC_API_KEY
//   • PDF.co          → PDFCO_API_KEY
//   • Zoho Writer     → ZOHO_ACCESS_TOKEN
//
// Common env:
//   DOC_PROVIDER   = "google"|"docusign"|"pandadoc"|"pdfco"|"zoho"
//   DOC_DRY_RUN    = "1"
//   DOC_DEMO       = "1"
//
// Input:
//   {
//     templateId: string,             // required ID of the base template
//     variables: object,              // { placeholderName: value }
//     title?: string,                 // optional new title
//     recipients?: [{ name, email }], // optional for e-signing
//     folderId?: string               // optional target folder
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
  if (process.env.DOCUSIGN_ACCESS_TOKEN) return "docusign";
  if (process.env.PANDADOC_API_KEY) return "pandadoc";
  if (process.env.PDFCO_API_KEY) return "pdfco";
  if (process.env.ZOHO_ACCESS_TOKEN) return "zoho";
  return null;
}

function emitNote(emit, msg) { try { emit && emit({ type: "note", msg }); } catch {} }
function emitErr(emit, msg) { try { emit && emit({ type: "error", msg }); } catch {} }
function toJSON(o) { return JSON.stringify(o, null, 2); }

// -------------- GOOGLE DOCS --------------
async function viaGoogle({ templateId, variables, title }) {
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  if (!token) throw new Error("Missing GOOGLE_ACCESS_TOKEN");

  // Copy template
  const copyRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${templateId}/copy`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: title || "New Document" }),
    }
  );
  const copyJson = await copyRes.json().catch(() => ({}));
  if (!copyRes.ok) throw new Error(copyJson.error?.message || `Google copy HTTP ${copyRes.status}`);

  const newId = copyJson.id;
  const link = `https://docs.google.com/document/d/${newId}/edit`;

  // Replace placeholders
  const requests = Object.entries(variables || {}).map(([k, v]) => ({
    replaceAllText: { containsText: { text: `{{${k}}}`, matchCase: false }, replaceText: String(v) },
  }));

  await fetch(`https://docs.googleapis.com/v1/documents/${newId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });

  return { id: newId, link, status: "filled" };
}

// -------------- DOCUSIGN --------------
async function viaDocuSign({ templateId, variables, recipients }) {
  const token = process.env.DOCUSIGN_ACCESS_TOKEN;
  if (!token) throw new Error("Missing DOCUSIGN_ACCESS_TOKEN");

  const body = {
    templateId,
    templateRoles: (recipients || []).map((r, i) => ({
      email: r.email,
      name: r.name,
      roleName: `signer${i + 1}`,
    })),
    status: "sent",
  };

  const r = await fetch("https://demo.docusign.net/restapi/v2.1/accounts/me/envelopes", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `DocuSign HTTP ${r.status}`);
  return { id: j.envelopeId, link: j.uri, status: "sent" };
}

// -------------- PANDADOC --------------
async function viaPandaDoc({ templateId, variables, recipients, title }) {
  const key = process.env.PANDADOC_API_KEY;
  if (!key) throw new Error("Missing PANDADOC_API_KEY");

  const body = {
    name: title || "New Document",
    template_uuid: templateId,
    recipients: (recipients || []).map((r, i) => ({
      email: r.email,
      first_name: r.name || `Recipient ${i + 1}`,
      role: `signer${i + 1}`,
    })),
    tokens: Object.entries(variables || {}).map(([k, v]) => ({ name: k, value: String(v) })),
  };

  const r = await fetch("https://api.pandadoc.com/public/v1/documents", {
    method: "POST",
    headers: { Authorization: `API-Key ${key}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `PandaDoc HTTP ${r.status}`);
  return { id: j.id, link: j.document_url, status: "created" };
}

// -------------- PDF.co --------------
async function viaPDFco({ templateId, variables }) {
  const key = process.env.PDFCO_API_KEY;
  if (!key) throw new Error("Missing PDFCO_API_KEY");
  const body = {
    name: `Filled_${Date.now()}.pdf`,
    templateId,
    fields: Object.entries(variables || {}).map(([n, v]) => ({ fieldName: n, text: String(v) })),
  };
  const r = await fetch("https://api.pdf.co/v1/pdf/edit/add", {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `PDF.co HTTP ${r.status}`);
  return { id: j.jobId || null, link: j.url || null, status: "filled" };
}

// -------------- ZOHO WRITER --------------
async function viaZoho({ templateId, variables, title }) {
  const token = process.env.ZOHO_ACCESS_TOKEN;
  if (!token) throw new Error("Missing ZOHO_ACCESS_TOKEN");
  const body = {
    merge_data: variables || {},
    output_format: "pdf",
    file_name: title || `Filled_${Date.now()}`,
  };
  const r = await fetch(`https://writer.zoho.com/writer/api/v1/document/merge/${templateId}`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Zoho HTTP ${r.status}`);
  return { id: j.document_id, link: j.url, status: "filled" };
}

// -------------- MAIN ENTRY --------------
export async function run({ input = {}, emit }) {
  const provider = detectProvider();

  if (!input.templateId) {
    emitErr(emit, "doc_fill_template: templateId is required");
    return { data: { error: "missing_templateId" } };
  }

  if (DRY_RUN) {
    emitNote(emit, `doc_fill_template[DRY_RUN]: provider=${provider || "n/a"} template=${input.templateId}`);
    return { data: { provider: provider || "dry-run", status: "dry-run" } };
  }

  if (!provider) {
    if (DEMO) {
      const fake = "demo_" + Math.random().toString(36).slice(2, 9);
      emitNote(emit, "doc_fill_template[DEMO]: returning fake template");
      return {
        data: { provider: "demo", id: fake, link: `about:blank#demo-template-${fake}`, status: "filled" },
        link: `about:blank#demo-template-${fake}`,
      };
    }
    emitErr(emit, "doc_fill_template: no provider configured.");
    return { data: { error: "no_provider_configured" } };
  }

  emitNote(emit, `doc_fill_template: via ${provider} → template ${input.templateId}`);
  try {
    let out;
    switch (provider) {
      case "google": out = await viaGoogle(input); break;
      case "docusign": out = await viaDocuSign(input); break;
      case "pandadoc": out = await viaPandaDoc(input); break;
      case "pdfco": out = await viaPDFco(input); break;
      case "zoho": out = await viaZoho(input); break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return { data: { provider, id: out?.id || null, link: out?.link, status: out?.status || "filled" }, link: out?.link };
  } catch (e) {
    const err = String(e?.message || e);
    emitErr(emit, `doc_fill_template failed: ${err}`);
    return { data: { error: err, provider } };
  }
}
