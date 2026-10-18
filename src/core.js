/* Pure logic shared by the dashboard: prompt construction + Markdown export.
 * No DOM, no chrome.* here, so it can be unit-tested in Node.
 */
export const RULES = [
  '先用 1-2 句话说清：前面谁的哪一点你最不认同（观点、论据或遗漏），点名到人；',
  '再给出你自己的判断，配 2-3 条具体论据或例子；',
  '如果前面没人发言，或你完全认同，就直接给出独立判断并说明依据；',
  '如果某个观点你已经认同，不要复述，只在它基础上补充或修正；',
  '全文 400 字以内，不要客套，不要重复议题原文，不要写"以上"。',
]
  .map((line, i) => `${i + 1}. ${line}`)
  .join('\n');

export const DEFAULT_MAX_PROMPT_CHARS = 4800;

export function truncate(text, max) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

export function buildSpeakerPrompt({ topic, round, rounds, speaker, turns, maxChars = DEFAULT_MAX_PROMPT_CHARS }) {
  const header = [
    `你是「${speaker}」，正在参加一场多方 AI 圆桌讨论。`,
    '',
    '【议题】',
    String(topic).trim(),
    '',
    `【进度】第 ${round} / ${rounds} 轮`,
    '',
  ].join('\n');

  const footer = ['', '【发言要求】', RULES, '', '直接开始发言，不要写开场白。'].join('\n');
  const budget = maxChars - header.length - footer.length;

  const blocks = [];
  for (const t of turns.filter((x) => x.round === round && x.text)) {
    blocks.push(`● ${t.speaker}（本轮已发言）：\n${truncate(t.text, 1100)}`);
  }
  const earlier = turns.filter((x) => x.round < round && x.text).sort((a, b) => b.round - a.round);
  for (const t of earlier) {
    blocks.push(`● 第${t.round}轮 ${t.speaker}：${truncate(t.text, 260)}`);
  }

  let context = '';
  let used = 0;
  let omitted = 0;
  for (const block of blocks) {
    if (used + block.length + 12 > budget) {
      omitted += 1;
      continue;
    }
    if (used === 0) context += '【前面已经说过的话】\n\n';
    context += `${block}\n\n`;
    used += block.length + 12;
  }
  if (omitted > 0) context += `（另有 ${omitted} 条更早的发言因篇幅略去。）\n\n`;
  if (!context.trim()) context = '【前面已经说过的话】\n（还没有人发言，你是本轮第一个。）\n\n';

  const prompt = `${header}${context}${footer}`;
  return prompt.length > maxChars ? prompt.slice(0, maxChars) : prompt;
}

export function buildSummaryPrompt({ topic, rounds, participants, turns, maxChars = 14000 }) {
  const head = `【完整讨论记录】共 ${rounds} 轮，参与者：${participants.join('、')}\n\n`;
  let body = '';
  let budget = maxChars - head.length;
  for (const t of turns) {
    if (!t.text) continue;
    const piece = `── 第${t.round}轮 · ${t.speaker} ──\n${t.text}\n\n`;
    if (piece.length > budget) {
      body += `── 第${t.round}轮 · ${t.speaker} ──\n${truncate(t.text, Math.max(120, budget))}\n\n`;
      break;
    }
    body += piece;
    budget -= piece.length;
  }

  return [
    '你是这场多方 AI 讨论的主持人兼记录员。请基于下面的完整讨论记录，输出一份结构化会议纪要。',
    '',
    '【议题】',
    String(topic).trim(),
    '',
    '【硬性要求】',
    '1. 只输出 Markdown，不要输出任何解释性开场白或结束语；',
    '2. 严格使用给定的标题层级，标题文字不要改写；',
    '3. 内容必须来自讨论记录，不要引入记录里没有的新事实；',
    '4. 如果各方存在明显分歧，必须如实写出，不要为了"和谐"而抹平；',
    '5. 结论要具体、可执行，避免空话。',
    '',
    head + body,
    '【输出格式】',
    '# 议题',
    '',
    '> 一句话结论：……',
    '',
    '## 一、各方核心观点',
    '（按发言人分点，每点不超过 80 字）',
    '',
    '## 二、共识与分歧',
    '### 共识',
    '### 分歧',
    '',
    '## 三、被忽略的风险与遗漏',
    '',
    '## 四、最终建议',
    '（3-5 条，每条可执行）',
  ].join('\n');
}

export function fallbackSummary({ topic, rounds, participants, turns }) {
  const lines = [`# ${topic}`, ''];
  lines.push('> 说明：自动汇总失败，以下为全部发言的原始整理稿。', '');
  lines.push(`- 讨论轮数：${rounds}`);
  lines.push(`- 参与者：${participants.join('、')}`);
  lines.push(`- 发言条数：${turns.filter((t) => t.text).length}`, '');
  for (const t of turns) {
    if (!t.text) continue;
    lines.push(`## 第${t.round}轮 · ${t.speaker}`, '', String(t.text).trim(), '');
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ markdown

function fmtTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}分${String(s).padStart(2, '0')}秒` : `${s}秒`;
}

export function buildMarkdown(meeting) {
  const out = [];
  out.push(`# ${meeting.topic}`, '');
  out.push('| 项目 | 内容 |', '| --- | --- |');
  out.push(`| 会议时间 | ${fmtTime(meeting.createdAt)} |`);
  out.push(`| 讨论轮数 | ${meeting.rounds} 轮 |`);
  out.push(`| 参与发言 | ${meeting.participants.map((p) => p.label).join('、')} |`);
  out.push(`| 纪要生成 | ${meeting.summarizerLabel || 'DeepSeek'} |`);
  out.push(`| 总耗时 | ${meeting.totalMs ? fmtDuration(meeting.totalMs) : '-'} |`);
  out.push(`| 会议编号 | \`${meeting.id}\` |`, '');

  out.push('---', '', '## 一、会议纪要', '');
  if (meeting.summary && meeting.summary.text) {
    out.push(meeting.summary.text.trim(), '');
    if (meeting.summary.status === 'fallback') {
      out.push(`> ⚠️ 自动汇总失败（${meeting.summary.error || '未知原因'}），以上为原始整理稿。`, '');
    }
  } else {
    out.push('> 尚未生成会议纪要。', '');
  }

  out.push('---', '', '## 二、讨论全过程', '');
  const rounds = [...new Set(meeting.turns.map((t) => t.round))].sort((a, b) => a - b);
  for (const round of rounds) {
    out.push(`### 第 ${round} 轮`, '');
    for (const turn of meeting.turns.filter((t) => t.round === round)) {
      const meta = [
        turn.durationMs ? `耗时 ${fmtDuration(turn.durationMs)}` : null,
        turn.attempts > 1 ? `重试 ${turn.attempts - 1} 次` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      out.push(`#### ${turn.label}${meta ? `（${meta}）` : ''}`, '');
      if (turn.status === 'done' && turn.text) out.push(String(turn.text).trim(), '');
      else if (turn.status === 'failed') out.push(`> ❌ 本次发言失败：${turn.error || '未知错误'}`, '');
      else out.push('> ⏸ 未执行', '');
    }
  }

  const failed = meeting.turns.filter((t) => t.status === 'failed');
  if (failed.length) {
    out.push('---', '', '## 三、异常记录', '');
    for (const t of failed) out.push(`- 第 ${t.round} 轮 · ${t.label}：${t.error || '未知错误'}`);
    out.push('');
  }

  out.push('---', '', `*由 AI 圆桌扩展自动生成 · ${fmtTime(meeting.endedAt || meeting.updatedAt)}*`);
  return out.join('\n');
}

export function safeFileName(name, fallback = 'meeting') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return cleaned || fallback;
}
