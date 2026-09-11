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
  getZonedParts,
  zonedDateTimeToUtcMs,
} from './rates.js';

const TZ_DEFAULT = 'America/New_York';
const PARENT_UNLOCK_KEY = 'bst:parentUnlocked';

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
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function hoursLabel(n) {
  const v = Number(n) || 0;
  if (Math.abs(v - Math.round(v)) < 0.0001) return String(Math.round(v));
  return v.toFixed(2).replace(/\.?0+$/, (m) => (m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '') : m));
}

/** Parse #/h/<uuid> or create a new household id and set the hash. */
function resolveHouseholdId() {
  const hash = location.hash || '';
  const m = hash.match(/^#\/h\/([0-9a-fA-F-]{36})$/);
  if (m) return m[1];
  // Also accept shorter legacy ids
  const m2 = hash.match(/^#\/h\/([A-Za-z0-9_-]{8,})$/);
  if (m2) return m2[1];
  const id = uuid();
  history.replaceState(null, '', `#/h/${id}`);
  return id;
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
  // custom
  const fromStr = $('rangeFrom').value;
  const toStr = $('rangeTo').value;
  if (!fromStr || !toStr) return rangeToday(now, zone);
  const [fy, fm, fd] = fromStr.split('-').map(Number);
  const [ty, tm, td] = toStr.split('-').map(Number);
  const from = zonedDateTimeToUtcMs(fy, fm, fd, 0, 0, 0, zone);
  // inclusive end day → next midnight
  const endParts = { year: ty, month: tm, day: td };
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

function renderParent() {
  if (!parentUnlocked) return;
  const h = db.getHousehold();
  const { from, to } = getParentRange();
  const shifts = db.listShifts({ from, to });

  let morningPay = 0;
  let afternoonPay = 0;
  let totalHours = 0;
  let totalPay = 0;

  // Totals exclude incomplete shifts (missing departure)
  for (const s of shifts) {
    if (s.clockOut == null) continue;
    morningPay += s.morningPay || 0;
    afternoonPay += s.afternoonPay || 0;
    totalHours += s.totalHours || 0;
    totalPay += s.totalPay || 0;
  }

  $('parentHours').textContent = hoursLabel(totalHours);
  $('parentPay').textContent = money(totalPay);
  $('parentMorning').textContent = money(morningPay);
  $('parentAfternoon').textContent = money(afternoonPay);

  const list = $('parentShiftList');
  if (!shifts.length) {
    list.innerHTML = '<li class="empty">No shifts in this range</li>';
  } else {
    list.innerHTML = shifts.map((s) => shiftItemHtml(s, h, true)).join('');
  }

  // Settings form
  $('setName').value = h.name || '';
  $('setMorning').value = h.morningRate;
  $('setAfternoon').value = h.afternoonRate;
  $('setCutoff').value = h.cutoffHour;
  $('setPin').value = h.pin;
  $('setTz').value = h.timeZone || TZ_DEFAULT;
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
