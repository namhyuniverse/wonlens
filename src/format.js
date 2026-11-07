// 문자열 → 달러 금액 판별과 원화 표기. content script·popup·node 테스트가 같이 쓴다.
(function () {
  const NUM = '([+\\-−]?)\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)';
  // "1,234.56 USDT", "-12.3USDT (-5.2%)", "≈ 100 USDC"
  const UNIT_RE = new RegExp('^(?:≈\\s*)?' + NUM + '\\s*(?:USDT|USDC|FDUSD)(?![A-Za-z])');
  // "$1,234.56", "≈ $1,234.56", "-$12.30"
  const DOLLAR_RE = new RegExp('^(?:≈\\s*)?([+\\-−]?)\\s*\\$\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)(?![0-9A-Za-z])');
  const PURE_RE = /^[+\-−]?\s*[0-9][0-9,]*(?:\.[0-9]+)?$/;

  const MAN = 1e4;
  const EOK = 1e8;

  function toNumber(sign, digits) {
    const value = Number(digits.replace(/,/g, ''));
    if (!Number.isFinite(value)) return null;
    return sign === '-' || sign === '−' ? -value : value;
  }

  // 텍스트가 달러 표시 금액으로 시작하면 부호 포함 금액, 아니면 null
  function parseAmount(text) {
    const t = text.trim();
    const m = UNIT_RE.exec(t) || DOLLAR_RE.exec(t);
    return m ? toNumber(m[1], m[2]) : null;
  }

  // 단위 없이 숫자만 있는 텍스트("-12.30")면 그 값, 아니면 null
  function parsePureNumber(text) {
    const t = text.trim();
    if (!PURE_RE.test(t)) return null;
    const sign = /^[-−]/.test(t) ? '-' : '';
    return toNumber(sign, t.replace(/^[+\-−]\s*/, ''));
  }

  function grouped(value, digits) {
    return value.toLocaleString('ko-KR', { maximumFractionDigits: digits });
  }

  // unit: 'won' → ₩1,683,940 / 'man' → 168.4만원 / 'auto' → 1억 이상 억원, 1만 이상 만원, 그 아래 ₩
  function formatKrw(usd, rate, { unit = 'won', approx = true } = {}) {
    const krw = Math.round(usd * rate);
    const sign = krw < 0 ? '-' : '';
    const abs = Math.abs(krw);
    let body;
    if (unit === 'man' || (unit === 'auto' && abs >= MAN && abs < EOK)) {
      body = `${grouped(abs / MAN, 1)}만원`;
    } else if (unit === 'auto' && abs >= EOK) {
      body = `${grouped(abs / EOK, 2)}억원`;
    } else {
      body = `₩${grouped(abs, 0)}`;
    }
    return `${approx ? '≈ ' : ''}${sign}${body}`;
  }

  // 업비트 USDT 원화 시세가 USD/KRW 환율보다 몇 % 비싼지(테더 김프)
  function premium(usdtKrw, usdKrw) {
    return usdtKrw / usdKrw - 1;
  }

  const api = { parseAmount, parsePureNumber, formatKrw, premium };
  globalThis.BKRW = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();
