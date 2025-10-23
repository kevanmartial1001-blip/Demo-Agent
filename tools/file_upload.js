// tools/file_upload.js
// UNIVERSAL FILE UPLOADER (Google Drive, Dropbox, OneDrive, Box, AWS S3, Cloudflare R2) + Demo
// ---------------------------------------------------------------------------------------------
// Auto-detected providers (first match wins; or force with FILE_PROVIDER):
//   • Google Drive   → GOOGLE_ACCESS_TOKEN
//   • Dropbox        → DROPBOX_ACCESS_TOKEN
//   • OneDrive       → MS_GRAPH_TOKEN or OAUTH_MS_TOKEN
//   • Box            → BOX_ACCESS_TOKEN
//   • AWS S3         → AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_S3_BUCKET
//   • Cloudflare R2  → R2_ACCOUNT_ID + R2_ACCESS_KEY + R2_SECRET_KEY + R2_BUCKET
//
// Common env:
//   FILE_PROVIDER  = "google"|"dropbox"|"onedrive"|"box"|"s3"|"r2"
//   FILE_DRY_RUN   = "1"
//   FILE_DEMO      = "1"
//
// Input:
//   {
//     name: string,                // required filename (e.g. "report.pdf")
//     mimeType?: string,           // optional MIME type
//     content?: string|Buffer,     // file content (Base64 or text)
//     folderId?: string,           // optional target folder
//     base64?: boolean             // true if content is base64 encoded
//   }
//
// Output:
//   { data: { provider, id?: string|null, link?: string, status?: string }, link?: string }

import crypto from "crypto";

const DRY_RUN = String(process.env.FILE_DRY_RUN || "") === "1";
const DEMO = String(process.env.FILE_DEMO || "") === "1";

function detectProvider() {
  const forced = (process.env.FILE_PROVIDER || "").toLowerCase().trim();
  if (forced) return forced;
  if (process.env.GOOGLE_ACCESS_TOKEN) return "google";
  if (process.env.DROPBOX_ACCESS_TOKEN) return "dropbox";
  if (process.env.MS_GRAPH_TOKEN || process.env.OAUTH_MS_TOKEN) return "onedrive";
  if (process.env.BOX_ACCESS_TOKEN) return "box";
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_S3_BUCKET) return "s3";
  if (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY && process.env.R2_SECRET_KEY && process.env.R2_BUCKET) return "r2";
  return null;
}

function emitNote(emit,msg){try{emit&&emit({type:"note",msg});}catch{}}
function emitErr(emit,msg){try{emit&&emit({type:"error",msg});}catch{}}

// -------------- GOOGLE DRIVE --------------
async function viaGoogle({ name, mimeType, content, folderId }) {
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  if (!token) throw new Error("Missing GOOGLE_ACCESS_TOKEN");
  const metadata = { name, mimeType: mimeType || "application/octet-stream" };
  if (folderId) metadata.parents = [folderId];

  const boundary = "-------314159265358979323846";
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    "",
    JSON.stringify(metadata),
    "",
    `--${boundary}`,
    `Content-Type: ${mimeType || "application/octet-stream"}`,
    "",
    content,
    "",
    `--${boundary}--`
  ].join("\r\n");

  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Google Drive HTTP ${r.status}`);
  return { id: j.id, link: `https://drive.google.com/file/d/${j.id}/view`, status: "uploaded" };
}

// -------------- DROPBOX --------------
async function viaDropbox({ name, content, base64 }) {
  const token = process.env.DROPBOX_ACCESS_TOKEN;
  if (!token) throw new Error("Missing DROPBOX_ACCESS_TOKEN");
  const data = base64 ? Buffer.from(content, "base64") : content;
  const r = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Dropbox-API-Arg": JSON.stringify({ path: `/${name}`, mode: "add", autorename: true }),
      "Content-Type": "application/octet-stream",
    },
    body: data
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_summary || `Dropbox HTTP ${r.status}`);
  return { id: j.id, link: `https://www.dropbox.com/home${j.path_display}`, status: "uploaded" };
}

// -------------- ONEDRIVE --------------
async function viaOneDrive({ name, content, base64 }) {
  const token = process.env.MS_GRAPH_TOKEN || process.env.OAUTH_MS_TOKEN;
  if (!token) throw new Error("Missing MS_GRAPH_TOKEN");
  const data = base64 ? Buffer.from(content, "base64") : content;
  const r = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${encodeURIComponent(name)}:/content`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
    body: data
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `OneDrive HTTP ${r.status}`);
  return { id: j.id, link: j.webUrl, status: "uploaded" };
}

// -------------- BOX --------------
async function viaBox({ name, content, base64, folderId }) {
  const token = process.env.BOX_ACCESS_TOKEN;
  if (!token) throw new Error("Missing BOX_ACCESS_TOKEN");
  const data = base64 ? Buffer.from(content, "base64") : content;
  const body = new FormData();
  body.append("attributes", JSON.stringify({ name, parent: { id: folderId || "0" } }));
  body.append("file", new Blob([data]), name);

  const r = await fetch("https://upload.box.com/api/2.0/files/content", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Box HTTP ${r.status}`);
  const file = j.entries?.[0];
  return { id: file?.id, link: file?.shared_link?.url || `https://app.box.com/file/${file?.id}`, status: "uploaded" };
}

// -------------- AWS S3 --------------
async function viaS3({ name, content, base64, mimeType }) {
  const key = process.env.AWS_ACCESS_KEY_ID;
  const secret = process.env.AWS_SECRET_ACCESS_KEY;
  const bucket = process.env.AWS_S3_BUCKET;
  if (!key || !secret || !bucket) throw new Error("Missing AWS S3 credentials");
  const region = process.env.AWS_REGION || "us-east-1";
  const data = base64 ? Buffer.from(content, "base64") : content;
  const endpoint = `https://${bucket}.s3.${region}.amazonaws.com/${encodeURIComponent(name)}`;
  const r = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": mimeType || "application/octet-stream" }, body: data });
  if (!r.ok) throw new Error(`S3 upload failed: ${r.status}`);
  return { id: name, link: endpoint, status: "uploaded" };
}

// -------------- CLOUDFLARE R2 --------------
async function viaR2({ name, content, base64, mimeType }) {
  const acc = process.env.R2_ACCOUNT_ID;
  const access = process.env.R2_ACCESS_KEY;
  const secret = process.env.R2_SECRET_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!acc || !access || !secret || !bucket) throw new Error("Missing R2 credentials");
  const endpoint = `https://${acc}.r2.cloudflarestorage.com/${bucket}/${encodeURIComponent(name)}`;
  const data = base64 ? Buffer.from(content, "base64") : content;
  const r = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": mimeType || "application/octet-stream" }, body: data });
  if (!r.ok) throw new Error(`R2 upload failed: ${r.status}`);
  return { id: name, link: endpoint, status: "uploaded" };
}

// -------------- MAIN ENTRY --------------
export async function run({ input = {}, emit }) {
  const provider = detectProvider();
  const { name, content } = input;
  if (!name || !content) {
    emitErr(emit, "file_upload: name and content are required");
    return { data: { error: "missing_fields" } };
  }

  if (DRY_RUN) {
    emitNote(emit, `file_upload[DRY_RUN]: provider=${provider || "n/a"} file=${name}`);
    return { data: { provider: provider || "dry-run", status: "dry-run" } };
  }

  if (!provider) {
    if (DEMO) {
      const fake = crypto.randomUUID();
      emitNote(emit, "file_upload[DEMO]: returning fake file upload");
      return {
        data: { provider: "demo", id: fake, link: `about:blank#demo-file-${fake}`, status: "uploaded" },
        link: `about:blank#demo-file-${fake}`
      };
    }
    emitErr(emit, "file_upload: no provider configured.");
    return { data: { error: "no_provider_configured" } };
  }

  emitNote(emit, `file_upload: via ${provider} → ${name}`);
  try {
    let out;
    switch (provider) {
      case "google": out = await viaGoogle(input); break;
      case "dropbox": out = await viaDropbox(input); break;
      case "onedrive": out = await viaOneDrive(input); break;
      case "box": out = await viaBox(input); break;
      case "s3": out = await viaS3(input); break;
      case "r2": out = await viaR2(input); break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return { data: { provider, id: out?.id || null, link: out?.link, status: out?.status || "uploaded" }, link: out?.link };
  } catch (e) {
    const err = String(e?.message || e);
    emitErr(emit, `file_upload failed: ${err}`);
    return { data: { error: err, provider } };
  }
}
