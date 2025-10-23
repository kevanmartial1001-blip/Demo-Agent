// tools/browser_scrape.js
// UNIVERSAL WEBPAGE SCRAPER (Jina.ai, Firecrawl, Apify, SerpApi, Cheerio) + Demo
// -------------------------------------------------------------------------------
//
// Auto-detected providers (first match wins; or force with SCRAPE_PROVIDER):
//   • Jina Reader     → JINA_API_KEY
//   • Firecrawl       → FIRECRAWL_API_KEY
//   • Apify           → APIFY_API_TOKEN
//   • SerpApi         → SERPAPI_KEY
//   • Cheerio fallback (local)
//
// Common env:
//   SCRAPE_PROVIDER   = "jina"|"firecrawl"|"apify"|"serpapi"|"cheerio"
//   SCRAPE_DRY_RUN    = "1"
//   SCRAPE_DEMO       = "1"
//   SCRAPE_TIMEOUT_MS = "15000"
//
// Input:
//   {
//     url: string,          // required
//     extract?: "text"|"html"|"links"|"metadata"|"full",  // optional, default "full"
//     depth?: number,        // optional, number of subpages to follow (default 0)
//   }
//
// Output:
//   { data: { provider, url, content, links?, meta?, status }, status }

import cheerio from "cheerio";

const DRY_RUN = String(process.env.SCRAPE_DRY_RUN || "") === "1";
const DEMO = String(process.env.SCRAPE_DEMO || "") === "1";
const TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS || 15000);

function emitNote(emit, msg) { try { emit && emit({ type: "note", msg }); } catch {} }
function emitErr(emit, msg) { try { emit && emit({ type: "error", msg }); } catch {} }
function toJSON(o) { return JSON.stringify(o, null, 2); }

function detectProvider() {
  const forced = (process.env.SCRAPE_PROVIDER || "").toLowerCase().trim();
  if (forced) return forced;
  if (process.env.JINA_API_KEY) return "jina";
  if (process.env.FIRECRAWL_API_KEY) return "firecrawl";
  if (process.env.APIFY_API_TOKEN) return "apify";
  if (process.env.SERPAPI_KEY) return "serpapi";
  return "cheerio"; // local fallback
}

// --------- PROVIDERS ---------
async function viaJina({ url }) {
  const key = process.env.JINA_API_KEY;
  if (!key) throw new Error("Missing JINA_API_KEY");
  const r = await fetch(`https://r.jina.ai/${encodeURIComponent(url)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!r.ok) throw new Error(`Jina Reader HTTP ${r.status}`);
  const text = await r.text();
  return { provider: "jina", url, content: text, status: "ok" };
}

async function viaFirecrawl({ url }) {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error("Missing FIRECRAWL_API_KEY");
  const r = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: toJSON({ url }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Firecrawl HTTP ${r.status}`);
  return { provider: "firecrawl", url, content: j.text || j.html || "", meta: j.meta, status: "ok" };
}

async function viaApify({ url }) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error("Missing APIFY_API_TOKEN");
  const actor = "apify/web-scraper";
  const body = { startUrls: [{ url }], maxConcurrency: 1, maxRequestsPerCrawl: 3 };
  const r = await fetch(`https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Apify HTTP ${r.status}`);
  const item = Array.isArray(j) ? j[0] : j;
  return { provider: "apify", url, content: item?.text || item?.html || "", meta: item?.metadata, status: "ok" };
}

async function viaSerpApi({ url }) {
  const key = process.env.SERPAPI_KEY;
  if (!key) throw new Error("Missing SERPAPI_KEY");
  const r = await fetch(`https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(url)}&api_key=${key}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `SerpApi HTTP ${r.status}`);
  return { provider: "serpapi", url, content: j.organic_results?.map(r => r.snippet).join("\n") || "", status: "ok" };
}

async function viaCheerio({ url, extract }) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Cheerio HTTP ${r.status}`);
  const html = await r.text();
  const $ = cheerio.load(html);
  let content = "";
  if (extract === "text") content = $("body").text().trim();
  else if (extract === "links") content = $("a").map((_, el) => $(el).attr("href")).get().join("\n");
  else if (extract === "metadata") {
    const meta = {};
    $("meta").each((_, el) => {
      const name = $(el).attr("name") || $(el).attr("property");
      const content = $(el).attr("content");
      if (name && content) meta[name] = content;
    });
    return { provider: "cheerio", url, meta, status: "ok" };
  } else content = html;
  return { provider: "cheerio", url, content, status: "ok" };
}

// --------- MAIN ENTRY ---------
export async function run({ input = {}, emit }) {
  const provider = detectProvider();
  const { url, extract = "full" } = input;
  if (!url) {
    emitErr(emit, "browser_scrape: url required");
    return { data: { error: "missing_url" } };
  }

  if (DRY_RUN) {
    emitNote(emit, `browser_scrape[DRY_RUN]: provider=${provider || "n/a"} url=${url}`);
    return { data: { provider, status: "dry-run" } };
  }

  if (DEMO) {
    emitNote(emit, "browser_scrape[DEMO]: returning mock content");
    return {
      data: {
        provider: "demo",
        url,
        content: `Demo scrape of ${url}\n\n<h1>Example Page</h1><p>This is a simulated page content.</p>`,
        status: "ok",
      },
    };
  }

  emitNote(emit, `browser_scrape: via ${provider} for ${url}`);
  try {
    let out;
    switch (provider) {
      case "jina": out = await viaJina(input); break;
      case "firecrawl": out = await viaFirecrawl(input); break;
      case "apify": out = await viaApify(input); break;
      case "serpapi": out = await viaSerpApi(input); break;
      case "cheerio": out = await viaCheerio(input); break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return { data: out, status: "ok" };
  } catch (e) {
    const err = String(e?.message || e);
    emitErr(emit, `browser_scrape failed: ${err}`);
    return { data: { provider, url, error: err, status: "error" } };
  }
}
