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

  function findEditor() {
    for (const sel of SITE.editors || []) {
      const el = [...document.querySelectorAll(sel)].find(visible);
      if (el) return { el, sel };
    }
    return null;
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

  function clickSendButton(spec) {
    const nodes = [...document.querySelectorAll(spec.selector)].filter(visible);
    if (!nodes.length) return false;
    clickElement(spec.last ? nodes[nodes.length - 1] : nodes[0]);
    return true;
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
    // Make sure the composer is genuinely focused/initialised first.
    clickElement(el);

    if (SITE.sendCheckSel && sendDisabled() && prompt) {
      emit('AI_LOG', { level: 'warn', message: '发送按钮为禁用态，重新注入输入' });
      await injectText(el, prompt).catch(() => {});
      await sleep(400);
    }

    const spec = SITE.send || {};
    let handled = false;
    if (spec.kind === 'text') handled = clickByText(spec.text);
    else if (spec.kind === 'enter') {
      pressEnter(el);
      handled = true;
    } else handled = clickSendButton(spec);

    if (!handled) throw tagged('找不到发送控件', 'E_SEND');

    if (await waitForCleared(el, 5000)) return;

    emit('AI_LOG', { level: 'warn', message: '发送后输入框未清空，回退到回车键' });
    if (spec.kind !== 'enter') pressEnter(el);
    if (await waitForCleared(el, 6000)) return;

    throw tagged('消息未能发送（输入框内容未清空）', 'E_NOT_SENT');
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
    const el = hit.el;

    await waitUntilIdle(60000);
    await waitForComposerStable();
    const before = readReplyNow();
    const baselineText = before.text;
    trace('baseline', { count: before.count, len: baselineText.length });

    await fillAndVerify(el, prompt, prompt.length);
    trace('filled');
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
