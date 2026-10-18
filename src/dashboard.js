/* Dashboard = control panel + orchestrator.
 *
 * Why here and not in the service worker: MV3 workers are reclaimed at will,
 * but a page context survives for as long as the tab is open and still has full
 * chrome.* access. All per-turn timing is enforced inside the content script,
 * so throttling of this (background) tab can never stall a turn.
 */
import {
  buildSpeakerPrompt,
  buildSummaryPrompt,
  fallbackSummary,
  buildMarkdown,
  fmtDuration,
  safeFileName,
} from './core.js';

const SITE_META = {
  doubao: { id: 'doubao', label: '豆包', url: 'https://www.doubao.com/chat/', host: 'www.doubao.com' },
  qwen: { id: 'qwen', label: '通义千问', url: 'https://chat.qwen.ai/', host: 'chat.qwen.ai' },
  zhipu: { id: 'zhipu', label: '智谱清言', url: 'https://chatglm.cn/main/alltoolsdetail', host: 'chatglm.cn' },
  deepseek: { id: 'deepseek', label: 'DeepSeek', url: 'https://chat.deepseek.com/', host: 'chat.deepseek.com' },
};

const SPEAKERS = ['doubao', 'qwen', 'zhipu'];
const SUMMARIZER = 'deepseek';
const GROUP_TITLE = 'AI 圆桌';
const GROUP_COLOR = 'blue';

const TURN_TIMEOUT_MS = 300000;
const STABLE_MS = 4000;
const SUMMARY_BUDGET_MS = 420000;

const $ = (sel) => document.querySelector(sel);
const els = {
  conn: $('#conn'),
  exportBtn: $('#exportBtn'),
  setup: $('#setup'),
  siteStatus: $('#siteStatus'),
  preflightBtn: $('#preflightBtn'),
  topic: $('#topic'),
  rounds: $('#rounds'),
  estimate: $('#estimate'),
  startBtn: $('#startBtn'),
  runPanel: $('#runPanel'),
  phasePill: $('#phasePill'),
  runTitle: $('#runTitle'),
  statRound: $('#statRound'),
  statSpeaker: $('#statSpeaker'),
  statElapsed: $('#statElapsed'),
  pauseBtn: $('#pauseBtn'),
  stopBtn: $('#stopBtn'),
  progressFill: $('#progressFill'),
  timeline: $('#timeline'),
  summaryCard: $('#summaryCard'),
  summaryBadge: $('#summaryBadge'),
  summaryBody: $('#summaryBody'),
  logs: $('#logs'),
  logCount: $('#logCount'),
};

const state = {
  meeting: null,
  running: false,
  aborted: false,
  paused: false,
  tabIds: {},
  windowId: null,
  createdTabIds: [],
  groupId: null,
  progress: new Map(),
  turnEls: new Map(),
  logCount: 0,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------- utils

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

function labelOf(id) {
  return SITE_META[id]?.label || id;
}

function fmtClock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function pushLog(level, message, extra) {
  state.logCount += 1;
  els.logCount.textContent = String(state.logCount);
  const line = document.createElement('div');
  line.className = 'log-line';
  const ts = document.createElement('span');
  ts.className = 'log-ts';
  ts.textContent = fmtClock(new Date().toISOString());
  const lv = document.createElement('span');
  lv.className = `log-lv-${level}`;
  lv.textContent = String(level).slice(0, 5).padEnd(5, ' ');
  const msg = document.createElement('span');
  msg.textContent = extra ? `${message} ${JSON.stringify(extra)}` : message;
  line.append(ts, lv, msg);
  els.logs.appendChild(line);
  while (els.logs.childElementCount > 500) els.logs.removeChild(els.logs.firstChild);
  els.logs.scrollTop = els.logs.scrollHeight;
}

const log = {
  info: (m, e) => pushLog('info', m, e),
  warn: (m, e) => pushLog('warn', m, e),
  error: (m, e) => pushLog('error', m, e),
  debug: (m, e) => pushLog('debug', m, e),
};

// ------------------------------------------------------------------ tabs

async function findTabFor(siteId, windowId) {
  const meta = SITE_META[siteId];
  const tabs = await chrome.tabs.query({ windowId });
  return tabs.find((t) => {
    try {
      return new URL(t.url || '').hostname === meta.host;
    } catch {
      return false;
    }
  });
}

async function ensureTab(siteId) {
  if (state.tabIds[siteId]) {
    try {
      await chrome.tabs.get(state.tabIds[siteId]);
      return state.tabIds[siteId];
    } catch {
      delete state.tabIds[siteId];
    }
  }
  const meta = SITE_META[siteId];
  let tab = await findTabFor(siteId, state.windowId);
  if (!tab) {
    tab = await chrome.tabs.create({ url: meta.url, active: false, windowId: state.windowId });
    state.createdTabIds.push(tab.id);
    log.info(`已打开 ${meta.label} 标签页`);
    await sleep(1500);
  }
  state.tabIds[siteId] = tab.id;
  return tab.id;
}

async function ensureAgent(tabId) {
  const ping = async () => {
    try {
      return await chrome.tabs.sendMessage(tabId, { type: 'AI_PING' });
    } catch {
      return null;
    }
  };
  let res = await ping();
  if (res && res.ok) return res;

  // Content script missing (tab predates the install, or page just reloaded).
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/sites.js', 'src/agent.js'] });
  } catch (err) {
    log.warn(`注入内容脚本失败：${err.message}`);
  }
  for (let i = 0; i < 20; i += 1) {
    await sleep(500);
    res = await ping();
    if (res && res.ok) return res;
  }
  throw new Error('内容脚本未能加载，请刷新该标签页');
}

async function focusTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    await sleep(350);
  } catch (err) {
    log.warn(`激活标签页失败：${err.message}`);
  }
}

async function groupTabs() {
  const ids = Object.values(state.tabIds);
  if (ids.length < 2) return;
  try {
    state.groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: state.windowId } });
    await chrome.tabGroups.update(state.groupId, { title: GROUP_TITLE, color: GROUP_COLOR, collapsed: false });
    log.info('四个标签页已归入同一个分组');
  } catch (err) {
    log.warn(`标签分组失败（不影响讨论）：${err.message}`);
  }
}

async function releaseTabs() {
  if (state.groupId != null) {
    try {
      const tabs = await chrome.tabs.query({ groupId: state.groupId });
      const ids = tabs.map((t) => t.id);
      if (ids.length) await chrome.tabs.ungroup(ids);
    } catch {
      /* ignore */
    }
    state.groupId = null;
  }
  for (const id of state.createdTabIds) {
    try {
      await chrome.tabs.remove(id);
    } catch {
      /* already closed */
    }
  }
  state.createdTabIds = [];
  state.tabIds = {};
}

// --------------------------------------------------------------- messaging

async function askTab(siteId, prompt, timeoutMs) {
  const tabId = await ensureTab(siteId);
  await ensureAgent(tabId);
  await focusTab(tabId);

  const guardMs = timeoutMs + 30000;
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('扩展侧等待超时'), { code: 'E_GUARD' })), guardMs);
  });

  try {
    const res = await Promise.race([
      chrome.tabs.sendMessage(tabId, {
        type: 'AI_ASK',
        prompt,
        options: { timeoutMs, stableMs: STABLE_MS },
      }),
      guard,
    ]);
    if (!res) throw Object.assign(new Error('页面无响应'), { code: 'E_NO_RESPONSE' });
    if (!res.ok) throw Object.assign(new Error(res.error || '未知错误'), { code: res.code, partial: res.partial });
    return res.text;
  } finally {
    clearTimeout(timer);
  }
}

async function prepareTab(siteId) {
  const tabId = await ensureTab(siteId);
  await ensureAgent(tabId);
  await focusTab(tabId);
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'AI_PREPARE' });
    if (res && res.ok) return true;
    log.warn(`${labelOf(siteId)}：新建对话失败，继续使用当前会话`);
    return false;
  } catch (err) {
    log.warn(`${labelOf(siteId)}：新建对话异常（${err.message}），继续使用当前会话`);
    return false;
  }
}

async function clearTab(siteId) {
  const tabId = state.tabIds[siteId];
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'AI_CLEAR' });
  } catch {
    /* ignore */
  }
}

// -------------------------------------------------------------- reminders

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;
  if (msg.type === 'AI_PROGRESS' && sender.tab) {
    const siteId = Object.keys(state.tabIds).find((k) => state.tabIds[k] === sender.tab.id);
    if (!siteId) return;
    state.progress.set(siteId, msg);
    const turn = (state.meeting?.turns || []).find((t) => t.status === 'running' && t.speaker === siteId);
    if (turn) {
      const node = state.turnEls.get(turn.id);
      const body = node?.querySelector('.turn-body');
      if (body && body.classList.contains('streaming')) {
        body.textContent = `正在生成… 已收到 ${msg.chars} 字`;
      }
    }
    return;
  }
  if (msg.type === 'AI_LOG' && sender.tab) {
    pushLog(msg.level || 'debug', msg.message, msg.extra);
  }
});

// ------------------------------------------------------------------ state

function buildAgenda(rounds, participants) {
  const turns = [];
  for (let round = 1; round <= rounds; round += 1) {
    for (const speaker of participants) {
      turns.push({
        id: `r${round}-${speaker}`,
        round,
        speaker,
        label: labelOf(speaker),
        status: 'pending',
        text: '',
        error: null,
        attempts: 0,
        startedAt: null,
        endedAt: null,
        durationMs: null,
      });
    }
  }
  return turns;
}

function save() {
  if (!state.meeting) return;
  state.meeting.updatedAt = nowIso();
  try {
    chrome.storage.local.set({ meeting: state.meeting });
  } catch {
    /* ignore */
  }
}

function restore() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['meeting'], (data) => resolve(data?.meeting || null));
  });
}

// ------------------------------------------------------------------- render

const PHASE_TEXT = {
  idle: '待开始',
  preparing: '准备中',
  discussing: '讨论中',
  summarizing: '汇总中',
  done: '已完成',
  stopped: '已停止',
  error: '出现错误',
};

function phaseClass(phase) {
  if (phase === 'done') return 'pill-ok';
  if (phase === 'error') return 'pill-err';
  if (phase === 'stopped') return 'pill-warn';
  return 'pill-run';
}

function renderTimeline(meeting) {
  const seen = new Set();
  for (const turn of meeting.turns || []) {
    seen.add(turn.id);
    let node = state.turnEls.get(turn.id);
    if (!node) {
      node = document.createElement('div');
      node.className = `turn ${turn.speaker}`;
      node.innerHTML = `<div class="turn-head"><span class="turn-who"></span><span class="turn-round"></span><span class="turn-time"></span></div><div class="turn-body"></div><div class="turn-error hidden"></div>`;
      els.timeline.appendChild(node);
      state.turnEls.set(turn.id, node);
    }
    node.querySelector('.turn-who').textContent = turn.label || labelOf(turn.speaker);
    node.querySelector('.turn-round').textContent = `第 ${turn.round} 轮`;
    const timeEl = node.querySelector('.turn-time');
    const bodyEl = node.querySelector('.turn-body');
    const errEl = node.querySelector('.turn-error');

    if (turn.status === 'done') {
      bodyEl.classList.remove('pending', 'streaming');
      bodyEl.textContent = turn.text || '';
      errEl.classList.add('hidden');
      timeEl.textContent = turn.durationMs ? `耗时 ${fmtDuration(turn.durationMs)}${turn.attempts > 1 ? ` · 重试${turn.attempts - 1}次` : ''}` : '';
    } else if (turn.status === 'failed') {
      bodyEl.classList.remove('streaming');
      bodyEl.classList.add('pending');
      bodyEl.textContent = '（本次发言失败）';
      errEl.classList.remove('hidden');
      errEl.textContent = turn.error || '未知错误';
      timeEl.textContent = turn.durationMs ? fmtDuration(turn.durationMs) : '';
    } else if (turn.status === 'running') {
      bodyEl.classList.add('streaming');
      bodyEl.classList.remove('pending');
      const prog = state.progress.get(turn.speaker);
      bodyEl.textContent = prog ? `正在生成… 已收到 ${prog.chars} 字` : '正在生成…';
      errEl.classList.add('hidden');
      timeEl.textContent = '进行中';
    } else {
      bodyEl.classList.add('pending');
      bodyEl.classList.remove('streaming');
      bodyEl.textContent = '等待发言…';
      errEl.classList.add('hidden');
      timeEl.textContent = '';
    }
  }
  for (const [id, node] of state.turnEls) {
    if (!seen.has(id)) {
      node.remove();
      state.turnEls.delete(id);
    }
  }
}

function render() {
  const m = state.meeting;
  const active = !!m && !['idle', 'done', 'stopped', 'error'].includes(m.phase);
  els.setup.classList.toggle('hidden', active);
  els.runPanel.classList.toggle('hidden', !m || m.phase === 'idle');
  els.startBtn.disabled = state.running;
  els.exportBtn.disabled = !m;
  els.stopBtn.disabled = !state.running;
  els.pauseBtn.disabled = !state.running;
  els.pauseBtn.textContent = state.paused ? '继续' : '暂停';

  if (!m) {
    els.summaryCard.classList.add('hidden');
    return;
  }

  els.phasePill.textContent = PHASE_TEXT[m.phase] || m.phase;
  els.phasePill.className = `pill ${phaseClass(m.phase)}`;
  els.runTitle.textContent = m.topic;
  els.statRound.textContent = `${m.currentRound || 0} / ${m.rounds}`;
  els.statSpeaker.textContent = m.currentSpeaker ? labelOf(m.currentSpeaker) : '—';

  const total = (m.turns || []).length;
  const done = (m.turns || []).filter((t) => t.status === 'done').length;
  els.progressFill.style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';

  renderTimeline(m);

  if (m.summary && m.summary.text) {
    els.summaryCard.classList.remove('hidden');
    els.summaryBody.textContent = m.summary.text;
    els.summaryBadge.textContent = m.summary.status === 'fallback' ? '降级整理稿' : '已生成';
    els.summaryBadge.className = `pill ${m.summary.status === 'fallback' ? 'pill-warn' : 'pill-ok'}`;
  } else if (m.phase === 'error') {
    els.summaryCard.classList.remove('hidden');
    els.summaryBody.textContent = `会议异常终止：${m.error || '未知错误'}`;
    els.summaryBadge.textContent = '失败';
    els.summaryBadge.className = 'pill pill-err';
  } else {
    els.summaryCard.classList.add('hidden');
  }
  updateElapsed();
}

let tickTimer = null;
function updateElapsed() {
  const m = state.meeting;
  if (!m) return;
  if (m.totalMs) {
    els.statElapsed.textContent = fmtDuration(m.totalMs);
  } else if (m.startedAt && state.running) {
    els.statElapsed.textContent = fmtDuration(Date.now() - new Date(m.startedAt).getTime());
  } else {
    els.statElapsed.textContent = '0秒';
  }
}

function renderSites(results) {
  els.siteStatus.innerHTML = '';
  for (const r of results) {
    const chip = document.createElement('div');
    chip.className = 'site-chip';
    const dot = document.createElement('span');
    dot.className = `dot ${r.error ? 'err' : r.foreground === false ? 'warn' : r.ok ? 'ok' : 'warn'}`;
    const name = document.createElement('span');
    name.textContent = r.label;
    const detail = document.createElement('span');
    detail.className = 'sub-dot';
    if (r.error) detail.textContent = '不可用';
    else if (!r.hasEditor) detail.textContent = '未找到输入框';
    else if (r.foreground === false) detail.textContent = '后台标签页';
    else detail.textContent = '就绪（前台）';
    chip.append(dot, name, detail);
    els.siteStatus.appendChild(chip);
  }
}

// ---------------------------------------------------------------- preflight

async function preflight() {
  els.siteStatus.innerHTML = '';
  for (const id of [...SPEAKERS, SUMMARIZER]) {
    const chip = document.createElement('div');
    chip.className = 'site-chip';
    chip.innerHTML = `<span class="dot busy"></span><span>${labelOf(id)}</span><span class="sub-dot">检查中…</span>`;
    els.siteStatus.appendChild(chip);
  }

  state.windowId = (await chrome.windows.getCurrent()).id;
  const results = [];
  for (const id of [...SPEAKERS, SUMMARIZER]) {
    const meta = SITE_META[id];
    try {
      const tabId = await ensureTab(id);
      const ping = await ensureAgent(tabId);
      results.push({ id, label: meta.label, ok: true, hasEditor: !!ping.hasEditor, foreground: ping.visible, url: ping.url });
    } catch (err) {
      results.push({ id, label: meta.label, ok: false, error: err.message });
    }
  }
  renderSites(results);
  const bad = results.filter((r) => !r.ok || !r.hasEditor);
  const bg = results.filter((r) => r.foreground === false);
  if (bg.length) {
    log.warn(`${bg.map((r) => r.label).join('、')} 处于后台标签页。扩展会在每次发言前把对应标签切到前台。`);
  }
  return { results, bad };
}

// -------------------------------------------------------------------- run

async function runMeeting(meeting) {
  state.running = true;
  state.aborted = false;
  render();
  const t0 = Date.now();

  try {
    meeting.phase = 'preparing';
    meeting.startedAt = meeting.startedAt || nowIso();
    save();
    render();
    log.info('正在为每个站点新建独立对话…');

    for (const id of [...SPEAKERS, SUMMARIZER]) {
      if (state.aborted) break;
      await prepareTab(id);
    }

    meeting.phase = 'discussing';
    save();
    render();

    let consecutiveFailures = 0;
    for (const turn of meeting.turns) {
      if (state.aborted) break;
      while (state.paused && !state.aborted) await sleep(400);
      if (state.aborted) break;
      if (turn.status === 'done' && turn.text) continue;

      meeting.currentRound = turn.round;
      meeting.currentSpeaker = turn.speaker;
      turn.status = 'running';
      turn.startedAt = nowIso();
      turn.error = null;
      save();
      render();
      log.info(`第 ${turn.round} 轮 · ${turn.label} 开始发言`);

      const priorTurns = meeting.turns
        .filter((t) => t !== turn && t.status === 'done' && t.text)
        .map((t) => ({ round: t.round, speaker: t.label, text: t.text }));
      const prompt = buildSpeakerPrompt({
        topic: meeting.topic,
        round: turn.round,
        rounds: meeting.rounds,
        speaker: turn.label,
        turns: priorTurns,
      });

      const startedAt = Date.now();
      let ok = false;
      for (let attempt = 1; attempt <= 2 && !ok; attempt += 1) {
        turn.attempts = attempt;
        save();
        try {
          const text = await askTab(turn.speaker, prompt, TURN_TIMEOUT_MS);
          turn.status = 'done';
          turn.text = text;
          turn.durationMs = Date.now() - startedAt;
          turn.endedAt = nowIso();
          ok = true;
          consecutiveFailures = 0;
          save();
          render();
          log.info(`第 ${turn.round} 轮 · ${turn.label} 完成（${text.length} 字，${Math.round(turn.durationMs / 1000)} 秒）`);
        } catch (err) {
          if (attempt === 2) {
            turn.status = 'failed';
            turn.error = err.message;
            turn.durationMs = Date.now() - startedAt;
            turn.endedAt = nowIso();
            consecutiveFailures += 1;
            save();
            render();
            log.error(`第 ${turn.round} 轮 · ${turn.label} 失败：${err.message}`);
          } else {
            log.warn(`${turn.label} 第 ${attempt} 次失败：${err.message}，重试`);
            await clearTab(turn.speaker);
            await sleep(2000);
          }
        }
      }

      if (consecutiveFailures >= 3) {
        throw new Error(`连续 ${consecutiveFailures} 次发言失败，判定为系统性故障，会议终止`);
      }
    }

    if (state.aborted) {
      meeting.phase = 'stopped';
      meeting.endedAt = nowIso();
      meeting.totalMs = Date.now() - t0;
      save();
      render();
      log.warn('会议已停止');
      return;
    }

    // ------------------------------------------------------------- summary
    meeting.phase = 'summarizing';
    meeting.currentSpeaker = SUMMARIZER;
    save();
    render();

    const doneTurns = meeting.turns.filter((t) => t.status === 'done' && t.text);
    if (!doneTurns.length) throw new Error('没有任何成功发言，无法生成纪要');

    const summaryPrompt = buildSummaryPrompt({
      topic: meeting.topic,
      rounds: meeting.rounds,
      participants: meeting.participants.map((p) => p.label),
      turns: doneTurns.map((t) => ({ round: t.round, speaker: t.label, text: t.text })),
    });

    log.info(`${labelOf(SUMMARIZER)} 正在汇总生成会议纪要…`);
    const budgetStart = Date.now();
    let summaryText = null;
    let lastErr = null;
    while (summaryText === null) {
      const remaining = SUMMARY_BUDGET_MS - (Date.now() - budgetStart);
      if (remaining < 30000) break;
      try {
        summaryText = await askTab(SUMMARIZER, summaryPrompt, Math.min(remaining, 240000));
      } catch (err) {
        lastErr = err;
        log.warn(`汇总失败（已用 ${Math.round((Date.now() - budgetStart) / 1000)} 秒）：${err.message}`);
        await clearTab(SUMMARIZER);
        await sleep(2000);
      }
    }

    if (summaryText) {
      meeting.summary = { status: 'done', text: summaryText, error: null };
      log.info('会议纪要生成完成');
    } else {
      meeting.summary = {
        status: 'fallback',
        text: fallbackSummary({
          topic: meeting.topic,
          rounds: meeting.rounds,
          participants: meeting.participants.map((p) => p.label),
          turns: doneTurns.map((t) => ({ round: t.round, speaker: t.label, text: t.text })),
        }),
        error: lastErr ? lastErr.message : '超出时间预算',
      };
      log.error(`汇总失败，已降级为原始整理稿：${meeting.summary.error}`);
    }

    meeting.phase = 'done';
    meeting.endedAt = nowIso();
    meeting.totalMs = Date.now() - t0;
    save();
    render();
    log.info(`会议结束，总耗时 ${fmtDuration(meeting.totalMs)}`);
  } catch (err) {
    meeting.phase = 'error';
    meeting.error = err.message;
    meeting.endedAt = nowIso();
    meeting.totalMs = Date.now() - t0;
    save();
    render();
    log.error(`会议异常终止：${err.message}`);
  } finally {
    state.running = false;
    render();
    await releaseTabs();
  }
}

// ------------------------------------------------------------------ actions

function estimateText() {
  const rounds = Number(els.rounds.value) || 0;
  if (!rounds) return '';
  const seconds = rounds * SPEAKERS.length * 45 + 90;
  const min = Math.round(seconds / 60);
  const warn = rounds > 8 ? '（轮数较多，耗时较长）' : '';
  return `预计约 ${min} 分钟${warn}`;
}

els.rounds.addEventListener('input', () => {
  els.estimate.textContent = estimateText();
});

els.preflightBtn.addEventListener('click', () => {
  preflight().catch((err) => log.error(`预检失败：${err.message}`));
});

els.startBtn.addEventListener('click', async () => {
  const topic = els.topic.value.trim();
  if (topic.length < 4) {
    els.topic.focus();
    els.topic.style.borderColor = '#dc2626';
    setTimeout(() => (els.topic.style.borderColor = ''), 1500);
    return;
  }
  let rounds = Number(els.rounds.value);
  if (!Number.isInteger(rounds) || rounds < 1) rounds = 1;
  if (rounds > 20) rounds = 20;
  els.rounds.value = String(rounds);

  els.startBtn.disabled = true;
  els.startBtn.textContent = '正在启动…';
  try {
    state.windowId = (await chrome.windows.getCurrent()).id;
    state.createdTabIds = [];
    state.tabIds = {};
    state.progress.clear();
    state.turnEls.forEach((n) => n.remove());
    state.turnEls.clear();
    els.logs.innerHTML = '';
    state.logCount = 0;

    const { bad } = await preflight();
    if (bad.length) throw new Error(`以下站点未就绪：${bad.map((b) => b.label).join('、')}`);

    await groupTabs();

    const meeting = {
      id: makeId(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      topic,
      rounds,
      participants: SPEAKERS.map((id) => ({ id, label: labelOf(id) })),
      summarizer: SUMMARIZER,
      summarizerLabel: labelOf(SUMMARIZER),
      phase: 'idle',
      currentRound: 0,
      currentSpeaker: null,
      turns: buildAgenda(rounds, SPEAKERS),
      summary: { status: 'pending', text: '', error: null },
      error: null,
      startedAt: null,
      endedAt: null,
      totalMs: null,
    };
    state.meeting = meeting;
    state.paused = false;
    save();
    render();
    runMeeting(meeting);
  } catch (err) {
    log.error(`启动失败：${err.message}`);
    alert(`启动失败：${err.message}`);
  } finally {
    els.startBtn.disabled = false;
    els.startBtn.textContent = '开始讨论';
  }
});

els.stopBtn.addEventListener('click', () => {
  if (!state.running) return;
  if (!confirm('确定要停止本次讨论吗？已完成的发言会保留。')) return;
  state.aborted = true;
  log.warn('已请求停止，当前发言结束后停止');
});

els.pauseBtn.addEventListener('click', () => {
  state.paused = !state.paused;
  log.info(state.paused ? '已暂停（当前发言完成后生效）' : '已继续');
  render();
});

els.exportBtn.addEventListener('click', () => {
  if (!state.meeting) return;
  const md = buildMarkdown(state.meeting);
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const name = `${safeFileName(state.meeting.topic, 'meeting')}-${state.meeting.id}.md`;
  chrome.downloads.download({ url, filename: name, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
});

// --------------------------------------------------------------------- boot

(async function boot() {
  tickTimer = setInterval(updateElapsed, 1000);
  state.windowId = (await chrome.windows.getCurrent()).id;
  els.estimate.textContent = estimateText();
  pushLog('info', '控制台已就绪');

  const saved = await restore();
  if (saved) {
    state.meeting = saved;
    render();
    if (saved.phase === 'discussing' || saved.phase === 'preparing' || saved.phase === 'summarizing') {
      pushLog('warn', '发现未完成的会议，可点击「开始讨论」重新发起，或查看已完成的发言。');
    }
  }
  preflight().catch((err) => log.error(`预检失败：${err.message}`));
})();
