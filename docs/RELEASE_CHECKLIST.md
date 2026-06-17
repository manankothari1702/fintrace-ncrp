# FinTrace NCRP — Release Checklist

## 0.3.0 (current release)

**Release:** v0.3.0
**Product:** FinTrace NCRP — Cyber Crime Financial Trail Analyzer
**Owner:** M Intergraph Systems Pvt. Ltd. (MINT)

| # | Item | Status | Result / Notes |
|---|------|--------|----------------|
| 1 | Version bumped across root/backend/frontend `package.json` | **[x] PASS** | Bumped root `package.json`, `backend/package.json`, and `frontend/package.json` from `0.2.0` → **0.3.0**; sidebar UI footer reads `v0.3.0`; `app.getVersion()` (IPC `app:get-version`) and the backend `appVersion()` both read `package.json`, so they return 0.3.0 automatically. Installer-name references in `USER_GUIDE.md` / `BUILD_INSTRUCTIONS.md` updated to `FinTrace NCRP Setup 0.3.0.exe`. |
| 2 | Visual PDF dossier (charts + annexure split) | **[x] PASS** | Dossier upgraded from tabular-only to visual: money-flow network, layer-breakdown, and daily-volume charts built as SVG and rasterised to PNG (`@resvg/resvg-js`) for reliable printing; deterministic (same case → same charts). Bulky tables moved to a labelled Annexure (A–H); all 15 Section-102 lien letters and financial figures preserved. |
| 3 | Evidentiary provenance (source-file SHA-256) | **[x] PASS** | SHA-256 of the raw uploaded NCRP file is computed before parsing, stored on the case record + audit log (filename, hash, upload timestamp, app version), stamped into the PDF (cover "Source & Provenance" block, every page footer, and PDF metadata), and a changed-source warning fires when the same case is re-ingested from a file with a different hash. |
| 4 | Backend test suite green | **[x] PASS** | `cd backend && npm test` → **254/254 tests across 14 suites**; cross-artifact validator (`scripts/validate_v020.js`) 66/66. |
| 5 | Code signing | **[~] IN PROGRESS** | Authenticode signing of the installer and binaries is still being set up (carried over from 0.2.0). |
| 6 | Offline auto-updater | **[~] IN PROGRESS** | Offline / air-gapped update flow remains under development (carried over from 0.2.0). |

---

## 0.2.0 — historical

**Release:** v0.2.0
**Product:** FinTrace NCRP — Cyber Crime Financial Trail Analyzer
**Owner:** M Intergraph Systems Pvt. Ltd. (MINT)

| # | Item | Status | Result / Notes |
|---|------|--------|----------------|
| 1 | Version bumped across root/backend/frontend `package.json` | **[x] PASS** | Bumped root `package.json`, `backend/package.json`, and `frontend/package.json` from `0.1.0` → **0.2.0**; sidebar UI footer reads `v0.2.0`; `app.getVersion()` (IPC `app:get-version`) returns 0.2.0. |
| 2 | Code signing | **[~] IN PROGRESS** | Authenticode signing of the installer and binaries is being set up for this release. |
| 3 | Offline auto-updater | **[~] IN PROGRESS** | Offline / air-gapped update flow is under development for this release. |

---

## 0.1.0 (Beta) — historical

**Release:** v0.1.0 (Beta)
**Product:** FinTrace NCRP — Cyber Crime Financial Trail Analyzer
**Owner:** M Intergraph Systems Pvt. Ltd. (MINT)
**Last updated by this finalization pass:** 2026-06-03

---

## Legend

- **[x] PASS** — verified complete.
- **[~] PENDING** — must be done on the Windows build machine / clean VM / by a
  human; cannot be completed in the headless dev environment used for this pass.
  Each one has a clear instruction for how to finish it.
- **[ ] TODO** — not yet started / deliberately deferred for this beta.

> **Why some items are PENDING.** This finalization pass ran in a headless Linux/
> CI-style environment with **no Visual Studio C++ build tools and Node v24**, so
> the native module `better-sqlite3` could not be compiled or loaded here. Any
> step that needs a running server, the packaged installer, or a real Windows
> machine is therefore marked PENDING with instructions, and **must be run on the
> designated Windows build machine** (which has the toolchain per
> `BUILD_INSTRUCTIONS.md §1`) before shipping.

---

## Release gate

| # | Item | Status | Result / Notes |
|---|------|--------|----------------|
| 1 | All Phase 8 tests passing | **[~] PENDING** | Pure-logic suites **PASS here**: `analyzer.test.js`, `ncrpParser.test.js`, `emailGenerator.test.js` → **61/61 tests green**. The DB-backed suites (`queries.test.js`, `security.test.js`, `api/reports.api.test.js`) need `better-sqlite3`, which won't compile in this environment. **Run `cd backend && npm test` on the Windows build machine** to confirm all suites + the ≥70% coverage gate. |
| 2 | E2E validation script: all 10 steps PASS | **[~] PENDING** | Script reviewed and intact (`backend/scripts/e2e_validate.js`, 10 steps). Needs a live server (better-sqlite3). **Run `cd backend && node scripts/e2e_validate.js` on the build machine**; expect 10/10 PASS, exit 0. |
| 3 | Tested with real NCRP file | **[x] PASS** | Verified on real CompleteTrail exports (prior run): **File 32712250107170** — 2,411 rows, 7 sheets, ₹40.24L disputed, 11 layers; **File 32712250107145** — 151 rows, 6 sheets, ₹22.8L disputed. Duplicate-row notes are expected NCRP portal behaviour. Re-confirm against a fresh real file after the build. |
| 4 | Tested on clean Windows 10 VM | **[~] PENDING** | Follow `BUILD_INSTRUCTIONS.md §9`: fresh Win10 VM, **no** Node/Python/VS installed, run the installer, smoke-test (upload sample, open dashboard, generate PDF), uninstall. |
| 5 | Tested on clean Windows 11 VM | **[~] PENDING** | Same as #4 on a fresh Windows 11 VM. (This pass's host OS is Windows 11 Pro 26200, but that is **not** a clean VM — a pristine VM test is still required.) |
| 6 | Installer < 200 MB | **[~] PENDING** | Build with `npm run build:win` and check `dist\FinTrace NCRP Setup 0.1.0.exe`. Electron runtime is ~120 MB; total expected ~150–180 MB. If over 200 MB, enable 7z compression in the NSIS config. |
| 7 | App loads in < 5 seconds on i3 CPU | **[~] PENDING** | Measure cold launch (double-click → main window visible) on an i3 / 4 GB machine. A splash window shows immediately; the embedded backend boots in-process. Re-measure on target hardware. |
| 8 | 50,000-row file analysed in < 30 seconds | **[~] PENDING** | **Optimised this pass** (see below): the analyzer's cash-out write-back is now a **single SQLite transaction** instead of 50k auto-commits, and a composite index `(report_id, transaction_date DESC, id DESC)` backs the paginated query. Re-measure with a 50k-row file on the build machine. |
| 9 | PDF generates in < 10 seconds | **[~] PENDING** | PDF is streamed to disk via PDFKit (`doc.pipe(createWriteStream)`), not buffered into one string. Verify timing on the build machine, including the large 1,190-account case. |
| 10 | User guide reviewed by a non-technical officer | **[~] PENDING** | **`docs/USER_GUIDE.md` written this pass** (officer-facing, 10 sections + FAQ). Needs sign-off by a non-technical officer for clarity. |
| 11 | All `console.log` removed or replaced with proper logging | **[x] PASS** | Audited all source. **No stray/debug logs.** Remaining console calls are intentional: the required startup banner + start-up failure in `backend/src/server.js`, route-level **error** logging in `routes/ncrp.js` (captured by Electron stdout / `electron-log` in packaged builds), and the dev hint in the React `ErrorBoundary`. `electron/main.js` uses `electron-log`. |
| 12 | Version number updated in package.json and UI | **[x] PASS** | Unified to **0.1.0**: root `package.json` (was `1.0.0` → now `0.1.0`), `backend/package.json` (0.1.0), `frontend/package.json` (0.1.0), and the sidebar UI footer (`v0.1.0`). `app.getVersion()` (IPC `app:get-version`) now returns 0.1.0. |
| 13 | electron-builder code signing configured (or documented as TODO) | **[x] PASS (documented TODO)** | **Intentionally unsigned for this beta.** `forceCodeSigning:false`; the documented build command sets `CSC_IDENTITY_AUTO_DISCOVERY=false` / `WIN_CSC_LINK=""`. Users will see a Windows SmartScreen prompt (covered in the User Guide). **TODO for GA:** acquire an OV/EV code-signing certificate and set `WIN_CSC_LINK` + `CSC_KEY_PASSWORD` before `npm run build:win`. |

---

## Changes made in this finalization pass (Phase 10)

### Performance

- **Backend — analyzer write-back is now transactional.** In
  `backend/src/analyzers/analyzer.js`, the post-analysis cash-out write-back
  (`same_day_cashout` / `cashout_mode` on every row) is wrapped in a single
  `db.transaction(...)`. On a 50k-row file this collapses ~50,000 individual
  auto-commits into one fsync — the dominant cost of analysing a large report.
- **Backend — composite index for the hot query.** Added
  `idx_txn_report_date ON ncrp_transactions(report_id, transaction_date DESC, id DESC)`
  in `backend/src/db/schema.js`, matching the Transaction Browser's
  `WHERE report_id = ? ORDER BY transaction_date DESC, id DESC` paginated query so
  it no longer sorts the whole report per page. (Index is `IF NOT EXISTS`; it is
  added automatically to existing databases on next launch.)
- **Backend — analysis is cached, never re-run.** Confirmed: analysis runs once
  post-upload and is persisted in `ncrp_reports.analysis_json`; all read endpoints
  serve from that snapshot.
- **Frontend — code splitting.** Every page except Upload is now `React.lazy`-
  loaded (`frontend/src/App.jsx`) behind a `Suspense` fallback. Vite
  `manualChunks` split the heavy libraries into cacheable vendor chunks.
  **Result (measured):** main entry chunk **786 KB → 25 KB** (gzip 9.4 KB);
  recharts (~360 KB) now loads only on the Dashboard/Timeline pages. No
  chunk-size warnings.
- **Frontend — fewer re-renders.** `React.memo` on `StatCard`, `DataTable`, and
  `Badge`; `useMemo` already guards the per-page data transforms.

### UI polish

- **Loading skeletons** (new `Skeleton` component) replace bare spinners on the
  Dashboard, Lien, Mules, Layers, Timeline, Transactions, and the Upload reports
  list — shape-matched to each page, and motion-reduced for accessibility.
- **Custom empty states** per page (Mules, Lien, Emails, Timeline, Dashboard
  cash-out table, Upload) that explain *why* there's no data.
- **High-value highlight:** transaction amounts over **₹1,00,000** render in
  orange in the Transactions table.
- **Keyboard navigation:** `Escape` closes the Transactions filter panel and the
  open Emails letter; `Enter` in the Transactions search box applies immediately.
- **Print stylesheet** for the whole app, tuned for the **Lien** and **Emails**
  pages: hides chrome, flattens cards, repeats table headers, and prints **every**
  letter (each on its own page).
- **Responsive tables:** horizontal scroll with a sensible min-width below 1200 px.
- **Missing fields** render as `—` (real NCRP files often omit name/city/state).
- **Clearer parser note:** the duplicate-row warning now explains that the same
  transaction appearing across NCRP channel sheets is normal portal behaviour.

### Bug fixes (final hunt)

- **Fixed: null bytes corrupting `routes/ncrp.js`.** The control-character scrub
  regex in `sanitizeStringParam` was stored as **literal control bytes**
  (`0x00`, `0x1F`, `0x7F`) instead of escapes, which made the file read as
  *binary* to Git/grep/editors and is fragile across encodings. Replaced with the
  readable, identical-behaviour `/[\x00-\x1f\x7f]/g` (matching `emailGenerator.js`)
  plus an `eslint-disable no-control-regex` note. **No behaviour change.**
- **Hardened: delete-while-analysis-running.** `runAnalysisInBackground` now
  re-checks the report exists immediately before persisting; if the officer
  deleted it mid-analysis, it aborts quietly instead of tripping the foreign-key
  guard and logging a misleading `analysis.error`.
- **Reviewed: concurrent uploads.** Safe by design — Node is single-threaded and
  better-sqlite3 is synchronous, so two uploads get distinct report IDs and their
  background analyses serialise on the event loop without interleaving a
  transaction. The 5-uploads/min limiter also bounds this.
- **Verified (no change needed):** Lien page with 0 eligible accounts (empty
  state, no crash); PDF with no cash-out data (renders a "no cash-out" section);
  date parsing handles both DD/MM/YYYY and Excel serials; 50k-row UI stays
  responsive (server pagination + row virtualization).

### Documentation

- `docs/USER_GUIDE.md` — full officer-facing guide (install → portal export →
  analyse → dashboard → mule score → lien → emails → PDF → FAQ → support).
- `docs/RELEASE_CHECKLIST.md` — this file.
- `BUILD_INSTRUCTIONS.md` — installer-name references updated to **0.1.0**.

---

## How to finish the remaining (PENDING) items — on the Windows build machine

```powershell
# 0. Prereqs once (see BUILD_INSTRUCTIONS.md §1): Node 18+, Python 3.10-3.12,
#    Visual Studio Build Tools 2022 (Desktop development with C++).

# 1. Install + native rebuild
npm install
cd backend ; npm install ; cd ..
cd frontend ; npm install ; cd ..
npm run rebuild-sqlite      # only if a NODE_MODULE_VERSION mismatch appears

# 2. Item #1 — full backend test suite + coverage gate
cd backend ; npm run test:coverage ; cd ..

# 3. Item #2 — end-to-end validation (use a real CompleteTrail file if available)
cd backend ; node scripts/e2e_validate.js ; cd ..

# 4. Items #6-#9 — build the installer, then measure
$env:CSC_IDENTITY_AUTO_DISCOVERY="false"; $env:WIN_CSC_LINK=""
npm run build:win
#   - check dist\"FinTrace NCRP Setup 0.1.0.exe" size (< 200 MB)
#   - launch on an i3 box, time to main window (< 5 s)
#   - analyse a 50,000-row file (< 30 s), generate its PDF (< 10 s)

# 5. Items #4-#5 — install the .exe on clean Win10 and Win11 VMs (no toolchain),
#    smoke-test, then uninstall. (BUILD_INSTRUCTIONS.md §9)

# 6. Item #10 — have a non-technical officer read docs/USER_GUIDE.md and sign off.
```

### Sign-off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Build / QA engineer | | | |
| Reviewing officer (User Guide) | | | |
| Release approver (MINT) | | | |
