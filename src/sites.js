/* Per-site automation config. Injected as a content script ahead of agent.js.
 *
 * When a site ships a redesign, this is the only file that needs editing.
 * Every selector below was verified against the live page.
 */
(function () {
  const SITES = {
    doubao: {
      id: 'doubao',
      label: '豆包',
      host: 'www.doubao.com',
      url: 'https://www.doubao.com/chat/',
      color: 'blue',
      // Doubao keeps a hidden ProseMirror display layer under a real <textarea>
      // (its IME shell). Try the interactive textarea first; agent.js verifies
      // which layer the site actually registers.
      editors: ['textarea[data-testid="chat_input_input"]', 'textarea.textarea-YelHeN', '.tiptap.ProseMirror'],
      send: { kind: 'click', selector: '[data-testid="chat_input_send_button"]' },
      sendCheckSel: '[data-testid="chat_input_send_button"]',
      replySel: '[data-testid="receive_message"]',
      textSel: '[data-testid="message_text_content"]',
      newChat: { kind: 'click', selector: '[data-testid="create_conversation_button"]' },
    },

    qwen: {
      id: 'qwen',
      label: '通义千问',
      host: 'chat.qwen.ai',
      url: 'https://chat.qwen.ai/',
      color: 'purple',
      editors: ['textarea.message-input-textarea'],
      send: { kind: 'click', selector: 'button.send-button' },
      sendCheckSel: 'button.send-button',
      replySel: '.qwen-chat-message-assistant',
      textSel: '.response-message-content',
      newChat: { kind: 'click', selector: '[aria-label="新建对话"]' },
      // Qwen sometimes samples two answers and waits for a pick.
      resolveAmbiguity: function () {
        const vis = (el) => el.getClientRects().length > 0;
        const labels = ['我更喜欢这个回复', '回复 1', '回复1'];
        const all = [...document.querySelectorAll('button,div,span,a')].filter(vis);
        for (const label of labels) {
          const hit = all.find((el) => (el.innerText || '').trim() === label);
          if (hit) {
            (hit.closest('button') || hit).click();
            return true;
          }
        }
        const card = all.find((el) => {
          const t = (el.innerText || '').trim();
          return t.startsWith('回复') && t.length < 12 && el.closest('[class*="siblings"]');
        });
        if (card) {
          (card.closest('button') || card).click();
          return true;
        }
        return false;
      },
    },

    zhipu: {
      id: 'zhipu',
      label: '智谱清言',
      host: 'chatglm.cn',
      url: 'https://chatglm.cn/main/alltoolsdetail',
      color: 'green',
      editors: ['textarea.scroll-display-none'],
      // The paper-plane control is a plain div; Enter is the reliable path.
      send: { kind: 'enter' },
      replySel: '.conversation-item .answer',
      textSel: '.answer-content-wrap',
      newChat: { kind: 'click', selector: '.new-session' },
      // Zhipu inlines web-search citations as 【turn0search12】 plus bare domains.
      clean: function (text) {
        return text
          .replace(/【\s*turn\d+[^】]*】/gi, '')
          .replace(/(?:^|\n)\s*(?:[a-z0-9-]+\.)+(?:cn|com|org|net|io|ai|edu|gov|co)\s*(?=\n|$)/gi, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      },
    },

    deepseek: {
      id: 'deepseek',
      label: 'DeepSeek',
      host: 'chat.deepseek.com',
      url: 'https://chat.deepseek.com/',
      color: 'grey',
      editors: ['textarea.ds-scroll-area', 'textarea'],
      send: { kind: 'click', selector: 'div.ds-button--circle', last: true },
      replySel: '.ds-assistant-message-main-content',
      textSel: null,
      newChat: { kind: 'text', text: '开启新对话' },
      // Turn off reasoning/search toggles so a summary does not take minutes.
      prepare: function () {
        const off = [];
        for (const t of document.querySelectorAll('.ds-toggle-button')) {
          if (t.classList.contains('ds-toggle-button--select')) {
            t.click();
            off.push((t.innerText || '').trim());
          }
        }
        return off;
      },
    },
  };

  window.__AIR = window.__AIR || {};
  window.__AIR.SITES = SITES;
  window.__AIR.site = Object.keys(SITES)
    .map((k) => SITES[k])
    .find((s) => location.hostname === s.host || location.hostname.endsWith('.' + s.host)) || null;
})();
