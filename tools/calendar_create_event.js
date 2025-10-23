export async function run({ input, emit }) {
  if (!/calendar|meeting|schedule/i.test(input?.task_text||"")) return;
  // Stub: call Google Calendar API here
  const fakeLink = "https://calendar.google.com/event?eid=demo";
  emit({ type:"note", msg:"(stub) Would create calendar event via Google API" });
  return { link: fakeLink };
}
