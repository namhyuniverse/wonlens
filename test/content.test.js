// content script 를 jsdom 의 바이낸스 비슷한 화면에 올려 표시·갱신·끄기·직접 지정을 확인한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const FORMAT_SRC = fs.readFileSync(path.join(__dirname, '../src/format.js'), 'utf8');
const CONTENT_SRC = fs.readFileSync(path.join(__dirname, '../src/content.js'), 'utf8');

const PAGE = `<!doctype html><html><head></head><body>
  <div class="account">
    <div>Margin Balance</div><div id="mb">1,234.56 USDT</div>
    <div>Estimated</div><div id="est">≈ $98.70</div>
  </div>
  <div id="pnl"><span id="pnl-num">-12.30</span><span>USDT</span></div>
  <table><tr><td id="price">95,000.1</td><td id="size">0.010 BTC</td></tr></table>
  <div class="panel"><span id="bare">500.00</span></div>
</body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FLUSH = 260;

function load(store = {}) {
  // pretendToBeVisual: 탭이 보이는 상태(document.hidden=false)여야 시세 포트를 연다
  const dom = new JSDOM(PAGE, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://www.binance.com/ko/futures/BTCUSDT',
  });
  const { window } = dom;
  const storageListeners = [];
  const messageListeners = [];
  const portListeners = [];
  window.CSS ??= {};
  window.CSS.escape ??= (s) => s;
  window.chrome = {
    runtime: {
      id: 'test',
      connect: () => ({
        onMessage: { addListener: (f) => portListeners.push(f) },
        onDisconnect: { addListener() {} },
        disconnect() {},
      }),
      onMessage: { addListener: (f) => messageListeners.push(f) },
    },
    storage: {
      local: {
        get: async () => ({ ...store }),
        set: async (obj) => {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) changes[k] = { oldValue: store[k], newValue: v };
          Object.assign(store, obj);
          for (const f of storageListeners) f(changes, 'local');
        },
      },
      onChanged: { addListener: (f) => storageListeners.push(f) },
    },
  };
  window.eval(FORMAT_SRC);
  window.eval(CONTENT_SRC);
  const doc = window.document;
  return {
    window,
    doc,
    store,
    el: (id) => doc.getElementById(id),
    label: (id) => doc.getElementById(id).getAttribute('data-wonlens'),
    pushRate: (value) => {
      for (const f of portListeners) f({ type: 'rate', rate: { value, fetchedAt: Date.now(), source: 'ws' } });
    },
    setStore: (obj) => window.chrome.storage.local.set(obj),
    send: (msg) => {
      for (const f of messageListeners) f(msg);
    },
    click: (id) => doc.getElementById(id).dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
  };
}

test('단위가 붙은 금액만 잡고 가격·코인 수량은 건너뛴다', async () => {
  const p = load();
  await sleep(0);
  p.pushRate(1364);
  assert.equal(p.label('mb'), '≈ ₩1,683,940');
  assert.equal(p.label('est'), '≈ ₩134,627');
  assert.equal(p.label('pnl'), '≈ -₩16,777'); // 숫자와 USDT 가 다른 span 이면 부모에 붙는다
  assert.equal(p.el('pnl-num').hasAttribute('data-wonlens'), false);
  assert.equal(p.el('price').hasAttribute('data-wonlens'), false);
  assert.equal(p.el('size').hasAttribute('data-wonlens'), false);
  assert.equal(p.el('bare').hasAttribute('data-wonlens'), false);
});

test('숫자가 바뀌면 원화도 따라 바뀌고 시세가 바뀌면 다시 계산한다', async () => {
  const p = load();
  await sleep(0);
  p.pushRate(1364);
  p.el('pnl-num').firstChild.data = '-20.00';
  await sleep(FLUSH);
  assert.equal(p.label('pnl'), '≈ -₩27,280');
  p.pushRate(1400);
  assert.equal(p.label('pnl'), '≈ -₩28,000');
});

test('표기 단위와 원화만 보기', async () => {
  const p = load();
  await sleep(0);
  p.pushRate(1364);
  await p.setStore({ unit: 'auto' });
  assert.equal(p.label('mb'), '≈ 168.4만원');
  assert.equal(p.label('est'), '≈ 13.5만원');
  await p.setStore({ unit: 'man', mode: 'replace' });
  assert.equal(p.label('pnl'), '-1.7만원'); // 원화만 보기에서는 ≈ 를 뗀다
  assert.match(p.doc.getElementById('wonlens-style').textContent, /font-size: 0 !important/);
});

test('끄면 속성과 스타일이 모두 사라진다', async () => {
  const p = load();
  await sleep(0);
  p.pushRate(1364);
  await p.setStore({ enabled: false });
  assert.equal(p.doc.querySelectorAll('[data-wonlens-usd]').length, 0);
  assert.equal(p.doc.getElementById('wonlens-style'), null);
  await p.setStore({ enabled: true });
  assert.equal(p.label('mb'), '≈ ₩1,683,940');
});

test('저장된 꺼짐 상태면 아무것도 붙이지 않는다', async () => {
  const p = load({ enabled: false });
  await sleep(0);
  p.pushRate(1364);
  assert.equal(p.doc.querySelectorAll('[data-wonlens-usd]').length, 0);
});

test('칸 직접 지정: 단위 없는 숫자를 눌러 지정하고 다시 눌러 해제한다', async () => {
  const p = load();
  await sleep(0);
  p.pushRate(1364);

  p.send({ type: 'pick' });
  p.click('bare');
  await sleep(0);
  assert.equal(p.store.pins.length, 1);
  assert.equal(p.store.pins[0].page, 'futures');
  assert.equal(p.label('bare'), '≈ ₩682,000');

  // 숫자가 바뀌어도 지정이 유지된다
  p.el('bare').firstChild.data = '600.00';
  await sleep(FLUSH);
  assert.equal(p.label('bare'), '≈ ₩818,400');

  p.send({ type: 'pick' });
  p.click('bare');
  await sleep(0);
  assert.equal(p.store.pins.length, 0);
  assert.equal(p.el('bare').hasAttribute('data-wonlens'), false);
});

test('칸 직접 지정: 숫자가 아닌 칸은 거절하고 고르기를 계속한다', async () => {
  const p = load();
  await sleep(0);
  p.send({ type: 'pick' });
  p.click('size');
  await sleep(0);
  assert.equal(p.store.pins, undefined);
  p.click('bare');
  await sleep(0);
  assert.equal(p.store.pins.length, 1);
});
