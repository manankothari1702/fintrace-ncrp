# Software Requirements Specification (SRS)
## FinTrace NCRP — Cyber Crime Financial Trail Analyzer

| Field | Value |
|---|---|
| Document ID | FINTRACE-SRS-001 |
| Version | 1.0 |
| Status | Baseline (Single Source of Truth) |
| Date | 2026-05-26 |
| Owner | Architecture / Engineering |
| Audience | Engineering, QA, UX, Investigating Officers (IO), Cyber Crime Cell stakeholders |

> **As-built pointer (added 2026-06-18).** This SRS remains the **v1.0 requirements baseline** dated 2026-05-26 and is intentionally not re-litigated here. Where the shipped product (currently **v0.4.0**) diverges from this forward design — language (JavaScript, not TypeScript), **Electron 33** (not 28), 7 SQLite tables, an uncapped 11-signal mule score, the CypherSOL gross-balance lien formula, a 19-sheet Excel workbook, and a visual PDF dossier — the authoritative description is **[SDD.md](SDD.md) v2.1 (as-built)**. Read the SDD for what exists; read this SRS for the original intent and acceptance criteria.

---

## 1. Executive Summary

### 1.1 Purpose
FinTrace NCRP is a **standalone, fully offline Windows desktop application** designed for Indian Cyber Crime Police personnel. It ingests **NCRP BankAction CompleteTrail Excel exports** (downloaded from the National Cyber Crime Reporting Portal) and transforms them into investigation-grade intelligence: layered money trails, mule account identification, cashout patterns, lien-recovery worksheets, RBI/MHA-formatted bank correspondence, and PDF dossiers ready for case files.

### 1.2 Problem Statement
Investigating Officers (IOs) handling cyber-financial fraud cases currently:
- Manually parse NCRP Excel exports row-by-row in Microsoft Excel.
- Cannot easily visualize layered money movement (Layer 0 → Layer N).
- Struggle to spot mule accounts and repeat offenders across multiple complaints.
- Draft lien-request letters to banks manually, one bank at a time.
- Lose hours preparing investigation reports for senior officers and courts.
- Have no offline tool that respects police-station IT constraints (no internet, low-spec hardware, no admin rights for installations needing servers/databases).

### 1.3 Solution Overview
A single signed Windows `.exe` installer (built via `electron-builder`) that ships:
- An **Electron** desktop shell (Electron 33 as built).
- A **React 18 + Vite** UI.
- An **embedded Node.js + Express** backend bound to `127.0.0.1:3847` (loopback only, never exposed to LAN).
- An **embedded SQLite** database (via `better-sqlite3`, WAL mode) stored under the user's `%APPDATA%`.
- **SheetJS (`xlsx`)** for tolerant, auto-detecting Excel parsing.
- **Recharts** for visualizations, **TanStack Table v8** for high-density tables, **PDFKit** for report generation, **dayjs** for date math.

No internet calls. No external database. No separate server. No login. One double-click to install; one double-click to run.

### 1.4 Stakeholders
| Stakeholder | Interest |
|---|---|
| Investigating Officer (IO) | Primary daily user. Wants speed-to-insight on every complaint. |
| Inspector / Senior Officer | Reviews PDF reports; signs off on lien requests. |
| Cyber Crime Cell Head | Cross-case visibility (repeat accounts, mule rings). |
| Bank Nodal Officer (indirect) | Recipient of generated lien request emails — format must be RBI/MHA compliant. |
| IT / Procurement | Cares about offline operation, single-installer footprint, no admin server. |

### 1.5 Success Criteria
- An IO can go from "downloaded Excel" → "PDF dossier + drafted lien emails" in **under 5 minutes** for a 5,000-row file.
- Mule scoring surfaces the **top 10 suspect accounts** automatically, with explainable scoring.
- Files with **50,000+ rows** parse without UI freeze.
- Cold launch on a 4 GB / i3 PC in **< 3 seconds**.
- Zero outbound network connections during normal operation.

---

## 2. Scope & Boundaries

### 2.1 In Scope
- Local ingestion and parsing of NCRP `BankAction CompleteTrail` Excel files (`.xlsx`, `.xls`).
- Header auto-detection across NCRP portal export variants.
- Persistent storage of complaints, transactions, accounts, layers, lien states, and email drafts.
- All twelve required analytical features (see §3).
- Generation of investigation PDF and lien-request email drafts (saved as `.eml` or `.txt` for copy-paste into the officer's email client).
- Cross-file aggregation: repeat accounts and mule patterns across multiple uploaded complaints.

### 2.2 Out of Scope (see also §9 for the complete list)
- Real-time data fetch from the NCRP portal (the portal does not provide a public API).
- Sending emails directly (no SMTP integration — police email policy forbids unattended sending; tool only **drafts**).
- Multi-user concurrent access, role-based access control, audit-grade authentication.
- Cloud sync / inter-station replication.
- Mobile or web clients.
- OCR of scanned bank statements.

### 2.3 System Context Diagram (Textual)
```
   ┌──────────────────────────────────────────────────────────┐
   │                  Windows PC (Police Station)             │
   │                                                          │
   │   ┌───────────────┐    loopback     ┌─────────────────┐  │
   │   │  React UI     │ ───────────────▶│ Express @ 3847  │  │
   │   │ (Electron     │ ◀──────────────│ (Node, embedded)│  │
   │   │  renderer)    │   127.0.0.1     └────────┬────────┘  │
   │   └───────────────┘                          │           │
   │                                              ▼           │
   │                                    ┌──────────────────┐  │
   │   NCRP .xlsx ──── drag/drop ───▶  │ SQLite (WAL)     │  │
   │                                    │ %APPDATA%/...    │  │
   │                                    └──────────────────┘  │
   │                                                          │
   │   Outputs: investigation.pdf, lien_emails/*.eml          │
   └──────────────────────────────────────────────────────────┘
              ⛔  No outbound network. No telemetry.
```

---

## 3. Functional Requirements

Each FR is testable. Acceptance criteria are stated where the bar is non-obvious.

### 3.1 File Upload & Ingestion

**FR-01 — Drag-and-Drop Excel Upload**
The system shall accept `.xlsx` and `.xls` files via drag-and-drop onto the Upload screen, or via a "Browse" button.
*Acceptance:* Dropping a non-Excel file rejects with a clear inline error; oversize (>250 MB) is rejected with a guidance message.

**FR-02 — Tolerant Header Auto-Detection**
The parser shall auto-detect NCRP column headers across known export variants (e.g., `Acknowledgement No`, `Ack No`, `Complaint Number`; `Transaction Amount`, `Txn Amount`, `Amount (INR)`). A header-synonym map shall live in a single config module so new variants can be added without code surgery.
*Acceptance:* A test corpus of ≥ 5 NCRP export variants parses with zero manual mapping.

**FR-03 — Streaming Parse for Large Files**
For files > 5,000 rows the parser shall stream rows in batches of 1,000 into SQLite using `better-sqlite3` transactions, with a progress bar (rows processed / total) updating at ≥ 10 Hz.

**FR-04 — Upload History**
Every successful or failed upload shall be recorded (`uploads` table: id, filename, file_hash_sha256, row_count, complaint_count, uploaded_at, status, error_message). The Upload History screen shall list uploads newest-first with filters (date range, status).

**FR-05 — Duplicate Upload Detection**
On upload, the SHA-256 of the file shall be compared against `uploads.file_hash_sha256`. If a match exists the user shall see: *"This exact file was already imported on `<date>`. Re-import will skip duplicates by `Acknowledgement No + UTR/Reference No`."* and choose Cancel or Proceed.

**FR-06 — Row-Level Validation & Quarantine**
Rows missing a usable Acknowledgement No **and** missing a UTR shall be quarantined (`quarantined_rows` table) with the reason. Parsing shall not abort on bad rows; the post-import summary shall display `<imported>` / `<quarantined>` counts.

### 3.2 Layer Analysis

**FR-07 — Layer Tree Construction**
For each complaint, the system shall reconstruct the money trail as a directed graph: Layer 0 = victim account; Layer 1 = first beneficiary; Layer N = subsequent beneficiaries. The `Layer No` column from NCRP shall be used when present; when absent, the system shall infer layers via transaction date + beneficiary→victim chaining.

**FR-08 — Per-Layer Aggregates**
For each layer the system shall compute and display: number of distinct accounts, total transaction amount (sum), share of disputed amount (%), median transfer interval (minutes between inbound and outbound).

**FR-09 — Layer Drill-Down**
Clicking any layer in the layer chart shall navigate to a filtered Transaction Browser view (FR-30) showing only that layer's transactions, with breadcrumb context.

**FR-10 — Layer Sankey / Flow Chart**
A Sankey-style flow diagram (Recharts custom or `react-flow`) shall visualize fund flow from Layer 0 to Layer N. Edge width = amount; node colour = layer index.

### 3.3 Cashout Detection

**FR-11 — Cashout Mode Classification**
Each terminal transaction (no further outbound) shall be classified into one of: `ATM_WITHDRAWAL`, `POS_PURCHASE`, `ONLINE_PURCHASE`, `UPI_TRANSFER_OUT`, `WALLET_LOAD`, `UNKNOWN`. Classification rules shall use `Payment Mode`, presence of `ATM ID`/`ATM Location`, and merchant/MCC tokens parsed from `Remarks`.

**FR-12 — Same-Day Cashout Flag**
A transaction is flagged `same_day_cashout = true` when funds arrived in the account on the same calendar day (IST) as they were withdrawn/spent. Tolerance threshold ≥ 70% of inbound amount cashed out same-day.

**FR-13 — Cashout Speed Metric**
For every account, compute `cashout_speed_minutes` = median(minutes between inbound credit and matched outbound debit). Display in the Cashout screen with quartile bands (P25/P50/P75/P90) across the complaint.

**FR-14 — Cashout Hotspot Identification**
ATM IDs / locations that appear in ≥ 3 distinct complaints **or** ≥ 5 transactions in one complaint shall be flagged as `hotspot=true`. Hotspots are surfaced on the Geography View (FR-44).

### 3.4 Mule Account Detection

**FR-15 — Mule Score (0–100)**
The system shall compute a per-account `mule_score` ∈ [0, 100] from the following weighted components (weights adjustable in `config/mule_weights.json`; documented defaults below):

| Signal | Weight | Computation |
|---|---:|---|
| Pass-through ratio | 30 | `outbound_amount / inbound_amount`, clipped to [0, 1.2], rescaled. ≥ 0.9 → full points. |
| Cashout speed | 20 | Inverse of `cashout_speed_minutes`; ≤ 60 min → full points; ≥ 24 h → 0. |
| Transaction count | 15 | Log-scaled count; ≥ 20 txns in one complaint → full points. |
| Cross-case appearances | 20 | Distinct `acknowledgement_no` values for this account; ≥ 3 → full points. |
| Geographic spread | 10 | Distinct cities/states across the account's transactions; ≥ 4 → full points. |
| KYC-mismatch heuristic | 5 | Beneficiary Name token-set distance vs prior occurrences; high variance → full points. |

`mule_score` is the weighted sum, rounded to integer.

**FR-16 — Mule Score Explainability**
Every score shall be accompanied by a **per-component breakdown** ("why this score?") visible on hover/click. No black-box scoring.

**FR-17 — Suspect List**
A "Top Suspect Accounts" view shall list accounts with `mule_score ≥ 60` by default (threshold configurable), sorted descending, with columns: account, bank, score, components, linked complaints.

**FR-18 — Mule Tags**
IO shall be able to manually tag an account as `confirmed_mule`, `cleared`, or `under_review`. Tags persist in `account_tags` table and override the auto-derived suspect-list inclusion only for display badges (the score itself is never mutated by tags).

### 3.5 Lien Amount Calculator

**FR-19 — Per-Account Recoverable Balance**
For each beneficiary account compute:
`recoverable = max(0, inbound_disputed - outbound_after_complaint_date)`
where `complaint_date = MIN(Complaint Date)` for that account across all complaints.

**FR-20 — Lien Status Lifecycle**
Each account shall carry a `lien_status` ∈ {`not_requested`, `pending`, `applied`, `success`, `failed`}. Default = `not_requested`. IO updates manually; every change is timestamped in `lien_status_history`.

**FR-21 — Lien Worksheet Export**
A "Lien Worksheet" Excel/CSV export shall list every flagged account with: bank, IFSC, account, recoverable amount, disputed amount, complaint refs, current lien status. Used for offline submission to seniors.

**FR-22 — Lien Aging**
Accounts in `pending` for > 7 calendar days shall be highlighted amber; > 15 days red, on the Lien Tracker screen.

### 3.6 Repeat Account Registry

**FR-23 — Cross-Complaint Account Aggregation**
The system shall maintain a `repeat_accounts` materialized view (refreshed on each upload) listing every account that appears as a beneficiary in ≥ 2 distinct complaints.

**FR-24 — Repeat Account Detail View**
Clicking a repeat account shall show all linked complaints, total disputed amount across them, first/last seen dates, and current lien status.

**FR-25 — Repeat Account Alert on Upload**
After every upload, the post-import summary shall surface "N new repeat-account matches found in this file" with a one-click jump to the registry.

### 3.7 Draft Email Generator

**FR-26 — Bank-Grouped Lien Letters**
The system shall draft one lien request letter **per bank** (not per account), grouping all flagged accounts for that bank into a single letter. Letters are generated as `.eml` files (RFC 5322) saved to a user-chosen folder; the user opens them in their email client (Outlook/Thunderbird) to review and send.

**FR-27 — RBI/MHA Format Compliance**
Each letter shall use the format prescribed by RBI's Master Direction on Frauds and MHA's I4C SOP, including:
- Subject line: `Request for Lien Marking under Section 102 CrPC / IT Act, 2000 — Acknowledgement No(s): <list>`
- Reference to complaint Acknowledgement Numbers.
- Tabular list of accounts with bank, IFSC, A/c No, disputed amount.
- Statutory citation block.
- Officer signature block (configurable: name, designation, PS, contact).

**FR-28 — Officer Profile**
A one-time Officer Profile (name, rank, posting, phone, email, signature image path) is stored in `settings` table and merged into every letter.

**FR-29 — Letter Template Override**
The default letter template (`templates/lien_request.hbs`, Handlebars) shall be editable by the user via a Templates screen; reset-to-default button provided.

**FR-30 — Bank Address Book**
A local `banks.json` shipping with the app shall map IFSC prefix → bank nodal officer email/postal address (best-effort, editable). The user may override addresses per bank.

### 3.8 PDF Report Generator

**FR-31 — Professional Investigation Dossier**
A "Generate Investigation Report" action shall produce a PDF via PDFKit containing:
1. Cover page (case ack no, IO name, station, date).
2. Executive summary (auto-text from Key Findings, FR-41).
3. Complaint metadata table.
4. Layer analysis (chart image + table).
5. Top suspect accounts (mule list with scores + breakdowns).
6. Cashout analysis (mode breakdown + hotspot map).
7. Geography breakdown.
8. Timeline chart.
9. Recommended actions (auto-generated checklist).
10. Annexure: full transaction list (optional, IO toggles).
11. Annexure: lien worksheet.

**FR-32 — Chart Rasterization**
Recharts SVGs shall be rasterized to PNG at 2× DPI before embedding to keep the PDF crisp and the file size reasonable.

**FR-33 — Page Numbering, Header, Footer**
Every page shall carry: header = "FinTrace NCRP — Investigation Report — Ack No: `<n>`", footer = "Page X of Y · Generated <ISO timestamp> · For Official Use Only".

**FR-34 — PDF Size Guard**
If a generated PDF would exceed 50 MB, the system shall prompt to split the Annexure into a separate file.

### 3.9 Transaction Browser

**FR-35 — High-Density Filterable Table**
A TanStack Table view of all transactions for the selected complaint(s), with column-level filters (layer, bank, date range, amount range, payment mode, city, state, mule-score band, cashout flag).

**FR-36 — Virtualized Rendering**
Table shall virtualize rows (windowing) so 50,000-row datasets scroll at 60 fps on the target hardware.

**FR-37 — Saved Views**
IO shall save filter combinations as named views (`saved_views` table) for quick recall.

**FR-38 — CSV Export of Current View**
Exports respect active filters and column ordering.

### 3.10 Timeline View

**FR-39 — Daily Money Movement Chart**
A stacked area / bar chart (Recharts) plotting per-day total amount split by direction (`inbound to victim chain` vs `outbound / cashout`).

**FR-40 — Brush & Zoom**
The chart shall support brushed range selection that filters all other screens (cross-filter pattern).

**FR-41 — Event Annotations**
Markers shall annotate: complaint registration date, first cashout, hotspot ATM events.

### 3.11 Key Findings

**FR-42 — Auto-Generated Findings**
On complaint open the system shall produce a bulleted Key Findings list, each finding tagged `INFO | WATCH | ACTION`. Examples:
- `ACTION`: "Account `XXXXXX1234` (HDFC) scored 87 — recommend immediate lien request."
- `WATCH`: "Cashout concentrated at ATM ID `ABC1234` (Delhi NCR) — appears in 4 complaints."
- `INFO`: "Median forward-transfer time 12 minutes — consistent with mule layering."

**FR-43 — Recommended Actions Checklist**
A second list translates findings into IO action items (e.g., "Draft lien for Account X", "Request CCTV for ATM Y", "Cross-reference with NCRP Ack No Z"). Each item links to the relevant screen.

**FR-44 — Findings Persistence**
IO may mark findings as `acknowledged`, `acted_on`, or `dismissed`; state persists.

### 3.12 Geography View

**FR-45 — State/City Cashout Heatmap**
A choropleth-style India map (SVG, bundled — no tile server) shading states by total cashout amount. Drill-down to city-level bar chart.

**FR-46 — ATM Hotspot Markers**
Hotspot ATMs (FR-14) shall appear as pins on the map with tooltip (ATM ID, location, transactions, complaints).

**FR-47 — Geography Export**
Geography data exportable as CSV (state, city, txn_count, total_amount, distinct_atms).

---

## 4. Non-Functional Requirements

### 4.1 Performance
**NFR-01** Cold launch ≤ 3 seconds on Intel i3, 4 GB RAM, HDD (worst-case target hardware).
**NFR-02** Excel parse throughput ≥ 2,000 rows/sec on target hardware.
**NFR-03** UI shall remain responsive (input latency < 100 ms) while parsing 50,000-row files; achieved by running parse + DB writes in a Node worker thread and streaming progress to the renderer over IPC.
**NFR-04** Transaction Browser shall scroll a 50,000-row dataset at ≥ 60 fps.
**NFR-05** Mule scoring of 10,000 accounts shall complete in ≤ 5 seconds.
**NFR-06** PDF generation for a 5,000-row complaint shall complete in ≤ 10 seconds.

### 4.2 Reliability & Data Integrity
**NFR-07** SQLite shall run in WAL mode with `synchronous=NORMAL`; ingestion writes shall be wrapped in transactions of ≤ 1,000 rows.
**NFR-08** A power-loss / crash mid-import shall leave the database consistent; the partial upload shall be marked `status=failed` and importable rows shall be discarded (all-or-nothing per upload).
**NFR-09** Daily auto-backup: on app launch, if the DB has changed since last backup, copy `fintrace.sqlite` → `fintrace.backup-YYYYMMDD.sqlite` (retain last 7).

### 4.3 Security & Privacy
**NFR-10** Zero outbound network calls. Electron `session.webRequest.onBeforeRequest` shall block any request whose URL host is not `127.0.0.1` or `localhost`.
**NFR-11** Express server shall bind to `127.0.0.1` only (never `0.0.0.0`).
**NFR-12** Renderer context isolation enabled; `nodeIntegration: false`; preload script exposes a narrow typed IPC surface via `contextBridge`.
**NFR-13** No telemetry, no auto-update pings, no crash-reporter network sinks.
**NFR-14** Database file shall live under `%APPDATA%\FinTraceNCRP\` (per-Windows-user, not world-readable by default).
**NFR-15** Generated PDFs and `.eml` drafts shall carry "For Official Use Only" footers.

### 4.4 Usability
**NFR-16** Primary tasks (upload → view findings → draft emails → export PDF) reachable within 3 clicks from the dashboard.
**NFR-17** All destructive actions (delete upload, reset lien status) require a confirmation modal.
**NFR-18** Keyboard navigation supported on tables (arrow keys, `f` to focus filter, `Ctrl+E` to export).
**NFR-19** Number formatting shall use Indian conventions (`1,23,45,678`) and currency `₹`.
**NFR-20** Dates displayed in `DD-MMM-YYYY HH:mm IST`.

### 4.5 Portability & Deployment
**NFR-21** A single signed `FinTraceNCRP-Setup-<version>.exe` installer (NSIS via `electron-builder`) ≤ 200 MB.
**NFR-22** Per-machine and per-user install modes both supported; per-user is default to avoid requiring admin rights.
**NFR-23** Windows 10 (1809+) and Windows 11 supported. No 32-bit build.
**NFR-24** Uninstaller leaves `%APPDATA%\FinTraceNCRP\` intact by default (officer data preserved); a "remove all data" checkbox is offered.

### 4.6 Maintainability
**NFR-25** Code split: `/main` (Electron main), `/preload`, `/renderer` (React), `/server` (Express + parsing + scoring), `/shared` (types, constants). Strict TypeScript across the board.
**NFR-26** All scoring weights, header synonyms, bank address book, and letter templates shall be data-driven (JSON / Handlebars), not compiled.
**NFR-27** Unit-test coverage targets: parser ≥ 85%, scoring ≥ 90%, formatters ≥ 80%.
**NFR-28** Logs go to `%APPDATA%\FinTraceNCRP\logs\fintrace-YYYY-MM-DD.log` (rolling, 14-day retention). No PII in logs beyond ack numbers.

### 4.7 Accessibility (Best-Effort)
**NFR-29** Color is never the sole carrier of meaning (icons + text accompany colour states).
**NFR-30** WCAG AA contrast on primary screens.

### 4.8 Internationalization
**NFR-31** All UI strings live in `i18n/en-IN.json`. Hindi (`hi-IN.json`) is a planned secondary locale (not required for v1).

---

## 5. User Roles & Personas

### 5.1 Roles
This is a **single-user offline tool**. There is no authentication and no role-based access control. The application runs under the Windows account of whoever launched it. "Roles" below are **personas** that describe usage patterns, not enforced privileges.

### 5.2 Personas

**Persona A — Sub-Inspector Ravi (Primary IO)**
- Age 32, 6 years in service, 1 year in Cyber Crime Cell.
- Handles 4–8 active NCRP complaints per week.
- Comfortable with Excel; uneasy with command lines.
- Hardware: station-issued Lenovo, Windows 10, 4 GB RAM, HDD.
- Pain: spends 2–3 hours per case manually correlating Excel rows; misses cross-case patterns.
- Success looks like: opens FinTrace, drops the Excel, gets a PDF + lien drafts in under 10 minutes.

**Persona B — Inspector Meena (Reviewing Officer)**
- Reviews 20–30 IO reports per week before sign-off.
- Wants a consistent, signed PDF format she can skim.
- Doesn't run the tool herself — receives PDFs and `.eml` drafts from IOs.

**Persona C — Cyber Crime Cell Head**
- Strategic view: which mule accounts / ATM hotspots recur across the station's cases?
- Periodically opens the Repeat Accounts Registry and Geography View on the senior-most IO's machine to spot patterns.

**Persona D — Nodal Officer at Bank (Indirect)**
- Receives the lien-request email drafted by FinTrace.
- Not a user, but the **format and tone of the generated letter must satisfy them** — wrong format → bank rejects → complaint goes cold.

### 5.3 Anti-Persona
**Not for**: civilians, complainants, journalists, external researchers. The tool consumes NCRP exports that are restricted-use; it is not a public utility.

---

## 6. Use Cases

Each use case follows: **Actor · Trigger · Preconditions · Main Flow · Alternate / Exception Flow · Postconditions / Outcome**.

### UC-01 — Import a New NCRP Excel File
- **Actor:** IO (Persona A)
- **Trigger:** IO has downloaded `BankAction_CompleteTrail_<ackno>.xlsx` from the NCRP portal.
- **Preconditions:** FinTrace launched; Dashboard visible.
- **Main flow:**
  1. IO clicks "Upload" or drags the file onto the dashboard drop zone.
  2. System computes SHA-256, checks for duplicate (FR-05).
  3. System auto-detects headers (FR-02), streams rows into SQLite (FR-03) with a progress bar.
  4. On completion, shows import summary: `<imported>` / `<quarantined>` rows, new repeat-account matches (FR-25).
  5. IO clicks "Open Case" to land on the per-complaint dashboard.
- **Alternate flows:**
  - 2a. Duplicate file → modal offering Cancel / Proceed (skip duplicates by Ack+UTR).
  - 3a. Header detection fails → IO is shown a manual mapping screen.
  - 3b. Some rows quarantined → summary lists reasons; IO can export quarantined rows for fixing.
- **Outcome:** Complaint(s) ingested; upload recorded in history; user lands on per-complaint dashboard.

### UC-02 — Review Layer Analysis for a Complaint
- **Actor:** IO
- **Trigger:** IO opens a complaint.
- **Preconditions:** Complaint imported.
- **Main flow:**
  1. IO navigates to Layer Analysis tab.
  2. System renders Sankey flow chart (FR-10) and per-layer aggregate table (FR-08).
  3. IO clicks Layer 2 node.
  4. System navigates to Transaction Browser pre-filtered to Layer 2 (FR-09).
- **Outcome:** IO understands fund flow Layer 0 → N at a glance.

### UC-03 — Identify Mule Accounts
- **Actor:** IO
- **Trigger:** IO opens "Suspect Accounts" view.
- **Preconditions:** ≥ 1 complaint imported.
- **Main flow:**
  1. System displays all accounts with `mule_score ≥ 60`, sorted descending.
  2. IO clicks an account → side panel shows score breakdown (FR-16): pass-through 28/30, cashout speed 18/20, etc.
  3. IO clicks "View transactions" → Transaction Browser filtered to this account.
  4. IO returns and tags the account `confirmed_mule` (FR-18).
- **Alternate flow:** IO adjusts threshold slider (40–80) to widen/narrow the suspect list.
- **Outcome:** Confirmed-mule tag persisted; account flagged across all screens with a badge.

### UC-04 — Draft Lien-Request Emails for All Banks
- **Actor:** IO
- **Trigger:** IO clicks "Draft Lien Emails" from Lien Tracker.
- **Preconditions:** Officer Profile filled in (FR-28); ≥ 1 account flagged for lien.
- **Main flow:**
  1. System groups flagged accounts by IFSC → bank (FR-26).
  2. System renders the per-bank letters using the active template (FR-27, FR-29), merging Officer Profile and bank nodal address (FR-30).
  3. IO previews each letter, edits inline if needed.
  4. IO clicks "Save to folder" → system writes `.eml` files into a user-chosen folder.
  5. IO opens Outlook/Thunderbird, double-clicks each `.eml`, reviews, and sends.
- **Alternate flows:**
  - 2a. Bank address unknown → letter is still drafted; recipient field marked `<TO BE FILLED>` and the Bank Address Book editor opens for inline correction.
  - 3a. IO edits the master template → option to save changes back to the template.
- **Outcome:** A folder of ready-to-send `.eml` drafts; no email is sent by FinTrace itself.

### UC-05 — Generate the Investigation PDF Dossier
- **Actor:** IO
- **Trigger:** IO clicks "Generate Report".
- **Preconditions:** Complaint imported; Officer Profile filled in.
- **Main flow:**
  1. IO chooses options: include full transaction annexure? include lien worksheet? cover-page case notes?
  2. System rasterizes charts (FR-32) and assembles the PDF via PDFKit (FR-31).
  3. Progress bar shows section-by-section progress.
  4. PDF saves to user-chosen path; "Open" button revealed.
- **Alternate flows:**
  - 2a. PDF size > 50 MB projected → prompt to split annexure (FR-34).
- **Outcome:** Submission-ready PDF on disk.

### UC-06 — Cross-Reference Repeat Account Across Complaints
- **Actor:** Cyber Crime Cell Head (Persona C) or IO
- **Trigger:** Opens Repeat Account Registry.
- **Preconditions:** ≥ 2 complaints imported.
- **Main flow:**
  1. System lists every account appearing in ≥ 2 complaints, sorted by total disputed amount across complaints.
  2. User clicks an account.
  3. Detail panel shows all linked complaints with ack numbers, dates, disputed amounts, current lien status (FR-24).
  4. User clicks a complaint ack number → drills into that complaint.
- **Outcome:** Cross-case pattern visible; user can initiate a consolidated lien request.

### UC-07 — Filter Transactions by Multiple Criteria
- **Actor:** IO
- **Trigger:** IO opens Transaction Browser.
- **Preconditions:** Complaint imported.
- **Main flow:**
  1. IO applies filters: Layer = 2, Bank = "HDFC", Amount ≥ ₹50,000, Date range = last 14 days, Cashout flag = true.
  2. System updates virtualized table (FR-36) in real time.
  3. IO saves the view as "HDFC L2 cashouts" (FR-37).
  4. IO clicks Export CSV (FR-38) → CSV honoring filters saved to disk.
- **Outcome:** Focused dataset isolated and saved.

### UC-08 — View Day-by-Day Timeline & Cross-Filter
- **Actor:** IO
- **Trigger:** IO opens Timeline View.
- **Preconditions:** Complaint imported.
- **Main flow:**
  1. System renders daily inbound/outbound stacked bars (FR-39) with markers for complaint date, first cashout (FR-41).
  2. IO brushes the 3 days around the complaint date (FR-40).
  3. All other open screens (Layer, Cashout, Transaction Browser) re-filter to the brushed range.
- **Outcome:** Focused temporal window applied across the workspace.

### UC-09 — Review Key Findings & Acknowledge Recommended Actions
- **Actor:** IO
- **Trigger:** IO opens a complaint.
- **Preconditions:** Complaint imported.
- **Main flow:**
  1. System displays auto-generated Key Findings (FR-42) at the top of the complaint dashboard.
  2. IO reads `ACTION`-tagged items.
  3. IO marks "Draft lien for HDFC accounts" as `acted_on` (FR-44); badge changes to ✅.
- **Outcome:** Findings status tracked, surfaced in the next PDF report's "Actions Taken" section.

### UC-10 — Geography Drill-Down on Cashout Hotspots
- **Actor:** Cyber Crime Cell Head
- **Trigger:** Opens Geography View.
- **Preconditions:** ≥ 1 complaint imported.
- **Main flow:**
  1. System renders India choropleth (FR-45) shaded by total cashout amount.
  2. User clicks Delhi → drills to city/area-level bar chart and ATM hotspot pins (FR-46).
  3. User clicks an ATM pin → tooltip shows ATM ID, complaints involved, transactions.
  4. User clicks "Export geography CSV" (FR-47).
- **Outcome:** Hotspot intelligence for CCTV / field-team coordination.

### UC-11 — Recover from Mid-Import Crash
- **Actor:** IO (Persona A)
- **Trigger:** Power outage during a 40,000-row import.
- **Preconditions:** Import was in progress.
- **Main flow:**
  1. IO restarts FinTrace.
  2. App detects orphaned `upload` row with `status=in_progress`, marks it `failed`, rolls back any partial rows (NFR-08).
  3. Upload History shows the failed entry with reason.
  4. IO retries the upload; succeeds.
- **Outcome:** Database consistent; no half-imported complaint.

### UC-12 — First-Run Setup
- **Actor:** IO (first time)
- **Trigger:** First launch after installation.
- **Preconditions:** App installed.
- **Main flow:**
  1. App detects no Officer Profile → opens Setup wizard.
  2. IO fills name, rank, posting, phone, email, signature image (optional).
  3. IO confirms backup folder location (default `%APPDATA%\FinTraceNCRP\backups\`).
  4. IO sees a 30-second "What can FinTrace do?" tour (skippable).
- **Outcome:** App ready for first upload.

---

## 7. Data Dictionary

### 7.1 NCRP Source Columns (as found in Excel exports)

| Source Column (canonical) | Synonyms / Variants | Internal Field | Type | Nullable | Description |
|---|---|---|---|---|---|
| Acknowledgement No | Ack No, Complaint Number, NCRP No | `ack_no` | TEXT (12–20 chars) | No | Unique NCRP complaint ID. Primary correlation key across files. |
| Complaint Date | Date of Complaint, Reg Date | `complaint_date` | DATETIME (IST) | No | When the victim filed the complaint. |
| Victim Account No | Complainant A/c, Victim A/C No | `victim_account_no` | TEXT | Yes | Account the funds were debited from. Often partially masked. |
| Victim Bank | Complainant Bank, Source Bank | `victim_bank` | TEXT | Yes | Bank holding the victim account. |
| Beneficiary A/C | Beneficiary Account No, Recipient A/C | `beneficiary_account_no` | TEXT | No | Account receiving funds at this layer. |
| Beneficiary Bank | Receiving Bank, Bene Bank | `beneficiary_bank` | TEXT | Yes | Bank holding the beneficiary account. |
| Beneficiary Name | Recipient Name, A/C Holder Name | `beneficiary_name` | TEXT | Yes | KYC name on the beneficiary account. Frequently fake / mule-network alias. |
| IFSC Code | IFSC, Bene IFSC | `ifsc_code` | TEXT (11 chars) | Yes | IFSC of beneficiary account; first 4 chars = bank code. |
| Transaction Date | Txn Date, Date & Time | `txn_date` | DATETIME (IST) | No | Timestamp of the bank transaction. |
| Transaction Amount | Txn Amount, Amount, Amount (INR) | `txn_amount` | DECIMAL(18,2) | No | INR amount of this transaction. |
| Disputed Amount | Fraud Amount, Disputed Value | `disputed_amount` | DECIMAL(18,2) | Yes | Portion contested by the victim. ≤ Transaction Amount. |
| UTR/Reference No | UTR, RRN, Transaction Ref No | `utr_ref` | TEXT | Yes | Bank-side transaction reference. Together with Ack No, used for dedupe. |
| Payment Mode | Mode, Channel | `payment_mode` | TEXT (enum-ish) | Yes | NEFT / IMPS / UPI / RTGS / ATM / POS / WALLET / OTHER. |
| Layer No | Layer, Hop | `layer_no` | INTEGER | Yes | Distance from victim (0 = victim, 1+ = downstream). Inferred if missing. |
| ATM ID | ATM Code, Terminal ID | `atm_id` | TEXT | Yes | ATM terminal identifier when payment_mode involves cash withdrawal. |
| ATM Location | ATM Address | `atm_location` | TEXT | Yes | Free-text ATM location. |
| City | Txn City | `city` | TEXT | Yes | City of transaction / ATM / merchant. |
| State | Txn State | `state` | TEXT | Yes | State of transaction. |
| Remarks | Narration, Description | `remarks` | TEXT | Yes | Narration string; mined for merchant / MCC clues. |

### 7.2 Derived / Internal Fields (computed at ingest or analysis time)

| Field | Type | Description |
|---|---|---|
| `txn_id` | INTEGER PK | Surrogate transaction id. |
| `complaint_id` | INTEGER FK | Surrogate complaint id. |
| `account_id` | INTEGER FK | Surrogate account id (unique on `(beneficiary_account_no, ifsc_code)`). |
| `same_day_cashout` | BOOLEAN | FR-12. |
| `cashout_mode` | TEXT enum | FR-11. |
| `cashout_speed_minutes` | INTEGER | FR-13 (per account). |
| `hotspot` | BOOLEAN | FR-14 (per ATM). |
| `mule_score` | INTEGER 0–100 | FR-15. |
| `mule_score_components` | JSON | Per-signal breakdown for FR-16. |
| `recoverable_amount` | DECIMAL(18,2) | FR-19. |
| `lien_status` | TEXT enum | FR-20. |
| `account_tags` | TEXT (csv) | FR-18 (`confirmed_mule`, `cleared`, `under_review`). |
| `imported_at` | DATETIME | UTC timestamp of row ingest. |
| `source_upload_id` | INTEGER FK | Which upload produced this row. |

### 7.3 Tables (logical)

`uploads`, `complaints`, `accounts`, `transactions`, `quarantined_rows`, `account_tags`, `lien_status_history`, `findings`, `findings_state`, `saved_views`, `settings`, `templates`, `banks` (address book).

---

## 8. UI Screen Inventory

| # | Screen | Purpose | Primary FRs |
|---|---|---|---|
| S-01 | **First-Run Setup Wizard** | Capture Officer Profile, backup location. | FR-28, UC-12 |
| S-02 | **Global Dashboard** | Entry point. Recent uploads, KPIs (total complaints, suspect accounts, pending liens), prominent drag-drop. | UC-01 |
| S-03 | **File Upload** | Drag-drop zone, header preview, dedupe modal, progress bar. | FR-01–06 |
| S-04 | **Upload History** | List of all imports, status, row counts, re-open / re-export. | FR-04 |
| S-05 | **Per-Complaint Dashboard** | Header strip (ack no, victim, dates, totals) + Key Findings + tab nav. | FR-42, UC-09 |
| S-06 | **Layer Analysis** | Sankey/flow chart + per-layer aggregate table. | FR-07–10 |
| S-07 | **Cashout Detection** | Mode breakdown, same-day flags, cashout-speed quartiles. | FR-11–14 |
| S-08 | **Mule / Suspect Accounts** | Sorted table + threshold slider + breakdown side-panel. | FR-15–18 |
| S-09 | **Lien Tracker** | Per-account recoverable amount, status lifecycle, aging colours. | FR-19–22 |
| S-10 | **Repeat Account Registry** | Cross-complaint matches, detail drill-in. | FR-23–25 |
| S-11 | **Draft Emails (Lien Letters)** | Per-bank letter previews, edit, save `.eml`. | FR-26–30 |
| S-12 | **PDF Report Preview** | Section toggles, generate, open. | FR-31–34 |
| S-13 | **Transaction Browser** | Virtualized filterable table, saved views, CSV export. | FR-35–38 |
| S-14 | **Timeline View** | Daily flow chart, brush, annotations. | FR-39–41 |
| S-15 | **Geography View** | India choropleth, city drill, ATM pins. | FR-45–47 |
| S-16 | **Key Findings** | Findings list with action checklist (also embedded in S-05). | FR-42–44 |
| S-17 | **Templates Editor** | Edit Handlebars letter template; reset to default. | FR-29 |
| S-18 | **Bank Address Book** | Edit IFSC-prefix → nodal officer entries. | FR-30 |
| S-19 | **Officer Profile** | Edit name, rank, posting, signature image. | FR-28 |
| S-20 | **Settings** | Backup folder, log retention, mule weights, threshold defaults, language. | NFR-09, NFR-26 |
| S-21 | **About / For Official Use Only** | Version, build hash, offline-mode confirmation indicator. | NFR-10 |

---

## 9. Out of Scope

The following are **explicitly not** in scope for v1 to keep the boundary clean:

1. **NCRP portal API integration** — the portal has no public API; tool is import-only.
2. **Direct email sending** — only `.eml` drafts; user sends via their mail client.
3. **Multi-user, multi-station sync** — no server, no cloud.
4. **Authentication / role-based access control** — single-user offline tool.
5. **Audit log of every UI click** — only state-changing actions are logged.
6. **OCR of scanned bank statements / FIRs** — only structured Excel input.
7. **PDF parsing of NCRP printouts** — Excel only.
8. **Machine-learning models** — mule scoring is explainable, rule + weight-based (no opaque ML in v1).
9. **Live integration with bank Core Banking Systems** — out of legal scope for a station-level tool.
10. **Mobile app, web app, browser extension** — desktop only.
11. **Hindi / regional language UI** — v1 ships `en-IN` only; localization plumbing present.
12. **Auto-update mechanism** — distribution is via signed installers handed out by the cell; no internet-fetch updater.
13. **Cryptocurrency / blockchain trail** — beneficiary chain is bank-rail only.
14. **CDR (Call Detail Records) ingestion / IPDR correlation** — adjacent toolset, separate roadmap.
15. **Integration with CCTNS / I4C dashboards** — exports (CSV/PDF) only.

---

## 10. Assumptions & Constraints

### 10.1 Assumptions
**A-01** NCRP Excel exports remain broadly schema-stable (column names may vary but the underlying fields persist). Header synonym map handles drift.
**A-02** The IO has the authority to download NCRP exports for their assigned complaints and to store them locally on the station PC.
**A-03** Each NCRP `BankAction CompleteTrail` file pertains to one or more related Ack Nos; the file is the authoritative trail snapshot at download time.
**A-04** Disputed Amount, when present, never exceeds Transaction Amount. (Validator flags violations as quarantined.)
**A-05** Timestamps in the Excel are India Standard Time (IST). Tool will normalize without timezone conversion.
**A-06** Officers have their own email client (Outlook/Thunderbird) configured for sending lien letters.
**A-07** Bank IFSC → nodal officer mapping ships as best-effort and the IO is expected to verify before sending.
**A-08** Police PCs have Windows 10 (1809+) or Windows 11, x64, ≥ 4 GB RAM, ≥ 1 GB free disk.
**A-09** Station's IT policy permits installation of signed third-party `.exe` (per-user mode, no admin rights).
**A-10** Mule scoring weights chosen here are sensible defaults; the cell's senior officer may tune them in `config/mule_weights.json` over time.

### 10.2 Constraints
**C-01 (Legal/Procedural)** Lien requests must cite Section 102 CrPC and the IT Act, 2000. Letter template enforces this.
**C-02 (Compliance)** No PII or case data may leave the local machine. Telemetry strictly forbidden.
**C-03 (Hardware)** Must operate within 4 GB RAM; peak working set target ≤ 1 GB during 50k-row imports.
**C-04 (Disk)** Total app footprint (installer + runtime data for 10 cases) ≤ 1 GB.
**C-05 (Distribution)** Installer must be code-signed; SmartScreen warnings on first run are a procurement blocker and must be planned for.
**C-06 (Format Fidelity)** The PDF report and `.eml` letter formats must be acceptable to bank nodal officers and to senior reviewing officers — format changes require sign-off from a designated cell SME, not just engineering.
**C-07 (Determinism)** All scoring, ranking, and aggregation must be deterministic given the same input data (no nondeterministic ML, no time-based randomization).
**C-08 (No Background Network)** Even diagnostic / "phone home" features are prohibited. Offline status indicator on S-21 is a visible reassurance.
**C-09 (Backwards Compatibility of Data)** Schema migrations must preserve all imported data; downgrade is not required, but upgrades must never drop case data.
**C-10 (Single-Threaded SQLite)** `better-sqlite3` is synchronous and single-threaded. All heavy DB work must run inside the Node main process (or worker), never on the renderer.

---

## Appendix A — Glossary

| Term | Meaning |
|---|---|
| NCRP | National Cyber Crime Reporting Portal (cybercrime.gov.in). |
| Ack No | NCRP Acknowledgement Number — unique complaint ID. |
| Layer | Hop distance from the victim account in the money trail. |
| Mule Account | An account used to receive and forward fraud proceeds, usually with low KYC integrity. |
| Lien | A bank-applied hold on funds in an account pending investigation outcome. |
| IFSC | Indian Financial System Code, 11-character bank-branch identifier. |
| UTR | Unique Transaction Reference. |
| I4C | Indian Cyber Crime Coordination Centre (MHA). |
| RBI | Reserve Bank of India. |
| IO | Investigating Officer. |
| PS | Police Station. |
| CrPC | Code of Criminal Procedure (Section 102 empowers seizure of property). |
| IT Act, 2000 | Information Technology Act — primary cybercrime statute. |

## Appendix B — Header Synonym Examples (illustrative subset)

```json
{
  "ack_no": ["Acknowledgement No", "Ack No", "Complaint Number", "NCRP No"],
  "txn_amount": ["Transaction Amount", "Txn Amount", "Amount", "Amount (INR)"],
  "beneficiary_account_no": ["Beneficiary A/C", "Beneficiary Account No", "Recipient A/C"],
  "ifsc_code": ["IFSC Code", "IFSC", "Bene IFSC"],
  "utr_ref": ["UTR/Reference No", "UTR", "RRN", "Transaction Ref No"]
}
```

## Appendix C — Mule Score Worked Example

Account `XXXX1234` @ HDFC, complaint Ack `12345678901234`:
- Inbound ₹2,00,000 across 3 credits; Outbound ₹1,90,000 across 5 debits → pass-through ratio 0.95 → **30 / 30**.
- Median credit→debit gap 18 min → cashout speed → **18 / 20**.
- 12 transactions in this complaint → log-scaled → **12 / 15**.
- Appears in 2 other Ack Nos → **13 / 20**.
- Transactions span Delhi, Mumbai, Bengaluru (3 cities) → **7 / 10**.
- Beneficiary name varies "RAJ KUMAR" / "R KUMAR" / "RAJU K" → **4 / 5**.
- **Total: 84 / 100** → surfaces in Top Suspect Accounts; ACTION-tagged finding generated.

---

*End of SRS v1.0 — FinTrace NCRP*
