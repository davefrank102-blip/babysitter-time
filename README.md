# Sitter Time

Mobile-first Progressive Web App for babysitter time tracking. Parents and the babysitter use the **same household link** on different phones; roles toggle on the home screen. Data syncs live via **Firebase Firestore**.

## Live site

**https://davefrank102-blip.github.io/babysitter-time/**

## Household link (one only)

This family uses a **single locked household**. The live site always opens:

**https://davefrank102-blip.github.io/babysitter-time/#/h/5d35fd91-6d35-4def-91fa-fe5545295c85**

1. Bookmark that URL (or Add to Home Screen from it) on every phone.
2. Tap **Share link** (Parent view → unlocked) to copy it for the sitter.
3. Opening the bare site root now **redirects** to this same household — it no longer creates a new one.

## Rates (America/New_York)

| Period | When | Default rate |
|--------|------|--------------|
| Morning | Before 12:00 local | **$20/hr** |
| Afternoon | From 12:00 onward | **$25/hr** |

If a shift crosses noon, hours are **split** across both rates. Pay amounts **round up** to the next whole dollar (no cents). Overnight shifts are split per calendar day at that day’s cutoff. Timezone is fixed to `America/New_York` for cutoffs and display.

Rates, cutoff hour, household name, and parent PIN are editable in **Parent → Settings**.

**Default parent PIN:** `1234`


## Mileage (Parent only)

Parents can log driving reimbursement after PIN unlock. A **Mileage** card sits between Shift history and Settings.

- **Preset route:** BCCT ↔ Home · **18 mi**
- Pick a date + route (or **Other…** for a custom destination/miles). Optional **Save to route list** adds a custom destination for later.
- Amount = miles × **IRS business standard rate** for that date (America/New_York), then **ceil to whole dollars** (same as shift pay).
- Destinations are managed under **Settings → Destinations** (add/delete; stored on the household doc).
- Totals show **Hours**, **Pay** (shifts), **Mileage**, and **Combined**. By-week mode includes mileage per week.
- **Export mileage CSV** downloads trips in the selected totals range.

### IRS business mileage rates

| Period (America/New_York) | Rate |
|---------------------------|------|
| Before 2026 | **$0.70**/mi |
| 2026 Jan 1 – Jun 30 | **$0.725**/mi |
| 2026 Jul 1 onward | **$0.76**/mi |

Trips live in `households/{id}/trips` (and localStorage `bst:{id}:trips`). Routes are on the household document as `routes: [{ id, label, miles }]`.

## Logging shifts

Sitters enter **Arrival** and **Departure** (`datetime-local`), see a live pay/hours preview from household rates, and tap **Save shift**. Today’s hours/pay summary counts **closed** shifts only. Parent edit modal uses the same Arrival/Departure labels.

## Parent totals

Parent → **Totals** ranges: **Today**, **This week**, **By week**, and **Custom**. **By week** lists each Monday–Sunday week (America/New_York) that has closed shifts, newest first, with hours and morning/afternoon/total pay; an all-time grand total stays above. Shift history is hidden in that mode.

## Add to Home Screen

### iPhone (Safari)

1. Open the household link in Safari.
2. Tap the Share button → **Add to Home Screen**.
3. Confirm the name (**Sitter Time**). The app opens standalone with Apple touch icon / status bar meta.

### Android (Chrome)

1. Open the link in Chrome.
2. Menu → **Install app** / **Add to Home screen**.

The app includes `manifest.json`, icons, theme color, and a service worker for offline shell caching.

## Sync

UI talks only to `db.js`:

```js
createDb({ mode: 'local' | 'firebase', firebaseConfig?, householdId })
```

**Firebase mode (live site):** Firestore collections `households/{id}`, `households/{id}/shifts`, and `households/{id}/trips`. `onSnapshot` keeps an in-memory cache so both phones update in near real time. Header shows **Live sync on**.

**Local mode:** `localStorage` keyed by `bst:<householdId>:…` for offline / local development (`mode: 'local'` in `app.js`).

### Security note

Firestore is currently in **test mode** (open read/write for the MVP family use case). That is fine for a private household link among trusted people, but anyone with the project config and a guessed/known household id could read or write data. Tighten rules (Auth + per-household access) before wider sharing.

## Open locally

```bash
cd babysitter-time
python3 -m http.server 8080 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8080/`. Firebase mode still needs network access to Google’s CDN and Firestore.

## Project files

| File | Role |
|------|------|
| `index.html` | App shell, sitter + parent views |
| `styles.css` | Phone-first UI |
| `app.js` | Routing, roles, PIN, shift form, mileage, history, CSV |
| `rates.js` | Timezone-aware pay split + IRS mileage helpers |
| `rates.test.js` | Node assertions (`npm test` / `node rates.test.js`) |
| `db.js` | Local adapter + Firebase Firestore live sync |
| `manifest.json` / `sw.js` / `icons/` | PWA |
| `docs/` | GitHub Pages publish root (static copy) |

## Tests

```bash
node rates.test.js
```

## Assumptions

- Sitters log completed shifts with arrival + departure (`addShift`); parent edit can still leave departure blank for incomplete rows.
- Parent unlock is session-scoped (`sessionStorage`); refresh keeps unlock until the tab closes or Lock is tapped.
- CSV export includes closed shifts in the selected range only.
- Mileage CSV export includes trips in the selected range only.
- `datetime-local` edit fields are interpreted in America/New_York, not the device’s OS zone.
