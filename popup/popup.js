const { premium } = globalThis.BKRW;

const $ = (id) => document.getElementById(id);
const toggle = $('enabled');

let rate = null;
let forex = null;

function time(ms) {
  return new Date(ms).toLocaleTimeString('ko-KR');
}

function showRate() {
  if (!rate?.value) {
    $('rate').textContent = '시세 없음';
  } else {
    $('rate').textContent = `1 USDT = ₩${rate.value.toLocaleString('ko-KR')}`;
    const source = rate.source === 'ws' ? '실시간' : 'REST';
    $('rate-meta').textContent = `${time(rate.tradedAt || rate.fetchedAt)} 체결 · ${source}`;
  }
  $('live').classList.toggle('on', rate?.source === 'ws');
  if (rate?.error) {
    $('rate-meta').textContent = [rate.value && $('rate-meta').textContent, `갱신 실패: ${rate.error}`]
      .filter(Boolean)
      .join(' · ');
    $('rate-meta').classList.add('error');
  }
  showPremium();
}

function showPremium() {
  const el = $('premium');
  if (!rate?.value || !forex?.value) return;
  const p = premium(rate.value, forex.value) * 100;
  el.textContent = `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
  el.className = p >= 0 ? 'up' : 'down';
}

function showForex() {
  const meta = $('forex-meta');
  if (forex?.value) {
    const value = forex.value.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
    const date = new Date(forex.at).toLocaleDateString('ko-KR');
    meta.textContent = `USD/KRW ${value} · 출처 ${forex.source} 기준환율(${date})`;
  }
  if (forex?.error) {
    meta.textContent = [forex.value && meta.textContent, `환율 실패: ${forex.error}`].filter(Boolean).join(' · ');
    meta.classList.add('error');
  }
  showPremium();
}

function showPins(pins = []) {
  const el = $('pins');
  el.textContent = pins.length ? `지정한 칸 ${pins.length}개` : '자동으로 못 잡는 칸을 눌러서 지정해요';
  if (!pins.length) return;
  const clear = document.createElement('button');
  clear.className = 'link';
  clear.textContent = '모두 지우기';
  clear.addEventListener('click', () => chrome.storage.local.set({ pins: [] }));
  el.append(clear);
}

function bindSeg(key, current) {
  const seg = document.querySelector(`.seg[data-key="${key}"]`);
  const mark = (value) => {
    for (const b of seg.children) b.classList.toggle('active', b.dataset.value === value);
  };
  mark(current);
  seg.addEventListener('click', (e) => {
    const value = e.target.dataset?.value;
    if (!value) return;
    mark(value);
    chrome.storage.local.set({ [key]: value });
  });
}

chrome.storage.local.get(['enabled', 'unit', 'mode', 'pins']).then((s) => {
  toggle.checked = s.enabled ?? true;
  bindSeg('unit', s.unit ?? 'won');
  bindSeg('mode', s.mode ?? 'append');
  showPins(s.pins);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.pins) showPins(changes.pins.newValue);
});

toggle.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: toggle.checked });
});

$('pick').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await chrome.storage.local.set({ enabled: true });
    await chrome.tabs.sendMessage(tab.id, { type: 'pick' });
    window.close();
  } catch {
    $('pins').textContent = '바이낸스 탭에서 눌러 주세요(탭을 새로고침해야 할 수도 있어요)';
  }
});

// 팝업이 열려 있는 동안 실시간 시세를 받는다
const port = chrome.runtime.connect({ name: 'rate' });
port.onMessage.addListener((msg) => {
  if (msg?.type !== 'rate') return;
  rate = msg.rate;
  showRate();
});

chrome.runtime.sendMessage({ type: 'getForex' }).then((value) => {
  forex = value;
  showForex();
});
