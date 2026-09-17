/**
 * Thin data-layer adapter.
 * mode: 'local'  → localStorage (works offline / for local dev)
 * mode: 'firebase' → Firestore live sync (CDN modular SDK)
 *
 * Public API is shared; firebase mutations are async.
 */

import { splitPay } from './rates.js';

const DEFAULT_ROUTES = [{ id: 'bcct-home', label: 'BCCT ↔ Home', miles: 18 }];

const DEFAULTS = {
  name: 'Household',
  pin: '1234',
  morningRate: 20,
  afternoonRate: 25,
  cutoffHour: 12,
  timeZone: 'America/New_York',
  routes: DEFAULT_ROUTES,
};

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function storageKey(householdId, suffix) {
  return `bst:${householdId}:${suffix}`;
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function normalizeRoutes(routes, { fallbackIfMissing = false } = {}) {
  if (!Array.isArray(routes)) {
    return fallbackIfMissing ? DEFAULT_ROUTES.map((r) => ({ ...r })) : [];
  }
  return routes.map((r) => ({
    id: r.id || uuid(),
    label: String(r.label || '').trim() || 'Route',
    miles: Number(r.miles) || 0,
  }));
}

function mergeHouseholdFields(data = {}, defaults = {}) {
  return {
    name: data.name ?? defaults.name ?? DEFAULTS.name,
    pin: data.pin ?? defaults.pin ?? DEFAULTS.pin,
    morningRate: data.morningRate ?? defaults.morningRate ?? DEFAULTS.morningRate,
    afternoonRate: data.afternoonRate ?? defaults.afternoonRate ?? DEFAULTS.afternoonRate,
    cutoffHour: data.cutoffHour ?? defaults.cutoffHour ?? DEFAULTS.cutoffHour,
    timeZone: data.timeZone ?? defaults.timeZone ?? DEFAULTS.timeZone,
    routes: data.routes != null
      ? normalizeRoutes(data.routes)
      : defaults.routes != null
        ? normalizeRoutes(defaults.routes)
        : normalizeRoutes(DEFAULTS.routes, { fallbackIfMissing: true }),
  };
}

/**
 * @param {{ mode?: 'local'|'firebase', firebaseConfig?: object, householdId: string }} config
 */
export function createDb(config) {
  const mode = config.mode || 'local';
  const householdId = config.householdId;
  if (!householdId) throw new Error('householdId is required');

  if (mode === 'firebase') {
    return createFirebaseDb(config);
  }
  return createLocalDb(householdId);
}

function createLocalDb(householdId) {
  const hKey = storageKey(householdId, 'household');
  const sKey = storageKey(householdId, 'shifts');
  const tKey = storageKey(householdId, 'trips');
  const listeners = new Set();
  let pollTimer = null;

  function notify() {
    const shifts = listShifts({});
    for (const cb of listeners) {
      try {
        cb(shifts);
      } catch (e) {
        console.error(e);
      }
    }
  }

  function ensureHousehold(defaults = {}) {
    let h = readJson(hKey, null);
    if (!h) {
      h = {
        id: householdId,
        ...mergeHouseholdFields({}, defaults),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      writeJson(hKey, h);
    } else if (!Array.isArray(h.routes)) {
      h = { ...h, routes: normalizeRoutes(DEFAULTS.routes, { fallbackIfMissing: true }), updatedAt: Date.now() };
      writeJson(hKey, h);
    } else {
      h = { ...h, routes: normalizeRoutes(h.routes) };
    }
    if (!readJson(sKey, null)) writeJson(sKey, []);
    if (!readJson(tKey, null)) writeJson(tKey, []);
    return h;
  }

  function getHousehold() {
    return ensureHousehold();
  }

  function updateHousehold(patch) {
    const base = getHousehold();
    const nextPatch = { ...patch };
    if (patch.routes != null) nextPatch.routes = normalizeRoutes(patch.routes);
    const h = { ...base, ...nextPatch, updatedAt: Date.now() };
    writeJson(hKey, h);
    notify();
    return h;
  }

  function allShifts() {
    return readJson(sKey, []);
  }

  function saveShifts(shifts) {
    writeJson(sKey, shifts);
    notify();
  }

  function allTrips() {
    return readJson(tKey, []);
  }

  function saveTrips(trips) {
    writeJson(tKey, trips);
    notify();
  }

  function listShifts({ from, to } = {}) {
    let shifts = allShifts().slice();
    if (from != null || to != null) {
      shifts = shifts.filter((s) => {
        const t = s.clockIn;
        if (from != null && t < from) return false;
        if (to != null && t >= to) return false;
        return true;
      });
    }
    return shifts.sort((a, b) => b.clockIn - a.clockIn);
  }

  function listTrips({ from, to } = {}) {
    let trips = allTrips().slice();
    if (from != null || to != null) {
      trips = trips.filter((t) => {
        const d = t.dayMs;
        if (from != null && d < from) return false;
        if (to != null && d >= to) return false;
        return true;
      });
    }
    return trips.sort((a, b) => b.dayMs - a.dayMs || (b.createdAt || 0) - (a.createdAt || 0));
  }

  function getOpenShift() {
    return allShifts().find((s) => s.clockOut == null) || null;
  }

  function rateOpts(h) {
    return {
      morningRate: h.morningRate,
      afternoonRate: h.afternoonRate,
      cutoffHour: h.cutoffHour,
      timeZone: h.timeZone,
    };
  }

  function applyPay(shift, h) {
    if (shift.clockOut == null) {
      return { ...shift, morningHours: 0, afternoonHours: 0, morningPay: 0, afternoonPay: 0, totalHours: 0, totalPay: 0 };
    }
    const pay = splitPay(shift.clockIn, shift.clockOut, rateOpts(h));
    return { ...shift, ...pay };
  }

  function clockIn() {
    if (getOpenShift()) throw new Error('Already clocked in');
    const h = getHousehold();
    const shift = {
      id: uuid(),
      householdId,
      clockIn: Date.now(),
      clockOut: null,
      note: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const shifts = allShifts();
    shifts.push(shift);
    saveShifts(shifts);
    return applyPay(shift, h);
  }

  function clockOut() {
    const open = getOpenShift();
    if (!open) throw new Error('Not clocked in');
    const h = getHousehold();
    const now = Date.now();
    if (now <= open.clockIn) throw new Error('Clock-out must be after clock-in');
    const updated = applyPay(
      { ...open, clockOut: now, updatedAt: now },
      h
    );
    const shifts = allShifts().map((s) => (s.id === updated.id ? updated : s));
    saveShifts(shifts);
    return updated;
  }

  function addShift({ clockIn, clockOut, note } = {}) {
    if (clockIn == null || clockOut == null) {
      throw new Error('Arrival and departure are required');
    }
    if (clockOut <= clockIn) {
      throw new Error('Departure must be after arrival');
    }
    const h = getHousehold();
    const now = Date.now();
    const shift = applyPay(
      {
        id: uuid(),
        householdId,
        clockIn,
        clockOut,
        note: note || '',
        createdAt: now,
        updatedAt: now,
      },
      h
    );
    const shifts = allShifts();
    shifts.push(shift);
    saveShifts(shifts);
    return shift;
  }

  function updateShift(id, patch) {
    const h = getHousehold();
    const shifts = allShifts();
    const idx = shifts.findIndex((s) => s.id === id);
    if (idx < 0) throw new Error('Shift not found');
    let next = { ...shifts[idx], ...patch, updatedAt: Date.now() };
    if (next.clockOut != null && next.clockOut <= next.clockIn) {
      throw new Error('Clock-out must be after clock-in');
    }
    next = applyPay(next, h);
    shifts[idx] = next;
    saveShifts(shifts);
    return next;
  }

  function deleteShift(id) {
    const shifts = allShifts().filter((s) => s.id !== id);
    saveShifts(shifts);
  }

  function addTrip(trip) {
    const now = Date.now();
    const row = {
      id: trip.id || uuid(),
      householdId,
      dayMs: trip.dayMs,
      routeId: trip.routeId || null,
      label: trip.label || '',
      miles: Number(trip.miles) || 0,
      ratePerMile: Number(trip.ratePerMile) || 0,
      amount: Number(trip.amount) || 0,
      note: trip.note || '',
      createdAt: trip.createdAt ?? now,
      updatedAt: trip.updatedAt ?? now,
    };
    const trips = allTrips();
    trips.push(row);
    saveTrips(trips);
    return row;
  }

  function deleteTrip(id) {
    const trips = allTrips().filter((t) => t.id !== id);
    saveTrips(trips);
  }

  function subscribeShifts(cb) {
    listeners.add(cb);
    try {
      cb(listShifts({}));
    } catch (e) {
      console.error(e);
    }

    const onStorage = (e) => {
      if (e.key === sKey || e.key === hKey || e.key === tKey) notify();
    };
    window.addEventListener('storage', onStorage);

    if (!pollTimer) {
      pollTimer = setInterval(() => notify(), 2000);
    }

    return () => {
      listeners.delete(cb);
      window.removeEventListener('storage', onStorage);
      if (listeners.size === 0 && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
  }

  function recalculateAll() {
    const h = getHousehold();
    const shifts = allShifts().map((s) => applyPay(s, h));
    saveShifts(shifts);
  }

  return {
    mode: 'local',
    householdId,
    ensureHousehold,
    getHousehold,
    updateHousehold,
    listShifts,
    listTrips,
    subscribeShifts,
    clockIn,
    clockOut,
    addShift,
    updateShift,
    deleteShift,
    addTrip,
    deleteTrip,
    getOpenShift,
    recalculateAll,
  };
}

/**
 * Firestore live sync. In-memory caches are kept fresh via onSnapshot so
 * getHousehold / listShifts / getOpenShift stay synchronous after ensureHousehold.
 */
function createFirebaseDb(config) {
  const householdId = config.householdId;
  const firebaseConfig = config.firebaseConfig;
  if (!firebaseConfig) throw new Error('firebaseConfig is required for firebase mode');

  let app = null;
  let db = null;
  let householdRef = null;
  let shiftsCol = null;
  let tripsCol = null;
  let cacheHousehold = null;
  let cacheShifts = [];
  let cacheTrips = [];
  let ready = false;
  let unsubHousehold = null;
  let unsubShifts = null;
  let unsubTrips = null;
  const listeners = new Set();

  // Firestore modular helpers (filled after dynamic import)
  let fs = null;

  function rateOpts(h) {
    return {
      morningRate: h.morningRate,
      afternoonRate: h.afternoonRate,
      cutoffHour: h.cutoffHour,
      timeZone: h.timeZone,
    };
  }

  function applyPay(shift, h) {
    if (shift.clockOut == null) {
      return {
        ...shift,
        morningHours: 0,
        afternoonHours: 0,
        morningPay: 0,
        afternoonPay: 0,
        totalHours: 0,
        totalPay: 0,
      };
    }
    const pay = splitPay(shift.clockIn, shift.clockOut, rateOpts(h));
    return { ...shift, ...pay };
  }

  function shiftFromDoc(docSnap) {
    const data = docSnap.data() || {};
    return {
      id: docSnap.id,
      householdId,
      clockIn: data.clockIn ?? null,
      clockOut: data.clockOut ?? null,
      note: data.note || '',
      morningHours: data.morningHours || 0,
      afternoonHours: data.afternoonHours || 0,
      morningPay: data.morningPay || 0,
      afternoonPay: data.afternoonPay || 0,
      totalHours: data.totalHours || 0,
      totalPay: data.totalPay || 0,
      createdAt: data.createdAt ?? null,
      updatedAt: data.updatedAt ?? null,
    };
  }

  function tripFromDoc(docSnap) {
    const data = docSnap.data() || {};
    return {
      id: docSnap.id,
      householdId,
      dayMs: data.dayMs ?? 0,
      routeId: data.routeId ?? null,
      label: data.label || '',
      miles: data.miles || 0,
      ratePerMile: data.ratePerMile || 0,
      amount: data.amount || 0,
      note: data.note || '',
      createdAt: data.createdAt ?? null,
      updatedAt: data.updatedAt ?? null,
    };
  }

  function householdFromDoc(docSnap) {
    const data = docSnap.data() || {};
    const merged = mergeHouseholdFields(data);
    return {
      id: householdId,
      ...merged,
      createdAt: data.createdAt ?? null,
      updatedAt: data.updatedAt ?? null,
    };
  }

  function notifyListeners() {
    const shifts = listShifts({});
    for (const cb of listeners) {
      try {
        cb(shifts);
      } catch (e) {
        console.error(e);
      }
    }
  }

  function assertReady() {
    if (!ready || !cacheHousehold) {
      throw new Error('Household not ready — await ensureHousehold() first');
    }
  }

  async function ensureHousehold(defaults = {}) {
    if (ready && cacheHousehold) return cacheHousehold;

    const [{ initializeApp }, firestore] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js'),
    ]);
    fs = firestore;

    app = initializeApp(firebaseConfig);
    db = fs.getFirestore(app);
    householdRef = fs.doc(db, 'households', householdId);
    shiftsCol = fs.collection(db, 'households', householdId, 'shifts');
    tripsCol = fs.collection(db, 'households', householdId, 'trips');

    const snap = await fs.getDoc(householdRef);
    if (!snap.exists()) {
      const now = Date.now();
      const created = {
        ...mergeHouseholdFields({}, defaults),
        createdAt: now,
        updatedAt: now,
      };
      await fs.setDoc(householdRef, created);
    } else {
      const data = snap.data() || {};
      if (!Array.isArray(data.routes)) {
        await fs.setDoc(
          householdRef,
          { routes: normalizeRoutes(DEFAULTS.routes, { fallbackIfMissing: true }), updatedAt: Date.now() },
          { merge: true }
        );
      }
    }

    // Wait for first household + shifts + trips snapshots before resolving
    await new Promise((resolve, reject) => {
      let gotH = false;
      let gotS = false;
      let gotT = false;
      const maybeDone = () => {
        if (gotH && gotS && gotT) {
          ready = true;
          resolve();
        }
      };

      unsubHousehold = fs.onSnapshot(
        householdRef,
        (docSnap) => {
          if (docSnap.exists()) {
            cacheHousehold = householdFromDoc(docSnap);
          }
          gotH = true;
          maybeDone();
          if (ready) notifyListeners();
        },
        reject
      );

      unsubShifts = fs.onSnapshot(
        fs.query(shiftsCol, fs.orderBy('clockIn', 'desc')),
        (qs) => {
          cacheShifts = qs.docs.map(shiftFromDoc);
          gotS = true;
          maybeDone();
          if (ready) notifyListeners();
        },
        reject
      );

      unsubTrips = fs.onSnapshot(
        fs.query(tripsCol, fs.orderBy('dayMs', 'desc')),
        (qs) => {
          cacheTrips = qs.docs.map(tripFromDoc);
          gotT = true;
          maybeDone();
          if (ready) notifyListeners();
        },
        reject
      );
    });

    return cacheHousehold;
  }

  function getHousehold() {
    assertReady();
    return cacheHousehold;
  }

  async function updateHousehold(patch) {
    assertReady();
    const nextPatch = { ...patch };
    if (patch.routes != null) nextPatch.routes = normalizeRoutes(patch.routes);
    const next = {
      ...cacheHousehold,
      ...nextPatch,
      updatedAt: Date.now(),
    };
    // Don't write id into Firestore doc
    const { id, ...fields } = next;
    await fs.setDoc(householdRef, fields, { merge: true });
    cacheHousehold = { ...next, id: householdId };
    notifyListeners();
    return cacheHousehold;
  }

  function listShifts({ from, to } = {}) {
    assertReady();
    let shifts = cacheShifts.slice();
    if (from != null || to != null) {
      shifts = shifts.filter((s) => {
        const t = s.clockIn;
        if (from != null && t < from) return false;
        if (to != null && t >= to) return false;
        return true;
      });
    }
    return shifts.sort((a, b) => b.clockIn - a.clockIn);
  }

  function listTrips({ from, to } = {}) {
    assertReady();
    let trips = cacheTrips.slice();
    if (from != null || to != null) {
      trips = trips.filter((t) => {
        const d = t.dayMs;
        if (from != null && d < from) return false;
        if (to != null && d >= to) return false;
        return true;
      });
    }
    return trips.sort((a, b) => b.dayMs - a.dayMs || (b.createdAt || 0) - (a.createdAt || 0));
  }

  function getOpenShift() {
    assertReady();
    return cacheShifts.find((s) => s.clockOut == null) || null;
  }

  async function clockIn() {
    assertReady();
    // Prevent double open shifts (server query, not just cache)
    const openQ = fs.query(shiftsCol, fs.where('clockOut', '==', null));
    const openSnap = await fs.getDocs(openQ);
    if (!openSnap.empty) throw new Error('Already clocked in');

    const h = getHousehold();
    const id = uuid();
    const now = Date.now();
    const shift = {
      id,
      householdId,
      clockIn: now,
      clockOut: null,
      note: '',
      morningHours: 0,
      afternoonHours: 0,
      morningPay: 0,
      afternoonPay: 0,
      totalHours: 0,
      totalPay: 0,
      createdAt: now,
      updatedAt: now,
    };
    const { id: _id, householdId: _hid, ...fields } = shift;
    await fs.setDoc(fs.doc(shiftsCol, id), fields);
    // Optimistic cache update (onSnapshot will reconcile)
    cacheShifts = [shift, ...cacheShifts.filter((s) => s.id !== id)];
    notifyListeners();
    return applyPay(shift, h);
  }

  async function clockOut() {
    assertReady();
    const open = getOpenShift();
    if (!open) throw new Error('Not clocked in');
    const h = getHousehold();
    const now = Date.now();
    if (now <= open.clockIn) throw new Error('Clock-out must be after clock-in');
    const updated = applyPay({ ...open, clockOut: now, updatedAt: now }, h);
    const { id, householdId: _hid, ...fields } = updated;
    await fs.setDoc(fs.doc(shiftsCol, id), fields, { merge: true });
    cacheShifts = cacheShifts.map((s) => (s.id === id ? updated : s));
    notifyListeners();
    return updated;
  }

  async function addShift({ clockIn, clockOut, note } = {}) {
    assertReady();
    if (clockIn == null || clockOut == null) {
      throw new Error('Arrival and departure are required');
    }
    if (clockOut <= clockIn) {
      throw new Error('Departure must be after arrival');
    }
    const h = getHousehold();
    const id = uuid();
    const now = Date.now();
    const shift = applyPay(
      {
        id,
        householdId,
        clockIn,
        clockOut,
        note: note || '',
        createdAt: now,
        updatedAt: now,
      },
      h
    );
    const { id: _id, householdId: _hid, ...fields } = shift;
    await fs.setDoc(fs.doc(shiftsCol, id), fields);
    cacheShifts = [shift, ...cacheShifts.filter((s) => s.id !== id)];
    notifyListeners();
    return shift;
  }

  async function updateShift(id, patch) {
    assertReady();
    const h = getHousehold();
    const existing = cacheShifts.find((s) => s.id === id);
    if (!existing) throw new Error('Shift not found');
    let next = { ...existing, ...patch, updatedAt: Date.now() };
    if (next.clockOut != null && next.clockOut <= next.clockIn) {
      throw new Error('Clock-out must be after clock-in');
    }
    // If opening this shift, ensure no other open shift
    if (next.clockOut == null) {
      const openQ = fs.query(shiftsCol, fs.where('clockOut', '==', null));
      const openSnap = await fs.getDocs(openQ);
      const other = openSnap.docs.find((d) => d.id !== id);
      if (other) throw new Error('Already clocked in');
    }
    next = applyPay(next, h);
    const { id: _id, householdId: _hid, ...fields } = next;
    await fs.setDoc(fs.doc(shiftsCol, id), fields, { merge: true });
    cacheShifts = cacheShifts.map((s) => (s.id === id ? next : s));
    notifyListeners();
    return next;
  }

  async function deleteShift(id) {
    assertReady();
    await fs.deleteDoc(fs.doc(shiftsCol, id));
    cacheShifts = cacheShifts.filter((s) => s.id !== id);
    notifyListeners();
  }

  async function addTrip(trip) {
    assertReady();
    const id = trip.id || uuid();
    const now = Date.now();
    const row = {
      id,
      householdId,
      dayMs: trip.dayMs,
      routeId: trip.routeId || null,
      label: trip.label || '',
      miles: Number(trip.miles) || 0,
      ratePerMile: Number(trip.ratePerMile) || 0,
      amount: Number(trip.amount) || 0,
      note: trip.note || '',
      createdAt: trip.createdAt ?? now,
      updatedAt: trip.updatedAt ?? now,
    };
    const { id: _id, householdId: _hid, ...fields } = row;
    await fs.setDoc(fs.doc(tripsCol, id), fields);
    cacheTrips = [row, ...cacheTrips.filter((t) => t.id !== id)];
    notifyListeners();
    return row;
  }

  async function deleteTrip(id) {
    assertReady();
    await fs.deleteDoc(fs.doc(tripsCol, id));
    cacheTrips = cacheTrips.filter((t) => t.id !== id);
    notifyListeners();
  }

  function subscribeShifts(cb) {
    listeners.add(cb);
    if (ready) {
      try {
        cb(listShifts({}));
      } catch (e) {
        console.error(e);
      }
    }
    return () => {
      listeners.delete(cb);
    };
  }

  async function recalculateAll() {
    assertReady();
    const h = getHousehold();
    const updates = cacheShifts.map((s) => applyPay(s, h));
    await Promise.all(
      updates.map((s) => {
        const { id, householdId: _hid, ...fields } = s;
        return fs.setDoc(fs.doc(shiftsCol, id), fields, { merge: true });
      })
    );
    cacheShifts = updates;
    notifyListeners();
  }

  return {
    mode: 'firebase',
    householdId,
    firebaseConfig,
    ensureHousehold,
    getHousehold,
    updateHousehold,
    listShifts,
    listTrips,
    subscribeShifts,
    clockIn,
    clockOut,
    addShift,
    updateShift,
    deleteShift,
    addTrip,
    deleteTrip,
    getOpenShift,
    recalculateAll,
  };
}

export { DEFAULTS, DEFAULT_ROUTES, uuid };
