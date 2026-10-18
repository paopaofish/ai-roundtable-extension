import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSpeakerPrompt,
  buildSummaryPrompt,
  fallbackSummary,
  buildMarkdown,
  safeFileName,
  fmtDuration,
  RULES,
} from '../src/core.js';

test('buildSpeakerPrompt: round 1, first speaker', () => {
  const p = buildSpeakerPrompt({
    topic: '小团队该不该全面转向 AI 辅助开发？',
    round: 1,
    rounds: 3,
    speaker: '豆包',
    turns: [],
  });
  assert.match(p, /你是「豆包」/);
  assert.match(p, /小团队该不该全面转向 AI 辅助开发？/);
  assert.match(p, /第 1 \/ 3 轮/);
  assert.match(p, /还没有人发言/);
  assert.ok(p.includes(RULES), 'must carry the debate rules');
});

test('buildSpeakerPrompt: same-round context is included verbatim-ish', () => {
  const p = buildSpeakerPrompt({
    topic: 'T',
    round: 2,
    rounds: 2,
    speaker: '千问',
    turns: [
      { round: 1, speaker: '豆包', text: '豆包第一轮的观点。' },
      { round: 2, speaker: '豆包', text: '豆包第二轮的观点，应当完整出现。' },
    ],
  });
  assert.match(p, /豆包第二轮的观点，应当完整出现。/);
  assert.match(p, /第1轮 豆包/);
});

test('buildSpeakerPrompt: respects the character budget', () => {
  const long = '很长的发言。'.repeat(500);
  const p = buildSpeakerPrompt({
    topic: 'T',
    round: 2,
    rounds: 2,
    speaker: '智谱清言',
    turns: [{ round: 1, speaker: '豆包', text: long }],
    maxChars: 1200,
  });
  assert.ok(p.length <= 1200, `prompt should be <= 1200 chars, got ${p.length}`);
});

test('buildSpeakerPrompt: omitted marker appears when context is dropped', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    round: 1,
    speaker: `S${i}`,
    text: '这是一段比较长的发言内容，用于占满预算。'.repeat(6),
  }));
  const p = buildSpeakerPrompt({ topic: 'T', round: 2, rounds: 2, speaker: '豆包', turns: many, maxChars: 2000 });
  assert.match(p, /另有 \d+ 条更早的发言因篇幅略去/);
});

test('buildSummaryPrompt: contains transcript and required headings', () => {
  const p = buildSummaryPrompt({
    topic: '议题 X',
    rounds: 2,
    participants: ['豆包', '通义千问', '智谱清言'],
    turns: [
      { round: 1, speaker: '豆包', text: '观点A' },
      { round: 1, speaker: '通义千问', text: '观点B' },
    ],
  });
  assert.match(p, /── 第1轮 · 豆包 ──/);
  assert.match(p, /观点A/);
  assert.match(p, /## 四、最终建议/);
  assert.match(p, /只输出 Markdown/);
});

test('fallbackSummary: keeps every turn', () => {
  const md = fallbackSummary({
    topic: '议题 X',
    rounds: 1,
    participants: ['豆包', '千问'],
    turns: [
      { round: 1, speaker: '豆包', text: '甲' },
      { round: 1, speaker: '千问', text: '乙' },
    ],
  });
  assert.match(md, /## 第1轮 · 豆包/);
  assert.match(md, /乙/);
});

test('buildMarkdown: renders metadata, summary and failures', () => {
  const md = buildMarkdown({
    id: 'm-1',
    topic: '议题 X',
    createdAt: '2026-01-02T03:04:05.000Z',
    rounds: 2,
    totalMs: 125000,
    participants: [
      { id: 'doubao', label: '豆包' },
      { id: 'qwen', label: '通义千问' },
    ],
    summarizerLabel: 'DeepSeek',
    summary: { status: 'done', text: '## 一、各方核心观点\n内容' },
    turns: [
      { round: 1, speaker: 'doubao', label: '豆包', status: 'done', text: '豆包发言', durationMs: 30000, attempts: 1 },
      { round: 1, speaker: 'qwen', label: '通义千问', status: 'failed', error: '发送失败', durationMs: 20000, attempts: 2 },
    ],
  });
  assert.match(md, /^\| 讨论轮数 \| 2 轮 \|/m);
  assert.match(md, /豆包发言/);
  assert.match(md, /本次发言失败：发送失败/);
  assert.match(md, /## 三、异常记录/);
  assert.match(md, /DeepSeek/);
});

test('safeFileName strips characters Windows rejects', () => {
  assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.equal(safeFileName('   '), 'meeting');
});

test('fmtDuration', () => {
  assert.equal(fmtDuration(1000), '1秒');
  assert.equal(fmtDuration(65000), '1分05秒');
  assert.equal(fmtDuration(-5), '-');
  assert.equal(fmtDuration(NaN), '-');
});
