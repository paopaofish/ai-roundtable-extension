// Minimal Kimi WebBridge client used only for local debugging.
// The extension itself never talks to this endpoint.
const ENDPOINT = process.env.WB_ENDPOINT || 'http://127.0.0.1:10086/command';

export async function wb(action, args = {}, session, { timeoutMs = 180000 } = {}) {
  const payload = { action, args };
  if (session) payload.session = session;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    const json = JSON.parse(text);
    if (!json.ok) throw new Error(json.error?.message || JSON.stringify(json.error));
    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

export async function evaluate(code, session, opts) {
  const data = await wb('evaluate', { code }, session, opts);
  if (data && typeof data === 'object' && 'value' in data) {
    const v = data.value;
    if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    }
    return v;
  }
  return data;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
