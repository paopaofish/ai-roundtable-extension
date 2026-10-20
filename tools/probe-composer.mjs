import { evaluate } from './wb.mjs';

const code = `(() => {
  const out = {};
  out.vis = document.visibilityState;
  const sel = ['.tiptap.ProseMirror', 'textarea[data-testid="chat_input_input"]', 'textarea.textarea-YelHeN'];
  out.nodes = sel.map((s) => {
    const els = [...document.querySelectorAll(s)];
    return {
      sel: s,
      n: els.length,
      info: els.map((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const isField = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
        return {
          tag: el.tagName,
          rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          display: cs.display,
          vis: cs.visibility,
          pe: cs.pointerEvents,
          innerTextLen: (el.innerText || '').length,
          textContentLen: (el.textContent || '').length,
          valueLen: isField ? (el.value || '').length : null,
          childCount: el.children.length,
          html: el.innerHTML.slice(0, 120),
        };
      }),
    };
  });
  const pm = document.querySelector('.tiptap.ProseMirror');
  if (pm) {
    const r = pm.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    out.hitTag = hit ? hit.tagName : null;
    out.hitCls = hit ? String(hit.className || '').slice(0, 40) : null;
    out.hitIsPm = hit === pm;
  }
  const btn = document.querySelector('[data-testid="chat_input_send_button"]');
  out.sendBtn = btn ? { dis: btn.disabled === true, aria: btn.getAttribute('aria-disabled') } : null;
  return JSON.stringify(out);
})()`;

console.log(JSON.stringify(await evaluate(code, 'doubao', { timeoutMs: 15000 }), null, 2));
