export const config = { runtime: "edge" };
import { kvGet } from "../../lib/kv.js";
import { sseResponse } from "../../lib/sse.js";
import { runWithSpec } from "../../lib/runner.js";

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const tenant_id = searchParams.get("tenant_id");
  const agent_id  = searchParams.get("agent_id");

  // Load spec from KV
  const spec = await kvGet(`agent:${tenant_id}:${agent_id}`);
  if (!spec) return new Response(JSON.stringify({ error: "agent_not_found" }), { status: 404 });

  const input = req.method === "POST" ? await req.json() : {};

  return sseResponse(async (emit) => {
    emit({ type:"info", msg:`Running ${agent_id}` });
    const result = await runWithSpec({ spec, input: { ...input, tenant_id }, emit });
    emit({ type:"final", result });
  });
}
