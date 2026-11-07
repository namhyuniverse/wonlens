// 바이낸스 화면의 USDT·$ 금액을 찾아 data 속성으로 표시하고, CSS ::after 로 원화를 붙인다.
// 텍스트 노드를 직접 고치지 않으므로 React 렌더링과 충돌하지 않고, 끄면 흔적 없이 사라진다.
(() => {
  const { parseAmount, parsePureNumber, formatKrw } = globalThis.BKRW;

  const USD_ATTR = 'data-wonlens-usd';
  const LABEL_ATTR = 'data-wonlens';
  const FS_ATTR = 'data-wonlens-fs';
  const STYLE_ID = 'wonlens-style';
  const MAX_TEXT = 48; // 이보다 긴 텍스트를 가진 요소는 금액 하나로 보지 않는다
  const MAX_HOPS = 2; // 숫자만 있는 요소에서 단위를 찾으러 올라가는 최대 단계
  const RATE_STALE_MS = 10 * 60_000; // 이보다 오래된 시세로는 표시하지 않는다
  const FLUSH_MS = 200;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION']);
  const MARKED = `[${LABEL_ATTR}]:not([${LABEL_ATTR}=""])`;

  const settings = { unit: 'won', mode: 'append', pins: [] };
  let enabled = false;
  let rate = null;
  let port = null;
  let observer = null;
  let flushTimer = null;
  let picking = null;
  const pending = new Set();
  const fontSizes = new WeakMap();

  function css() {
    if (settings.mode === 'replace') {
      // 원래 숫자를 글자 크기 0 으로 숨기고 원화만 같은 크기로 그린다
      return `
${MARKED}, ${MARKED} * { font-size: 0 !important; }
${MARKED}::after {
  content: attr(${LABEL_ATTR});
  font-size: 13px;
  font-size: attr(${FS_ATTR} type(<length>), 13px) !important;
  white-space: nowrap;
}`;
    }
    return `
${MARKED}::after {
  content: attr(${LABEL_ATTR});
  margin-left: 4px;
  font-size: 0.85em;
  font-weight: 400;
  opacity: 0.7;
  white-space: nowrap;
}`;
  }

  function applyStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = css();
  }

  function amountOf(el) {
    const text = el.textContent;
    if (!text || text.length > MAX_TEXT) return null;
    return parseAmount(text);
  }

  // 텍스트 노드 하나에서 금액을 표시할 요소와 금액을 찾는다.
  // 1) 부모 요소 텍스트가 "123.45 USDT" 꼴이면 그 요소
  // 2) 숫자만 있으면 단위가 붙은 조상(최대 MAX_HOPS)을 찾되, 그 금액이 이 숫자와 같을 때만
  function findTarget(textNode) {
    const own = textNode.data;
    if (!/[0-9]/.test(own)) return null;
    let el = textNode.parentElement;
    if (!el || SKIP_TAGS.has(el.tagName)) return null;

    const direct = amountOf(el);
    if (direct !== null) return [el, direct];

    const pure = parsePureNumber(own);
    if (pure === null) return null;
    for (let hop = 0; hop < MAX_HOPS && el.parentElement; hop++) {
      el = el.parentElement;
      if (el.textContent.length > MAX_TEXT) return null;
      const amount = amountOf(el);
      if (amount !== null) return Math.abs(amount) === Math.abs(pure) ? [el, amount] : null;
    }
    return null;
  }

  function label(usd) {
    if (!rate || Date.now() - rate.fetchedAt > RATE_STALE_MS) return '';
    return formatKrw(usd, rate.value, { unit: settings.unit, approx: settings.mode !== 'replace' });
  }

  // 원화만 보기에서 쓸 원래 글자 크기. 표시 전에 한 번 재서 기억한다
  function fontSizeOf(el) {
    let size = fontSizes.get(el);
    if (!size) {
      size = getComputedStyle(el).fontSize;
      if (size === '0px') return null;
      fontSizes.set(el, size);
    }
    return size;
  }

  function setAttr(el, name, value) {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  function mark(el, usd) {
    const size = fontSizeOf(el);
    if (size) setAttr(el, FS_ATTR, size);
    setAttr(el, USD_ATTR, String(usd));
    setAttr(el, LABEL_ATTR, label(usd));
  }

  function unmark(el) {
    el.removeAttribute(USD_ATTR);
    el.removeAttribute(LABEL_ATTR);
    el.removeAttribute(FS_ATTR);
  }

  function clearMarks(scope) {
    for (const el of scope.querySelectorAll(`[${USD_ATTR}]`)) unmark(el);
    if (scope.hasAttribute?.(USD_ATTR)) unmark(scope);
  }

  function scan(node) {
    const host = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!host || !host.isConnected) return;
    // 이미 표시된 조상이 있으면 그 범위째 다시 본다(숫자만 바뀌어도 조상 표시가 갱신되도록)
    const scope = host.closest(`[${USD_ATTR}]`) || host;
    clearMarks(scope);
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const found = findTarget(t);
      if (found) mark(found[0], found[1]);
    }
  }

  function relabel() {
    for (const el of document.querySelectorAll(`[${USD_ATTR}]`)) {
      setAttr(el, LABEL_ATTR, label(Number(el.getAttribute(USD_ATTR))));
    }
  }

  // ---- 칸 직접 지정 ----

  // 경로 첫 칸(언어 코드 제외)을 화면 종류로 본다: /ko/futures/BTCUSDT → futures
  function pageKey() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length && /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(parts[0])) parts.shift();
    return parts[0] || '';
  }

  function cssPath(el) {
    const parts = [];
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (node.id && !/\d{3,}|:/.test(node.id)) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        return parts.join(' > ');
      }
      let part = node.tagName.toLowerCase();
      const siblings = [...node.parentElement.children].filter((c) => c.tagName === node.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      parts.unshift(part);
    }
    return `body > ${parts.join(' > ')}`;
  }

  function query(selector) {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  function readPinned(el) {
    const text = el.textContent || '';
    if (!text || text.length > MAX_TEXT) return null;
    return parseAmount(text) ?? parsePureNumber(text);
  }

  // 지정한 칸은 단위가 없어도 USD 로 보고 표시한다. 자동으로 잡힌 표시와 겹치면 건너뛴다
  function applyPins() {
    const page = pageKey();
    for (const pin of settings.pins) {
      if (pin.page !== page) continue;
      const el = query(pin.selector);
      if (!el) continue;
      const usd = readPinned(el);
      if (usd === null) continue;
      if (el.parentElement?.closest(`[${USD_ATTR}]`) || el.querySelector(`[${USD_ATTR}]`)) continue;
      mark(el, usd);
    }
  }

  function rescanAll() {
    clearMarks(document.body);
    scan(document.body);
    applyPins();
  }

  function startPick() {
    if (picking) return;
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;display:none;border:2px solid #6C8CFF;' +
      'background:rgba(108,140,255,.15);border-radius:3px';
    const tip = document.createElement('div');
    tip.style.cssText =
      'position:fixed;z-index:2147483647;top:12px;left:50%;transform:translateX(-50%);pointer-events:none;' +
      'padding:8px 12px;border-radius:6px;background:#14161b;color:#e6e8eb;font:13px/1.4 sans-serif;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.4)';
    tip.textContent = '원화로 볼 숫자 칸을 클릭하세요 · 지정한 칸을 다시 누르면 해제 · Esc 취소';
    // body 밖에 붙여 MutationObserver 를 건드리지 않는다
    document.documentElement.append(box, tip);

    const block = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    const onMove = (e) => {
      const r = e.target.getBoundingClientRect();
      Object.assign(box.style, {
        display: 'block',
        left: `${r.left - 2}px`,
        top: `${r.top - 2}px`,
        width: `${r.width + 4}px`,
        height: `${r.height + 4}px`,
      });
    };
    const onClick = (e) => {
      block(e);
      choose(e.target);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      block(e);
      endPick();
    };
    const listeners = [
      ['mousemove', onMove],
      ['pointerdown', block],
      ['mousedown', block],
      ['pointerup', block],
      ['mouseup', block],
      ['click', onClick],
      ['keydown', onKey],
    ];
    for (const [type, fn] of listeners) window.addEventListener(type, fn, true);
    picking = { box, tip, listeners };
  }

  function endPick(message) {
    if (!picking) return;
    const { box, tip, listeners } = picking;
    for (const [type, fn] of listeners) window.removeEventListener(type, fn, true);
    picking = null;
    box.remove();
    if (!message) {
      tip.remove();
      return;
    }
    tip.textContent = message;
    setTimeout(() => tip.remove(), 1500);
  }

  async function choose(target) {
    const page = pageKey();
    const existing = settings.pins.find((p) => p.page === page && query(p.selector)?.contains(target));
    if (existing) {
      await savePins(settings.pins.filter((p) => p !== existing));
      endPick('지정을 해제했어요');
      return;
    }
    if (readPinned(target) === null) {
      picking.tip.textContent = 'USD 금액으로 읽을 수 없는 칸이에요(숫자·USDT·$ 만). 다른 칸을 눌러 주세요 · Esc 취소';
      return;
    }
    const selector = cssPath(target);
    if (query(selector) !== target) {
      picking.tip.textContent = '이 칸은 위치를 고정할 수 없어요. 다른 칸을 눌러 주세요 · Esc 취소';
      return;
    }
    await savePins([...settings.pins, { page, selector }]);
    endPick('지정했어요');
  }

  async function savePins(pins) {
    await chrome.storage.local.set({ pins });
  }

  // ---- 갱신 루프 ----

  function flush() {
    flushTimer = null;
    const roots = [...pending];
    pending.clear();
    if (roots.length > 300) scan(document.body);
    else for (const root of roots) scan(root);
    applyPins();
  }

  function onMutations(mutations) {
    for (const m of mutations) pending.add(m.target);
    flushTimer ??= setTimeout(flush, FLUSH_MS);
  }

  // 백그라운드가 웹소켓으로 받은 시세를 포트로 밀어 준다. 탭이 안 보이는 동안은 끊어 둔다
  function connect() {
    if (port || !enabled || document.hidden) return;
    try {
      port = chrome.runtime.connect({ name: 'rate' });
    } catch {
      stop(); // 확장을 다시 불러와 이 content script 의 연결이 끊긴 경우
      return;
    }
    port.onMessage.addListener((msg) => {
      if (msg?.type === 'rate' && msg.rate?.value) {
        rate = msg.rate;
        relabel();
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      if (!chrome.runtime?.id) {
        stop();
        return;
      }
      setTimeout(connect, 1000); // 서비스 워커가 내려간 경우 다시 깨운다
    });
  }

  function disconnect() {
    const p = port;
    port = null;
    p?.disconnect();
  }

  function onVisibility() {
    if (document.hidden) disconnect();
    else connect();
  }

  function start() {
    if (enabled) return;
    enabled = true;
    applyStyle();
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    rescanAll();
    document.addEventListener('visibilitychange', onVisibility);
    connect();
  }

  function stop() {
    if (!enabled) return;
    enabled = false;
    observer?.disconnect();
    observer = null;
    clearTimeout(flushTimer);
    flushTimer = null;
    pending.clear();
    document.removeEventListener('visibilitychange', onVisibility);
    disconnect();
    endPick();
    document.getElementById(STYLE_ID)?.remove();
    clearMarks(document.body);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.unit) settings.unit = changes.unit.newValue ?? 'won';
    if (changes.mode) settings.mode = changes.mode.newValue ?? 'append';
    if (changes.pins) settings.pins = changes.pins.newValue ?? [];
    if (changes.enabled) {
      changes.enabled.newValue === false ? stop() : start();
      return;
    }
    if (!enabled) return;
    if (changes.mode) applyStyle();
    if (changes.pins) rescanAll();
    else if (changes.unit || changes.mode) relabel();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'pick') startPick();
  });

  chrome.storage.local.get(['enabled', 'unit', 'mode', 'pins']).then((saved) => {
    settings.unit = saved.unit ?? 'won';
    settings.mode = saved.mode ?? 'append';
    settings.pins = saved.pins ?? [];
    if (saved.enabled ?? true) start();
  });
})();
