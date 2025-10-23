// Stub: in prod, write to Google Sheets; for now, just emit.
export async function run({ spec, input, emit }) {
  emit({ type:"note", msg:`Log run of ${spec.agent_id} for tenant ${input.tenant_id}` });
  return { link: null };
}
