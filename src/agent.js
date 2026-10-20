/* Content-script agent: drives one chat site inside its own page.
 *
 * Runs in the page's isolated world. All timing lives here on purpose — the
 * dashboard tab may be backgrounded (and throttled) while a site tab is active,
 * so the waiter must be the one that is never throttled.
 */
(function () {
  const AIR = window.__AIR;
  const SITE = AIR && AIR.site;
  if (!SITE) return;
  if (window.__AIR_AGENT_READY) return;
  window.__AIR_AGENT_READY = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const hasChrome = () => typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage;

  function emit(type, payload) {
    if (!hasChrome()) return;
    try {
      chrome.runtime.sendMessage(Object.assign({ type }, payload)).catch(() => {});
    } catch {
      /* extension context invalidated */
    }
  }

  const log = (message, extra) => emit('AI_LOG', { level: 'debug', message, extra });

  const trace = window.__AIR_DEBUG__
    ? (msg, data) => {
        if (!window.__AIR_TRACE) window.__AIR_TRACE = [];
        window.__AIR_TRACE.push({ t: Math.round(performance.now()), msg, data });
        if (window.__AIR_TRACE.length > 400) window.__AIR_TRACE.shift();
      }
    : () => {};

  // ------------------------------------------------------------- DOM helpers

  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // An editor must be *usable*, not merely laid out: Doubao keeps a hidden
  // ProseMirror display layer next to the real <textarea>, and a zero-rect or
  // pointer-events:none node silently swallows every injected keystroke.
  const editable = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.pointerEvents !== 'none';
  };

  function findEditors() {
    const found = [];
    for (const sel of SITE.editors || []) {
      for (const el of document.querySelectorAll(sel)) {
        if (editable(el)) found.push({ el, sel });
      }
    }
    if (!found.length) {
      for (const sel of SITE.editors || []) {
        const el = [...document.querySelectorAll(sel)].find(visible);
        if (el) found.push({ el, sel });
      }
    }
    return found;
  }

  function findEditor() {
    return findEditors()[0] || null;
  }

  async function waitForEditor(timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = findEditor();
      if (hit) return hit;
      await sleep(250);
    }
    throw tagged(`找不到输入框，页面可能未加载完成或已改版`, 'E_NO_EDITOR');
  }

  function readEditor(el) {
    const isField = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
    return isField ? el.value || '' : el.innerText || '';
  }

  function clickElement(el) {
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const o = {
      bubbles: true,
      cancelable: true,
      clientX: r.x + r.width / 2,
      clientY: r.y + r.height / 2,
      view: window,
    };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
    try {
      el.focus();
    } catch {
      /* ignore */
    }
  }

  function tagged(message, code, extra) {
    const err = new Error(message);
    err.code = code;
    if (extra) Object.assign(err, extra);
    return err;
  }

  // -------------------------------------------------------------- reply read

  function readReplyNow() {
    const nodes = [...document.querySelectorAll(SITE.replySel)];
    const el = nodes.length ? nodes[nodes.length - 1] : null;
    let text = '';
    if (el) {
      let inner = null;
      if (SITE.textSel) {
        const parts = [...el.querySelectorAll(SITE.textSel)];
        if (parts.length) {
          inner = parts.reduce((a, b) =>
            (b.innerText || '').length > (a.innerText || '').length ? b : a,
          );
        }
      }
      text = ((inner || el).innerText || '').trim();
    }
    if (typeof SITE.clean === 'function') text = SITE.clean(text);
    return { count: nodes.length, text };
  }

  // Loader / comparison / "still working" chrome — never a real answer.
  const SCAFFOLD_RE =
    /(你更喜欢哪个回复|更喜欢这个回复|请选择一个以继续|搜索中|正在搜索|正在思考|正在生成|深度思考中|正在联网|加载中|请稍候|Regenerate|Generating)/i;
  const CLEAN_END_RE = /[。！？…；：!?.)\]】」』"”~～]$/;

  function isScaffold(t) {
    const s = (t || '').trim();
    if (SCAFFOLD_RE.test(s) && s.length < 200) return true;
    if (/^回复\s*\d/m.test(s) && s.length < 200) return true;
    if (s.length < 60 && /跳过$/.test(s)) return true;
    return false;
  }

  const hasCleanEnd = (t) => CLEAN_END_RE.test((t || '').trim());

  // --------------------------------------------------------------- injection

  async function injectText(el, text) {
    clickElement(el);
    const isField = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
    if (isField) {
      const proto =
        el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const sel = window.getSelection();
      sel.selectAllChildren(el);
      document.execCommand('delete');
      const ok = document.execCommand('insertText', false, text);
      if (!ok) throw tagged('浏览器拒绝写入编辑器', 'E_FILL');
    }
    return readEditor(el).length;
  }

  async function fillAndVerify(el, text, expectedLen) {
    let lastReason = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await injectText(el, text);
      } catch (err) {
        lastReason = err.message;
      }
      await sleep(400);
      const len = readEditor(el).length;
      if (len >= Math.min(expectedLen * 0.9, expectedLen - 5)) {
        const disabled = SITE.sendCheckSel ? sendDisabled() : false;
        if (!disabled) return true;
        lastReason = '发送按钮仍为禁用态';
      } else {
        lastReason = `内容不完整（${len}/${expectedLen}）`;
      }
      await sleep(600);
    }
    throw tagged(`输入内容未能完整写入（${lastReason}）`, 'E_INPUT_REJECTED');
  }

  function sendDisabled() {
    const el = document.querySelector(SITE.sendCheckSel);
    if (!el) return false;
    return el.disabled === true || el.getAttribute('aria-disabled') === 'true';
  }

  // ------------------------------------------------------------------ sending

  function pressEnter(el) {
    const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', o));
    el.dispatchEvent(new KeyboardEvent('keypress', o));
    el.dispatchEvent(new KeyboardEvent('keyup', o));
  }

  function clickByText(text) {
    const hits = [...document.querySelectorAll('button,div,a,span')]
      .filter(visible)
      .filter((el) => (el.innerText || '').trim() === text);
    if (!hits.length) return false;
    clickElement(hits[hits.length - 1]);
    return true;
  }

  // The send control is often rendered a beat after the text lands (React state
  // sync), so a one-shot lookup is racy. Prefer visible nodes but tolerate a
  // zero-rect control mid-transition, and fall back to semantic hints.
  function findSendControl(spec) {
    const selectors = [spec && spec.selector, SITE.sendCheckSel].filter(Boolean);
    for (const sel of selectors) {
      const all = [...document.querySelectorAll(sel)];
      if (!all.length) continue;
      const shown = all.filter(visible);
      const pool = shown.length ? shown : all;
      return spec && spec.last ? pool[pool.length - 1] : pool[0];
    }
    const labelled = [...document.querySelectorAll('button, [role="button"], [aria-label]')]
      .filter(visible)
      .filter((el) =>
        /^(发送|发送消息|Send|Submit)$/i.test((el.getAttribute('aria-label') || el.innerText || '').trim()),
      );
    return labelled.length ? labelled[labelled.length - 1] : null;
  }

  async function waitForSendControl(spec, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let hit = null;
    while (Date.now() < deadline) {
      hit = findSendControl(spec);
      if (hit) return hit;
      await sleep(300);
    }
    return null;
  }

  async function waitForCleared(el, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!document.contains(el)) return true;
      if (readEditor(el).trim().length === 0) return true;
      await sleep(200);
    }
    return false;
  }

  async function submit(el, prompt) {
    // The composer may have been swapped by a re-render since we filled it.
    const fresh = findEditor();
    if (fresh) el = fresh.el;
    clickElement(el);

    if (SITE.sendCheckSel && sendDisabled() && prompt) {
      emit('AI_LOG', { level: 'warn', message: '发送按钮为禁用态，重新注入输入' });
      await injectText(el, prompt).catch(() => {});
      await sleep(400);
    }

    const spec = SITE.send || {};

    if (spec.kind === 'enter') {
      pressEnter(el);
      if (await waitForCleared(el, 6000)) return;
      throw tagged('消息未能发送（回车后输入框未清空）', 'E_NOT_SENT');
    }

    if (spec.kind === 'text') {
      if (clickByText(spec.text) && (await waitForCleared(el, 5000))) return;
    } else {
      // Give the control a moment to render instead of failing on first lookup.
      const target = await waitForSendControl(spec, 8000);
      if (target) {
        clickElement(target);
        if (await waitForCleared(el, 5000)) return;
        emit('AI_LOG', { level: 'warn', message: '点击发送后输入框未清空，回退到回车键' });
      } else {
        emit('AI_LOG', { level: 'warn', message: '发送控件未出现，改用回车键发送' });
      }
    }

    pressEnter(el);
    if (await waitForCleared(el, 6000)) return;

    throw tagged('消息未能发送（发送控件与回车均未生效）', 'E_SEND');
  }

  // --------------------------------------------------------------- the waiter

  const waitForReply = (() => {
    const factory = AIR && AIR.createReplyWaiter;
    if (typeof factory !== "function") {
      return async () => {
        throw tagged("等待模块未加载（waiter.js 缺失）", "E_NO_WAITER");
      };
    }
    return factory({
      readReply: readReplyNow,
      sleep,
      now: () => Date.now(),
      isScaffold,
      hasCleanEnd,
      resolveAmbiguity: typeof SITE.resolveAmbiguity === "function" ? () => SITE.resolveAmbiguity() : null,
      trace,
    });
  })();

  async function waitUntilIdle(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const a = readReplyNow();
      await sleep(1200);
      const b = readReplyNow();
      if (a.text === b.text) return true;
    }
    return false;
  }

  async function waitForComposerStable(timeoutMs = 20000, quietMs = 900) {
    const startedAt = Date.now();
    let lastSig = null;
    let stableSince = 0;
    while (Date.now() - startedAt < timeoutMs) {
      const hit = findEditor();
      if (!hit) {
        lastSig = null;
        await sleep(250);
        continue;
      }
      const sig = `${location.href}|${readEditor(hit.el).length}`;
      if (sig !== lastSig) {
        lastSig = sig;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= quietMs) {
        return true;
      }
      await sleep(300);
    }
    return false;
  }

  // --------------------------------------------------------------------- API

  async function ask(prompt, opts) {
    const timeoutMs = opts.timeoutMs || 300000;
    trace('ask-start', { len: prompt.length, timeoutMs });
    const hit = await waitForEditor();
    let el = hit.el;

    await waitUntilIdle(60000);
    await waitForComposerStable();
    // The composer can be swapped during settling; never fill a detached node.
    const settled = findEditor();
    if (settled) el = settled.el;
    const before = readReplyNow();
    const baselineText = before.text;
    trace('baseline', { count: before.count, len: baselineText.length });

    // Multi-layer composers (Doubao) register text in only one of their
    // editors — try every candidate until the site accepts it.
    let filled = false;
    let lastErr = null;
    for (const cand of findEditors()) {
      try {
        await fillAndVerify(cand.el, prompt, prompt.length);
        el = cand.el;
        filled = true;
        trace('filled', { sel: cand.sel });
        break;
      } catch (err) {
        lastErr = err;
        trace('fill-rejected', { sel: cand.sel, reason: err.message });
      }
    }
    if (!filled) throw lastErr || tagged('输入内容未能完整写入', 'E_INPUT_REJECTED');
    await submit(el, prompt);
    trace('submitted');
    emit('AI_LOG', { level: 'info', message: `已发送（${prompt.length} 字），等待回复` });

    return waitForReply(baselineText, {
      timeoutMs,
      stableMs: opts.stableMs,
      firstReplyMs: opts.firstReplyMs,
    });
  }

  async function prepare() {
    const spec = SITE.newChat;
    if (spec) {
      if (spec.kind === 'text') clickByText(spec.text);
      else {
        const nodes = [...document.querySelectorAll(spec.selector)].filter(visible);
        if (nodes.length) clickElement(nodes[0]);
      }
      await sleep(1200);
    }
    await waitForEditor(15000);
    await waitForComposerStable(15000, 1200);
    if (typeof SITE.prepare === 'function') {
      try {
        SITE.prepare();
      } catch {
        /* ignore */
      }
    }
    return { url: location.href, editor: !!findEditor() };
  }

  async function clearInput() {
    const hit = findEditor();
    if (!hit) return false;
    const len = readEditor(hit.el).length;
    if (!len) return true;
    await injectText(hit.el, '').catch(() => {});
    return true;
  }

  // ------------------------------------------------------------- message bus

  if (hasChrome() && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg.type !== 'string') return false;

      if (msg.type === 'AI_PING') {
        const hit = findEditor();
        sendResponse({
          ok: true,
          site: SITE.id,
          url: location.href,
          hasEditor: !!hit,
          visible: document.visibilityState === 'visible',
        });
        return false;
      }

      if (msg.type === 'AI_PREPARE') {
        prepare()
          .then((r) => sendResponse({ ok: true, ...r }))
          .catch((e) => sendResponse({ ok: false, error: e.message, code: e.code }));
        return true;
      }

      if (msg.type === 'AI_ASK') {
        ask(msg.prompt, msg.options || {})
          .then((text) => sendResponse({ ok: true, text }))
          .catch((e) =>
            sendResponse({ ok: false, error: e.message, code: e.code, partial: e.partial || '' }),
          );
        return true;
      }

      if (msg.type === 'AI_CLEAR') {
        clearInput()
          .then((r) => sendResponse({ ok: true, cleared: r }))
          .catch((e) => sendResponse({ ok: false, error: e.message }));
        return true;
      }

      return false;
    });
  }

  // Debug hook: lets the developer drive the very same code from a page console
  // (or from Kimi WebBridge) without loading the extension.
  if (window.__AIR_DEBUG__) {
    window.__AIR_TEST = { site: SITE, ask, prepare, clearInput, readReplyNow, findEditor, waitForReply };
  }

  emit('AI_LOG', { level: 'debug', message: `内容脚本已注入（${SITE.label}）` });
})();
