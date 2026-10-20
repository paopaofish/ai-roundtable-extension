// Live-test the real content script in a real chat page.
//
//   node tools/live-test.mjs <session> [prompt] [timeoutSeconds]
//
// It loads src/sites.js + src/agent.js into the page's main world with the
// debug hook enabled, then drives prepare()/ask() exactly like the extension
// does. This exercises the shipped code, not a copy — WebBridge is only the
// transport here.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, wb, sleep } from './wb.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const session = process.argv[2] || 'zhipu';
const prompt = process.argv[3] || '用一句话回答：2 加 3 等于几？';
const askTimeoutSec = Number(process.argv[4] || 180);

// Mirror the extension's focusTab(): an activated tab is not timer-throttled
// and accepts synthetic input far more reliably than a background one.
const sitesText = readFileSync(join(ROOT, 'src/sites.js'), 'utf8');
const urlMatch = sitesText.match(new RegExp(`${session}[^]*?url: '([^']+)'`));
const siteUrl = urlMatch ? urlMatch[1] : null;
try {
  const here = await evaluate('(() => JSON.stringify({ url: location.href }))()', session, { timeoutMs: 15000 });
  const current = here && here.url && !here.url.startsWith('chrome-extension://') ? here.url : siteUrl;
  if (current) {
    await wb('navigate', { url: current, newTab: true }, session, { timeoutMs: 60000 });
    await sleep(2500);
    console.log(`[${session}] 已激活标签页 ${current.slice(0, 60)}`);
  }
} catch (err) {
  if (siteUrl) {
    await wb('navigate', { url: siteUrl, newTab: true }, session, { timeoutMs: 60000 }).catch(() => {});
    await sleep(2500);
    console.log(`[${session}] 标签页缺失，已重建 ${siteUrl.slice(0, 60)}`);
  } else {
    console.log(`[${session}] 激活标签页失败（继续测试）: ${err.message.slice(0, 60)}`);
  }
}

const sitesSrc = readFileSync(join(ROOT, 'src/sites.js'), 'utf8');
const waiterSrc = readFileSync(join(ROOT, 'src/waiter.js'), 'utf8');
const agentSrc = readFileSync(join(ROOT, 'src/agent.js'), 'utf8');

const inject = `(() => {
  window.__AIR_TRACE = [];
  window.__AIR_DEBUG__ = true;
  window.__AIR_TEST = null;
  window.__AIR_AGENT_READY = false;
  try {
    ${sitesSrc}
  } catch (e) { return JSON.stringify({ ok: false, step: 'sites', error: e.message }); }
  try {
    ${waiterSrc}
  } catch (e) { return JSON.stringify({ ok: false, step: 'waiter', error: e.message }); }
  try {
    ${agentSrc}
  } catch (e) { return JSON.stringify({ ok: false, step: 'agent', error: e.message }); }
  return JSON.stringify({ ok: !!window.__AIR_TEST, site: window.__AIR && window.__AIR.site && window.__AIR.site.id });
})()`;

const dumpTrace = async (n = 40) => {
  try {
    const t = await evaluate(
      `(() => JSON.stringify((window.__AIR_TRACE || []).slice(-${n})))()`,
      session,
      { timeoutMs: 15000 },
    );
    console.log('\n--- trace ---');
    for (const row of t || []) console.log(`  ${String(row.t).padStart(6)}ms  ${row.msg}  ${row.data ? JSON.stringify(row.data) : ''}`);
  } catch (err) {
    console.log('trace unavailable:', err.message);
  }
};

console.log(`[${session}] 注入 agent.js …`);
const injected = await evaluate(inject, session, { timeoutMs: 30000 });
console.log('inject →', JSON.stringify(injected));
if (!injected || !injected.ok) {
  console.error('注入失败');
  process.exit(1);
}

console.log(`[${session}] prepare() …`);
const prep = await evaluate('(async () => JSON.stringify(await window.__AIR_TEST.prepare()))()', session, {
  timeoutMs: 60000,
});
console.log('prepare →', JSON.stringify(prep));

console.log(`[${session}] ask() … (最多 ${askTimeoutSec}s)`);
const t0 = Date.now();
try {
  const res = await evaluate(
    `(async () => {
       try {
         const text = await window.__AIR_TEST.ask(${JSON.stringify(prompt)}, { timeoutMs: ${askTimeoutSec * 1000} });
         return JSON.stringify({ ok: true, text });
       } catch (e) {
         return JSON.stringify({ ok: false, error: e.message, code: e.code, partial: e.partial || '' });
       }
     })()`,
    session,
    { timeoutMs: (askTimeoutSec + 20) * 1000 },
  );
  const secs = Math.round((Date.now() - t0) / 1000);
  if (res && res.ok) {
    console.log(`\n✅ ${secs}s 收到 ${res.text.length} 字\n---\n${res.text}\n---`);
  } else {
    console.log(`\n❌ ${secs}s 失败: ${res && res.code} ${res && res.error}`);
    if (res && res.partial) console.log('partial:', JSON.stringify(res.partial));
    process.exitCode = 1;
  }
} catch (err) {
  console.log(`\n❌ ${Math.round((Date.now() - t0) / 1000)}s 传输层错误: ${err.message}`);
  process.exitCode = 1;
}
await dumpTrace();
