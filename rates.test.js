/**
 * Lightweight Node assertions for rates.js (pay + mileage).
 * Run: node rates.test.js
 */

import {
  splitPay,
  ceilDollar,
  irsBusinessMileageRate,
  mileageAmount,
  zonedDateTimeToUtcMs,
} from './rates.js';

const TZ = 'America/New_York';
let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error('FAIL:', msg);
  }
}

function assertEq(actual, expected, msg) {
  assert(actual === expected, `${msg} (got ${actual}, expected ${expected})`);
}

// ceilDollar
assertEq(ceilDollar(0), 0, 'ceilDollar(0)');
assertEq(ceilDollar(-1), 0, 'ceilDollar negative');
assertEq(ceilDollar(12.01), 13, 'ceilDollar fractional');
assertEq(ceilDollar(12), 12, 'ceilDollar whole');
assertEq(ceilDollar(12.0000001), 13, 'ceilDollar small frac');
assertEq(ceilDollar(20 - 1e-12), 20, 'ceilDollar near-int stays whole');

// IRS rates by date
const ms2025 = zonedDateTimeToUtcMs(2025, 6, 15, 12, 0, 0, TZ);
const ms2026H1 = zonedDateTimeToUtcMs(2026, 3, 1, 12, 0, 0, TZ);
const ms2026Jun30 = zonedDateTimeToUtcMs(2026, 6, 30, 23, 0, 0, TZ);
const ms2026Jul1 = zonedDateTimeToUtcMs(2026, 7, 1, 0, 0, 0, TZ);
const ms2027 = zonedDateTimeToUtcMs(2027, 1, 1, 12, 0, 0, TZ);

assertEq(irsBusinessMileageRate(ms2025, TZ), 0.7, 'rate before 2026');
assertEq(irsBusinessMileageRate(ms2026H1, TZ), 0.725, 'rate 2026 H1');
assertEq(irsBusinessMileageRate(ms2026Jun30, TZ), 0.725, 'rate 2026 Jun 30');
assertEq(irsBusinessMileageRate(ms2026Jul1, TZ), 0.76, 'rate 2026 Jul 1');
assertEq(irsBusinessMileageRate(ms2027, TZ), 0.76, 'rate 2027');

// BCCT 18 mi examples
assertEq(mileageAmount(18, 0.7), 13, '18×0.70 → ceil $13');
assertEq(mileageAmount(18, 0.725), 14, '18×0.725=13.05 → ceil $14');
assertEq(mileageAmount(18, 0.76), 14, '18×0.76=13.68 → ceil $14');

// splitPay still ceilings via ceilDollar
const inMs = zonedDateTimeToUtcMs(2026, 9, 16, 10, 0, 0, TZ);
const outMs = zonedDateTimeToUtcMs(2026, 9, 16, 11, 0, 0, TZ);
const pay = splitPay(inMs, outMs, { morningRate: 20, afternoonRate: 25, cutoffHour: 12, timeZone: TZ });
assertEq(pay.totalHours, 1, '1h morning');
assertEq(pay.morningPay, 20, 'morning pay whole');
assertEq(pay.totalPay, 20, 'total pay');

console.log(`rates.test.js: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
