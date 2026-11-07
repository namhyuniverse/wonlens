const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAmount, parsePureNumber, formatKrw, premium } = require('../src/format.js');

test('USDT 단위가 붙은 금액', () => {
  assert.equal(parseAmount('1,234.56 USDT'), 1234.56);
  assert.equal(parseAmount('-12.30USDT'), -12.3);
  assert.equal(parseAmount('+0.52 USDT (+3.10%)'), 0.52);
  assert.equal(parseAmount('≈ 100 USDC'), 100);
  assert.equal(parseAmount('−7.5 FDUSD'), -7.5);
});

test('달러 표시 금액', () => {
  assert.equal(parseAmount('$1,234.56'), 1234.56);
  assert.equal(parseAmount('≈ $98.7'), 98.7);
  assert.equal(parseAmount('-$12.30'), -12.3);
});

test('금액이 아닌 텍스트는 null', () => {
  assert.equal(parseAmount('Margin Balance 1,234.56 USDT'), null); // 라벨이 앞에 붙은 큰 덩어리
  assert.equal(parseAmount('0.010 BTC'), null);
  assert.equal(parseAmount('1.23K USDT'), null); // 축약 표기는 값이 틀릴 수 있어 건너뜀
  assert.equal(parseAmount('USDT'), null);
  assert.equal(parseAmount('******'), null);
  assert.equal(parseAmount('BTCUSDT'), null);
  assert.equal(parseAmount('12.3 USDTX'), null);
});

test('숫자만 있는 텍스트', () => {
  assert.equal(parsePureNumber('-12.30'), -12.3);
  assert.equal(parsePureNumber(' 1,234 '), 1234);
  assert.equal(parsePureNumber('12.3%'), null);
  assert.equal(parsePureNumber('(-5.2%)'), null);
});

test('원화 표기', () => {
  assert.equal(formatKrw(1234.56, 1364), '≈ ₩1,683,940');
  assert.equal(formatKrw(-12.3, 1364), '≈ -₩16,777');
  assert.equal(formatKrw(-0.0001, 1364), '≈ ₩0');
});

test('표기 단위', () => {
  assert.equal(formatKrw(1234.56, 1364, { unit: 'man' }), '≈ 168.4만원');
  assert.equal(formatKrw(3, 1364, { unit: 'man' }), '≈ 0.4만원');
  assert.equal(formatKrw(-12.3, 1364, { unit: 'man', approx: false }), '-1.7만원');
  assert.equal(formatKrw(3, 1364, { unit: 'auto' }), '≈ ₩4,092');
  assert.equal(formatKrw(1234.56, 1364, { unit: 'auto' }), '≈ 168.4만원');
  assert.equal(formatKrw(123456, 1364, { unit: 'auto' }), '≈ 1.68억원');
  assert.equal(formatKrw(1234.56, 1364, { approx: false }), '₩1,683,940');
});

test('김프', () => {
  assert.ok(Math.abs(premium(1364, 1363.65) - 0.000256666) < 1e-6);
  assert.ok(premium(1350, 1360) < 0);
});
