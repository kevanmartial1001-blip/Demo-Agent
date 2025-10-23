export async function run({ input, emit }) {
  const url = input?.url || input?.task_text?.match(/https?:\/\/\S+/)?.[0];
  if (!url) return;
  const res = await fetch(url, { headers: { "User-Agent": "MetaAgent/1.0" }});
  const text = await res.text();
  emit({ type:"note", msg:`Fetched ${url} (${text.length} chars)` });
  return { artifact: { type: "text", url, bytes: text.length } };
}
