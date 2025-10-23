// tools/chat_send.js
// UNIVERSAL CHAT SENDER (Slack, Teams, Discord, Telegram, Mattermost, Google Chat, Generic Webhook)
// -------------------------------------------------------------------------------------------------
// Auto-detected providers (first match wins; or force with CHAT_PROVIDER):
//   • Slack (Bot API)        → SLACK_BOT_TOKEN [, SLACK_DEFAULT_CHANNEL]
//   • Slack (Incoming WH)    → SLACK_WEBHOOK_URL
//   • Microsoft Teams (WH)   → TEAMS_WEBHOOK_URL
//   • Discord (Webhook)      → DISCORD_WEBHOOK_URL
//   • Telegram (Bot API)     → TELEGRAM_BOT_TOKEN [, TELEGRAM_CHAT_ID]
//   • Mattermost (Webhook)   → MATTERMOST_WEBHOOK_URL
//   • Google Chat (Webhook)  → GOOGLE_CHAT_WEBHOOK_URL
//   • Generic (Webhook)      → CHAT_GENERIC_WEBHOOK_URL
//
// Common env:
//   CHAT_PROVIDER   = "slack"|"slack_webhook"|"teams"|"discord"|"telegram"|"mattermost"|"gchat"|"webhook"
//   CHAT_DRY_RUN    = "1"      // no external call, just log + return ok
//   CHAT_DEMO       = "1"      // if no provider configured, return mocked success
//
// Input:
//   {
//     text: string,                 // plain text or markdown-ish
//     channel?: string,             // Slack channel id/name OR Discord channel name (ignored for webhooks)
//     thread_ts?: string,           // Slack thread timestamp
//     chat_id?: string|number,      // Telegram chat id fallback (or env TELEGRAM_CHAT_ID)
//     username?: string,            // override display name where supported (Discord/MM/webhook)
//     icon_emoji?: string,          // Slack webhook / Mattermost ("😀")
//     icon_url?: string,            // Slack webhook / Mattermost
//     blocks?: any[],               // Slack Block Kit (only for Slack Bot API)
//     attachments?: Array<{         // optional lightweight file/link attaches
//       title?: string,
//       text?: string,
//       url?: string
//     }>,
//     card?: object                 // Google Chat card or Teams card payload (advanced; pass-thru)
//   }
//
// Output:
//   { data: { provider, id?: string|null, channel?: string|null }, link?: string }
//
// Notes:
//   • Prefers token-based Slack when available (threads, blocks).
//   • Webhook variants ignore channel routing (they’re bound to the webhook).
//   • Designed to be Edge-compatible (pure HTTP). No SDK versions pinned.

const DRY_RUN  = String(process.env.CHAT_DRY_RUN || "") === "1";
const DEMO     = String(process.env.CHAT_DEMO || process.env.MAIL_DEMO || "") === "1";

function detectProvider() {
  const forced = (process.env.CHAT_PROVIDER || "").toLowerCase().trim();
  if (forced) return forced;
  if (process.env.SLACK_BOT_TOKEN)          return "slack";
  if (process.env.SLACK_WEBHOOK_URL)        return "slack_webhook";
  if (process.env.TEAMS_WEBHOOK_URL)        return "teams";
  if (process.env.DISCORD_WEBHOOK_URL)      return "discord";
  if (process.env.TELEGRAM_BOT_TOKEN)       return "telegram";
  if (process.env.MATTERMOST_WEBHOOK_URL)   return "mattermost";
  if (process.env.GOOGLE_CHAT_WEBHOOK_URL)  return "gchat";
  if (process.env.CHAT_GENERIC_WEBHOOK_URL) return "webhook";
  return null;
}

function emitNote(emit, msg){ try { emit && emit({ type:"note", msg }); } catch {} }
function emitWarn(emit, msg){ try { emit && emit({ type:"warn", msg }); } catch {} }
function emitErr(emit, msg){  try { emit && emit({ type:"error", msg }); } catch {} }

// ---------------- Slack (Bot API) ----------------
async function viaSlackBot({ text, channel, thread_ts, blocks }) {
  const token = process.env.SLACK_BOT_TOKEN;
  const ch = channel || process.env.SLACK_DEFAULT_CHANNEL;
  if (!token) throw new Error("Missing SLACK_BOT_TOKEN");
  if (!ch) throw new Error("Slack channel missing (set input.channel or SLACK_DEFAULT_CHANNEL)");
  const body = {
    channel: ch,
    text: text || "",
    ...(thread_ts ? { thread_ts } : {}),
    ...(Array.isArray(blocks) && blocks.length ? { blocks } : {}),
  };
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type":"application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(()=> ({}));
  if (!j.ok) throw new Error(`Slack API: ${j.error || "unknown_error"}`);
  return { id: j.ts || null, channel: j.channel || ch, link: j.message?.permalink || undefined };
}

// ---------------- Slack (Incoming Webhook) ----------------
async function viaSlackWebhook({ text, username, icon_emoji, icon_url }) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) throw new Error("Missing SLACK_WEBHOOK_URL");
  const body = {
    text: text || "",
    ...(username ? { username } : {}),
    ...(icon_emoji ? { icon_emoji } : {}),
    ...(icon_url ? { icon_url } : {}),
  };
  const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Slack Webhook HTTP ${r.status}`);
  return { id: null, channel: null };
}

// ---------------- Microsoft Teams (Incoming Webhook) ----------------
async function viaTeams({ text, card }) {
  const url = process.env.TEAMS_WEBHOOK_URL;
  if (!url) throw new Error("Missing TEAMS_WEBHOOK_URL");
  // Simple text (MessageCard) or full Adaptive Card pass-through
  const payload = card || { text: text || "" };
  const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`Teams Webhook HTTP ${r.status}`);
  return { id: null, channel: null };
}

// ---------------- Discord (Webhook) ----------------
async function viaDiscord({ text, username }) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) throw new Error("Missing DISCORD_WEBHOOK_URL");
  const body = { content: text || "", ...(username ? { username } : {}) };
  const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Discord Webhook HTTP ${r.status}`);
  const j = await r.json().catch(()=> ({}));
  // some discord webhooks return created message json; others return 204
  return { id: j.id || null, channel: null, link: j.id ? undefined : undefined };
}

// ---------------- Telegram (Bot API) ----------------
async function viaTelegram({ text, chat_id }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const cid = chat_id || process.env.TELEGRAM_CHAT_ID;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  if (!cid) throw new Error("Missing chat_id (input.chat_id or TELEGRAM_CHAT_ID)");
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ chat_id: cid, text: text || "", parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const j = await r.json().catch(()=> ({}));
  if (!j.ok) throw new Error(`Telegram: ${j.description || "unknown_error"}`);
  return { id: String(j.result?.message_id || ""), channel: String(cid) };
}

// ---------------- Mattermost (Incoming Webhook) ----------------
async function viaMattermost({ text, username, icon_emoji, icon_url }) {
  const url = process.env.MATTERMOST_WEBHOOK_URL;
  if (!url) throw new Error("Missing MATTERMOST_WEBHOOK_URL");
  const body = { text: text || "", ...(username ? { username } : {}), ...(icon_emoji ? { icon_emoji } : {}), ...(icon_url ? { icon_url } : {}) };
  const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Mattermost Webhook HTTP ${r.status}`);
  return { id: null, channel: null };
}

// ---------------- Google Chat (Incoming Webhook) ----------------
async function viaGoogleChat({ text, card }) {
  const url = process.env.GOOGLE_CHAT_WEBHOOK_URL;
  if (!url) throw new Error("Missing GOOGLE_CHAT_WEBHOOK_URL");
  const payload = card ? { cardsV2: [card] } : { text: text || "" };
  const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`Google Chat Webhook HTTP ${r.status}`);
  return { id: null, channel: null };
}

// ---------------- Generic Webhook ----------------
async function viaGenericWebhook({ text, username }) {
  const url = process.env.CHAT_GENERIC_WEBHOOK_URL;
  if (!url) throw new Error("Missing CHAT_GENERIC_WEBHOOK_URL");
  const body = { text: text || "", username: username || undefined, ts: Date.now() };
  const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Generic Webhook HTTP ${r.status}`);
  return { id: null, channel: null };
}

// -------------------------------- MAIN --------------------------------
export async function run({ input = {}, emit }) {
  const provider = detectProvider();
  const text = input.text || "";

  if (DRY_RUN) {
    emitNote(emit, `chat_send[DRY_RUN]: provider=${provider || "n/a"} text="${text.slice(0,80)}"`);
    return { data: { provider: provider || "dry-run", id: null, channel: input.channel || null } };
  }

  if (!provider) {
    if (DEMO) {
      const fakeId = "demo_" + Math.random().toString(36).slice(2,8);
      emitNote(emit, `chat_send[DEMO]: No provider configured; returning mocked id=${fakeId}`);
      return { data: { provider: "demo", id: fakeId, channel: input.channel || null }, link: "about:blank#demo-chat" };
    }
    emitErr(emit, "chat_send: No chat provider configured (set CHAT_PROVIDER or provider envs).");
    return { data: { error: "no_provider_configured" } };
  }

  emitNote(emit, `chat_send: via ${provider}`);

  try {
    let out;
    switch (provider) {
      case "slack":
        out = await viaSlackBot({ text, channel: input.channel, thread_ts: input.thread_ts, blocks: input.blocks });
        break;
      case "slack_webhook":
        out = await viaSlackWebhook({ text, username: input.username, icon_emoji: input.icon_emoji, icon_url: input.icon_url });
        break;
      case "teams":
        out = await viaTeams({ text, card: input.card });
        break;
      case "discord":
        out = await viaDiscord({ text, username: input.username });
        break;
      case "telegram":
        out = await viaTelegram({ text, chat_id: input.chat_id });
        break;
      case "mattermost":
        out = await viaMattermost({ text, username: input.username, icon_emoji: input.icon_emoji, icon_url: input.icon_url });
        break;
      case "gchat":
        out = await viaGoogleChat({ text, card: input.card });
        break;
      case "webhook":
        out = await viaGenericWebhook({ text, username: input.username });
        break;
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }

    return {
      data: { provider, id: out?.id || null, channel: out?.channel || input.channel || null },
      link: out?.link,
    };
  } catch (e) {
    const err = String(e?.message || e);
    emitErr(emit, `chat_send failed: ${err}`);
    return { data: { error: err, provider } };
  }
}
