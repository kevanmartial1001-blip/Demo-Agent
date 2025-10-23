// tools/http_fetch.js
// UNIVERSAL HTTP CONNECTOR (GET, POST, PUT, PATCH, DELETE) + Demo
// ---------------------------------------------------------------
//
// Supported authentication methods:
//   - Bearer token (HTTP_AUTH_BEARER)
//   - Basic auth (HTTP_BASIC_USER / HTTP_BASIC_PASS)
//   - API key in header (HTTP_API_KEY / HTTP_API_KEY_HEADER)
//   - Query param (HTTP_API_KEY_QUERY)
//   - None (public)
//
// Common env:
//   HTTP_DRY_RUN   = "1"
//   HTTP_DEMO      = "1"
//   HTTP_TIMEOUT_MS = "10000"   // default 10 seconds
//
// Input:
//   {
//     method: "GET"|"POST"|"PUT"|"PATCH"|"DELETE",  // required
//     url: string,                                   // required
//     headers?: object,                              // optional custom headers
//     query?: object,                                // optional query params
//     body?: object|string,                          // optional body
//     expectJson?: boolean,                          // default true
//   }
//
// Output:
//   { data: { provider: "http", status, body, headers }, status }

const DRY_RUN = String(process.env.HTTP_DRY_RUN || "") === "1";
const DEMO = String(process.env.HTTP_DEMO || "") === "1";
const TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 10000);

function emitNote(emit,msg){try{emit&&emit({type:"note",msg});}catch{}}
function emitErr(emit,msg){try{emit&&emit({type:"error",msg});}catch{}}

function buildAuthHeaders() {
  const h = {};
  if (process.env.HTTP_AUTH_BEARER) h["Authorization"] = `Bearer ${process.env.HTTP_AUTH_BEARER}`;
  else if (process.env.HTTP_BASIC_USER && process.env.HTTP_BASIC_PASS)
    h["Authorization"] = "Basic " + Buffer.from(`${process.env.HTTP_BASIC_USER}:${process.env.HTTP_BASIC_PASS}`).toString("base64");
  else if (process.env.HTTP_API_KEY && process.env.HTTP_API_KEY_HEADER)
    h[process.env.HTTP_API_KEY_HEADER] = process.env.HTTP_API_KEY;
  return h;
}

function withQuery(url, q) {
  if (!q || typeof q !== "object") return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  if (process.env.HTTP_API_KEY_QUERY && process.env.HTTP_API_KEY)
    u.searchParams.set(process.env.HTTP_API_KEY_QUERY, process.env.HTTP_API_KEY);
  return u.toString();
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timeout);
    return res;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

export async function run({ input = {}, emit }) {
  const { method = "GET", url, headers = {}, query, body, expectJson = true } = input;
  if (!url || !method) {
    emitErr(emit, "http_fetch: method and url required");
    return { data: { error: "missing_method_or_url" } };
  }

  if (DRY_RUN) {
    emitNote(emit, `http_fetch[DRY_RUN]: ${method} ${url}`);
    return { data: { provider: "http", status: "dry-run" } };
  }

  if (DEMO) {
    emitNote(emit, "http_fetch[DEMO]: returning fake API response");
    return {
      data: {
        provider: "demo",
        status: 200,
        body: { message: "This is a demo response from http_fetch (no live call)" },
        headers: {},
      },
      status: 200,
    };
  }

  const finalHeaders = {
    Accept: "application/json",
    ...buildAuthHeaders(),
    ...headers,
  };

  const opts = { method, headers: finalHeaders };
  if (body) {
    if (typeof body === "object") {
      opts.body = JSON.stringify(body);
      opts.headers["Content-Type"] = "application/json";
    } else {
      opts.body = String(body);
    }
  }

  const finalUrl = withQuery(url, query);
  emitNote(emit, `http_fetch: ${method} ${finalUrl}`);

  try {
    const res = await fetchWithTimeout(finalUrl, opts);
    const status = res.status;
    const text = await res.text();
    let parsed;
    try { parsed = expectJson ? JSON.parse(text) : text; } catch { parsed = text; }
    const out = { provider: "http", status, body: parsed, headers: Object.fromEntries(res.headers.entries()) };
    return { data: out, status };
  } catch (e) {
    const err = String(e?.message || e);
    emitErr(emit, `http_fetch failed: ${err}`);
    return { data: { provider: "http", error: err } };
  }
}
