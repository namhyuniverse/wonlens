// 업비트 USDT/KRW 시세(웹소켓 실시간, 끊기면 REST)와 김프용 USD/KRW 환율을 받아 탭·팝업에 나눠 준다.
const REST_URL = 'https://api.upbit.com/v1/ticker?markets=KRW-USDT';
const WS_URL = 'wss://api.upbit.com/websocket/v1';
const REST_MAX_AGE_MS = 10_000;
const TICK_MS = 20_000; // 웹소켓 PING·재연결·REST 대체 주기. 20초마다 보내는 PING 이 서비스 워커도 깨워 둔다
const WS_SILENT_MS = 30_000; // 이만큼 체결이 안 들어오면 REST 로 한 번 받는다
const BROADCAST_MS = 500;
const SAVE_MS = 5_000;
const CLOSE_GRACE_MS = 30_000; // 마지막 탭이 닫힌 뒤 이만큼 기다렸다 웹소켓을 닫는다
const FOREX_MAX_AGE_MS = 60 * 60_000;

// USD/KRW 출처. 재사용 조건(출처 표기)이 공개된 ECB 기준환율만 쓴다. 영업일 하루 한 번 갱신
const FOREX_SOURCES = [
  {
    name: 'ECB',
    url: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW',
    parse: (d) => ({ value: d.rates.KRW, at: Date.parse(d.date) }),
  },
];

const ports = new Set();
let socket = null;
let tickTimer = null;
let closeTimer = null;
let latest = null; // { value, tradedAt, fetchedAt, source: 'ws' | 'rest' }
let restInflight = null;
let forexInflight = null;
let broadcastTimer = null;
let lastBroadcast = 0;
let lastSaved = 0;

function setRate(rate) {
  latest = rate;
  const now = Date.now();
  if (now - lastSaved >= SAVE_MS) {
    lastSaved = now;
    chrome.storage.local.set({ rate });
  }
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(
    () => {
      broadcastTimer = null;
      lastBroadcast = Date.now();
      for (const port of ports) port.postMessage({ type: 'rate', rate: latest });
    },
    Math.max(0, lastBroadcast + BROADCAST_MS - now),
  );
}

async function fetchRest() {
  const res = await fetch(REST_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`업비트 응답 HTTP ${res.status}`);
  const [ticker] = await res.json();
  const value = Number(ticker?.trade_price);
  if (!Number.isFinite(value) || value <= 0) throw new Error('업비트 응답에 시세가 없음');
  const rate = { value, tradedAt: ticker.trade_timestamp, fetchedAt: Date.now(), source: 'rest' };
  setRate(rate);
  return rate;
}

// 실패하면 마지막 값에 error 를 붙여 돌려준다
async function refreshRest() {
  restInflight ??= fetchRest().finally(() => {
    restInflight = null;
  });
  try {
    return await restInflight;
  } catch (e) {
    return { ...(latest || {}), error: String(e?.message || e) };
  }
}

async function getRate() {
  if (!latest) ({ rate: latest = null } = await chrome.storage.local.get('rate'));
  if (latest && Date.now() - latest.fetchedAt < REST_MAX_AGE_MS) return latest;
  return refreshRest();
}

function openSocket() {
  if (socket) return;
  const ws = new WebSocket(WS_URL);
  ws.binaryType = 'arraybuffer';
  socket = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify([{ ticket: `wonlens-${crypto.randomUUID()}` }, { type: 'ticker', codes: ['KRW-USDT'] }]));
  };
  ws.onmessage = (e) => {
    const text = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data);
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === 'ticker' && msg.trade_price > 0) {
      setRate({ value: msg.trade_price, tradedAt: msg.trade_timestamp, fetchedAt: Date.now(), source: 'ws' });
    }
  };
  ws.onerror = () => ws.close();
  ws.onclose = () => {
    if (socket === ws) socket = null; // 다음 tick 에서 다시 연결한다
  };
}

function tick() {
  if (socket?.readyState === WebSocket.OPEN) socket.send('PING');
  else openSocket();
  if (!latest || Date.now() - latest.fetchedAt > WS_SILENT_MS) refreshRest();
}

function startSession() {
  clearTimeout(closeTimer);
  closeTimer = null;
  if (tickTimer) return;
  openSocket();
  tickTimer = setInterval(tick, TICK_MS);
}

function stopSession() {
  clearInterval(tickTimer);
  tickTimer = null;
  socket?.close();
  socket = null;
}

async function fetchForex() {
  const errors = [];
  for (const source of FOREX_SOURCES) {
    try {
      const res = await fetch(source.url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { value, at } = source.parse(await res.json());
      if (!Number.isFinite(value) || value <= 0) throw new Error('응답에 환율이 없음');
      const forex = { value, at, source: source.name, fetchedAt: Date.now() };
      await chrome.storage.local.set({ forex });
      return forex;
    } catch (e) {
      errors.push(`${source.name}: ${e?.message || e}`);
    }
  }
  throw new Error(errors.join(' / '));
}

async function getForex() {
  const { forex } = await chrome.storage.local.get('forex');
  if (forex && Date.now() - forex.fetchedAt < FOREX_MAX_AGE_MS) return forex;
  forexInflight ??= fetchForex().finally(() => {
    forexInflight = null;
  });
  try {
    return await forexInflight;
  } catch (e) {
    return { ...(forex || {}), error: String(e?.message || e) };
  }
}

async function updateBadge() {
  const { enabled = true } = await chrome.storage.local.get('enabled');
  await chrome.action.setBadgeText({ text: enabled ? '₩' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#6C8CFF' });
}

// 탭(content script)·팝업이 'rate' 포트를 열어 두는 동안만 웹소켓을 유지한다
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'rate') return;
  ports.add(port);
  startSession();
  getRate().then((rate) => {
    try {
      port.postMessage({ type: 'rate', rate });
    } catch {
      // 그새 닫힌 포트
    }
  });
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    if (!ports.size) closeTimer = setTimeout(stopSession, CLOSE_GRACE_MS);
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'getRate') {
    getRate().then(sendResponse);
    return true;
  }
  if (msg?.type === 'getForex') {
    getForex().then(sendResponse);
    return true;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-krw') return;
  const { enabled = true } = await chrome.storage.local.get('enabled');
  await chrome.storage.local.set({ enabled: !enabled });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'enabled' in changes) updateBadge();
});

chrome.runtime.onInstalled.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);
