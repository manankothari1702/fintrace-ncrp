# FinTrace NCRP

**Cyber Crime Financial Trail Analyzer** — a fully offline Windows desktop application for Indian Cyber Crime Police personnel.

Ingests NCRP BankAction CompleteTrail Excel exports and transforms them into investigation-grade intelligence: layered money trails, mule account identification, cashout patterns, lien-recovery worksheets, RBI/MHA-formatted bank correspondence, and PDF dossiers.

---

## The Problem

Investigating Officers handling cyber-financial fraud cases currently:
- Parse NCRP Excel exports row-by-row in Microsoft Excel
- Cannot visualize layered money movement (Layer 0 → Layer N)
- Struggle to spot mule accounts and repeat offenders across complaints
- Draft lien-request letters to banks manually, one bank at a time
- Spend hours preparing investigation reports for courts and senior officers

## The Solution

A single signed `.exe` installer with no internet requirement, no external database, no separate server, and no login. One double-click to install; one double-click to run.

**Key performance targets:**
- From "downloaded Excel" → "PDF dossier + drafted lien emails" in under **5 minutes** for a 5,000-row file
- Files with **50,000+ rows** parse without UI freeze
- Cold launch on a 4 GB / i3 PC in **< 3 seconds**
- Zero outbound network connections

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 28 |
| UI | React 18 + Vite 5 + React Router 6 |
| Charts | Recharts 2 |
| Tables | TanStack Table v8 + TanStack Virtual v3 |
| Backend | Node.js + Express 4 (embedded in Electron main process) |
| Database | SQLite via better-sqlite3 (WAL mode, stored in `%APPDATA%`) |
| Excel parsing | SheetJS (xlsx 0.20.3) |
| PDF generation | PDFKit |
| Date math | dayjs |
| Testing | Jest 30 + Supertest 7 |

---

## Project Structure

```
fintrace-ncrp/
├── electron/
│   ├── main.js          # Electron main process — boots Express, opens BrowserWindow
│   └── preload.js       # Context-isolated IPC bridge
├── frontend/
│   ├── src/
│   │   ├── pages/       # Dashboard, Upload, Transactions, Layers, Mules,
│   │   │                #   Timeline, Lien, Emails
│   │   ├── components/  # Sidebar, DataTable, StatCard, Badge, etc.
│   │   ├── context/     # ReportContext (global report state)
│   │   └── utils/       # format.js (Indian number/date formatting)
│   └── vite.config.js
├── backend/
│   ├── src/
│   │   ├── server.js          # Express app factory
│   │   ├── routes/ncrp.js     # All REST endpoints
│   │   ├── parsers/
│   │   │   └── ncrpParser.js  # Excel ingestion + column mapping
│   │   ├── analyzers/
│   │   │   └── analyzer.js    # 8-module analysis engine
│   │   ├── db/
│   │   │   ├── schema.js      # SQLite schema + initializeDatabase()
│   │   │   └── queries.js     # All prepared-statement helpers
│   │   ├── utils/
│   │   │   ├── emailGenerator.js  # Draft lien-request email builder
│   │   │   └── pdfGenerator.js    # PDFKit report generator
│   │   ├── config/
│   │   │   ├── header_synonyms.json  # Column name alias map
│   │   │   └── mule_weights.json     # Mule scoring weight config
│   │   └── __tests__/         # Jest test suite (see Testing)
│   ├── jest.config.js
│   └── package.json
├── SRS.md               # Software Requirements Specification
├── SDD.md               # Software Design Document
└── .gitignore
```

---

## Features

### Upload & Parse
- Drag-and-drop NCRP Excel upload with magic-byte validation
- Tolerant column detection via synonym map (handles multiple NCRP export formats)
- Indian currency formatting (`₹1,23,456.50`), Excel serial date parsing, DD/MM/YYYY
- Async analysis pipeline — upload returns immediately, status polled by UI

### Analysis Engine (8 modules)
| Module | What it does |
|---|---|
| Layer Analysis | Counts accounts and flow per layer (Layer 0–N) |
| Cashout Analysis | Identifies ATM/POS withdrawals, same-day cashouts (IST clock) |
| Mule Detection | Weighted scoring: pass-through ratio, cashout speed, cross-case appearance, geo-spread, KYC variance |
| Lien Calculation | Computes eligible lien = received − forwarded for each mule account |
| Timeline Analysis | Aggregates transaction volume by day in IST |
| Geography Analysis | Groups by state/city for heat-map rendering |
| Key Findings | Surfaced summary bullets for the PDF report |
| Repeat Accounts | Cross-case UPSERT tracker for returning mule accounts |

### REST API
All endpoints are under `/api/ncrp/`:

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `POST` | `/upload` | Accept `.xlsx` file, trigger analysis |
| `GET` | `/reports` | List all uploaded reports |
| `GET` | `/:id` | Report detail + analysis status |
| `GET` | `/:id/transactions` | Paginated transactions with filters (layer, bank, date, amount, cashout, search) |
| `GET` | `/:id/layers` | Layer breakdown |
| `GET` | `/:id/mules` | Detected mule accounts with scores |
| `GET` | `/:id/lien` | Lien records |
| `POST` | `/:id/lien` | Create lien record |
| `PUT` | `/:id/lien/:lienId` | Update lien status |
| `GET` | `/:id/emails` | Draft emails |
| `POST` | `/:id/emails/:emailId` | Update email status |
| `GET` | `/:id/timeline` | Daily volume timeline |
| `GET` | `/:id/geography` | State/city breakdown |
| `GET` | `/:id/audit` | Audit log |
| `GET` | `/:id/pdf` | Download PDF dossier |
| `DELETE` | `/:id` | Delete report (cascades to all child records) |

### Security
- Magic-byte validation on upload (ZIP/OLE2 signatures, not just extension)
- 50 MB file size cap (multer)
- SQL injection prevention: `:id` validated as positive integer before any query
- Path traversal prevention on uploaded filenames
- CORS allow-list: `localhost:5173` (Vite dev), `file://` (Electron renderer)
- `sanitizeIdentifier()` strips control chars, angle brackets, quotes before embedding in email bodies
- Rate limiting (disabled in `NODE_ENV=test`)
- Electron hardening: `contextIsolation` on, `nodeIntegration` off, CSP headers, loopback-only network, single-instance lock

---

## Getting Started

### Prerequisites
- Node.js 18+
- npm 9+

### Install dependencies

```bash
# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install
```

### Run in development

Start the backend and frontend separately, then launch Electron:

```bash
# Terminal 1 — backend
cd backend
node src/server.js

# Terminal 2 — frontend
cd frontend
npm run dev

# Terminal 3 — Electron
npx electron electron/main.js
```

The backend listens on `127.0.0.1:3847`. The Vite dev server serves the UI on `http://localhost:5173`.

### Build for production

```bash
cd frontend
npm run build       # outputs to frontend/dist

# Then package with electron-builder (see SDD §6 for full config)
npx electron-builder
```

---

## Testing

All tests live in `backend/src/__tests__/`.

```bash
cd backend

npm test              # run all tests once
npm run test:coverage # run with coverage report
npm run test:watch    # watch mode
```

### Test suite overview

| File | Type | Tests |
|---|---|---|
| `ncrpParser.test.js` | Unit | Excel parsing, column mapping, date/amount/layer primitives |
| `analyzer.test.js` | Unit | All 8 analysis modules, mule scoring, lien calculation |
| `security.test.js` | Unit + Integration | XSS, path traversal, SQL injection, magic-byte, CORS, size cap |
| `emailGenerator.test.js` | Unit | Money/date formatting, email grouping, officer override |
| `queries.test.js` | Unit | All DB helper functions, filter branches, UPSERT idempotency |
| `api/reports.api.test.js` | Integration | Full upload → poll → all endpoints → delete flow (in-memory SQLite) |

**Coverage thresholds:** branches ≥ 70%, functions ≥ 70%, lines ≥ 70%, statements ≥ 70%

### E2E validation script

```bash
cd backend
node scripts/e2e_validate.js
```

Runs a 10-step end-to-end check against a real (temp) SQLite database with a real Express server on a random port. Outputs colored PASS/FAIL per step; exits 0 on success.

---

## Documentation

- [SRS.md](SRS.md) — Software Requirements Specification (functional requirements, constraints, acceptance criteria)
- [SDD.md](SDD.md) — Software Design Document (architecture, DB schema, API contract, security model, build plan)

---

## License

Private — Internal use by Cyber Crime Cell personnel only.
