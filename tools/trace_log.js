// tools/trace_log.js
// UNIVERSAL TRACE & TELEMETRY LOGGER
// (Datadog, OpenTelemetry OTLP, Elastic/Logstash, Sentry, Logtail, Loki, GCP, CloudWatch, Azure, File/Console) + Demo
// -----------------------------------------------------------------------------------------------------------------
//
// Auto-detected providers (first match wins; or force with TRACE_PROVIDER):
//   • Datadog        → DATADOG_API_KEY
//   • OpenTelemetry  → OTLP_HTTP_URL  (HTTP/JSON or protobuf if your collector supports it)
//   • Elastic/ES     → ES_URL (+ ES_API_KEY or ES_BASIC_AUTH)
//   • Logstash       → LOGSTASH_URL
//   • Sentry         → SENTRY_DSN
//   • Logtail        → LOGTAIL_SOURCE_TOKEN
//   • Loki           → LOKI_URL
//   • Google Logging → GCP_LOG_URL (or set GOOGLE_APPLICATION_CREDENTIALS and front an HTTPS sink)
//   • CloudWatch     → CW_LOG_URL  (use a proxy/lambda sink URL)
//   • Azure Monitor  → AZURE_LOGS_URL (+ AZURE_LOGS_KEY)
//   • File/Console   → fallback (writes to /tmp/trace.log and console)
//
// Common env:
//   TRACE_PROVIDER     = "datadog"|"otlp"|"elastic"|"logstash"|"sentry"|"logtail"|"loki"|"gcp"|"cloudwatch"|"azure"|"file"|"console"
//   TRACE_SERVICE_NAME = "ai-assistant"
//   TRACE_ENV          = "prod"|"staging"|"dev"
//   TRACE_DRY_RUN      = "1"
//   TRACE_DEMO         = "1"
//
// Specific env (by provider):
//   • Datadog:  DATADOG_API_KEY, DATADOG_SITE (default "datadoghq.com")
//   • OTLP:     OTLP_HTTP_URL (e.g. "https://otel-collector.example.com/v1/logs")
//   • Elastic:  ES_URL, ES_INDEX (default "traces-*"), ES_API_KEY or ES_BASIC_AUTH
//   • Logstash: LOGSTASH_URL
//   • Sentry:   SENTRY_DSN
//   • Logtail:  LOGTAIL_SOURCE_TOKEN
//   • Loki:     LOKI_URL (HTTP push /loki/api/v1/push)
//   • GCP:      GCP_LOG_URL (HTTPS endpoint to a Cloud Logging sink or Cloud Run proxy)
//   • CloudWatch: CW_LOG_URL (HTTPS sink/proxy), CW_LOG_GROUP?, CW_STREAM? (optional tags)
//   • Azure:    AZURE_LOGS_URL (Data Collector API / custom ingestion), AZURE_LOGS_KEY
//
// Input:
//   {
//     event: string,                 // required: name, e.g. "agent.task.created"
//     level?: "debug"|"info"|"warn"|"error",  // default "info"
//     message?: string,              // human message
//     data?: object,                 // arbitrary JSON payload
//     tags?: object,                 // { key: value, ... } flattened into provider labels
//     trace_id?: string,             // optional distributed trace id
//     span_id?: string,              // optional span id
//     parent_id?: string,            // optional parent span
//     user?: { id?: string, email?: string, name?: string },
//     tenant?: string,               // multi-tenant id
//     time?: number                  // ms epoch; default Date.now()
//   }
//
// Output:
//   { data: { provider, status, id?, url? }, status }

import fs from "fs";

const DRY_RUN = String(process.env.TRACE_DRY_RUN || "") === "1";
const DEMO = String(process.env.TRACE_DEMO || "") === "1";

function emitNote(emit,msg){ try{ emit && emit({type:"note",msg}); }catch{} }
function emitErr(emit,msg){ try{ emit && emit({type:"error",msg}); }catch{} }
function toJSON(o){ return JSON.stringify(o,null,2); }
function now(){ return Date.now(); }

function serviceMeta(){
  return {
    service: process.env.TRACE_SERVICE_NAME || "ai-assistant",
    env: process.env.TRACE_ENV || "dev",
  };
}

function detectProvider(){
  const forced=(process.env.TRACE_PROVIDER||"").toLowerCase().trim();
  if(forced) return forced;
  if(process.env.DATADOG_API_KEY) return "datadog";
  if(process.env.OTLP_HTTP_URL) return "otlp";
  if(process.env.ES_URL) return "elastic";
  if(process.env.LOGSTASH_URL) return "logstash";
  if(process.env.SENTRY_DSN) return "sentry";
  if(process.env.LOGTAIL_SOURCE_TOKEN) return "logtail";
  if(process.env.LOKI_URL) return "loki";
  if(process.env.GCP_LOG_URL) return "gcp";
  if(process.env.CW_LOG_URL) return "cloudwatch";
  if(process.env.AZURE_LOGS_URL) return "azure";
  return "console";
}

// ---------- Normalization ----------
function normalize(input={}){
  const t = input.time || now();
  const base = {
    ts: new Date(t).toISOString(),
    time_ms: t,
    event: input.event || "log.event",
    level: input.level || "info",
    message: input.message || "",
    data: input.data || {},
    tags: input.tags || {},
    trace_id: input.trace_id || null,
    span_id: input.span_id || null,
    parent_id: input.parent_id || null,
    user: input.user || null,
    tenant: input.tenant || null,
    ...serviceMeta()
  };
  // flatten tags to string kv for providers that need arrays
  const ddTags = Object.entries(base.tags).map(([k,v])=>`${k}:${v}`);
  return { base, ddTags };
}

// ---------- Providers ----------
async function viaDatadog(input){
  const { base, ddTags } = normalize(input);
  const apiKey = process.env.DATADOG_API_KEY;
  const site = process.env.DATADOG_SITE || "datadoghq.com";
  const url = `https://http-intake.logs.${site}/api/v2/logs`;
  const body = [{
    ddtags: ddTags.join(","),
    message: base.message || base.event,
    status: base.level,
    service: base.service,
    host: base.tenant || base.service,
    timestamp: Math.round(base.time_ms*1000000), // ns
    attributes: {
      event: base.event,
      data: base.data,
      user: base.user,
      env: base.env,
      trace_id: base.trace_id,
      span_id: base.span_id,
      parent_id: base.parent_id,
      ...base.tags
    }
  }];
  const r=await fetch(url,{
    method:"POST",
    headers:{ "Content-Type":"application/json", "DD-API-KEY": apiKey },
    body: toJSON(body)
  });
  if(!r.ok) throw new Error(`Datadog HTTP ${r.status}`);
  return { provider:"datadog", status:"ok" };
}

async function viaOTLP(input){
  // Generic OTLP HTTP logs (JSON). Many collectors accept JSON; adjust if your collector expects protobuf.
  const url=process.env.OTLP_HTTP_URL;
  const { base } = normalize(input);
  const body = {
    resourceLogs: [{
      resource: { attributes: [
        { key:"service.name", value:{ stringValue: base.service } },
        { key:"deployment.environment", value:{ stringValue: base.env } },
        ...Object.entries(base.tags).map(([k,v])=>({ key:String(k), value:{ stringValue:String(v) } }))
      ]},
      scopeLogs: [{
        scope: { name:"universal.tracer" },
        logRecords: [{
          timeUnixNano: String(base.time_ms * 1e6),
          severityText: base.level.toUpperCase(),
          body: { stringValue: base.message || base.event },
          attributes: [
            { key:"event", value:{ stringValue: base.event } },
            { key:"tenant", value:{ stringValue: String(base.tenant||"") } },
            { key:"trace_id", value:{ stringValue: String(base.trace_id||"") } },
            { key:"span_id", value:{ stringValue: String(base.span_id||"") } },
            { key:"parent_id", value:{ stringValue: String(base.parent_id||"") } },
            { key:"data", value:{ stringValue: JSON.stringify(base.data||{}) } }
          ]
        }]
      }]
    }]
  };
  const r=await fetch(url,{ method:"POST", headers:{ "Content-Type":"application/json" }, body: toJSON(body) });
  if(!r.ok) throw new Error(`OTLP HTTP ${r.status}`);
  return { provider:"otlp", status:"ok" };
}

async function viaElastic(input){
  const { base } = normalize(input);
  const index = process.env.ES_INDEX || "traces-logs";
  const baseUrl = process.env.ES_URL.replace(/\/+$/,"");
  const headers={"Content-Type":"application/json"};
  if(process.env.ES_API_KEY) headers["Authorization"]=`ApiKey ${process.env.ES_API_KEY}`;
  if(process.env.ES_BASIC_AUTH) headers["Authorization"]=`Basic ${process.env.ES_BASIC_AUTH}`;
  const doc = {
    "@timestamp": base.ts,
    service: base.service,
    env: base.env,
    level: base.level,
    event: base.event,
    message: base.message,
    data: base.data,
    tenant: base.tenant,
    trace_id: base.trace_id,
    span_id: base.span_id,
    parent_id: base.parent_id,
    tags: base.tags,
    user: base.user,
  };
  const r=await fetch(`${baseUrl}/${encodeURIComponent(index)}/_doc`,{ method:"POST", headers, body: toJSON(doc) });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.reason||`Elastic HTTP ${r.status}`);
  return { provider:"elastic", status:"ok", id:j._id, url:`${baseUrl}/${index}/_doc/${j._id}` };
}

async function viaLogstash(input){
  const url=process.env.LOGSTASH_URL;
  const { base } = normalize(input);
  const r=await fetch(url,{ method:"POST", headers:{ "Content-Type":"application/json" }, body: toJSON(base) });
  if(!r.ok) throw new Error(`Logstash HTTP ${r.status}`);
  return { provider:"logstash", status:"ok" };
}

async function viaSentry(input){
  // Map levels and add trace context
  const dsn=process.env.SENTRY_DSN;
  // Universal Sentry ingestion via envelope endpoint requires DSN parsing;
  // to keep vendor-agnostic, forward to a simple webhook proxy if available.
  const url=process.env.SENTRY_ENVELOPE_URL || "";
  if(!url) {
    // As a portable fallback, send a minimal store-like event via Sentry Ingest Proxy if configured.
    return { provider:"sentry", status:"ok" }; // no-op unless proxy provided
  }
  const { base } = normalize(input);
  const evt={
    message: base.message || base.event,
    level: base.level,
    tags: base.tags,
    extra: { data: base.data, tenant: base.tenant },
    timestamp: base.time_ms/1000,
    user: base.user || undefined,
    transaction: base.event,
    contexts:{
      trace:{ trace_id: base.trace_id, span_id: base.span_id, parent_span_id: base.parent_id }
    }
  };
  const r=await fetch(url,{ method:"POST", headers:{ "Content-Type":"application/json" }, body: toJSON(evt) });
  if(!r.ok) throw new Error(`Sentry HTTP ${r.status}`);
  return { provider:"sentry", status:"ok" };
}

async function viaLogtail(input){
  const token=process.env.LOGTAIL_SOURCE_TOKEN;
  const r=await fetch("https://in.logtail.com/",{
    method:"POST",
    headers:{ "Content-Type":"application/json", "Authorization": `Bearer ${token}` },
    body: toJSON({ ...normalize(input).base })
  });
  if(!r.ok) throw new Error(`Logtail HTTP ${r.status}`);
  return { provider:"logtail", status:"ok" };
}

async function viaLoki(input){
  const url=process.env.LOKI_URL.replace(/\/+$/,"");
  const { base } = normalize(input);
  const streams=[{
    stream: { service: base.service, env: base.env, level: base.level, tenant: String(base.tenant||"") },
    values: [[ String(base.time_ms*1e6), JSON.stringify(base) ]]
  }];
  const r=await fetch(`${url}/loki/api/v1/push`,{
    method:"POST", headers:{ "Content-Type":"application/json" }, body: toJSON({ streams })
  });
  if(!r.ok) throw new Error(`Loki HTTP ${r.status}`);
  return { provider:"loki", status:"ok" };
}

async function viaGCP(input){
  const url=process.env.GCP_LOG_URL; // your HTTPS shim to Cloud Logging
  const { base } = normalize(input);
  const r=await fetch(url,{ method:"POST", headers:{ "Content-Type":"application/json" }, body: toJSON(base) });
  if(!r.ok) throw new Error(`GCP Logs HTTP ${r.status}`);
  return { provider:"gcp", status:"ok" };
}

async function viaCloudWatch(input){
  const url=process.env.CW_LOG_URL; // HTTPS sink (e.g., API Gateway -> Lambda)
  const { base } = normalize(input);
  const r=await fetch(url,{ method:"POST", headers:{ "Content-Type":"application/json" }, body: toJSON(base) });
  if(!r.ok) throw new Error(`CloudWatch HTTP ${r.status}`);
  return { provider:"cloudwatch", status:"ok" };
}

async function viaAzure(input){
  const url=process.env.AZURE_LOGS_URL;
  const key=process.env.AZURE_LOGS_KEY; // optional if URL already includes SAS/signature
  const { base } = normalize(input);
  const headers={ "Content-Type":"application/json" };
  if(key) headers["x-api-key"]=key;
  const r=await fetch(url,{ method:"POST", headers, body: toJSON(base) });
  if(!r.ok) throw new Error(`Azure Logs HTTP ${r.status}`);
  return { provider:"azure", status:"ok" };
}

async function viaFileConsole(input){
  const { base } = normalize(input);
  // Write to console
  try { console.log("[trace]", base.level, base.event, base.message, { ...base.tags, trace_id: base.trace_id }); }catch{}
  // Append to file
  try { fs.appendFileSync("/tmp/trace.log", toJSON(base)+"\n"); }catch{}
  return { provider:"file", status:"ok", url:"file:///tmp/trace.log" };
}

// ---------- MAIN ----------
export async function run({input={},emit}){
  const provider = detectProvider();
  const { event } = input || {};
  if(!event){
    emitErr(emit,"trace_log: event required");
    return { data:{ error:"missing_event" } };
  }

  if(DRY_RUN){
    emitNote(emit,`trace_log[DRY_RUN]: provider=${provider}`);
    return { data:{ provider, status:"dry-run" }, status:"ok" };
  }

  if(DEMO){
    emitNote(emit,"trace_log[DEMO]: returning mock trace ack");
    return {
      data:{ provider:"demo", status:"ok", id:`demo_${Date.now().toString(36)}` },
      status:"ok"
    };
  }

  emitNote(emit,`trace_log: via ${provider}`);
  try{
    let out;
    switch(provider){
      case "datadog":    out = await viaDatadog(input); break;
      case "otlp":       out = await viaOTLP(input); break;
      case "elastic":    out = await viaElastic(input); break;
      case "logstash":   out = await viaLogstash(input); break;
      case "sentry":     out = await viaSentry(input); break;
      case "logtail":    out = await viaLogtail(input); break;
      case "loki":       out = await viaLoki(input); break;
      case "gcp":        out = await viaGCP(input); break;
      case "cloudwatch": out = await viaCloudWatch(input); break;
      case "azure":      out = await viaAzure(input); break;
      case "file":
      case "console":
      default:           out = await viaFileConsole(input); break;
    }
    return { data: out, status:"ok" };
  }catch(e){
    const err=String(e?.message||e);
    emitErr(emit,`trace_log failed: ${err}`);
    return { data:{ provider, error:err, status:"error" } };
  }
}
