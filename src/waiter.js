/* Reply-completion waiter, extracted from the content script so it can be
 * tested deterministically with scripted reply sequences.
 *
 * Injected as a classic script (content scripts cannot use ES modules).
 */
(function () {
  function createReplyWaiter(deps) {
    const {
      readReply,
      sleep,
      now = () => Date.now(),
      isScaffold,
      hasCleanEnd,
      resolveAmbiguity = null,
      trace = () => {},
    } = deps;

    /**
     * @param {string} baselineText text of the last reply before sending
     * @param {{timeoutMs:number, stableMs?:number, firstReplyMs?:number,
     *          cleanEndGraceMs?:number, onProgress?:Function}} opts
     */
    return async function waitForReply(baselineText, opts) {
      const {
        timeoutMs,
        stableMs = 4000,
        firstReplyMs = 150000,
        cleanEndGraceMs = 15000,
        onProgress = null,
      } = opts;

      const startedAt = now();
      let lastText = '';
      let lastChangeAt = 0;
      let appearedAt = 0;
      let lastResolveAt = 0;
      let consecutiveErrors = 0;

      // Background tabs throttle timers down to ~1/minute after a few minutes,
      // which would stall a plain sleep-poll loop. Wake on DOM mutations too:
      // the reply stream keeps mutating, so we notice instantly either way.
      let notify = null;
      const observer =
        typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && document.body
          ? new MutationObserver(() => {
              if (notify) {
                const n = notify;
                notify = null;
                n();
              }
            })
          : null;
      if (observer) {
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      }
      // Resolves on the injected sleep OR on the first DOM mutation.
      const tick = (ms) =>
        new Promise((resolve) => {
          const finish = () => {
            if (notify === finish) notify = null;
            resolve();
          };
          notify = finish;
          Promise.resolve(sleep(ms)).then(finish, finish);
        });

      try {
        for (;;) {
          const elapsed = now() - startedAt;
          if (elapsed > timeoutMs) {
            trace('timeout', { elapsed, lastLen: lastText.length });
            const err = new Error(`等待回复超时（${Math.round(timeoutMs / 1000)} 秒）`);
            err.code = 'E_TIMEOUT';
            err.partial = lastText;
            throw err;
          }

          let snap;
          try {
            snap = readReply();
            consecutiveErrors = 0;
          } catch (err) {
            consecutiveErrors += 1;
            if (consecutiveErrors >= 3) {
              const e = new Error('页面无响应，请刷新该标签页');
              e.code = 'E_UNRESPONSIVE';
              e.cause = err && err.message;
              throw e;
            }
            await tick(400);
            continue;
          }

          if (resolveAmbiguity && now() - lastResolveAt > 3000) {
            lastResolveAt = now();
            try {
              if (resolveAmbiguity()) {
                trace('resolved-ambiguity');
                await tick(500);
                continue;
              }
            } catch {
              /* ignore */
            }
          }

          const appeared = snap.text.length > 0 && snap.text !== baselineText;
          if (appeared) {
            if (!appearedAt) {
              appearedAt = now();
              trace('appeared', { len: snap.text.length });
            }
            if (snap.text !== lastText) {
              lastText = snap.text;
              lastChangeAt = now();
              trace('text-changed', { len: lastText.length });
            }
            if (onProgress) onProgress(lastText.length, elapsed);

            const stableFor = now() - lastChangeAt;
            if (lastText.trim().length > 0 && stableFor >= stableMs) {
              if (isScaffold(lastText)) {
                trace('scaffold-wait', { len: lastText.length, stableFor });
                await tick(600);
                continue;
              }
              const cleanEnd = hasCleanEnd(lastText);
              if (!cleanEnd && stableFor < cleanEndGraceMs) {
                trace('wait-clean-end', { len: lastText.length, stableFor });
                await tick(600);
                continue;
              }
              await tick(450);
              const again = readReply();
              if (again.text === lastText) {
                trace('accept', { len: lastText.length, cleanEnd, elapsed });
                return lastText;
              }
              trace('changed-during-confirm', { was: lastText.length, now: again.text.length });
              lastText = again.text;
              lastChangeAt = now();
            }
          } else if (appearedAt === 0 && elapsed > firstReplyMs) {
            const e = new Error(`发送后 ${Math.round(firstReplyMs / 1000)} 秒内没有出现新回复`);
            e.code = 'E_NO_REPLY';
            throw e;
          }

          await tick(400);
        }
      } finally {
        if (observer) observer.disconnect();
      }
    };
  }

  window.__AIR = window.__AIR || {};
  window.__AIR.createReplyWaiter = createReplyWaiter;
})();
