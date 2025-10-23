import * as httpFetch from "../tools/http_fetch.js";
import * as sheetsLog from "../tools/sheets_log.js";
import * as calendar from "../tools/calendar_create_event.js";

const TOOLBOX = {
  "http.fetch": httpFetch,
  "sheets.write_log": sheetsLog,
  "calendar.create_event": calendar,
};

export async function runWithSpec({ spec, input, emit }) {
  emit({ type: "plan", msg: "Planning steps" });

  // SUPER SIMPLE planner → sequence by tools
  const steps = [...spec.tools];

  const ctx = { input, artifacts: [], links: [], notes: [] };

  for (const t of steps) {
    emit({ type: "tool", name: t, msg: `Running ${t}` });
    const mod = TOOLBOX[t];
    if (!mod || !mod.run) { emit({ type:"warn", msg:`No adapter for ${t}` }); continue; }
    const out = await mod.run({ spec, input, ctx, emit });
    if (out?.artifact) ctx.artifacts.push(out.artifact);
    if (out?.link) ctx.links.push(out.link);
  }

  // Compose final
  const summary = `Completed: ${spec.goal}`;
  const result = { ok: true, summary, artifacts: ctx.artifacts, links: ctx.links };
  return result;
}
