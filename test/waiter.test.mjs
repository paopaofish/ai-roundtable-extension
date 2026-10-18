// Deterministic tests for the reply-completion waiter — no browser needed.
// A fake clock + scripted reply sequences let us cover the cases that are
// impossible to reproduce reliably against live chat sites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sandbox = { window: {}, Error, Math, Number, String, JSON };
vm.createContext(sandbox);
vm.runInContext(readFileSync(new URL('../src/waiter.js', import.meta.url), 'utf8'), sandbox);
const { createReplyWaiter } = sandbox.window.__AIR;

const SCAFFOLD_RE = /(你更喜欢哪个回复|搜索中|正在搜索|正在思考)/i;
const isScaffold = (t) => (SCAFFOLD_RE.test(t) && t.length < 200) || /^回复\s*\d/m.test(t);
const hasCleanEnd = (t) => /[。！？…]$/.test(t.trim());

/** Build a waiter whose readReply pops from a scripted list (repeat last). */
function harness(frames, { now0 = 1_000_000 } = {}) {
  let clock = now0;
  let i = 0;
  const trace = [];
  const waiter = createReplyWaiter({
    readReply: () => {
      const frame = frames[Math.min(i, frames.length - 1)];
      i += 1;
      return typeof frame === 'function' ? frame() : frame;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    isScaffold,
    hasCleanEnd,
    trace: (m, d) => trace.push({ m, d }),
  });
  return { waiter, trace, advance: (ms) => (clock += ms) };
}

test('accepts a complete answer once it stops changing', async () => {
  const { waiter } = harness([
    { count: 0, text: '' },
    { count: 1, text: '我认为' },
    { count: 1, text: '我认为应该' },
    { count: 1, text: '我认为应该优先投人。' },
  ]);
  const text = await waiter('', { timeoutMs: 60000 });
  assert.equal(text, '我认为应该优先投人。');
});

test('ignores scaffolding and waits for the real answer', async () => {
  // Stay on the loader long enough for it to look "settled" (stableMs), then
  // switch to the real answer.
  let calls = 0;
  const { waiter, trace } = harness([
    () => {
      calls += 1;
      return calls <= 20
        ? { count: 1, text: '正在思考...' }
        : { count: 1, text: '完整的回答在这里。' };
    },
  ]);
  const text = await waiter('', { timeoutMs: 120000 });
  assert.equal(text, '完整的回答在这里。');
  assert.ok(trace.some((t) => t.m === 'scaffold-wait'), 'should have skipped scaffolding');
});

test('accepts a settled answer that never ends with punctuation', async () => {
  const { waiter } = harness([
    { count: 1, text: '没有句号的回答' },
    { count: 1, text: '没有句号的回答' },
  ]);
  const text = await waiter('', { timeoutMs: 120000, cleanEndGraceMs: 15000 });
  assert.equal(text, '没有句号的回答');
});

test('throws E_NO_REPLY when nothing new appears', async () => {
  const { waiter } = harness([{ count: 0, text: '' }]);
  await assert.rejects(
    () => waiter('', { timeoutMs: 120000, firstReplyMs: 5000 }),
    (err) => err.code === 'E_NO_REPLY',
  );
});

test('throws E_TIMEOUT with the partial text', async () => {
  // Text keeps growing forever -> never stable.
  let n = 0;
  const { waiter } = harness([() => ({ count: 1, text: '增长中'.repeat(++n) })]);
  await assert.rejects(
    () => waiter('', { timeoutMs: 20000, stableMs: 4000 }),
    (err) => {
      assert.equal(err.code, 'E_TIMEOUT');
      assert.ok(err.partial.length > 0);
      return true;
    },
  );
});

test('ignores an unchanged baseline reply', async () => {
  const baseline = '上一轮的旧回答。';
  const { waiter } = harness([
    { count: 1, text: baseline },
    { count: 1, text: baseline },
    { count: 2, text: '这是新回答。' },
  ]);
  const text = await waiter(baseline, { timeoutMs: 60000 });
  assert.equal(text, '这是新回答。');
});

test('recovers from transient read errors', async () => {
  let calls = 0;
  const { waiter } = harness([
    () => {
      calls += 1;
      if (calls <= 2) throw new Error('tab busy');
      return { count: 1, text: '恢复之后的回答。' };
    },
  ]);
  const text = await waiter('', { timeoutMs: 60000 });
  assert.equal(text, '恢复之后的回答。');
});

test('fails fast on a dead page', async () => {
  const { waiter } = harness([
    () => {
      throw new Error('no such frame');
    },
  ]);
  await assert.rejects(
    () => waiter('', { timeoutMs: 60000 }),
    (err) => err.code === 'E_UNRESPONSIVE',
  );
});

test('auto-resolves an A/B comparison card', async () => {
  let picked = false;
  let clock = 0;
  const waiter = createReplyWaiter({
    readReply: () => (picked ? { count: 1, text: '选中的回答。' } : { count: 0, text: '' }),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    isScaffold,
    hasCleanEnd,
    resolveAmbiguity: () => {
      if (picked) return false;
      picked = true;
      return true;
    },
  });
  const text = await waiter('', { timeoutMs: 60000 });
  assert.equal(text, '选中的回答。');
});
