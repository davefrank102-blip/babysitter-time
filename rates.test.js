/**
 * Lightweight unit tests for rates.js — run with: node rates.test.js
 */
import {
  splitPay,
  zonedDateTimeToUtcMs,
  getZonedParts,
  rangeToday,
  rangeThisWeek,
} from './rates.js';

const TZ = 'America/New_York';
const opts = { morningRate: 20, afternoonRate: 25, cutoffHour: 12, timeZone: TZ };

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function assertClose(actual, expected, msg, eps = 0.0002) {
  const ok = Math.abs(actual - expected) <= eps;
  assert(ok, `${msg} (got ${actual}, expected ${expected})`);
}

function at(y, m, d, h, min = 0, s = 0) {
  return zonedDateTimeToUtcMs(y, m, d, h, min, s, TZ);
}

console.log('rates.js tests\n');

// --- helpers sanity ---
console.log('helpers');
{
  const ms = at(2026, 3, 15, 9, 30, 0);
  const p = getZonedParts(ms, TZ);
  assert(p.year === 2026 && p.month === 3 && p.day === 15, 'zoned parts date');
  assert(p.hour === 9 && p.minute === 30, 'zoned parts time');
}

// --- all morning ---
console.log('\nall morning');
{
  const r = splitPay(at(2026, 6, 10, 8, 0), at(2026, 6, 10, 11, 0), opts);
  assertClose(r.morningHours, 3, 'morning hours = 3');
  assertClose(r.afternoonHours, 0, 'afternoon hours = 0');
  assertClose(r.morningPay, 60, 'morning pay = $60');
  assertClose(r.afternoonPay, 0, 'afternoon pay = $0');
  assertClose(r.totalHours, 3, 'total hours = 3');
  assertClose(r.totalPay, 60, 'total pay = $60');
}

// --- all afternoon ---
console.log('\nall afternoon');
{
  const r = splitPay(at(2026, 6, 10, 13, 0), at(2026, 6, 10, 17, 0), opts);
  assertClose(r.morningHours, 0, 'morning hours = 0');
  assertClose(r.afternoonHours, 4, 'afternoon hours = 4');
  assertClose(r.morningPay, 0, 'morning pay = $0');
  assertClose(r.afternoonPay, 100, 'afternoon pay = $100');
  assertClose(r.totalPay, 100, 'total pay = $100');
}

// --- crosses noon ---
console.log('\ncrosses noon');
{
  // 10:00 → 14:00 = 2h morning + 2h afternoon = $40 + $50 = $90
  const r = splitPay(at(2026, 6, 10, 10, 0), at(2026, 6, 10, 14, 0), opts);
  assertClose(r.morningHours, 2, 'morning hours = 2');
  assertClose(r.afternoonHours, 2, 'afternoon hours = 2');
  assertClose(r.morningPay, 40, 'morning pay = $40');
  assertClose(r.afternoonPay, 50, 'afternoon pay = $50');
  assertClose(r.totalHours, 4, 'total hours = 4');
  assertClose(r.totalPay, 90, 'total pay = $90');
}

// --- starts exactly at noon ---
console.log('\nstarts at noon');
{
  const r = splitPay(at(2026, 6, 10, 12, 0), at(2026, 6, 10, 15, 0), opts);
  assertClose(r.morningHours, 0, 'morning hours = 0');
  assertClose(r.afternoonHours, 3, 'afternoon hours = 3');
  assertClose(r.totalPay, 75, 'total pay = $75');
}

// --- ends exactly at noon ---
console.log('\nends at noon');
{
  const r = splitPay(at(2026, 6, 10, 9, 0), at(2026, 6, 10, 12, 0), opts);
  assertClose(r.morningHours, 3, 'morning hours = 3');
  assertClose(r.afternoonHours, 0, 'afternoon hours = 0');
  assertClose(r.totalPay, 60, 'total pay = $60');
}

// --- fractional hours crossing noon ---
console.log('\nfractional cross');
{
  // 11:30 → 12:30 = 0.5h morning + 0.5h afternoon = $10 + $12.50 = $22.50
  const r = splitPay(at(2026, 6, 10, 11, 30), at(2026, 6, 10, 12, 30), opts);
  assertClose(r.morningHours, 0.5, 'morning hours = 0.5');
  assertClose(r.afternoonHours, 0.5, 'afternoon hours = 0.5');
  assertClose(r.totalPay, 22.5, 'total pay = $22.50');
}

// --- overnight (optional) ---
console.log('\novernight');
{
  // 22:00 → 02:00 next day
  // Day1: 22:00–24:00 = 2h afternoon
  // Day2: 00:00–02:00 = 2h morning
  // pay = 2*25 + 2*20 = 50 + 40 = 90
  const r = splitPay(at(2026, 6, 10, 22, 0), at(2026, 6, 11, 2, 0), opts);
  assertClose(r.morningHours, 2, 'overnight morning hours = 2');
  assertClose(r.afternoonHours, 2, 'overnight afternoon hours = 2');
  assertClose(r.totalHours, 4, 'overnight total hours = 4');
  assertClose(r.totalPay, 90, 'overnight total pay = $90');
}

// --- overnight crossing noon the next day ---
console.log('\novernight past noon');
{
  // 23:00 → 14:00 next day
  // D1: 23–24 = 1h afternoon
  // D2: 00–12 = 12h morning, 12–14 = 2h afternoon
  // morning=12, afternoon=3, pay=240+75=315
  const r = splitPay(at(2026, 6, 10, 23, 0), at(2026, 6, 11, 14, 0), opts);
  assertClose(r.morningHours, 12, 'morning = 12');
  assertClose(r.afternoonHours, 3, 'afternoon = 3');
  assertClose(r.totalPay, 315, 'pay = $315');
}

// --- zero / invalid ---
console.log('\nedge cases');
{
  const r = splitPay(at(2026, 6, 10, 10, 0), at(2026, 6, 10, 10, 0), opts);
  assertClose(r.totalHours, 0, 'zero duration');
  assertClose(r.totalPay, 0, 'zero pay');
}

// --- custom rates ---
console.log('\ncustom rates');
{
  const r = splitPay(at(2026, 6, 10, 10, 0), at(2026, 6, 10, 14, 0), {
    ...opts,
    morningRate: 10,
    afternoonRate: 30,
  });
  assertClose(r.morningPay, 20, 'custom morning pay');
  assertClose(r.afternoonPay, 60, 'custom afternoon pay');
  assertClose(r.totalPay, 80, 'custom total');
}

// --- range helpers ---
console.log('\nranges');
{
  const noon = at(2026, 6, 10, 12, 0); // Wed Jun 10 2026
  const today = rangeToday(noon, TZ);
  assert(today.from === at(2026, 6, 10, 0, 0), 'today from midnight');
  assert(today.to === at(2026, 6, 11, 0, 0), 'today to next midnight');

  const week = rangeThisWeek(noon, TZ);
  // Mon Jun 8 2026 → Mon Jun 15
  assert(week.from === at(2026, 6, 8, 0, 0), 'week from Monday');
  assert(week.to === at(2026, 6, 15, 0, 0), 'week to next Monday');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
