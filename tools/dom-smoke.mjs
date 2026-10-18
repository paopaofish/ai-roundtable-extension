// Read-only smoke test: injects the real scripts into each live page and
// reports whether the selectors still resolve. Safe to run at any time — it
// never types, clicks or scrolls.
//
//   node tools/dom-smoke.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate } from './wb.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sitesSrc = readFileSync(join(ROOT, 'src/sites.js'), 'utf8');
const waiterSrc = readFileSync(join(ROOT, 'src/waiter.js'), 'utf8');
const agentSrc = readFileSync(join(ROOT, 'src/agent.js'), 'utf8');

const inject = `(() => {
  window.__AIR_DEBUG__ = true;
  window.__AIR_AGENT_READY = false;
  ${sitesSrc}
  ${waiterSrc}
  ${agentSrc}
  return JSON.stringify({ ok: !!window.__AIR_TEST, site: window.__AIR_TEST && window.__AIR_TEST.site.id });
})()`;

const SESSIONS = ['doubao', 'qwen', 'zhipu', 'deepseek'];
let failures = 0;

for (const session of SESSIONS) {
  let line = session.padEnd(9);
  try {
    const injected = await evaluate(inject, session, { timeoutMs: 25000 });
    if (!injected || !injected.ok) throw new Error('注入失败');
    const report = await evaluate(
      `(() => {
        const t = window.__AIR_TEST;
        const ed = t.findEditor();
        const r = t.readReplyNow();
        return JSON.stringify({
          label: t.site.label,
          editor: ed ? ed.sel : null,
          tag: ed ? ed.el.tagName : null,
          replyCount: r.count,
          lastLen: r.text.length,
          lastHead: r.text.slice(0, 30),
        });
      })()`,
      session,
      { timeoutMs: 20000 },
    );
    const good = report.editor;
    if (!good) failures += 1;
    line += good ? '✅ ' : '❌ ';
    line += `editor=${report.editor || '未找到'} <${report.tag || '-'}>  reply=${report.replyCount} 字 ${report.lastLen}`;
    line += report.lastHead ? `  “${report.lastHead}”` : '';
    console.log(line);
  } catch (err) {
    failures += 1;
    console.log(`${line}❌ ${err.message.slice(0, 80)}`);
  }
}

console.log(failures === 0 ? '\n全部选择器有效' : `\n${failures} 个站点异常`);
process.exitCode = failures === 0 ? 0 : 1;
