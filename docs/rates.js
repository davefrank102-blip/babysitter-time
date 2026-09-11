/**
 * Rate calculation for babysitter shifts (America/New_York).
 * Morning rate applies before cutoffHour (default 12); afternoon from cutoff onward.
 * Shifts that cross the cutoff (or midnight) are split across both rates / days.
 */

/**
 * @param {number} ms
 * @param {string} timeZone
 * @returns {{ year:number, month:number, day:number, hour:number, minute:number, second:number }}
 */
export function getZonedParts(ms, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    dtf
      .formatToParts(new Date(ms))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/**
 * Convert a local wall-clock datetime in `timeZone` to UTC epoch ms.
 * Binary-searches a window around an approximate UTC instant (handles DST).
 *
 * @param {number} year
 * @param {number} month - 1-12
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @param {number} second
 * @param {string} timeZone
 * @returns {number}
 */
export function zonedDateTimeToUtcMs(year, month, day, hour, minute, second, timeZone) {
  // Rough UTC guess treating the wall time as UTC, then refine
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let lo = guess - 36 * 3600 * 1000;
  let hi = guess + 36 * 3600 * 1000;

  for (let i = 0; i < 60; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const p = getZonedParts(mid, timeZone);
    const cmp =
      p.year !== year
        ? p.year - year
        : p.month !== month
          ? p.month - month
          : p.day !== day
            ? p.day - day
            : p.hour !== hour
              ? p.hour - hour
              : p.minute !== minute
                ? p.minute - minute
                : p.second - second;
    if (cmp === 0) return mid;
    if (cmp < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.floor((lo + hi) / 2);
}

/** Add one calendar day to Y-M-D (naive Gregorian). */
function addOneDay(year, month, day) {
  const dt = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate(),
  };
}

/**
 * Split a shift across morning/afternoon rates using local wall time in `timeZone`.
 * Overnight shifts: each calendar day's portion is split at that day's cutoff.
 *
 * @param {number} clockInMs
 * @param {number} clockOutMs
 * @param {{ morningRate?: number, afternoonRate?: number, cutoffHour?: number, timeZone?: string }} [opts]
 * @returns {{ morningHours:number, afternoonHours:number, morningPay:number, afternoonPay:number, totalHours:number, totalPay:number }}
 */
export function splitPay(clockInMs, clockOutMs, opts = {}) {
  const morningRate = opts.morningRate ?? 20;
  const afternoonRate = opts.afternoonRate ?? 25;
  const cutoffHour = opts.cutoffHour ?? 12;
  const timeZone = opts.timeZone ?? 'America/New_York';

  if (!(clockOutMs > clockInMs)) {
    return {
      morningHours: 0,
      afternoonHours: 0,
      morningPay: 0,
      afternoonPay: 0,
      totalHours: 0,
      totalPay: 0,
    };
  }

  let morningMs = 0;
  let afternoonMs = 0;
  let cursor = clockInMs;

  while (cursor < clockOutMs) {
    const parts = getZonedParts(cursor, timeZone);
    const cutoffUtc = zonedDateTimeToUtcMs(
      parts.year,
      parts.month,
      parts.day,
      cutoffHour,
      0,
      0,
      timeZone
    );
    const next = addOneDay(parts.year, parts.month, parts.day);
    const dayEnd = zonedDateTimeToUtcMs(next.year, next.month, next.day, 0, 0, 0, timeZone);
    const segmentEnd = Math.min(clockOutMs, dayEnd);

    if (cursor < cutoffUtc) {
      const morningEnd = Math.min(segmentEnd, cutoffUtc);
      morningMs += Math.max(0, morningEnd - cursor);
      if (morningEnd < segmentEnd) {
        afternoonMs += segmentEnd - morningEnd;
      }
    } else {
      afternoonMs += segmentEnd - cursor;
    }

    cursor = segmentEnd;
  }

  const morningHours = morningMs / 3600000;
  const afternoonHours = afternoonMs / 3600000;
  const morningPay = morningHours * morningRate;
  const afternoonPay = afternoonHours * afternoonRate;

  const round4 = (n) => Math.round(n * 10000) / 10000;
  const round2 = (n) => Math.round(n * 100) / 100;

  return {
    morningHours: round4(morningHours),
    afternoonHours: round4(afternoonHours),
    morningPay: round2(morningPay),
    afternoonPay: round2(afternoonPay),
    totalHours: round4(morningHours + afternoonHours),
    totalPay: round2(morningPay + afternoonPay),
  };
}

/**
 * @param {number} ms
 * @param {string} [timeZone='America/New_York']
 * @param {Intl.DateTimeFormatOptions} [extra]
 */
export function formatInZone(ms, timeZone = 'America/New_York', extra = {}) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...extra,
  }).format(new Date(ms));
}

/**
 * @param {number} ms
 * @param {{ withSeconds?: boolean }} [opts]
 */
export function formatDuration(ms, opts = {}) {
  const withSeconds = opts.withSeconds !== false;
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (withSeconds) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${h}:${String(m).padStart(2, '0')}`;
}

/**
 * @param {number} [nowMs]
 * @param {string} [timeZone]
 * @returns {{ from:number, to:number }}
 */
export function rangeToday(nowMs = Date.now(), timeZone = 'America/New_York') {
  const p = getZonedParts(nowMs, timeZone);
  const from = zonedDateTimeToUtcMs(p.year, p.month, p.day, 0, 0, 0, timeZone);
  const n = addOneDay(p.year, p.month, p.day);
  const to = zonedDateTimeToUtcMs(n.year, n.month, n.day, 0, 0, 0, timeZone);
  return { from, to };
}

/**
 * Monday 00:00 → next Monday 00:00 in the given timezone.
 * @param {number} [nowMs]
 * @param {string} [timeZone]
 */
export function rangeThisWeek(nowMs = Date.now(), timeZone = 'America/New_York') {
  const weekdayStr = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(
    new Date(nowMs)
  );
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = map[weekdayStr] ?? 0;
  const daysSinceMon = (dow + 6) % 7;
  const p = getZonedParts(nowMs, timeZone);
  // Walk back daysSinceMon calendar days
  let y = p.year;
  let m = p.month;
  let d = p.day;
  for (let i = 0; i < daysSinceMon; i++) {
    const prev = new Date(Date.UTC(y, m - 1, d - 1));
    y = prev.getUTCFullYear();
    m = prev.getUTCMonth() + 1;
    d = prev.getUTCDate();
  }
  const from = zonedDateTimeToUtcMs(y, m, d, 0, 0, 0, timeZone);
  // +7 days
  let ey = y;
  let em = m;
  let ed = d;
  for (let i = 0; i < 7; i++) {
    const n = addOneDay(ey, em, ed);
    ey = n.year;
    em = n.month;
    ed = n.day;
  }
  const to = zonedDateTimeToUtcMs(ey, em, ed, 0, 0, 0, timeZone);
  return { from, to };
}
