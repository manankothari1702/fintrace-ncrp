# FinTrace NCRP — Automated Dead-Code Sweep (knip)

**Branch:** `chore/deadcode-sweep` (off `feature/auth-rbac`). Not merged to main.
**Tool:** knip 6.25.0 (devDependency, root `package.json`; installed with `--ignore-scripts` so the root `postinstall` native rebuild did not fire).
**Scope:** whole codebase — `electron/`, root `scripts/`, `backend/src` (incl. the four files the manual audit never reached: `analyzer.js`, `ncrpParser.js`, `pdfGenerator.js`, `excelGenerator.js` — knip parsed all of them), `frontend/src`.

**Action taken this task:** exactly **one** pre-approved deletion (the `resolveDbKey` dead import in `server.js`). Everything else below is **report-only** — nothing else was changed. You decide the batch.

---

## 1. knip config used (reproducible)

This repo has **three `package.json` files but is not an npm-workspaces monorepo** (no `workspaces` field — and adding one would risk the packaged-app node_modules layout, so I did not). Instead I declared the three package dirs as knip workspaces in a single root `knip.json`:

```json
{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "workspaces": {
    ".":        { "entry": ["electron/preload.js", "scripts/*.js"],                 "project": ["electron/**/*.js", "scripts/**/*.js"] },
    "backend":  { "entry": ["src/server.js", "scripts/*.js", "src/__tests__/**/*.js"], "project": ["src/**/*.js"] },
    "frontend": { "entry": ["src/**/*.test.{js,jsx}"],                               "project": ["src/**/*.{js,jsx}"] }
  }
}
```

**Why these entry points** (things that are real roots but nothing imports, so knip must not flag them):
- Root: `electron/main.js` is auto-detected (root `package.json#main`); `electron/preload.js` is declared (Electron preload isn't auto-detected); `scripts/*.js` are the build/prebuild scripts run via node.
- Backend: `src/server.js` is the entry Electron's main process loads (not auto-detected); `backend/scripts/*.js` are the standalone node scripts (accuracy_test, e2e_validate, security_audit, benchmark, reanalyze, consistency_test, validate_v020); `src/__tests__/**` are the jest suites. `src/analyzers/analyzer.js` is auto-detected (backend `package.json#main`).
- Frontend: `src/main.jsx`, `vite.config.js`, `src/test/setup.js` are auto-detected via knip's Vite/Vitest plugins; the `*.test.{js,jsx}` glob covers the vitest suites.

Run: `npx knip --no-progress`. The config produces **zero configuration hints** and is stable across runs. knip is a devDependency only and has no runtime effect (verified: not in any `dependencies`, and installed with `--ignore-scripts`).

---

## 2. Summary

| Category | Raw findings | CONFIRMED-DEAD | FALSE-POSITIVE | NEEDS-REVIEW |
|---|---:|---:|---:|---:|
| Unused files | 2 | 0 | 1 | 1 |
| Unused dependencies | 11 | 0 | 9 | 2 |
| Unlisted dependencies | 2 | 0 | 2 | 0 |
| Unused exports | 66 | 4 | 32 | 30 |
| **Total** | **81** | **4** | **44** | **33** |
| *Dead import (pre-approved, already removed)* | *1* | *1* | — | — |

**Headline:** of 81 raw findings, only **4** are confirmed genuinely-dead-and-safe (all frontend unused exports, LOW risk). **44** are false positives (the multi-`package.json`/shared-node_modules layout, CommonJS namespace imports, JSDoc type-imports, and internal-only "over-exports"). **33** need your review (they touch security / analyzer / parser / DB / recent Phase-1 code, so I defaulted them to review per your conservative rule). The knip surface is large but the actionable dead code is tiny — consistent with the manual audit's finding that this codebase is lean.

---

## 3. Findings

### 3a. Unused files (2)

| File | Verdict | Reasoning |
|---|---|---|
| `backend/src/db/seed.js` (516 ln) | **NEEDS-REVIEW** | A deterministic demo-seed module (`seedDatabase`). Nothing in `backend/src` or `backend/scripts` requires it, and it's explicitly excluded from jest coverage (`backend/jest.config.js:17`). It's intentional demo/dev tooling, not a leftover — plausibly kept for a demo/populate flow. Not obviously safe to delete; confirm it isn't wired into any demo/build path before removing. |
| `frontend/src/modules/bankStatement/utils/api.js` | **FALSE-POSITIVE** | The Bank Statement module is deliberately scaffold/mock for a future phase. This is forward-looking scaffold, not dead code, and is out of scope to touch. |

### 3b. Unused dependencies (11) — almost entirely a layout artifact

| Dependency | Where | Verdict | Reasoning |
|---|---|---|---|
| `@resvg/resvg-js`, `bcryptjs`, `better-sqlite3-multiple-ciphers`, `dayjs`, `express`, `express-rate-limit`, `multer`, `pdfkit`, `xlsx` | root `package.json` | **FALSE-POSITIVE** (×9) | These are imported by `backend/src`, which runs **inside the Electron main process** using the **root** node_modules that the packaged app ships. Root `package.json` is the authoritative runtime manifest for the bundle; knip flags them "unused in root" only because root's *own* source (`electron/`, `scripts/`) doesn't import them directly. Removing any would break the packaged app. |
| `electron-log` | `backend/package.json:17` | **NEEDS-REVIEW** | Used by `electron/main.js` (root workspace), not by `backend/src`. The `backend/package.json` entry appears to be an unnecessary mirror — likely removable from *backend's* manifest, but harmless; verify it isn't required by any backend script first. |
| `call-bind-apply-helpers` (pinned `1.0.2`) | root `package.json:25` | **NEEDS-REVIEW** | A normally-*transitive* polyfill listed as a **direct** dependency with a hard pin. That pattern almost always means a deliberate version pin/override for a transitive advisory. Not imported by any source, but do **not** remove without confirming why it was pinned (removing it could un-pin a transitive fix). |

### 3c. Unlisted dependencies (2)

| Symbol | Location | Verdict | Reasoning |
|---|---|---|---|
| `better-sqlite3` | `analyzers/analyzer.js:2617`, `utils/entityDetail.js:132` | **FALSE-POSITIVE** (×2) | Not a runtime `require` — these are **JSDoc type annotations** (`@param {import('better-sqlite3').Database}`). The DB instance is injected at runtime (the app uses the API-identical `better-sqlite3-multiple-ciphers`). No manifest change needed; optionally add `better-sqlite3` to `ignoreDependencies` to silence. |

### 3d. Unused exports (66)

**Backend — FALSE-POSITIVE (22): CommonJS namespace or white-box test imports knip can't trace**

| Exports | File | Reasoning |
|---|---|---|
| `getUserByUsername, getUserById, countUsers, countUsersByRole, insertUser, updateUserPassword, updateLastLogin, updateUserRole, setUserActive, listUsers` (10) | `db/authQueries.js` | Consumed via **namespace** — `const authQ = require('../db/authQueries')` in `auth/authContext.js:37` (and `auth.test.js:25`), called as `authQ.insertUser(...)`. knip doesn't track CJS namespace member access. All are in active use. |
| `FUZZY_THRESHOLD, AMBIGUITY_MARGIN, diceCoefficient, levenshtein, levenshteinRatio, similarity, normalizeLoose, bestMatch, SHEET_CATEGORY, SHEET_REGISTRY, SHEET_TARGETS, COLUMN_TARGETS` (12) | `parsers/parseFuzzy.js` | Exported for the white-box unit test, which imports the module by **namespace** (`const F = require('../parsers/parseFuzzy')`). Production wiring goes through `resolveColumnFuzzy`/`resolveSheetCategoryFuzzy` (imported destructured by `ncrpParser.js:54` — **not** flagged). Parser/accuracy path — leave regardless. |

**Backend — NEEDS-REVIEW (26): internal-only "over-exports" on security / analyzer / parser / DB code**

These are exported but imported by no other file; they *are* used **inside their own module**. Un-exporting them (making them module-private) is behavior-neutral, but every one sits on a sensitive path, so per your conservative rule they default to review, not delete.

| Exports | File | Path sensitivity |
|---|---|---|
| `canReadDatabase, PRAGMAS, CREATE_TABLES, CREATE_INDEXES, COLUMN_MIGRATIONS` (5) | `db/schema.js` | DB schema + encryption |
| `ALL_ROLES, ROLE_PERMISSIONS` (2) | `lib/roles.js` | RBAC (ROLE_PERMISSIONS is the tunable map, used internally by `roleHasPermission`) |
| `KDF, getCredentialSecret, saltPathFor` (3) | `lib/dbKey.js` | Encryption/KDF (`getCredentialSecret` is a documented bootstrap seam, possibly Phase 2/3) |
| `BCRYPT_ROUNDS, SESSION_IDLE_MS` (2) | `lib/authStore.js` | Auth/security constants |
| `KEYSTORE_VERSION` (1) | `lib/keystore.js` | Encryption keystore |
| `parseBackupDate` (1) | `lib/backup.js` | Phase-1 backups (used internally for retention) |
| `normaliseBankName, WALLET_PSEUDO_IFSC_PREFIXES, VALID_IFSC` (3) | `lib/ifscBankResolver.js` | Bank attribution (accuracy-adjacent) |
| `COLLECTOR_MIN_IN_DEGREE, DEFAULT_CAP` (2) | `analysis/connectivity.js` | Analyzer/competitor-features |
| `DEFAULT_MAX_LEN, DEFAULT_CAP` (2) | `analysis/cycleDetector.js` | Analyzer |
| `WEEKDAY_ORDER` (1) | `analysis/dayOfWeek.js` | Analyzer |
| `UPLOADS_DIR, EXPORTS_DIR, isExcelMagicBytes, looksLikeNcrpFile` (4) | `routes/ncrp.js` | **Security** — `isExcelMagicBytes`/`looksLikeNcrpFile` are magic-byte validators, exported for the upload-security tests. Leave. |

**Frontend — FALSE-POSITIVE (10): used internally, merely over-exported (LOW value tidy, not dead)**

| Exports | File | Reasoning |
|---|---|---|
| `API_BASE_URL, default (axios instance), isElectron, reportPdfUrl, reportExcelUrl, cashExitExcelUrl, entityExcelUrl` (7) | `utils/api.js` | Each is used **inside `api.js`** (e.g. `isElectron` at 6 call sites; `reportPdfUrl` inside `openReportPdf`; `cashExitExcelUrl` inside the cash-exit opener). "Unused export" only means they needn't be exported — dropping the `export` keyword is a micro-tidy, not a deletion. |
| `getStoredTheme, applyTheme, setTheme` (3) | `utils/theme.js` | Used internally by `initTheme`/`useTheme` within `theme.js`. Same over-export pattern. |

**Frontend — CONFIRMED-DEAD (4): genuinely no caller anywhere, LOW risk (non-security, non-accuracy)**

| Export | Location | Reasoning |
|---|---|---|
| `getGeography` | `utils/api.js:332` | No caller in the app at all. Its backend `/ncrp/:id/geography` route is likely its unused pair — worth reviewing/removing together. |
| `checkHealth` | `utils/api.js:107` | No app caller (only referenced as a string key in a test's `vi.mock`, which doesn't need the real export). A harmless health-probe helper that nothing calls. |
| `formatDateTime` | `utils/format.js:99` | Superseded by `formatDateTimeUTC` (the deliberate IST-as-UTC date model); no caller remains. |
| `default` export | `components/Skeleton.jsx:68` | Pages import the named `SkeletonStats`/`SkeletonTable`; the default export is unused. |

**Frontend — NEEDS-REVIEW (4)**

| Export | Location | Reasoning |
|---|---|---|
| `authMe` | `utils/api.js:539` | No caller yet, but it's a `/auth/me` helper on recent Phase-1 auth — plausibly intended for a Phase-2 session-restore check. Don't delete pre-Phase-2 without confirming. |
| `openReportPdf`, `openReportExcel` | `utils/api.js:360,381` | No app caller found, but `api.js` has a **parallel pair** of PDF/Excel open functions (~lines 430–460) that pages appear to use instead. Likely superseded duplicates — but confirm which exporter each page actually calls before removing (near-duplicate names, easy to get wrong). |
| `MOCK_DETECTED_HEADERS` | `modules/bankStatement/utils/mockData.js:32` | Bank Statement scaffold for a future phase; out of scope. |

---

## 4. The one pre-approved fix (done + verified)

**Removed:** `backend/src/server.js:28` — `const { resolveDbKey } = require('./lib/dbKey');` (imported, never referenced in `server.js`; the login-gated key path goes through `authContext`/`keystore`). Confirmed `resolveDbKey` appears nowhere else in `server.js` before removing. `resolveDbKey` itself and `lib/dbKey.js` are untouched (still used by `db/schema.js` docs and the encryption tests).

**Verification (all green after the change):**
- Backend jest: **515/515** (32 suites).
- Accuracy: **30/30** byte-exact (`accuracy_test.js`).
- Frontend vitest: **25/25** (5 files).
- Frontend build: **clean** (`vite build` ✓).
- Backend boots / encrypted DB opens: covered by the passing `encryption.test.js` + `auth.test.js` (the login-gated `createServerApp` → keystore-unlock → `initializeDatabase({key})` path). Removing an unused import is inert; I relied on the test suite that exercises server assembly and the encrypted-DB open rather than a full Electron GUI launch.

No other finding was acted on.

---

## 5. Recommendation — what's worth doing before Phase 2

**Safe batch (LOW risk, do it):**
1. ✅ `server.js` dead import — **already removed** (this task).
2. The **4 CONFIRMED-DEAD frontend exports** — `getGeography`, `checkHealth`, `formatDateTime`, and `Skeleton`'s default export. All genuinely unused, non-security, non-accuracy. Small win, low churn. Two carry a follow-on: `getGeography` likely lets you also drop the backend `/geography` route + its generator (verify it's unused server-side too); `formatDateTime` is safe to drop once you confirm no dynamic reference.

**Hold until you explicitly want a tidy pass (LOW value / cosmetic):**
- The ~13 frontend + backend **internal over-exports** (drop the `export`/`module.exports` entry only). Behavior-neutral but touches security files (`roles`, `dbKey`, `authStore`, `keystore`, `schema`) — not worth the diff noise pre-Phase-2.

**Leave (NEEDS-REVIEW / FALSE-POSITIVE — do not touch now):**
- All backend security/parser/analyzer/DB "unused exports" — mostly namespace/test false positives or intentional test seams; the real ones are internal-only and sit on gold-tested/encrypted paths.
- `authMe`, `openReportPdf`/`openReportExcel` — recent auth / near-duplicate exporters; verify before removing.
- `seed.js`, the Bank Statement scaffold, and all the flagged dependencies — false positives or forward-looking, except two worth a one-line check each: `electron-log` in `backend/package.json` (probably a redundant mirror entry) and `call-bind-apply-helpers` in root (confirm it's a deliberate pin before touching).

**Net:** the automated sweep confirms the manual audit's conclusion — there is very little genuinely-removable dead code. One import gone; four small frontend exports are the only other clean wins. knip is now wired in (`npx knip`) so this stays cheap to re-run each phase.
