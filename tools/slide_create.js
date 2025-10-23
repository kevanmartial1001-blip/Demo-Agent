// tools/slide_create.js
// UNIVERSAL PRESENTATION CREATOR (Google Slides, PowerPoint, Beautiful.ai, Pitch, Gamma) + Demo
// ---------------------------------------------------------------------------------------------
// Auto-detected providers (first match wins; or force with SLIDE_PROVIDER):
//   • Google Slides   → GOOGLE_ACCESS_TOKEN
//   • PowerPoint      → MS_GRAPH_TOKEN or OAUTH_MS_TOKEN
//   • Beautiful.ai    → BEAUTIFULAI_API_KEY
//   • Pitch           → PITCH_API_KEY
//   • Gamma.app       → GAMMA_API_KEY
//
// Common env:
//   SLIDE_PROVIDER = "google"|"powerpoint"|"beautifulai"|"pitch"|"gamma"
//   SLIDE_DRY_RUN  = "1"
//   SLIDE_DEMO     = "1"
//
// Input:
//   {
//     title: string,             // required
//     slides?: [{ title, content }], // optional slide definitions
//     theme?: string,            // optional (e.g., "modern", "dark", "corporate")
//     folderId?: string          // optional
//   }
//
// Output:
//   { data: { provider, id?: string|null, link?: string, status?: string }, link?: string }

const DRY_RUN = String(process.env.SLIDE_DRY_RUN || "") === "1";
const DEMO = String(process.env.SLIDE_DEMO || "") === "1";

function detectProvider() {
  const forced = (process.env.SLIDE_PROVIDER || "").toLowerCase().trim();
  if (forced) return forced;
  if (process.env.GOOGLE_ACCESS_TOKEN) return "google";
  if (process.env.MS_GRAPH_TOKEN || process.env.OAUTH_MS_TOKEN) return "powerpoint";
  if (process.env.BEAUTIFULAI_API_KEY) return "beautifulai";
  if (process.env.PITCH_API_KEY) return "pitch";
  if (process.env.GAMMA_API_KEY) return "gamma";
  return null;
}

function emitNote(emit, msg) { try { emit && emit({ type: "note", msg }); } catch {} }
function emitErr(emit, msg) { try { emit && emit({ type: "error", msg }); } catch {} }
function toJSON(o) { return JSON.stringify(o, null, 2); }

// -------------- GOOGLE SLIDES --------------
async function viaGoogle({ title, slides }) {
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  if (!token) throw new Error("Missing GOOGLE_ACCESS_TOKEN");

  const createRes = await fetch("https://slides.googleapis.com/v1/presentations", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const j = await createRes.json().catch(() => ({}));
  if (!createRes.ok) throw new Error(j.error?.message || `Google Slides HTTP ${createRes.status}`);

  const id = j.presentationId;
  const link = `https://docs.google.com/presentation/d/${id}/edit`;

  if (Array.isArray(slides) && slides.length > 0) {
    const requests = slides.map(s => ({
      createSlide: {
        objectId: `slide_${Math.random().toString(36).slice(2, 7)}`,
        insertionIndex: 1,
        slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
      },
    }));
    await fetch(`https://slides.googleapis.com/v1/presentations/${id}:batchUpdate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
    });
  }

  return { id, link, status: "created" };
}

// -------------- POWERPOINT (Microsoft Graph) --------------
async function viaPowerPoint({ title }) {
  const token = process.env.MS_GRAPH_TOKEN || process.env.OAUTH_MS_TOKEN;
  if (!token) throw new Error("Missing MS_GRAPH_TOKEN");
  const r = await fetch("https://graph.microsoft.com/v1.0/me/drive/root/children", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: `${title}.pptx`, file: {} }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `PowerPoint HTTP ${r.status}`);
  return { id: j.id, link: j.webUrl, status: "created" };
}

// -------------- BEAUTIFUL.AI --------------
async function viaBeautifulAI({ title, slides }) {
  const key = process.env.BEAUTIFULAI_API_KEY;
  if (!key) throw new Error("Missing BEAUTIFULAI_API_KEY");
  const body = { title, slides: slides || [{ title, content: "This is your first slide!" }] };
  const r = await fetch("https://api.beautiful.ai/api/v1/presentations", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Beautiful.ai HTTP ${r.status}`);
  return { id: j.id, link: j.url, status: "created" };
}

// -------------- PITCH --------------
async function viaPitch({ title, slides }) {
  const key = process.env.PITCH_API_KEY;
  if (!key) throw new Error("Missing PITCH_API_KEY");
  const body = { title, slides: slides || [] };
  const r = await fetch("https://api.pitch.com/v1/presentations", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Pitch HTTP ${r.status}`);
  return { id: j.id, link: j.url, status: "created" };
}

// -------------- GAMMA.APP --------------
async function viaGamma({ title, slides }) {
  const key = process.env.GAMMA_API_KEY;
  if (!key) throw new Error("Missing GAMMA_API_KEY");
  const body = { title, slides: slides || [] };
  const r = await fetch("https://api.gamma.app/v1/presentations", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Gamma HTTP ${r.status}`);
  return { id: j.id, link: j.url, status: "created" };
}

// -------------- MAIN ENTRY --------------
export async function run({ input = {}, emit }) {
  const provider = detectProvider();

  if (!input.title) {
    emitErr(emit, "slide_create: title is required");
    return { data: { error: "missing_title" } };
  }

  if (DRY_RUN) {
    emitNote(emit, `slide_create[DRY_RUN]: provider=${provider || "n/a"} title=${input.title}`);
    return { data: { provider: provider || "dry-run", status: "dry-run" } };
  }

  if (!provider) {
    if (DEMO) {
      const fake = "demo_" + Math.random().toString(36).slice(2, 9);
      emitNote(emit, "slide_create[DEMO]: returning fake slide deck");
      return {
        data: { provider: "demo", id: fake, link: `about:blank#demo-slide-${fake}`, status: "created" },
        link: `about:blank#demo-slide-${fake}`,
      };
    }
    emitErr(emit, "slide_create: no provider configured.");
    return { data: { error: "no_provider_configured" } };
  }

  emitNote(emit, `slide_create: via ${provider} → ${input.title}`);
  try {
    let out;
    switch (provider) {
      case "google": out = await viaGoogle(input); break;
      case "powerpoint": out = await viaPowerPoint(input); break;
      case "beautifulai": out = await viaBeautifulAI(input); break;
      case "pitch": out = await viaPitch(input); break;
      case "gamma": out = await viaGamma(input); break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return { data: { provider, id: out?.id || null, link: out?.link, status: out?.status || "created" }, link: out?.link };
  } catch (e) {
    const err = String(e?.message || e);
    emitErr(emit, `slide_create failed: ${err}`);
    return { data: { error: err, provider } };
  }
}
