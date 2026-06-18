# FinTrace NCRP

**Cyber Crime Financial Trail Analyzer** — a fully offline Windows desktop application for Indian Cyber Crime Police personnel.

Ingests NCRP BankAction CompleteTrail Excel exports and transforms them into investigation-grade intelligence: layered money trails, mule account identification, cashout patterns, lien-recovery worksheets (matched to CypherSOL CypherTrace v2.2.100), RBI/MHA-formatted bank correspondence, a multi-sheet Excel workbook, and a visual PDF dossier.

**Current version: 0.3.0**

---

## The Problem

Investigating Officers handling cyber-financial fraud cases currently:
- Parse NCRP Excel exports row-by-row in Microsoft Excel
- Cannot visualize layered money movement (Layer 0 → Layer N)
- Struggle to spot mule accounts and repeat offenders across complaints
- Draft lien-request letters to banks manually, one bank at a time
- Spend hours preparing investigation reports for courts and senior officers

## The Solution

A single `.exe` installer with no internet requirement, no external database, no separate server, and no login. One double-click to install; one double-click to run.

**Key performance targets:**
- From "downloaded Excel" → "PDF dossier + drafted lien emails" in under **5 minutes** for a 5,000-row file
- Files with **50,000+ rows** parse without UI freeze
- Cold launch on a 4 GB / i3 PC in **< 3 seconds**
- Zero outbound network connections

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 33 |
| UI | React 18 + Vite 5 + React Router 6 (HashRouter) |
| Charts (UI) | Recharts 2 |
| Tables | TanStack Table v8 + TanStack Virtual v3 |
| Backend | Node.js + Express 4 (embedded in the Electron main process, loopback `127.0.0.1:3847`) |
| Database | SQLite via better-sqlite3 (WAL mode, stored in `%APPDATA%`) |
| Excel parsing & export | SheetJS (xlsx 0.20.3) |
| PDF generation | PDFKit |
| Chart rasterization (PDF) | `@resvg/resvg-js` (SVG → PNG) |
| Date math | dayjs (UTC plugin; IST calendar-day logic) |
| Testing | Jest 30 + Supertest 7 |

---

## Project Structure

```
fintrace-ncrp/
├── electron/
│   ├── main.js          # Electron main process — boots Express in-process, BrowserWindow, IPC, native dialogs
│   └── preload.js       # Context-isolated IPC bridge (window.fintrace.*)
├── frontend/
│   ├── src/
│   │   ├── pages/       # Upload, Dashboard, Layers, MoneyFlow, Mules, Lien,
│   │   │                #   DataQuality, Transactions, Emails, Timeline (10 pages)
│   │   ├── components/  # Sidebar, DataTable, StatCard, Badge, Skeleton, ErrorAlert, LoadingSpinner
│   │   ├── context/     # ReportContext (active reportId)
│   │   └── utils/       # api.js (axios + Electron IPC detection), format.js (Indian number/date)
│   └── vite.config.js
├── backend/
│   ├── src/
│   │   ├── server.js              # Express app factory, binds 127.0.0.1:3847
│   │   ├── routes/ncrp.js         # All REST endpoints + /health
│   │   ├── parsers/
│   │   │   ├── ncrpParser.js      # Multi-sheet Excel ingestion + column mapping + IFSC resolution
│   │   │   └── parseFuzzy.js      # Self-healing fuzzy sheet/column resolver (3rd tier)
│   │   ├── analyzers/analyzer.js  # Multi-module analysis engine (entry: analyzeReport)
│   │   ├── analysis/
│   │   │   ├── hopGraph.js        # Account→account edge graph
│   │   │   ├── cycleDetector.js   # Circular-flow detection
│   │   │   ├── connectivity.js    # Per-account in/out-degree + collector ranking
│   │   │   └── dayOfWeek.js       # Day-of-week activity breakdown
│   │   ├── db/
│   │   │   ├── schema.js          # SQLite schema (7 tables) + WAL pragmas + idempotent migrations
│   │   │   ├── queries.js         # Prepared-statement helpers
│   │   │   └── seed.js
│   │   ├── lib/
│   │   │   ├── cashoutPolicy.js   # CASHOUT_POLICY.CAP_AT_RECEIVED
│   │   │   ├── ifscBankResolver.js# IFSC → bank map + resolveBank()
│   │   │   └── provenance.js      # Source-file SHA-256 + appVersion()
│   │   ├── utils/
│   │   │   ├── excelGenerator.js  # 19-sheet workbook
│   │   │   ├── pdfGenerator.js    # Visual PDF dossier (PDFKit)
│   │   │   ├── charts.js          # SVG→PNG charts for the PDF (resvg)
│   │   │   ├── exportViews.js     # Shared derived views for PDF/Excel
│   │   │   └── emailGenerator.js  # Per-bank RBI/MHA lien-request letters
│   │   ├── config/
│   │   │   ├── header_synonyms.json  # Column name alias map
│   │   │   └── mule_weights.json     # Mule scoring weight config (11 signals)
│   │   └── __tests__/             # Jest test suite (20 suites — see Testing)
│   ├── scripts/                   # accuracy / consistency / security / e2e / benchmark / validate harnesses
│   ├── jest.config.js
│   └── package.json
├── SRS.md                # Software Requirements Specification (baseline)
├── SDD.md                # Software Design Document (as-built)
├── BUILD_INSTRUCTIONS.md # Windows installer build guide
├── docs/USER_GUIDE.md    # Officer-facing user guide
├── docs/RELEASE_CHECKLIST.md
└── .gitignore
```

---

## Features

### Upload & Parse
- Drag-and-drop NCRP Excel upload with 3-stage validation (size → magic bytes → NCRP content tokens)
- Multi-sheet ingestion — every channel sheet (bank transfer, ATM, POS, AEPS, on-hold, …) is stitched into one trail
- Tolerant column detection via a three-tier resolver: **exact** → **loose** (normalized synonyms) → **self-healing fuzzy** (max Dice/Levenshtein ≥ 85%). The happy path is byte-identical; fuzzy matches surface as `parse_warnings`.
- **Evidentiary provenance** — a SHA-256 of the raw uploaded file is computed before parsing and recorded on the case record, the audit log, and stamped into the PDF; re-ingesting a different file for the same case raises a changed-source warning.
- **Suspected-duplicate flagging** — exact and probable duplicate rows are flagged non-destructively, with raw vs. deduped counts surfaced in reconciliation.
- **Old Transaction handling** — transactions older than 6 months are excluded from all figures and preserved separately for reference.
- Indian currency formatting (`₹1,23,456.50`), Excel serial date parsing, DD/MM/YYYY
- Async analysis pipeline — upload returns `202` immediately, status polled by the UI

### Analysis Engine
The analyzer (`analyzers/analyzer.js`) runs a fault-isolated, multi-module pipeline and returns one structured bundle persisted to `ncrp_reports.analysis_json`:

| Module | What it does |
|---|---|
| Layer Analysis | Per-layer accounts, banks, hop/disputed amounts, fan-out, avg forward time (Layer 0–N) |
| Cashout Analysis | ATM/POS withdrawals, same-day cashouts (IST clock), policy-capped at received |
| Mule Detection | **Uncapped 11-signal** weighted score (6 base + 5 bonus) + plain-language suspicion reasons |
| Lien Calculation | CypherSOL gross-balance parity: `min(received − forwarded − on_hold − cashed_out, disputed_received)` |
| Data Quality | Per-account bank-attribution flags (IFSC vs. text mismatch, no/invalid/unknown IFSC) |
| Money Flow Network | Heaviest account→account edges + collector aggregators |
| Circular Flows | Self-referential / cyclic money routes |
| Account Connectivity | In/out-degree per account, ranked collectors |
| Timeline | Daily volume + layer breakdown (IST); day-of-week pattern |
| Geography | State/city + ATM/merchant hotspots |
| Recovery Status | `cashed_out + on_hold + refunded + recoverable_residual` reconciles to victim loss |
| Investigation Roadmap | Prioritised P0–P3 action list |
| Repeat Accounts | Cross-case UPSERT registry for returning mule accounts |
| Key Findings | Auto-generated summary bullets for the dashboard and PDF |

### Outputs
- **Visual PDF dossier** — Cover (with provenance block) + Executive Summary, Visual Summary (money-flow/layer/daily-volume charts rasterised SVG→PNG), Investigation Roadmap, Key Findings, then **Annexure A–H** (Layer, Money Flow, Mules, Lien, Cashout, Geography, Timeline, Data Quality) and every per-bank draft lien letter. Deterministic (same case → same charts).
- **19-sheet Excel workbook** — Summary, Layer Breakdown, Lien Calculation, Suspected Mules, Transactions, Money Flow Network, Circular Flows, Account Connectivity, Victim Accounts (Layer 0), ATM Exit Details, POS Exit Details, Daily Volume, Hourly Pattern, Day of Week, Bank Rankings, Data Quality, Parse Audit, Geographic Hotspots, Glossary.
- **Per-bank lien-request letters** — one formal letter per bank citing Section 102 Cr.P.C. read with the IT Act, 2000; copy-paste ready (the app never sends mail).
- **Native Save As** — in the packaged app, every export (PDF + Excel) prompts a native OS "Save As" dialog before anything is written; cancelling writes nothing. In a browser the same routes stream a blob download.

### REST API
All endpoints are served by Express on `http://127.0.0.1:3847` under the `/api` prefix. `:id` is a `reportId`, validated as a positive integer.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Liveness check (version + uptime; never leaks the DB path) |
| `POST` | `/api/ncrp/upload` | Accept `.xlsx`/`.xls`, parse + insert, schedule analysis, return `202` |
| `GET` | `/api/ncrp/reports` | List all uploaded reports (newest first) |
| `GET` | `/api/ncrp/:id` | Report detail + full `analysis_json` (polled for status) |
| `GET` | `/api/ncrp/:id/transactions` | Paginated ledger with filters (layer, bank, mode, date, amount, search) |
| `GET` | `/api/ncrp/:id/layers` | Per-layer aggregates |
| `GET` | `/api/ncrp/:id/mules` | Scored mule accounts (uncapped 11-signal) |
| `GET` | `/api/ncrp/:id/data-quality` | Accounts whose bank attribution needs IO review |
| `GET` | `/api/ncrp/:id/lien` | Lien worksheet (recoverable accounts + balances) |
| `POST` | `/api/ncrp/:id/lien` | Create/update a lien record (audit-logged) |
| `GET` | `/api/ncrp/:id/emails` | Per-bank draft lien letters (generated on first access) |
| `POST` | `/api/ncrp/:id/emails/:emailId` | Update a draft's status (`draft` → `sent`) |
| `GET` | `/api/ncrp/:id/timeline` | Daily volume timeline |
| `GET` | `/api/ncrp/:id/geography` | State/city + ATM/merchant breakdown |
| `GET` | `/api/ncrp/:id/pdf` | Generate the PDF dossier (`?mode=file` writes to `exports/`) |
| `GET` | `/api/ncrp/:id/excel` | Generate the 19-sheet workbook (`?mode=file` writes to `exports/`) |
| `GET` | `/api/ncrp/:id/audit` | Audit log (newest first) |
| `DELETE` | `/api/ncrp/:id` | Delete report (cascades to all child records) |

### Security
- 3-stage upload gate: magic-byte/Excel-signature validation (ZIP/OLE2 — not just extension), NCRP-content token scan, and a **50 MB** file size cap (multer)
- SQL injection prevention: `:id` validated as a positive integer; parameterized statements throughout
- Path-traversal prevention on uploaded filenames and on every IPC file operation (exports confined to `EXPORTS_DIR`)
- `sanitizeIdentifier()` strips control chars, angle brackets, and quotes before embedding user data in email bodies
- Rate limiting (100 req/min general, 5/min upload; disabled in `NODE_ENV=test`)
- Electron hardening: `contextIsolation` on, `nodeIntegration` off, `sandbox` on, HTTP CSP header, loopback-only egress block, single-instance lock, whitelisted IPC channels only

---

## Getting Started

### Prerequisites
- Node.js 18+ (24.x tested)
- npm 9+
- For native builds on Windows: Python 3.10–3.12 + Visual Studio Build Tools 2022 (Desktop development with C++) — see [BUILD_INSTRUCTIONS.md](BUILD_INSTRUCTIONS.md)

### Install dependencies

```bash
# Root (Electron + electron-builder + electron-updater + electron-rebuild)
npm install

# Backend (express, better-sqlite3, xlsx, pdfkit, @resvg/resvg-js, …)
cd backend && npm install && cd ..

# Frontend (React + Vite)
cd frontend && npm install && cd ..
```

The root `postinstall` runs `electron-builder install-app-deps`, which rebuilds native modules (better-sqlite3) against the bundled Electron — no manual rebuild is usually needed.

### Run in development

```bash
# Terminal 1 — backend
cd backend && node src/server.js

# Terminal 2 — frontend (Vite dev server on http://localhost:5173)
cd frontend && npm run dev

# Terminal 3 — Electron
npm run dev:electron
```

The backend listens on `127.0.0.1:3847`.

### Build the Windows installer

```bash
npm run build:win   # build:frontend + electron-builder --win → dist/FinTrace NCRP Setup 0.3.0.exe
```

See [BUILD_INSTRUCTIONS.md](BUILD_INSTRUCTIONS.md) for the full toolchain, native-rebuild, and clean-VM verification steps.

---

## Testing

All Jest tests live in `backend/src/__tests__/`.

```bash
cd backend

npm test              # run all tests once  → 366 tests across 20 suites
npm run test:coverage # run with coverage report
npm run test:watch    # watch mode
```

### Test suite overview

| Area | Suites |
|---|---|
| Parsing | `ncrpParser.test.js`, `parseFuzzy.test.js`, `parserFuzzyIntegration.test.js`, `parserHardening.test.js` |
| Analysis | `analyzer.test.js`, `cashoutPolicy.test.js`, `dataQuality.test.js`, `reconciliation.test.js`, `oldTransaction.test.js`, `accountMerge.test.js`, `channelSafety.test.js`, `competitorFeatures.test.js` |
| Outputs | `charts.test.js`, `exports.test.js`, `emailGenerator.test.js` |
| Platform | `ifscBankResolver.test.js`, `provenance.test.js`, `queries.test.js`, `security.test.js`, `api/reports.api.test.js` |

**Coverage thresholds:** branches/functions/lines/statements ≥ 70%.

### Validation harnesses (`backend/scripts/`)

These run the real parser/analyzer/exporters against the verified NCRP gold cases and exit non-zero on any mismatch — a reviewer (or an SP's tech team) can run them to confirm parity:

```bash
cd backend
node scripts/accuracy_test.js     # derived metrics vs CypherSOL gold (file …145) + edge cases → 30/30
node scripts/security_audit.js    # 10-vector HTTP attack gate → 10/10
node scripts/consistency_test.js  # cashed_out identical across summary/cashout/recovery/PDF/Excel
node scripts/validate_v020.js     # fixes hold in the GENERATED PDF text + Excel cells → 121 cross-artifact + 4/4 suites
node scripts/e2e_validate.js      # full pipeline: parse → analyze → PDF/Excel over real case 145
node scripts/benchmark.js         # parse/analysis/PDF/Excel timings vs CypherSOL-beating targets
```

---

## Documentation

- [SRS.md](SRS.md) — Software Requirements Specification (functional requirements, constraints, acceptance criteria — v1.0 baseline)
- [SDD.md](SDD.md) — Software Design Document (as-built architecture, DB schema, API contract, security model)
- [BUILD_INSTRUCTIONS.md](BUILD_INSTRUCTIONS.md) — Windows installer build guide
- [docs/USER_GUIDE.md](docs/USER_GUIDE.md) — Officer-facing user guide
- [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) — Per-release verification checklist

---

## License

Private — Internal use by Cyber Crime Cell personnel only.
Copyright © M Intergraph Systems Pvt. Ltd. (MINT).
