// Simple in-memory KV for dev. Replace with Upstash Redis for prod.
const _kv = new Map();
export async function kvGet(key) { return _kv.get(key) ?? null; }
export async function kvSet(key, val, ttlSec) {
  _kv.set(key, val);
  if (ttlSec) setTimeout(() => _kv.delete(key), ttlSec * 1000).unref?.();
}
export async function kvDel(key) { _kv.delete(key); }
