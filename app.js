/**
 * Sitter Time — main UI
 * Hash routing: #/h/<uuid>
 * Roles: sitter | parent (PIN-gated)
 */

import { createDb, uuid } from './db.js';
import {
  splitPay,
  formatInZone,
  rangeToday,
  rangeThisWeek,
  weekStartMs,
  formatWeekRangeLabel,
  getZonedParts,
  zonedDateTimeToUtcMs,
  irsBusinessMileageRate,
  mileageAmount,
} from './rates.js';

const TZ_DEFAULT = 'America/New_York';
const PARENT_UNLOCK_KEY = 'bst:parentUnlocked';
const OTHER_ROUTE_VALUE = '__other__';

/** @type {ReturnType<typeof createDb> | null} */
let db = null;
let householdId = null;
let role = localStorage.getItem('bst:role') || 'sitter';
let parentUnlocked = sessionStorage.getItem(PARENT_UNLOCK_KEY) === '1';
let rangeMode = 'today';
let unsub = null;

const $ = (id) => document.getElementById(id);

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function money(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function hoursLabel(n) {
  const v = Number(n) || 0;
  if (Math.abs(v - Math.round(v)) < 0.0001) return String(Math.round(v));
  return v.toFixed(2).replace(/\.?0+$/, (m) => (m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '') : m));
}

/** Single household for this family — never mint a new id. */
const CANONICAL_HOUSEHOLD_ID = '5d35fd91-6d35-4def-91fa-fe5545295c85';

/** Always use the canonical household; normalize the URL hash. */
function resolveHouseholdId() {
  const target = `#/h/${CANONICAL_HOUSEHOLD_ID}`;
  if (location.hash !== target) {
    history.replaceState(null, '', target);
  }
  return CANONICAL_HOUSEHOLD_ID;
}

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBMUO1xWi4T7GcjVfgdOyqiNqnMnepJz2I",
  authDomain: "babysitter-time.firebaseapp.com",
  projectId: "babysitter-time",
  storageBucket: "babysitter-time.firebasestorage.app",
  messagingSenderId: "192652900612",
  appId: "1:192652900612:web:b7a7badd80033c8aba3851"
};

async function initDb() {
  householdId = resolveHouseholdId();
  db = createDb({
    mode: 'firebase',
    firebaseConfig: FIREBASE_CONFIG,
    householdId,
  });
  await db.ensureHousehold({ name: 'Household' });
}

function tz() {
  return db?.getHousehold()?.timeZone || TZ_DEFAULT;
}

function rateOpts(h) {
  return {
    morningRate: h.morningRate,
    afternoonRate: h.afternoonRate,
    cutoffHour: h.cutoffHour,
    timeZone: h.timeZone || TZ_DEFAULT,
  };
}

function setRole(next) {
  role = next;
  localStorage.setItem('bst:role', role);
  $('roleSitter').classList.toggle('active', role === 'sitter');
  $('roleParent').classList.toggle('active', role === 'parent');
  $('sitterView').classList.toggle('hidden', role !== 'sitter');
  $('parentView').classList.toggle('hidden', role !== 'parent');
  if (role === 'parent') {
    renderParentGate();
  }
  render();
}

function renderParentGate() {
  const unlocked = parentUnlocked;
  $('pinGate').classList.toggle('hidden', unlocked);
  $('parentContent').classList.toggle('hidden', !unlocked);
}

function unlockParent() {
  const pin = ($('pinInput').value || '').trim();
  const h = db.getHousehold();
  if (pin === String(h.pin)) {
    parentUnlocked = true;
    sessionStorage.setItem(PARENT_UNLOCK_KEY, '1');
    $('pinError').textContent = '';
    $('pinInput').value = '';
    renderParentGate();
    render();
  } else {
    $('pinError').textContent = 'Incorrect PIN';
  }
}

function lockParent() {
  parentUnlocked = false;
  sessionStorage.removeItem(PARENT_UNLOCK_KEY);
  renderParentGate();
}

function updateHeader() {
  const h = db.getHousehold();
  const short = householdId.slice(0, 8);
  const live = db.mode === 'firebase' ? ' · Live sync on' : '';
  $('householdMeta').textContent = `${h.name} · ${short}…${live}`;
  const modeLabel = db.mode === 'firebase' ? 'Live sync on' : 'Local mode';
  $('footerNote').textContent = `${modeLabel} · ${h.timeZone || TZ_DEFAULT}`;
}

function renderSitter() {
  const h = db.getHousehold();
  const today = rangeToday(Date.now(), tz());
  const shifts = db.listShifts({ from: today.from, to: today.to });
  const closed = shifts.filter((s) => s.clockOut != null);

  let totalHours = 0;
  let totalPay = 0;
  for (const s of closed) {
    totalHours += s.totalHours || 0;
    totalPay += s.totalPay || 0;
  }
  $('sitterHours').textContent = hoursLabel(totalHours);
  $('sitterPay').textContent = money(totalPay);

  const list = $('sitterShiftList');
  if (!shifts.length) {
    list.innerHTML = '<li class="empty">No shifts yet today</li>';
  } else {
    list.innerHTML = shifts.map((s) => shiftItemHtml(s, h, false)).join('');
  }

  updateShiftPreview();
}

function shiftItemHtml(s, h, withActions) {
  const incomplete = s.clockOut == null;
  const pay = incomplete ? 0 : s.totalPay || 0;
  const hours = incomplete ? 0 : s.totalHours || 0;
  const morningH = incomplete ? 0 : s.morningHours || 0;
  const afternoonH = incomplete ? 0 : s.afternoonHours || 0;
  const timeRange = incomplete
    ? `${formatInZone(s.clockIn, tz())} → —`
    : `${formatInZone(s.clockIn, tz())} → ${formatInZone(s.clockOut, tz())}`;
  const meta = incomplete
    ? `Incomplete${s.note ? ` · ${escapeHtml(s.note)}` : ''}`
    : `${hoursLabel(hours)}h · AM ${hoursLabel(morningH)}h / PM ${hoursLabel(afternoonH)}h${
        s.note ? ` · ${escapeHtml(s.note)}` : ''
      }`;
  const actions = withActions
    ? `<div class="shift-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-edit="${s.id}">Edit</button>
        <button type="button" class="btn btn-ghost btn-sm" data-delete="${s.id}" style="color:var(--danger)">Delete</button>
      </div>`
    : '';
  return `<li class="shift-item${incomplete ? ' incomplete' : ''}">
    <div class="shift-top">
      <div class="shift-times">${timeRange}${incomplete ? ' <span class="badge">Incomplete</span>' : ''}</div>
      <div class="shift-pay">${incomplete ? '—' : money(pay)}</div>
    </div>
    <div class="shift-meta">${meta}</div>
    ${actions}
  </li>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getParentRange() {
  const now = Date.now();
  const zone = tz();
  if (rangeMode === 'today') return rangeToday(now, zone);
  if (rangeMode === 'week') return rangeThisWeek(now, zone);
  if (rangeMode === 'byweek') return { from: null, to: null };
  // custom
  const fromStr = $('rangeFrom').value;
  const toStr = $('rangeTo').value;
  if (!fromStr || !toStr) return rangeToday(now, zone);
  const [fy, fm, fd] = fromStr.split('-').map(Number);
  const [ty, tm, td] = toStr.split('-').map(Number);
  const from = zonedDateTimeToUtcMs(fy, fm, fd, 0, 0, 0, zone);
  // inclusive end day → next midnight
  const next = new Date(Date.UTC(ty, tm - 1, td + 1));
  const to = zonedDateTimeToUtcMs(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    0,
    0,
    0,
    zone
  );
  return { from, to };
}

function accumulateClosed(shifts) {
  let morningPay = 0;
  let afternoonPay = 0;
  let totalHours = 0;
  let totalPay = 0;
  for (const s of shifts) {
    if (s.clockOut == null) continue;
    morningPay += s.morningPay || 0;
    afternoonPay += s.afternoonPay || 0;
    totalHours += s.totalHours || 0;
    totalPay += s.totalPay || 0;
  }
  return { morningPay, afternoonPay, totalHours, totalPay };
}

function accumulateMileage(trips) {
  let totalMiles = 0;
  let totalMileage = 0;
  for (const t of trips) {
    totalMiles += Number(t.miles) || 0;
    totalMileage += Number(t.amount) || 0;
  }
  return { totalMiles, totalMileage };
}

function setParentSummary(totals, mileagePay = 0) {
  $('parentHours').textContent = hoursLabel(totals.totalHours);
  $('parentPay').textContent = money(totals.totalPay);
  $('parentMileage').textContent = money(mileagePay);
  $('parentCombined').textContent = money((totals.totalPay || 0) + (mileagePay || 0));
}

/** Group closed shifts by Monday-start calendar week; newest first. */
function groupClosedShiftsByWeek(shifts, timeZone) {
  /** @type {Map<number, typeof shifts>} */
  const map = new Map();
  for (const s of shifts) {
    if (s.clockOut == null) continue;
    const start = weekStartMs(s.clockIn, timeZone);
    if (!map.has(start)) map.set(start, []);
    map.get(start).push(s);
  }
  return [...map.entries()].sort((a, b) => b[0] - a[0]);
}

function groupTripsByWeek(trips, timeZone) {
  /** @type {Map<number, typeof trips>} */
  const map = new Map();
  for (const t of trips) {
    const start = weekStartMs(t.dayMs, timeZone);
    if (!map.has(start)) map.set(start, []);
    map.get(start).push(t);
  }
  return map;
}

function weekItemHtml(weekFromMs, weekShifts, weekTrips, timeZone) {
  const totals = accumulateClosed(weekShifts);
  const mileage = accumulateMileage(weekTrips || []);
  const label = formatWeekRangeLabel(weekFromMs, timeZone);
  const combined = (totals.totalPay || 0) + (mileage.totalMileage || 0);
  return `<li class="week-item">
    <div class="week-label">${escapeHtml(label)}</div>
    <div class="summary-row">
      <div class="stat"><div class="label">Hours</div><div class="value">${hoursLabel(totals.totalHours)}</div></div>
      <div class="stat"><div class="label">Pay</div><div class="value">${money(totals.totalPay)}</div></div>
      <div class="stat"><div class="label">Mileage</div><div class="value">${money(mileage.totalMileage)}</div></div>
      <div class="stat"><div class="label">Combined</div><div class="value">${money(combined)}</div></div>
    </div>
  </li>`;
}

function formatDayLabel(dayMs, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(dayMs));
}

function tripItemHtml(t, timeZone) {
  const dayLabel = formatDayLabel(t.dayMs, timeZone);
  const milesLabel = `${hoursLabel(t.miles)} mi · $${Number(t.ratePerMile).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}/mi`;
  const meta = `${milesLabel}${t.note ? ` · ${escapeHtml(t.note)}` : ''}`;
  return `<li class="shift-item">
    <div class="shift-top">
      <div class="shift-times">${escapeHtml(dayLabel)} · ${escapeHtml(t.label || 'Trip')}</div>
      <div class="shift-pay">${money(t.amount)}</div>
    </div>
    <div class="shift-meta">${meta}</div>
    <div class="shift-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-delete-trip="${t.id}" style="color:var(--danger)">Delete</button>
    </div>
  </li>`;
}

function routeItemHtml(r) {
  return `<li class="shift-item">
    <div class="shift-top">
      <div class="shift-times">${escapeHtml(r.label)}</div>
      <div class="shift-pay">${hoursLabel(r.miles)} mi</div>
    </div>
    <div class="shift-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-delete-route="${escapeHtml(r.id)}" style="color:var(--danger)">Delete</button>
    </div>
  </li>`;
}

function populateRouteSelect(routes, preferValue) {
  const sel = $('tripRoute');
  if (!sel) return;
  const prev = preferValue != null ? preferValue : sel.value;
  const opts = (routes || []).map(
    (r) =>
      `<option value="${escapeHtml(r.id)}">${escapeHtml(r.label)} · ${hoursLabel(r.miles)} mi</option>`
  );
  opts.push(`<option value="${OTHER_ROUTE_VALUE}">Other…</option>`);
  sel.innerHTML = opts.join('');
  if (prev && [...sel.options].some((o) => o.value === prev)) {
    sel.value = prev;
  } else if (routes && routes.length) {
    sel.value = routes[0].id;
  } else {
    sel.value = OTHER_ROUTE_VALUE;
  }
  toggleTripCustomFields();
}

function toggleTripCustomFields() {
  const isOther = $('tripRoute')?.value === OTHER_ROUTE_VALUE;
  $('tripCustomFields')?.classList.toggle('hidden', !isOther);
}

function dateInputValueFromMs(ms, timeZone) {
  const p = getZonedParts(ms, timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function dayMsFromDateInput(str, timeZone) {
  if (!str) return null;
  const [y, m, d] = str.split('-').map(Number);
  if (!y || !m || !d) return null;
  return zonedDateTimeToUtcMs(y, m, d, 0, 0, 0, timeZone);
}

function ensureTripDateDefault() {
  const input = $('tripDate');
  if (!input || input.value) return;
  input.value = dateInputValueFromMs(Date.now(), tz());
}

function resolveTripDraft() {
  const zone = tz();
  const h = db.getHousehold();
  const dayMs = dayMsFromDateInput($('tripDate')?.value, zone);
  const routeVal = $('tripRoute')?.value;
  const isOther = routeVal === OTHER_ROUTE_VALUE;
  let label = '';
  let miles = 0;
  let routeId = null;

  if (isOther) {
    label = ($('tripCustomLabel')?.value || '').trim();
    miles = Number($('tripCustomMiles')?.value);
  } else {
    const route = (h.routes || []).find((r) => r.id === routeVal);
    if (route) {
      label = route.label;
      miles = Number(route.miles) || 0;
      routeId = route.id;
    }
  }

  const ratePerMile = dayMs != null ? irsBusinessMileageRate(dayMs, zone) : 0;
  const amount = dayMs != null && miles > 0 ? mileageAmount(miles, ratePerMile) : 0;
  const note = ($('tripNote')?.value || '').trim();
  const saveToList = isOther && $('tripSaveToList')?.checked;

  return { dayMs, routeId, label, miles, ratePerMile, amount, note, isOther, saveToList };
}

function updateTripPreview() {
  const preview = $('tripPreviewText');
  if (!preview || !db) return;
  const draft = resolveTripDraft();
  if (draft.dayMs == null) {
    preview.textContent = 'Pick a date and route to preview';
    return;
  }
  if (draft.isOther && (!draft.label || !(draft.miles > 0))) {
    preview.textContent = 'Enter destination name and miles';
    return;
  }
  if (!(draft.miles > 0)) {
    preview.textContent = 'Pick a date and route to preview';
    return;
  }
  const rateLabel = `$${draft.ratePerMile.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}/mi`;
  preview.textContent = `${hoursLabel(draft.miles)} mi × ${rateLabel} → ${money(draft.amount)}`;
}

function renderParent() {
  if (!parentUnlocked) return;
  const h = db.getHousehold();
  const zone = h.timeZone || TZ_DEFAULT;
  const byWeek = rangeMode === 'byweek';
  const weekList = $('weekTotalsList');
  const historyCard = $('parentHistoryCard');
  const mileageCard = $('parentMileageCard');
  const summaryRow = $('parentSummaryRow');

  populateRouteSelect(h.routes || []);
  ensureTripDateDefault();

  if (byWeek) {
    const allShifts = db.listShifts({});
    const allTrips = db.listTrips({});
    const weeks = groupClosedShiftsByWeek(allShifts, zone);
    const tripsByWeek = groupTripsByWeek(allTrips, zone);
    // Include weeks that only have mileage
    const weekStarts = new Set(weeks.map(([start]) => start));
    for (const start of tripsByWeek.keys()) {
      if (!weekStarts.has(start)) {
        weeks.push([start, []]);
        weekStarts.add(start);
      }
    }
    weeks.sort((a, b) => b[0] - a[0]);

    const grand = accumulateClosed(allShifts);
    const mileageGrand = accumulateMileage(allTrips);
    setParentSummary(grand, mileageGrand.totalMileage);
    summaryRow.classList.remove('hidden');
    weekList.classList.remove('hidden');
    historyCard.classList.add('hidden');
    mileageCard.classList.add('hidden');
    if (!weeks.length) {
      weekList.innerHTML = '<li class="empty">No closed shifts or trips yet</li>';
    } else {
      weekList.innerHTML = weeks
        .map(([start, list]) => weekItemHtml(start, list, tripsByWeek.get(start) || [], zone))
        .join('');
    }
  } else {
    weekList.classList.add('hidden');
    weekList.innerHTML = '';
    historyCard.classList.remove('hidden');
    mileageCard.classList.remove('hidden');
    summaryRow.classList.remove('hidden');

    const { from, to } = getParentRange();
    const shifts = db.listShifts({ from, to });
    const trips = db.listTrips({ from, to });
    const totals = accumulateClosed(shifts);
    const mileage = accumulateMileage(trips);
    setParentSummary(totals, mileage.totalMileage);

    const list = $('parentShiftList');
    if (!shifts.length) {
      list.innerHTML = '<li class="empty">No shifts in this range</li>';
    } else {
      list.innerHTML = shifts.map((s) => shiftItemHtml(s, h, true)).join('');
    }

    const tripList = $('tripList');
    if (!trips.length) {
      tripList.innerHTML = '<li class="empty">No trips in this range</li>';
    } else {
      tripList.innerHTML = trips.map((t) => tripItemHtml(t, zone)).join('');
    }
  }

  // Settings form
  $('setName').value = h.name || '';
  $('setMorning').value = h.morningRate;
  $('setAfternoon').value = h.afternoonRate;
  $('setCutoff').value = h.cutoffHour;
  $('setPin').value = h.pin;
  $('setTz').value = h.timeZone || TZ_DEFAULT;

  const routeList = $('routeList');
  const routes = h.routes || [];
  if (!routes.length) {
    routeList.innerHTML = '<li class="empty">No destinations yet</li>';
  } else {
    routeList.innerHTML = routes.map(routeItemHtml).join('');
  }

  updateTripPreview();
}

function render() {
  if (!db) return;
  updateHeader();
  if (role === 'sitter') renderSitter();
  else renderParent();
}

function updateShiftPreview() {
  const preview = $('shiftPreviewText');
  if (!preview || !db) return;
  const zone = tz();
  const inStr = $('shiftArrival')?.value;
  const outStr = $('shiftDeparture')?.value;
  if (!inStr || !outStr) {
    preview.textContent = 'Enter arrival and departure to preview pay';
    return;
  }
  const clockIn = fromDatetimeLocalValue(inStr, zone);
  const clockOut = fromDatetimeLocalValue(outStr, zone);
  if (clockIn == null || clockOut == null) {
    preview.textContent = 'Enter arrival and departure to preview pay';
    return;
  }
  if (clockOut <= clockIn) {
    preview.textContent = 'Departure must be after arrival';
    return;
  }
  const h = db.getHousehold();
  const pay = splitPay(clockIn, clockOut, rateOpts(h));
  preview.textContent = `${hoursLabel(pay.totalHours)}h · ${money(pay.totalPay)} (AM ${money(pay.morningPay)} / PM ${money(pay.afternoonPay)})`;
}

/** datetime-local value in household TZ */
function toDatetimeLocalValue(ms, timeZone) {
  const p = getZonedParts(ms, timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

function fromDatetimeLocalValue(str, timeZone) {
  if (!str) return null;
  const [date, time] = str.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return zonedDateTimeToUtcMs(y, m, d, hh, mm, 0, timeZone);
}

function openEditModal(id) {
  const shifts = db.listShifts({});
  const s = shifts.find((x) => x.id === id);
  if (!s) return;
  const zone = tz();
  $('editId').value = s.id;
  $('editIn').value = toDatetimeLocalValue(s.clockIn, zone);
  $('editOut').value = s.clockOut != null ? toDatetimeLocalValue(s.clockOut, zone) : '';
  $('editNote').value = s.note || '';
  $('editModal').classList.remove('hidden');
}

function closeEditModal() {
  $('editModal').classList.add('hidden');
}

function exportCsv() {
  const { from, to } = getParentRange();
  const shifts = db.listShifts({ from, to }).filter((s) => s.clockOut != null);
  const zone = tz();
  const header = [
    'id',
    'clock_in',
    'clock_out',
    'morning_hours',
    'afternoon_hours',
    'total_hours',
    'morning_pay',
    'afternoon_pay',
    'total_pay',
    'note',
  ];
  const rows = shifts.map((s) =>
    [
      s.id,
      formatInZone(s.clockIn, zone, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      formatInZone(s.clockOut, zone, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      s.morningHours,
      s.afternoonHours,
      s.totalHours,
      s.morningPay,
      s.afternoonPay,
      s.totalPay,
      JSON.stringify(s.note || ''),
    ].join(',')
  );
  const csv = [header.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sitter-time-${householdId.slice(0, 8)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('CSV downloaded');
}

function exportMileageCsv() {
  const { from, to } = getParentRange();
  const trips = db.listTrips({ from, to });
  const zone = tz();
  const header = ['id', 'date', 'label', 'miles', 'rate_per_mile', 'amount', 'note'];
  const rows = trips.map((t) => {
    const p = getZonedParts(t.dayMs, zone);
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
    return [
      t.id,
      dateStr,
      JSON.stringify(t.label || ''),
      t.miles,
      t.ratePerMile,
      t.amount,
      JSON.stringify(t.note || ''),
    ].join(',');
  });
  const csv = [header.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sitter-mileage-${householdId.slice(0, 8)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Mileage CSV downloaded');
}

function bindEvents() {
  $('roleSitter').addEventListener('click', () => setRole('sitter'));
  $('roleParent').addEventListener('click', () => setRole('parent'));

  $('shiftArrival').addEventListener('input', updateShiftPreview);
  $('shiftDeparture').addEventListener('input', updateShiftPreview);
  $('shiftArrival').addEventListener('change', updateShiftPreview);
  $('shiftDeparture').addEventListener('change', updateShiftPreview);

  $('shiftForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const zone = tz();
    const clockIn = fromDatetimeLocalValue($('shiftArrival').value, zone);
    const clockOut = fromDatetimeLocalValue($('shiftDeparture').value, zone);
    const note = ($('shiftNote').value || '').trim();
    if (clockIn == null || clockOut == null) {
      toast('Arrival and departure are required');
      return;
    }
    try {
      await db.addShift({ clockIn, clockOut, note });
      $('shiftForm').reset();
      updateShiftPreview();
      toast('Shift saved');
      // list/summary refresh via subscribe; render as backup
      render();
    } catch (err) {
      toast(err.message || 'Could not save shift');
    }
  });

  $('btnUnlock').addEventListener('click', unlockParent);
  $('pinInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') unlockParent();
  });
  $('btnLock').addEventListener('click', () => {
    lockParent();
    toast('Locked');
  });

  $('rangeSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-range]');
    if (!btn) return;
    rangeMode = btn.dataset.range;
    for (const b of $('rangeSeg').querySelectorAll('button')) {
      b.classList.toggle('active', b === btn);
    }
    $('customRange').classList.toggle('visible', rangeMode === 'custom');
    if (rangeMode === 'custom') {
      const t = rangeToday(Date.now(), tz());
      const pFrom = getZonedParts(t.from, tz());
      const pTo = getZonedParts(t.from, tz()); // today
      const pad = (n) => String(n).padStart(2, '0');
      if (!$('rangeFrom').value) {
        $('rangeFrom').value = `${pFrom.year}-${pad(pFrom.month)}-${pad(pFrom.day)}`;
      }
      if (!$('rangeTo').value) {
        $('rangeTo').value = `${pTo.year}-${pad(pTo.month)}-${pad(pTo.day)}`;
      }
    }
    renderParent();
  });

  $('rangeFrom').addEventListener('change', () => renderParent());
  $('rangeTo').addEventListener('change', () => renderParent());

  $('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const patch = {
      name: $('setName').value.trim() || 'Household',
      morningRate: Number($('setMorning').value) || 0,
      afternoonRate: Number($('setAfternoon').value) || 0,
      cutoffHour: Math.min(23, Math.max(0, Number($('setCutoff').value) || 12)),
      pin: ($('setPin').value || '1234').trim(),
      timeZone: TZ_DEFAULT,
    };
    try {
      await db.updateHousehold(patch);
      if (typeof db.recalculateAll === 'function') await db.recalculateAll();
      toast('Settings saved');
      render();
    } catch (err) {
      toast(err.message || 'Could not save settings');
    }
  });

  $('btnExport').addEventListener('click', exportCsv);
  $('btnExportMileage').addEventListener('click', exportMileageCsv);

  $('tripRoute').addEventListener('change', () => {
    toggleTripCustomFields();
    updateTripPreview();
  });
  $('tripDate').addEventListener('change', updateTripPreview);
  $('tripDate').addEventListener('input', updateTripPreview);
  $('tripCustomLabel').addEventListener('input', updateTripPreview);
  $('tripCustomMiles').addEventListener('input', updateTripPreview);
  $('tripNote').addEventListener('input', updateTripPreview);

  $('tripForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const draft = resolveTripDraft();
    if (draft.dayMs == null) {
      toast('Date is required');
      return;
    }
    if (draft.isOther) {
      if (!draft.label) {
        toast('Destination name is required');
        return;
      }
      if (!(draft.miles > 0)) {
        toast('Miles must be greater than 0');
        return;
      }
    } else if (!(draft.miles > 0) || !draft.routeId) {
      toast('Pick a route');
      return;
    }

    try {
      let routeId = draft.routeId;
      let label = draft.label;
      let miles = draft.miles;

      if (draft.isOther && draft.saveToList) {
        const h = db.getHousehold();
        const newRoute = { id: uuid(), label, miles };
        const routes = [...(h.routes || []), newRoute];
        await db.updateHousehold({ routes });
        routeId = newRoute.id;
      }

      await db.addTrip({
        dayMs: draft.dayMs,
        routeId,
        label,
        miles,
        ratePerMile: draft.ratePerMile,
        amount: draft.amount,
        note: draft.note,
      });

      $('tripNote').value = '';
      $('tripCustomLabel').value = '';
      $('tripCustomMiles').value = '';
      $('tripSaveToList').checked = false;
      if (draft.isOther && !draft.saveToList) {
        // stay on Other
      } else {
        populateRouteSelect(db.getHousehold().routes || [], routeId || undefined);
      }
      updateTripPreview();
      toast('Trip saved');
      render();
    } catch (err) {
      toast(err.message || 'Could not save trip');
    }
  });

  $('tripList').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-delete-trip]');
    if (!del) return;
    if (confirm('Delete this trip?')) {
      try {
        await db.deleteTrip(del.dataset.deleteTrip);
        toast('Trip deleted');
        render();
      } catch (err) {
        toast(err.message || 'Delete failed');
      }
    }
  });

  $('routeAddForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = ($('routeNewLabel').value || '').trim();
    const miles = Number($('routeNewMiles').value);
    if (!label) {
      toast('Label is required');
      return;
    }
    if (!(miles > 0)) {
      toast('Miles must be greater than 0');
      return;
    }
    try {
      const h = db.getHousehold();
      const routes = [...(h.routes || []), { id: uuid(), label, miles }];
      await db.updateHousehold({ routes });
      $('routeAddForm').reset();
      toast('Route added');
      render();
    } catch (err) {
      toast(err.message || 'Could not add route');
    }
  });

  $('routeList').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-delete-route]');
    if (!del) return;
    if (confirm('Delete this destination?')) {
      try {
        const h = db.getHousehold();
        const routes = (h.routes || []).filter((r) => r.id !== del.dataset.deleteRoute);
        await db.updateHousehold({ routes });
        toast('Route deleted');
        render();
      } catch (err) {
        toast(err.message || 'Delete failed');
      }
    }
  });

  $('btnCopyLink').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}${location.search}#/h/${householdId}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch {
      prompt('Copy this link:', url);
    }
  });

  $('parentShiftList').addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit]');
    const del = e.target.closest('[data-delete]');
    if (edit) openEditModal(edit.dataset.edit);
    if (del) {
      if (confirm('Delete this shift?')) {
        try {
          await db.deleteShift(del.dataset.delete);
          toast('Shift deleted');
          render();
        } catch (err) {
          toast(err.message || 'Delete failed');
        }
      }
    }
  });

  $('btnEditCancel').addEventListener('click', closeEditModal);
  $('editModal').addEventListener('click', (e) => {
    if (e.target === $('editModal')) closeEditModal();
  });

  $('editForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('editId').value;
    const zone = tz();
    const clockIn = fromDatetimeLocalValue($('editIn').value, zone);
    const outStr = $('editOut').value;
    const clockOut = outStr ? fromDatetimeLocalValue(outStr, zone) : null;
    const note = $('editNote').value.trim();
    try {
      // Only one open shift allowed
      if (clockOut == null) {
        const open = db.getOpenShift();
        if (open && open.id !== id) {
          toast('Another shift is already open');
          return;
        }
      }
      await db.updateShift(id, { clockIn, clockOut, note });
      closeEditModal();
      toast('Shift updated');
      render();
    } catch (err) {
      toast(err.message || 'Update failed');
    }
  });

  $('btnEditDelete').addEventListener('click', async () => {
    const id = $('editId').value;
    if (confirm('Delete this shift?')) {
      try {
        await db.deleteShift(id);
        closeEditModal();
        toast('Shift deleted');
        render();
      } catch (err) {
        toast(err.message || 'Delete failed');
      }
    }
  });

  window.addEventListener('hashchange', async () => {
    const next = resolveHouseholdId();
    if (next !== householdId) {
      if (unsub) unsub();
      try {
        await initDb();
        unsub = db.subscribeShifts(() => render());
        lockParent();
        render();
      } catch (err) {
        console.error(err);
        toast(err.message || 'Failed to load household');
      }
    }
  });
}

function registerSw() {
  if (!('serviceWorker' in navigator)) return;
  // Only register when served over http(s)
  if (location.protocol === 'file:') return;
  navigator.serviceWorker.register('./sw.js').catch((err) => {
    console.warn('SW registration failed', err);
  });
}

async function main() {
  try {
    $('householdMeta').textContent = 'Connecting…';
    await initDb();
    bindEvents();
    setRole(role === 'parent' ? 'parent' : 'sitter');
    unsub = db.subscribeShifts(() => render());
    registerSw();
    render();
  } catch (err) {
    console.error(err);
    $('householdMeta').textContent = 'Connection failed';
    toast(err.message || 'Failed to connect');
  }
}

main();
