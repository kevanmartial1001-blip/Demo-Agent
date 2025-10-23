// tools/calendar_find_slots.js
// UNIVERSAL CALENDAR AVAILABILITY FINDER (Google, Outlook, Cronofy, Nylas) + Demo
// -------------------------------------------------------------------------------
// Auto-detected providers (first match wins; or force with CAL_PROVIDER):
//   • Google Calendar   → GOOGLE_ACCESS_TOKEN
//   • Outlook (Graph)   → MS_GRAPH_TOKEN or OAUTH_MS_TOKEN
//   • Cronofy           → CRONOFY_ACCESS_TOKEN
//   • Nylas             → NYLAS_ACCESS_TOKEN
//
// Common env:
//   CAL_PROVIDER   = "google"|"outlook"|"cronofy"|"nylas"
//   CAL_DRY_RUN    = "1"
//   CAL_DEMO       = "1"
//
// Input:
//   {
//     start: string|Date,           // window start ISO
//     end: string|Date,             // window end ISO
//     attendees?: string[],         // optional list of emails
//     durationMinutes?: number,     // optional (for slot sizing)
//     timezone?: string             // e.g. "Europe/Madrid"
//   }
//
// Output:
//   {
//     data: {
//       provider: string,
//       slots: [{ start, end }],
//       busy?: [{ start, end }],
//     }
//   }
//
// Notes:
//   • Uses each provider's freeBusy endpoint.
//   • Demo mode generates mock availability for the UI.
//   • Ideal for meeting schedulers and assistants.

const DRY_RUN = String(process.env.CAL_DRY_RUN || "") === "1";
const DEMO    = String(process.env.CAL_DEMO || "") === "1";

function detectProvider() {
  const forced = (process.env.CAL_PROVIDER || "").toLowerCase().trim();
  if (forced) return forced;
  if (process.env.GOOGLE_ACCESS_TOKEN) return "google";
  if (process.env.MS_GRAPH_TOKEN || process.env.OAUTH_MS_TOKEN) return "outlook";
  if (process.env.CRONOFY_ACCESS_TOKEN) return "cronofy";
  if (process.env.NYLAS_ACCESS_TOKEN) return "nylas";
  return null;
}

function emitNote(emit,msg){try{emit&&emit({type:"note",msg});}catch{}}
function emitErr(emit,msg){try{emit&&emit({type:"error",msg});}catch{}}
function toJSON(o){return JSON.stringify(o,null,2);}
function iso(x){return typeof x==="string"?x:new Date(x).toISOString();}

// -------------- GOOGLE FREEBUSY --------------
async function viaGoogle({ start, end, attendees }) {
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  if (!token) throw new Error("Missing GOOGLE_ACCESS_TOKEN");
  const body = {
    timeMin: iso(start),
    timeMax: iso(end),
    items: (attendees || ["primary"]).map(email => ({ id: email })),
  };
  const r = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Google FreeBusy HTTP ${r.status}`);
  const busyBlocks = Object.values(j.calendars || {}).flatMap(c => c.busy || []);
  return { busy: busyBlocks };
}

// -------------- OUTLOOK GRAPH FREEBUSY --------------
async function viaOutlook({ start, end, attendees, timezone }) {
  const token = process.env.MS_GRAPH_TOKEN || process.env.OAUTH_MS_TOKEN;
  if (!token) throw new Error("Missing MS_GRAPH_TOKEN");
  const body = {
    schedules: attendees || [],
    startTime: { dateTime: iso(start), timeZone: timezone || "UTC" },
    endTime: { dateTime: iso(end), timeZone: timezone || "UTC" },
    availabilityViewInterval: 30,
  };
  const r = await fetch("https://graph.microsoft.com/v1.0/me/calendar/getSchedule", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Outlook getSchedule HTTP ${r.status}`);
  const busy = j.value?.flatMap(x =>
    (x.scheduleItems || []).map(i => ({ start: i.start.dateTime, end: i.end.dateTime }))
  ) || [];
  return { busy };
}

// -------------- CRONOFY FREEBUSY --------------
async function viaCronofy({ start, end, attendees }) {
  const token = process.env.CRONOFY_ACCESS_TOKEN;
  if (!token) throw new Error("Missing CRONOFY_ACCESS_TOKEN");
  const body = {
    participants: (attendees || []).map(email => ({ email })),
    from: iso(start),
    to: iso(end),
  };
  const r = await fetch("https://api.cronofy.com/v1/free_busy", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Cronofy HTTP ${r.status}`);
  return { busy: j.free_busy || [] };
}

// -------------- NYLAS FREEBUSY --------------
async function viaNylas({ start, end, attendees }) {
  const token = process.env.NYLAS_ACCESS_TOKEN;
  if (!token) throw new Error("Missing NYLAS_ACCESS_TOKEN");
  const body = {
    emails: attendees || [],
    start_time: Math.floor(new Date(start).getTime() / 1000),
    end_time: Math.floor(new Date(end).getTime() / 1000),
  };
  const r = await fetch("https://api.nylas.com/calendars/free-busy", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Nylas HTTP ${r.status}`);
  return { busy: j.time_slots || [] };
}

// -------------- MAIN ENTRY --------------
export async function run({ input = {}, emit }) {
  const provider = detectProvider();
  const start = input.start;
  const end = input.end;
  const attendees = input.attendees || [];
  const durationMinutes = input.durationMinutes || 30;
  const timezone = input.timezone || "UTC";

  if (!start || !end) {
    emitErr(emit, "calendar_find_slots: start and end are required");
    return { data: { error: "missing_fields" } };
  }

  if (DRY_RUN) {
    emitNote(emit, `calendar_find_slots[DRY_RUN]: provider=${provider || "n/a"}`);
    return { data: { provider: provider || "dry-run", slots: [] } };
  }

  if (!provider) {
    if (DEMO) {
      // Generate mock availability every 2h blocks in window
      const s = new Date(start);
      const e = new Date(end);
      const slots = [];
      while (s < e) {
        const slotEnd = new Date(s.getTime() + durationMinutes * 60000);
        slots.push({ start: s.toISOString(), end: slotEnd.toISOString() });
        s.setHours(s.getHours() + 2);
      }
      emitNote(emit, "calendar_find_slots[DEMO]: returning fake slots");
      return { data: { provider: "demo", slots } };
    }
    emitErr(emit, "calendar_find_slots: no provider configured.");
    return { data: { error: "no_provider_configured" } };
  }

  emitNote(emit, `calendar_find_slots: via ${provider}`);

  try {
    let out;
    switch (provider) {
      case "google":  out = await viaGoogle({ start, end, attendees }); break;
      case "outlook": out = await viaOutlook({ start, end, attendees, timezone }); break;
      case "cronofy": out = await viaCronofy({ start, end, attendees }); break;
      case "nylas":   out = await viaNylas({ start, end, attendees }); break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }

    // Basic availability inference
    const busy = out.busy || [];
    const slots = busy.length === 0
      ? [{ start, end }]
      : [{ start, end }]; // (You can later implement busy→free logic)

    return { data: { provider, slots, busy } };
  } catch (e) {
    const err = String(e?.message || e);
    emitErr(emit, `calendar_find_slots failed: ${err}`);
    return { data: { error: err, provider } };
  }
}
