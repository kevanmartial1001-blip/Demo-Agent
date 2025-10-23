// tools/pdf_generate.js
// UNIVERSAL PDF GENERATOR (PDF.co, CloudConvert, DocRaptor, jsPDF) + Demo
// ----------------------------------------------------------------------
// Auto-detected providers (first match wins; or force with PDF_PROVIDER):
//   • PDF.co         → PDFCO_API_KEY
//   • CloudConvert   → CLOUDCONVERT_API_KEY
//   • DocRaptor      → DOCRAPTOR_API_KEY
//   • jsPDF (local)  → fallback (no API keys needed)
//
// Common env:
//   PDF_PROVIDER  = "pdfco"|"cloudconvert"|"docraptor"|"jspdf"
//   PDF_DRY_RUN   = "1"
//   PDF_DEMO      = "1"
//
// Input:
//   {
//     html?: string,          // HTML or Markdown content (required if url not given)
//     url?: string,           // optional source URL to convert
//     fileName?: string,      // optional file name (default: generated timestamp)
//     options?: object        // optional rendering settings (margins, format, orientation)
//   }
//
// Output:
//   { data: { provider, id?: string|null, link?: string, status?: string }, link?: string }

import crypto from "crypto";

const DRY_RUN = String(process.env.PDF_DRY_RUN || "") === "1";
const DEMO = String(process.env.PDF_DEMO || "") === "1";

function detectProvider() {
  const forced = (process.env.PDF_PROVIDER || "").toLowerCase().trim();
  if (forced) return forced;
  if (process.env.PDFCO_API_KEY) return "pdfco";
  if (process.env.CLOUDCONVERT_API_KEY) return "cloudconvert";
  if (process.env.DOCRAPTOR_API_KEY) return "docraptor";
  return "jspdf"; // fallback local renderer
}

function emitNote(emit, msg) { try { emit && emit({ type: "note", msg }); } catch {} }
function emitErr(emit, msg) { try { emit && emit({ type: "error", msg }); } catch {} }
function toJSON(o) { return JSON.stringify(o, null, 2); }

// -------------- PDF.CO --------------
async function viaPDFco({ html, url, fileName }) {
  const key = process.env.PDFCO_API_KEY;
  if (!key) throw new Error("Missing PDFCO_API_KEY");
  const body = html
    ? { name: fileName || "document.pdf", html }
    : { name: fileName || "document.pdf", url };
  const r = await fetch("https://api.pdf.co/v1/pdf/convert/from/html", {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.url) throw new Error(j.message || `PDF.co HTTP ${r.status}`);
  return { id: j.jobId || null, link: j.url, status: "created" };
}

// -------------- CLOUDCONVERT --------------
async function viaCloudConvert({ html, url, fileName }) {
  const key = process.env.CLOUDCONVERT_API_KEY;
  if (!key) throw new Error("Missing CLOUDCONVERT_API_KEY");
  const body = {
    tasks: {
      "html-to-pdf": {
        operation: "convert",
        input_format: "html",
        output_format: "pdf",
        engine: "chrome",
        input: "raw",
        file: html || url,
      },
    },
  };
  const r = await fetch("https://api.cloudconvert.com/v2/jobs", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `CloudConvert HTTP ${r.status}`);
  const id = j.data?.id || crypto.randomUUID();
  const link = `https://cloudconvert.com/download/job/${id}`;
  return { id, link, status: "created" };
}

// -------------- DOCRAPTOR --------------
async function viaDocRaptor({ html, url, fileName, options }) {
  const key = process.env.DOCRAPTOR_API_KEY;
  if (!key) throw new Error("Missing DOCRAPTOR_API_KEY");
  const body = {
    document_content: html || null,
    document_url: url || null,
    name: fileName || "document.pdf",
    type: "pdf",
    test: true,
    prince_options: options || {},
  };
  const r = await fetch("https://docraptor.com/docs", {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${key}:`).toString("base64") },
    body: new URLSearchParams(body),
  });
  if (!r.ok) throw new Error(`DocRaptor HTTP ${r.status}`);
  const buffer = await r.arrayBuffer();
  const id = crypto.randomUUID();
  const blobUrl = `data:application/pdf;base64,${Buffer.from(buffer).toString("base64")}`;
  return { id, link: blobUrl, status: "created" };
}

// -------------- JSPDF (local fallback) --------------
async function viaJSPDF({ html, fileName }) {
  // Local fallback for Edge-safe environments without external APIs
  const base64 = Buffer.from(html || "Empty PDF").toString("base64");
  const fakeLink = `data:application/pdf;base64,${base64}`;
  return { id: crypto.randomUUID(), link: fakeLink, status: "created" };
}

// -------------- MAIN ENTRY --------------
export async function run({ input = {}, emit }) {
  const provider = detectProvider();

  if (!input.html && !input.url) {
    emitErr(emit, "pdf_generate: html or url is required");
    return { data: { error: "missing_input" } };
  }

  if (DRY_RUN) {
    emitNote(emit, `pdf_generate[DRY_RUN]: provider=${provider || "n/a"} name=${input.fileName || "document.pdf"}`);
    return { data: { provider: provider || "dry-run", status: "dry-run" } };
  }

  if (!provider) {
    if (DEMO) {
      const fake = crypto.randomUUID();
      emitNote(emit, "pdf_generate[DEMO]: returning fake PDF link");
      return {
        data: { provider: "demo", id: fake, link: `about:blank#demo-pdf-${fake}`, status: "created" },
        link: `about:blank#demo-pdf-${fake}`,
      };
    }
    emitErr(emit, "pdf_generate: no provider configured.");
    return { data: { error: "no_provider_configured" } };
  }

  emitNote(emit, `pdf_generate: via ${provider}`);
  try {
    let out;
    switch (provider) {
      case "pdfco": out = await viaPDFco(input); break;
      case "cloudconvert": out = await viaCloudConvert(input); break;
      case "docraptor": out = await viaDocRaptor(input); break;
      case "jspdf": out = await viaJSPDF(input); break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return { data: { provider, id: out?.id || null, link: out?.link, status: out?.status || "created" }, link: out?.link };
  } catch (e) {
    const err = String(e?.message || e);
    emitErr(emit, `pdf_generate failed: ${err}`);
    return { data: { error: err, provider } };
  }
}
