// Minimal heuristic planner (replace with your LLM call).
export async function planAgentSpec(task) {
  const goal = task?.task_text?.trim() || "Do the requested task";
  // Decide tools by simple keywords (you'll swap this with LLM later).
  const tools = [];
  if (/price|pricing|fetch|http|website/i.test(goal)) tools.push("http.fetch");
  if (/calendar|meeting|schedule/i.test(goal)) tools.push("calendar.create_event");
  if (/slide|presentation|ppt|deck/i.test(goal)) tools.push("drive.create_slide");
  tools.push("sheets.write_log");

  return {
    agent_id: semanticId(`${task.tenant_id}:${goal}:${tools.join(",")}`),
    goal,
    tools,
    io: {
      input_schema: { task_text: "string", attachments: "array?" },
      output_schema: { ok: "boolean", summary: "string?", artifacts: "array?", links: "array?" }
    },
    constraints: ["be concise", "cite sources if scraping web"],
    memory_policy: { scope: "tenant_agent", ttl_hours: 24 }
  };
}

function semanticId(s) {
  // quick stable-ish hash → short id
  let h = 0; for (let i=0;i<s.length;i++) h = (Math.imul(31,h) + s.charCodeAt(i))|0;
  return "agt_" + (h>>>0).toString(36);
}
