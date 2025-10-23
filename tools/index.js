// /tools/index.js
// Tiny universal tool runner. Dynamically imports any tool file in /tools and calls `run({input, emit})`.
//
// Usage:
//   const { runTool } = require('../tools');
//   await runTool('email_send', { to:'x@x.com', subject:'Hi' }, (evt)=>console.log(evt));
//
// Notes:
//   • Tools in this repo export `export async function run({input, emit})` (ESM).
//   • This runner uses dynamic import so it works from CommonJS code (Node 18+).
//   • All tools include DEMO/DRY_RUN env flags — so you can test without real keys.

const pathBase = process.cwd().replace(/\\/g, "/") + "/tools";

async function runTool(name, input = {}, emit = null) {
  if (!name) throw new Error("runTool: missing tool name");
  const file = `${pathBase}/${name}.js`;
  let mod;
  try {
    mod = await import(file + `?v=${Date.now()}`); // bust require cache in dev
  } catch (e) {
    throw new Error(`runTool: cannot import ${name} (${file}): ${String(e.message || e)}`);
  }
  if (!mod || typeof mod.run !== "function") {
    throw new Error(`runTool: ${name} missing exported async function run({input,emit})`);
  }
  const safeEmit = (evt) => { try { emit && emit(evt); } catch {} };
  return await mod.run({ input, emit: safeEmit });
}

module.exports = { runTool };
