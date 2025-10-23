export const config = { runtime: "edge" };
import { planAgentSpec } from "../../lib/planner.js";
import { kvGet, kvSet } from "../../lib/kv.js";

export default async function handler(req) {
  const task = await req.json();
  const spec = await planAgentSpec(task);

  const key = `agent:${task.tenant_id}:${spec.agent_id}`;
  // Reuse if exists; otherwise save with TTL per memory policy
  const ttlSec = (spec.memory_policy?.ttl_hours ?? 24) * 3600;
  const existing = await kvGet(key);
  if (!existing) await kvSet(key, spec, ttlSec);

  // Return the run endpoint + agent_id
  return new Response(JSON.stringify({
    agent_id: spec.agent_id,
    run_url: `/api/agent/run?tenant_id=${encodeURIComponent(task.tenant_id)}&agent_id=${spec.agent_id}`
  }), { headers: { "content-type": "application/json" }});
}
