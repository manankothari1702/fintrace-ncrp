# FinTrace NCRP — Tender Compliance Audit

**Tender:** Rajasthan Police HQ, Jaipur — "Financial Fund Trail Analysis Tool" (परिशिष्ट-ई, 12 licenses, cyber crime police stations)
**Audited codebase:** FinTrace NCRP v0.4.0, `main` @ `5a9febf` (2026-07-07)
**Method:** every requirement verified against actual code (file:line evidence), not docs/plans. Nine parallel deep-dive audits: bank-statement module, search, multi-case/case management, auth/security/backups, Hindi/i18n, performance/scale, NCRP import, report types, mule detection/network analysis.
**Statuses:** DONE = works end to end · PARTIAL = some exists, gap stated · SCAFFOLD = UI/stubs only · MISSING = nothing addresses it · N-A = assumes data/infrastructure we don't receive (raise as bid clarification)
**Effort tiers:** S = days · M = 1–2 weeks · L = 3+ weeks · `?` = uncertain

> **Honest headline.** FinTrace today is a hardened, well-validated **single-user, single-complaint NCRP forensic analyzer** — the NCRP import pipeline, layer/cash-out/mule analysis, and the dossier/Excel exports are genuinely strong and byte-validated against gold cases. But the tender describes an **investigation management platform**: multi-format bank-statement ingestion with OCR, multi-user RBAC, case management, cross-case intelligence with alerts, bilingual UI, and 1M-transaction scale. Roughly 40% of tender clauses have nothing behind them today, and 5 of the ~12 acceptance-checklist items would fail outright as things stand.

---

## 1. Summary table

| Spec section | Total clauses | DONE | PARTIAL | SCAFFOLD | MISSING | N-A / Clarify |
|---|---|---|---|---|---|---|
| 1. Scope & Purpose | 2 | 0 | 2 | 0 | 0 | 0 |
| 2. Data Import & Format Compatibility | 20 | 5 | 4 | 2 | 6 | 3 |
| 3. Mule Account Analysis & Detection | 24 | 8 | 6 | 0 | 8 | 2 |
| 4. Financial Analysis & Investigation | 22 | 5 | 7 | 0 | 10 | 0 |
| 5. Reporting & Case Management | 14 | 0 | 5 | 0 | 9 | 0 |
| 6. Technical Requirements | 13 | 2 | 3 | 0 | 7 | 1 |
| 7. Training / Support / Vendor (code-relevant) | 9 | 0 | 1 | 0 | 3 | 5 |
| **Total** | **104** | **20 (19%)** | **28 (27%)** | **2 (2%)** | **43 (41%)** | **11 (11%)** |

Note: the spec repeats a few requirements across sections (multi-complaint linking appears in §2 and §5; RBAC in §5 and §6). Each occurrence is counted where the spec states it; statuses are consistent.

---

## 2. Clause-by-clause matrix

### Section 1 — Scope & Purpose

| # | Requirement | Status | Evidence | Gap | Effort |
|---|---|---|---|---|---|
| 1.1 | Comprehensive financial analysis **and investigation management** system for NCRP complaints | PARTIAL | Analysis engine: `backend/src/analyzers/analyzer.js` (3,113 lines, ~20 modules); dossier: `backend/src/utils/pdfGenerator.js` | Analysis half is real; the investigation-management half (cases, statuses, tasks, multi-user) does not exist — see §5 rows | L |
| 1.2 | Operable by police with average computer literacy after minimal training | PARTIAL | Guided single workflow (upload → dashboard), plain-language `suspicion_reasons` (`analyzer.js:936-1049`, rendered `Mules.jsx:236-255`), Glossary sheet in Excel (`excelGenerator.js`), masked accounts | English-only UI; no in-app help; usability never tested with target users | M? |

### Section 2 — Data Import & Format Compatibility

| # | Requirement | Status | Evidence | Gap | Effort |
|---|---|---|---|---|---|
| 2.1 | Bank statement import from all banks in India (PDF text-based) | SCAFFOLD | `frontend/src/modules/bankStatement/` — Upload page never reads file bytes (`Upload.jsx:10`), stub API "No backend exists for this module yet" (`utils/api.js:5,12`), detection = filename substring over 6 hardcoded banks (`mockData.js:92-108`) | Zero backend routes, zero DB tables, zero parsing code anywhere in repo. SRS explicitly lists this out of scope (`SRS.md:626-627`) | L |
| 2.2 | Scanned-PDF OCR with ≥90% accuracy | MISSING | No OCR dependency (tesseract etc. absent from all 3 package.json) | Nothing to build on; accuracy target untestable until engine exists | L? |
| 2.3 | XLS/XLSX/CSV bank-statement ingestion | MISSING | `xlsx` (SheetJS) present but only used for NCRP CompleteTrail parsing (`ncrpParser.js:1338`) and report generation | No bank-statement parser, no per-bank format handling | L |
| 2.4 | Batch/folder import, mixed formats, auto format detection, bank identification, sequential processing with progress | SCAFFOLD | Bank-ID "detection chips" are mock (`mockData.js:101-108`); NCRP upload is strictly single-file (`multer .single`, `routes/ncrp.js:446-458`; single-file input `pages/Upload.jsx:117,318`) | No folder upload, no multi-file queue, no real detection. Real upload progress bar exists for the one NCRP file (`api.js:99-103`) | M (after 2.1–2.3) |
| 2.5 | Detailed per-file import log (success/failure + specific error descriptions) | MISSING | Nearest: `audit_log` rows `upload.ingested`/`analysis.complete`/`analysis.error` per report (`routes/ncrp.js:571-597,763`) | No batch-import log table or screen; per-file error log needs the batch flow first | S–M |
| 2.6 | Direct import of NCRP portal exports — Excel | DONE | Full 7-sheet CompleteTrail pipeline: `parsers/ncrpParser.js` (channel sheets `537-550`, header scan `896-912`, per-sheet column maps `1402-1404`); fail-loud required columns (`1471-1496`); 3-tier header matching incl. fuzzy ≥85% (`parseFuzzy.js:52-62`) | — (CSV variant is row 2.7) | — |
| 2.7 | Direct import of NCRP portal exports — CSV | MISSING | Blocked by triple gate: extension allow-list (`routes/ncrp.js:84`), MIME list (`:90-94`), Excel magic-bytes check (`:231-254`) | SheetJS could parse CSV; gates + parser entry need extension | S |
| 2.8 | Auto-extract complaint ID, fraud date, fraud amount, suspect account numbers | DONE | `ack_no` synonyms (`config/header_synonyms.json:2-13`), `complaint_date` (`:14-18`), `disputed_amount` (`:133-146`), `beneficiary_account` (`:51-63`); cross-sheet cash-out join (`ncrpParser.js:1114-1118`) | — | — |
| 2.9 | Auto-extract victim details | PARTIAL | `victim_account`, `victim_bank` (`header_synonyms.json:19-50`) | **No victim name** captured; no victim contact fields | S? |
| 2.10 | Auto-extract UPI IDs and phone numbers | MISSING | No UPI/VPA/phone column mapping or regex anywhere in parser | Also a data question — the CompleteTrail exports we receive don't carry these columns (see Clarifications #3) | S–M? |
| 2.11 | Create case files linked to NCRP complaint IDs | PARTIAL | Each upload becomes an `ncrp_reports` row carrying `ack_no` via its transactions (`routes/ncrp.js:407-412`) | No case entity distinct from an upload; re-upload of same file silently creates a duplicate report (sha256 stored `:704-708` but never used to dedupe) | M |
| 2.12 | Link multiple NCRP complaints to a single investigation (same mule network) | MISSING | `findReportsByAckNo` (`db/queries.js:329-332`) exists but only powers a "source file changed" warning (`routes/ncrp.js:723-741`) | No investigation/grouping entity of any kind | M (needs case entity) |
| 2.13 | Mandatory field: transaction date | DONE | `header_synonyms.json:94-105`; robust `parseDate` (Excel serials, DD/MM/YYYY, 2-digit years, AM/PM — `ncrpParser.js:431-499`) | — | — |
| 2.14 | Mandatory field: value date | N-A | No such column exists in NCRP CompleteTrail format (no synonym, no canonical field) | Bank-statement concept — raise as clarification #2 | — |
| 2.15 | Mandatory field: description/narration | DONE | `remarks` canonical field (`header_synonyms.json:205-210`) → `ncrp_transactions.remarks` (`schema.js:85`) | (Not searchable — see 4.10) | — |
| 2.16 | Mandatory fields: separate debit amount / credit amount | N-A | CompleteTrail carries one amount per channel row; direction is implicit in the sheet (transfer/withdrawal/hold). "Debit Amount" maps to the single amount (`header_synonyms.json:125`) | Bank-statement concept — clarification #2 | — |
| 2.17 | Mandatory field: running balance | N-A | No such column in NCRP format | Bank-statement concept — clarification #2 | — |
| 2.18 | Mandatory field: reference number | DONE | `utr_no` (UTR/RRN/Transaction Id synonyms, `header_synonyms.json:147-158`) | — | — |
| 2.19 | Intelligent narration parsing (UPI IDs, phones, NEFT/IMPS acct+IFSC, beneficiary names, ATM locations, merchant names) | PARTIAL | Two narrow fallbacks: rail keyword detection UPI/IMPS/NEFT/RTGS in remarks (`ncrpParser.js:676-686`); ATM `Terminal ID`/`Card acceptor name` extraction (`:720-734`). Names/accounts/IFSC/merchant arrive as structured columns, not narration | No UPI-ID/phone/beneficiary-account extraction from free text (mostly a bank-statement-era need) | M? |
| 2.20 | Normalization: YYYY-MM-DD dates, numeric amounts w/ debit-credit flags, standardized account numbers & IFSC | PARTIAL | Dates → full ISO-8601 UTC (superset of spec, `parseDate`); amounts strip ₹/INR/commas/`/-` (`ncrpParser.js:285-315`); IFSC canonicalized + **IFSC-authoritative bank resolution** with audit flags (`lib/ifscBankResolver.js:253-307`) | No debit/credit flags (see 2.16); account standardization is trim-only (`trimOrNull`), canonicalization only at analysis time | S |

### Section 3 — Mule Account Analysis & Detection

| # | Requirement | Status | Evidence | Gap | Effort |
|---|---|---|---|---|---|
| 3.1 | Automatic mule identification with risk scores 0–100 | PARTIAL | `muleDetection` (`analyzer.js:924-1061`) + `config/mule_weights.json`; validated 28/28 vs gold (`backend/scripts/accuracy_test.js`); HIGH ≥70 / MEDIUM ≥40 bands (`analyzer.js:102-103`) | Score is deliberately **uncapped above 100** (`analyzer.js:909-912,1023-1025` — CypherSOL parity); only 2 of the 7 spec indicators fully implemented (rows 3.2–3.8) | S (cap/display) |
| 3.2 | Indicator: number of incoming sources | DONE | `fanIn` bonus ≥2 senders (`analyzer.js:999-1002`) + graduated `inDegreeCollector` per extra sender (`:1003-1013`) | — | — |
| 3.3 | Indicator: transaction velocity (0–72h turnover) | PARTIAL | Forward-speed weight 20, full ≤4h decaying to 0 at 24h (`analyzer.js:952-963`, consts `:107-108`); txn-count weight 15 (`:965-967`) | Spec band is 72h; ours zeroes at 24h — window/decay mismatch | S |
| 3.4 | Indicator: account age vs activity | N-A | No account-opening/age data in any input (`schema.js:64-93`) | Requires bank KYC data we don't receive — clarification #4 | — |
| 3.5 | Indicator: round-figure transaction patterns | MISSING | No round-amount detection anywhere in `backend/src` | Straightforward to add on existing rollup | S |
| 3.6 | Indicator: geographic anomalies | DONE | `geoSpread` weight 10 — cash-out outside home state (`analyzer.js:974-980`) | — | — |
| 3.7 | Indicator: minimal balance maintenance | PARTIAL | Proxied by `passThrough` ratio ≥0.8 weight 30 (`analyzer.js:939-950`) and `highCashoutRatio` ≥90% (`:1014-1017`); residual `gross_balance` computed for liens (`:833-843`) but not fed to score | True balance-maintenance needs statement balances (we have none); proxy is defensible — clarify | S? |
| 3.8 | Indicator: weak KYC documentation | PARTIAL | `kycVariance` weight 5 — inconsistent name/bank/IFSC across an account's rows (`analyzer.js:982-985`) | Identity-variance proxy only; no KYC-quality data exists — clarification #4 | — |
| 3.9 | Complete money-flow visualization victim → layers → beneficiaries | PARTIAL | Layer-aggregated Sankey (`buildLayerFlows` `analyzer.js:1646-1688`; `MoneyFlow.jsx:169-230`); true node-link diagram only as static PNG in PDF (`charts.js:169-337`) | No account-level interactive graph; account edges shown only as top-10 table (`analyzer.js:1811`) | L |
| 3.10 | Timeline visualization with chronological sequence | DONE | UI ComposedChart w/ fraud-start/first-cashout reference lines (`Timeline.jsx`); PDF PNG w/ same-day-cashout overlay (`charts.js:441-511`); data `analyzer.js:1490-1519` | — | — |
| 3.11 | Highlight specific paths in diagrams | MISSING | No path highlighting in Sankey or any diagram | Needs the graph component (3.9) | M (with 3.9) |
| 3.12 | Filter diagrams by amount thresholds | MISSING | Money-flow diagram has no amount filter; tables fixed top-10 (`MoneyFlow.jsx:512-519`) | Amount filters exist on Mules/Transactions tables, not the network view | S (with 3.9) |
| 3.13 | Export diagrams as high-resolution images/documents for court | MISSING | Charts rasterised at fixed 960px and embedded in PDF only (`charts.js:217,354,450`, `rasterise :523`); no image-export endpoint or UI button (grep of `routes/ncrp.js` confirms) | No standalone/hi-DPI export path; SVG is generated (`charts.js:565`) but never served | M |
| 3.14 | Bottleneck accounts (fund convergence) | DONE | Collector detection in-degree ≥2 (`analysis/connectivity.js:28,47-100`); tiered aggregators ≥3/≥5 (`analyzer.js:2049-2102`, `lib/thresholds.js:46-47`) | — | — |
| 3.15 | Hub accounts with high connection counts (controllers) | DONE | Per-account in/out-degree + totals over shared hop graph (`connectivity.js:62-99`; UI `MoneyFlow.jsx:400-418`) | — | — |
| 3.16 | Layering patterns / mule hierarchy | DONE | `layerAnalysis` per-layer rollups + `fan_out_ratio`/`fan_out_high` (`analyzer.js:429-549`, threshold `thresholds.js:37`); step diagram `Layers.jsx` | — | — |
| 3.17 | Circular transaction patterns | DONE | Bounded DFS simple cycles length 2–6 (`analysis/cycleDetector.js`, `DEFAULT_MAX_LEN=6 :41`) + self-loops (`analyzer.js:1732-1747`); UI `MoneyFlow.jsx:429-500` | Scale caveat: combinatorial blow-up on dense graphs (see §6.3 / risk #3) | — |
| 3.18 | Split-and-merge patterns | MISSING | Fan-out (layers) and fan-in (aggregators) detected separately; no combined split-then-reconverge detector | — | S–M |
| 3.19 | Common controllers via IP addresses / device IDs | N-A | Confirmed: no IP/device/IMEI fields in schema (`schema.js:64-93`) or anywhere in `backend/src` | NCRP CompleteTrail carries no such data — clarification #1 | — |
| 3.20 | Cash-out points: ATM withdrawal clusters | DONE | ATM hotspots (`analyzer.js:1571-1599`); per-channel ATM/POS/AEPS analytics (`:2306-2381`); rapid ≥3/60min (`:2127-2163`), multi-ATM ≥3/day (`:2169-2196`), suspicious merchants (`:2203-2243`) | — | — |
| 3.21 | Cash-out points: cryptocurrency exchange transfers | MISSING | No crypto/exchange detection (repo search: only Node `crypto` hashing) | Feasible only via exchange account/IFSC watchlist — clarification #5 | M? |
| 3.22 | Centralized mule intelligence DB (profiles, complaint list, scores, freeze/recovery/arrest) | PARTIAL | `repeat_accounts` — genuine cross-report registry: `account_no UNIQUE`, upsert per analysis (`schema.js:96-106`; `queries.js:148-162`; populated `routes/ncrp.js:554-562`) | Thin counter only: no profiles, no complaint list, no freeze/recovery/arrest fields; rich `repeat_accounts` analyzer output is **never surfaced** (zero API/UI/PDF/Excel references); counts inflate on re-analysis, keys not canonicalized, never cleaned on report delete | M |
| 3.23 | Automatic alerts when known mule account appears in new complaint | MISSING | Only passive "Cases (incl. prior complaints)" column (`Mules.jsx:231`, from `analyzer.js:970-972`) | No alert/notification mechanism anywhere in frontend or backend | S–M (after 3.22 hardening) |
| 3.24 | Case clubbing (organized-network recognition) | MISSING | No grouping mechanism; cross-case linkage is exact account-number only | Needs case entity + 3.22 | M |

### Section 4 — Financial Analysis & Investigation

All search rows refer to the one live endpoint `GET /api/ncrp/:id/transactions` (`routes/ncrp.js:805`), which builds SQL inline. NOTE: a richer helper `getTransactionsByReport` with exact account/state/city filters exists in `db/queries.js:171-183,438` but is **dead code** — only its unit test calls it.

| # | Requirement | Status | Evidence | Gap | Effort |
|---|---|---|---|---|---|
| 4.1 | Search by account number | PARTIAL | Substring LIKE via shared `search` param over `beneficiary_account`/`victim_account` (`ncrp.js:869-878`) | No dedicated exact-match param on live route; no index for LIKE (full scan per report) | S |
| 4.2 | Search by IFSC code | PARTIAL | Same shared LIKE box (`ncrp.js:875`) | No dedicated param | S |
| 4.3 | Beneficiary name search **with fuzzy matching** | MISSING | Name search is substring LIKE only (`ncrp.js:874`). `parseFuzzy.js` is parse-time header matching, imported only by the parser (`ncrpParser.js:54`) — not query-time | No edit-distance/phonetic search anywhere | M |
| 4.4 | Date-range filters | DONE | `date_from`/`date_to` (`ncrp.js:857-860`); UI date pickers (`Transactions.jsx:513-518`) | — | — |
| 4.5 | Amount filters | DONE | `min_amount`/`max_amount` (`ncrp.js:861-868`); UI min/max inputs | — | — |
| 4.6 | Transaction-type filter (UPI/NEFT/RTGS/IMPS/ATM) | DONE | `payment_mode` exact filter (`ncrp.js:852-856`); UI dropdown UPI/IMPS/NEFT/RTGS/ATM/POS/AEPS/HOLD (`Transactions.jsx:34,506-511`) | — | — |
| 4.7 | Search by UPI ID | MISSING | No `upi_id` column in schema (`schema.js:64-93`), no param | Blocked by 2.10 (extraction + schema) | M (with 2.10) |
| 4.8 | Search by mobile number | MISSING | No phone/mobile column, no param | Blocked by 2.10 | M (with 2.10) |
| 4.9 | Search by reference number | PARTIAL | `utr_no` folded into shared LIKE box (`ncrp.js:875`) | No dedicated param | S |
| 4.10 | Free-text search across descriptions | MISSING | `search` hits 5 identifier columns only; `remarks` (the description field) is excluded (`ncrp.js:874-875`) | Add remarks to LIKE set or FTS index | S |
| 4.11 | Automated tracing from an investigator-specified source transaction | MISSING | Full route list has no trace endpoint; nearest is edge drill-down of an already-identified A→B edge (`utils/entityDetail.js:481-546`) | Only automatic whole-network analysis exists; no interactive from-source forward trace | M |
| 4.12 | Trace through splits, convergence, circular flows, cash-out points; effective layer calculation | DONE | Automatic whole-trail: layer flows to cashed-out/hold sinks (`analyzer.js:1646-1688`), aggregator convergence (`:2067-2102`), cycles (`cycleDetector.js`), cash-out classification (`lib/cashoutPolicy.js`), layers + avg forward time (`:429-549`) | Whole-network automatic only (per-source scoping is 4.11) | — |
| 4.13 | Complete tree diagrams of amount subdivision through the network | MISSING | Layer Sankey + per-layer bars exist; no per-source subdivision tree ("₹X split into a/b/c down each branch") | Needs 4.11 trace + graph component | M (with 3.9) |
| 4.14 | Smurfing/structuring detection | MISSING | No sub-threshold/many-small-transactions detector in `backend/src` | — | M |
| 4.15 | Rapid-fire transactions within minutes | PARTIAL | ≥3 cash-exits per 60-min window (`analyzer.js:2127-2163`); ≥3 POS per terminal/60min (`:2203-2243`) | Cash-out/POS legs only — not account-to-account transfers | S |
| 4.16 | Consistent timing patterns suggesting automation | MISSING | `analysis/dayOfWeek.js:58-90` is a Mon–Sun breakdown only; no inter-transaction cadence/regularity detection | — | M |
| 4.17 | Identical/similar amount patterns across transactions | MISSING | Amount equality used only in exact-duplicate dedupe key (`analyzer.js:329-352`) — dedup, not detection | — | S–M |
| 4.18 | Counterparty clustering | PARTIAL | Fan-in convergence onto collectors (`analyzer.js:2067-2102`; connectivity graph) | No general clustering beyond in-degree grouping | M? |
| 4.19 | Velocity anomalies | PARTIAL | Threshold-based per-account velocity + case-level median/mean cashout speed (`analyzer.js:1949-1965`), flagged "informational only" (`:2032`) | No statistical baseline/anomaly detection | M? |
| 4.20 | Cross-case pattern matching (same modus operandi across complaints) | PARTIAL | Exact same-`account_no` matching via `repeat_accounts` (`ncrp.js:554-562`; `analyzer.js:969-972,1434-1474`) | No MO matching (timing/amount/structure similarity across cases); registry integrity caveats (3.22) | L? |
| 4.21 | Geographic anomalies in transaction locations | DONE | `geoSpread` signal (`analyzer.js:974-980`); state/city/ATM distributions (`:1538-1605`) | — | — |
| 4.22 | Beneficiary clustering across apparently unconnected cases | MISSING | Cross-case linkage is exact account number only; no name/pattern similarity clustering | — | M–L? |

### Section 5 — Reporting & Case Management

Architectural fact framing all rows: the product generates **one dossier PDF per uploaded complaint** (cover + exec summary + charts + roadmap + findings + Annexures A–H + §102 lien letters — assembly `pdfGenerator.js:1564-1601`) plus 19-sheet/cash-exit/entity Excel workbooks. None of the spec's five report types exist as distinct documents.

| # | Requirement | Status | Evidence | Gap | Effort |
|---|---|---|---|---|---|
| 5.1 | NCRP investigation report (complaint ID, status, money trail, suspects w/ scores, freeze/recovery/arrest, next steps, auto-populated) | PARTIAL | Dossier covers complaint ID (cover `pdfGenerator.js:288`), money trail (Annex A/B/G + charts), mule scores (Annex C `:754-789`), next steps (Roadmap `:530`, Findings `:1073`), fully auto-populated | Missing: investigation status, arrest status; freeze = draft request letters + coarse `lien_status` only; recovery financial-only (refunds hardcoded 0, `analyzer.js:2906`; Dashboard shows "Not tracked" `Dashboard.jsx:864`) | M |
| 5.2 | Investigation status matching NCRP portal categories | MISSING | Only `analysis_status` pipeline states pending/processing/complete/error (`schema.js:53-54`) | Need the portal category list — clarification #9 | S |
| 5.3 | Freeze order details, recovery status, arrest tracking | PARTIAL | `lien_records.lien_status` pending/applied/success/rejected + `applied_date` (`schema.js:130-135`; API `ncrp.js:1100-1155`); §102 letters `draft`/`sent` (`schema.js:146-147`) | No freeze-order number/date/confirmation, no recorded recovery amounts, zero arrest tracking (repo-wide grep: 0 hits) | M |
| 5.4 | Action Taken Report — chronological investigative steps | MISSING | `audit_log` records system events only (pdf.generated etc., `ncrp.js:571-1562`), never compiled to a report; Roadmap is forward-looking recommendations, not actions taken | Needs investigator action logging + report template | M |
| 5.5 | Final investigation report for chargesheet (exec summary, fraud narrative, accused w/ roles & quantum, evidence summary, legal sections) | PARTIAL | Exec summary (`pdfGenerator.js:384`) + complete financial annexures + raw ledger sheet | Missing: narrative fraud description, named accused (only account-level roles), evidence summary, offence sections — only §102 CrPC + IT Act 2000 cited anywhere (`emailGenerator.js:252-268`); no IPC/BNS/66C/66D/420 (grep confirmed) | M |
| 5.6 | Mule account profile report (per-account dossier: details, activity, all complaints, network position, timeline, legal status, recommendations) | MISSING | Only generic account drill-down modal + 2-sheet Excel (`excelGenerator.js:828-846`; route `ncrp.js:1384`) | Not a formatted profile; "all complaints involving account" impossible until cross-case linkage exists; no per-account network viz | M–L |
| 5.7 | Mule network analysis report (topology, stats, key controllers, patterns, priority recommendations) | PARTIAL | All content exists scattered in dossier: network PNG (`charts.js:169`), connectivity/aggregators (`pdfGenerator.js:678`), circular flows (`:713`), roadmap priorities | Not compiled as a distinct report artifact | S–M |
| 5.8 | Case management module with unique internal reference numbers linked to NCRP IDs; link multiple complaints per investigation | MISSING | Only identifier is the NCRP `ack_no` itself; reports listed flat (`ncrp.js:799-802`; `Upload.jsx:401-408`); no case table in schema | Requires the case/investigation entity — the root dependency for most of §5 | M–L |
| 5.9 | Customizable case folders / lifecycle statuses (active, pending statements, analysis complete, chargesheet filed, closed) | MISSING | `analysis_status` is a processing pipeline state, not case lifecycle (`schema.js:53-54`) | With case entity | S–M |
| 5.10 | Centralized document repository (drag-drop upload, version control, full-text search) | MISSING | Only file handling is the single source `.xlsx` (multer `ncrp.js:438-458`); no documents/attachments table, route, or page | — | L |
| 5.11 | Task management (due dates, priority levels) | MISSING | Roadmap P0–P3 labels are static auto-generated suggestions (`Dashboard.jsx:219-224`), not assignable/persistent tasks | — | M |
| 5.12 | Automatic reminders for statutory timelines | MISSING | No scheduler, reminder table, or notification mechanism anywhere | Needs 5.11 | S–M |
| 5.13 | Multi-user operation with RBAC (System Admin, SHO, IO, Data Entry Operator) | MISSING | No auth of any kind; single-instance lock actively prevents second instance (`electron/main.js:518-519`); SRS declares single-user (`SRS.md:73,360,624`) | Same as 6.4/6.5 — architecture change | L |
| 5.14 | Comprehensive audit trails | PARTIAL | 11 event types logged with details incl. source SHA-256 (`queries.js:637-652`; callers `ncrp.js:571-1562`); read via `GET /:id/audit` (`:1572-1601`); rows survive report deletion (no FK, `schema.js:153`) | Plain rows — no hash chain, no signing, freely UPDATE/DELETE-able; **no user identity** (no users exist) | S–M |

### Section 6 — Technical Requirements

| # | Requirement | Status | Evidence | Gap | Effort |
|---|---|---|---|---|---|
| 6.1 | Runs on Windows 10/11 as standalone desktop app | DONE | Electron 33 + NSIS installer (`package.json` build.win: nsis, desktop/start-menu shortcuts); offline-first; DB per Windows user under `%APPDATA%\FinTraceNCRP` (`electron/main.js:118-122`) | — | — |
| 6.2 | Optional client-server deployment for LAN | MISSING | Server binds 127.0.0.1 only by design (`server.js:33-34,134`; header comment `:15-19`); Electron CSP/network guard blocks non-loopback (`main.js:187-200`) | `FINTRACE_HOST` env could rebind, but LAN exposure of an **unauthenticated** API is not viable — blocked by 6.4 | L (with auth) |
| 6.3 | Handle minimum 1,000,000 transactions | MISSING | Architecture: whole-workbook in-memory parse (`ncrpParser.js:1338,1377`); ~25–30 full passes + 2–3 full row-set copies (`analyzer.js:333,371,380` …); exponential cycle enumeration on hub graphs (`cycleDetector.js:81-102`); entire analysis persisted as one unbounded `analysis_json` blob re-`JSON.parse`d on **every** read (`schema.js:56`; `ncrp.js:320-323,565`). Largest data ever exercised: 235 KB xlsx (repo samples) — ~3 orders of magnitude short | Requires re-architecture: streaming/bounded parse, worker-thread analysis, relational persistence of results, guarded cycle detection. One good path exists already: paginated transactions endpoint + virtualized table (`queries.js:443-490`, `Transactions.jsx:16,285`) | L |
| 6.4 | Strong user authentication with complex password requirements | MISSING | Zero auth code (grep of backend+electron: no bcrypt/jwt/session/login); no users table (`schema.js:43-161`) | Foundational gap; SRS scopes it out explicitly | M–L |
| 6.5 | Role-based access control preventing unauthorized function access | MISSING | As above — no roles, no permission checks on any route | Depends on 6.4 | L (with 6.4) |
| 6.6 | Encryption of sensitive data at rest | MISSING | Plain better-sqlite3, no SQLCipher/`PRAGMA key` (`schema.js:29-34,311`); DB holds victim/beneficiary accounts, names, UTRs in plaintext; uploads/exports also plaintext | SQLCipher or OS-level (EFS/BitLocker guidance) — decide approach | M |
| 6.7 | Encryption of network transmission | N-A / Clarify | Loopback-only HTTP (`server.js:134`); renderer→backend via `http://127.0.0.1:3847` (`main.js:73,82`); traffic never leaves the machine | No transmission exists in standalone mode; TLS becomes real only for the LAN option — clarification #6 | S (with 6.2) |
| 6.8 | Tamper-proof comprehensive audit logging | PARTIAL | See 5.14. Code comments claim "tamper-evident" (`ncrp.js:762`) but implementation is plain rows; what exists is source-file SHA-256 provenance (`lib/provenance.js:26-29`), which is chain-of-custody for inputs, not log integrity | Hash-chain rows + include user identity (needs 6.4) | S–M |
| 6.9 | Automated backups — 7 daily / 4 weekly / 3 monthly, integrity verification, easy restore | MISSING | No backup/restore code anywhere (grep: no `.backup(`, `VACUUM INTO`, scheduler); SRS NFR-09 promises a weaker 7-daily scheme — also unimplemented (`SRS.md:319,532`) | SQLite online backup API + retention + integrity check + restore UI | S–M |
| 6.10 | Intuitive interface: clear labels, consistent color coding, icons+labels, dashboard/widgets | DONE | Consistent design system (`frontend/src/index.css`, self-hosted Inter, dark mode), dashboard with stat cards/charts/roadmap (`Dashboard.jsx`), sidebar icons+labels (`Sidebar.jsx:31-43`), plain-language flag reasons | English-only (see 6.13); "Windows-style familiar" is subjective | — |
| 6.11 | Navigation: primary menu + breadcrumbs; quick-access toolbar | PARTIAL | Persistent sidebar nav + module toggle (`shell/AppRoot.jsx:50-90`) | No breadcrumbs; no quick-access toolbar | S |
| 6.12 | Well-designed forms with validation/auto-format; copy-paste throughout; high-resolution export | PARTIAL | Upload validation is defense-in-depth (ext+MIME+magic-bytes+content gate, `ncrp.js:446-457,231-291`); letters have copy-to-clipboard (`Emails.jsx`); lien/email enum validation (`ncrp.js:1114-1117,1247-1250`) | Few forms exist overall (little data entry by design); hi-res export missing (3.13) | S–M |
| 6.13 | Interface in English **and Hindi**, simple switching, proper Devanagari rendering | MISSING | No i18n framework (all 3 package.json checked; zero `t()`/locale files); `<html lang="en">`; all strings inline JSX literals (`Dashboard.jsx:688` etc.); bundled fonts are Inter **Latin/Latin-ext only** (`index.css:23-44` unicode-ranges exclude U+0900-097F); **PDF pipeline actively strips non-ASCII** via `asciiSafe` monkey-patch on every drawn string (`pdfGenerator.js:146-156,1555-1558`) over WinAnsi Helvetica; charts render via Arial (`charts.js:137,528`) | Full retrofit: i18n framework + string extraction (~40 components), language switcher, bundled Devanagari font (UI+PDF+charts), remove `asciiSafe`, fix fixed-width/`text-transform:uppercase` assumptions (`index.css:2347` etc.). Only existing Hindi capability is **input-side**: parser recognizes Hindi column headers (`config/header_synonyms.json:41,62,77,130-131,145,177`) | L |

### Section 7 — Training, Support, Vendor (code-relevant items only)

| # | Requirement | Status | Evidence | Gap | Effort |
|---|---|---|---|---|---|
| 7.1 | Training, printed materials, video tutorials (EN+HI), refresher | N-A (vendor) | — | Hindi materials presume Hindi product capability (6.13) | — |
| 7.2 | User manual — printed + searchable PDF | N-A (vendor) | `docs/USER_GUIDE.md` exists as a starting point | Needs productization; not a code gap per se | — |
| 7.3 | Context-sensitive help integrated in software | MISSING | Only scattered `title=` tooltips (`Sidebar.jsx`) and an Excel Glossary sheet | No help system/panel | M |
| 7.4 | Helpline / email SLAs / remote assistance / ticketing / forum | N-A (vendor) | — | — | — |
| 7.5 | Free updates 1 yr; in-software update notifications; release notes | PARTIAL | Auto-updater genuinely wired: `electron-updater` `checkForUpdatesAndNotify()` in packaged builds, autoDownload on (`electron/main.js:319-344`) | No `publish` feed configured in `package.json` build block, so updater has no server to check today; no in-app release notes | S |
| 7.6 | AMC, on-site visits | N-A (vendor) | — | — | — |
| 7.7 | Database maintenance utilities for periodic optimization | MISSING | `backend/scripts/` has dev CLIs (reanalyze.js, benchmark.js) but nothing user-facing does VACUUM/optimize/integrity-check | Small settings/maintenance screen | S |
| 7.8 | Customization: custom fields, report templates, letterhead integration | MISSING | PDF layout, letter templates hardcoded (`pdfGenerator.js`, `emailGenerator.js`); no template/letterhead config | — | M |
| 7.9 | Reference sites, demo, 15-day PoC, ISO, NDA, SLAs, 45-day implementation | N-A (vendor) | — | Note general condition: demo within 3 days of bid opening; 3-year warranty (see Clarification #11) | — |

---

## 3. Acceptance-criteria checklist — pass/fail as of today

| Acceptance test | Today | Why |
|---|---|---|
| 90% automatic import success from 20 different banks | **FAIL** | No bank-statement engine exists (rows 2.1–2.4) |
| OCR accuracy 90%+ | **FAIL** | No OCR capability (2.2) |
| Trace money through 5+ mule layers | **PASS** | Layer handling is unbounded — `parseLayer` (`ncrpParser.js:515-527`), per-layer analysis for arbitrary N (`analyzer.js:429-549`). Caveat: layers come from NCRP data, not derived by tracing |
| Automatic mule detection with sensible risk scoring | **PASS (with caveats)** | Scoring validated 28/28 vs gold cases; but 2/7 spec indicators implemented, score uncapped >100 (3.1–3.8) |
| Network diagrams with 50+ nodes, readable and exportable | **FAIL** | Only a ~10–15-node layer-aggregated Sankey; account detail capped at top-10 edges; no image export (3.9–3.13) |
| Generation of all specified reports with accurate data | **FAIL** | ATR and per-account mule profile missing entirely; investigation report/chargesheet partial (5.1–5.7). What exists is accurate (byte-validated) |
| Management of 20+ concurrent cases without degradation | **FAIL** | Can *store* 20+ reports (indexed per report_id), but single-threaded synchronous analysis blocks the whole server per case; single-active-report UI model; no case management (6.3, 5.8) |
| Proper security controls | **FAIL vs tender definition** | No auth/RBAC/encryption/backups (6.4–6.9). App-level hardening is genuinely strong (rate limiting, parameterized SQL, magic-byte gates, Electron sandbox/CSP, provenance) but doesn't satisfy the listed controls |
| 30-day stable operation without critical bugs | UNKNOWN | Not verifiable in a code audit; single-user stability is plausible (390 jest tests, gold-case regression anchors) |
| Functionality in both English and Hindi | **FAIL** | Zero output-side Hindi capability; PDF strips non-ASCII (6.13) |
| Performance benchmarking (import/search/viz/report) | AT RISK | `backend/scripts/benchmark.js` exists as an in-process harness, but no load generation at tender scale; scale ceilings per 6.3 would dominate results |
| Usability by untrained police personnel | PLAUSIBLE-UNTESTED | Guided workflow + plain-language output, but English-only and never user-tested |

**Score today: ~2 clear passes, 5–6 clear fails** out of the testable items.

---

## 4. Bid risk — most likely acceptance failures, by severity

1. **Bank statement ingestion + OCR (rows 2.1–2.5).** Two acceptance items (20-bank 90% import, OCR 90%) test a subsystem that is a frontend mock with zero backend. This is the largest single build in the entire gap list (L + L), it's on the critical path for the 45-day implementation promise, and its accuracy targets carry inherent R&D risk (real-world scanned statements). *This is the bid's make-or-break line item.*
2. **English + Hindi (6.13).** Explicit acceptance item. Effort is not exotic but it is wide: every string, plus fonts across three render pipelines (DOM, PDFKit, resvg), plus removing a PDF sanitizer that actively deletes non-ASCII. Underestimating this is easy; it touches everything.
3. **1M transactions + performance benchmarking (6.3).** Not a tuning problem — an architecture problem (in-memory parse, monolithic analysis blob, single-threaded pipeline, exponential cycle enumeration). Current tested scale is ~3 orders of magnitude below target. Any acceptance benchmark at even 100k rows is likely to fail today.
4. **Security-controls bundle (6.4–6.9): auth, RBAC, encryption at rest, backups, tamper-proof audit.** Absent by deliberate architecture (SRS scopes them out). Auth/RBAC is also the dependency root for multi-user, LAN mode, and audit-log identity — schedule it first or everything behind it slips.
5. **Case management + 20+ concurrent cases (5.8–5.13).** There is no case entity at all; "case" today means "one uploaded file". The acceptance phrase "management of 20+ concurrent cases" fails on both meanings (workflow management and concurrent processing).
6. **50+ node network diagrams, readable & exportable (3.9–3.13).** Needs a real graph component (react-flow/cytoscape class), server-side node budgeting, and an image-export pipeline. The current Sankey + top-10 tables cannot be argued past this checklist item.
7. **"All specified reports" (5.1–5.7).** ATR and per-account mule profile don't exist in any form; chargesheet report lacks legal sections and accused identities. Also depends on data we don't capture today (arrest/recovery/status fields).
8. **Mule intelligence DB + automatic alerts (3.22–3.24).** The cross-case registry exists but is dead-ended and has correctness bugs (inflation on re-analysis, no canonical keys, no cleanup on delete). Demo-day risk: a repeat account that *should* alert, doesn't — or shows a wrong count.
9. **Search criteria (4.1–4.10).** Half the enumerated criteria missing or degraded; fuzzy name matching is called out by name in the spec. Moderate effort, high visibility in any functional checklist walkthrough.
10. **Interactive money-flow tracing from a source transaction (4.11, 4.13).** Spec describes it explicitly ("investigator specifies source transaction… complete tree diagrams"). Whole-network automatic analysis is strong, but the interactive trace-from-here experience does not exist.

---

## 5. Needs clarification with the department

Data-availability issues (requirements that assume inputs NCRP CompleteTrail does not contain):

1. **IP addresses / device IDs (3.19)** — no IP/device/IMEI fields exist in NCRP exports. Common-controller detection via device linkage is impossible with the specified input. Propose: transaction-pattern-based linkage instead, or confirm an additional data source.
2. **Value date, running balance, separate debit/credit columns (2.14, 2.16, 2.17)** — these are bank-statement ledger concepts; NCRP CompleteTrail has one amount per channel row and no balances. Confirm these apply only to the bank-statement module, not NCRP imports.
3. **UPI IDs and phone numbers in NCRP data (2.10, 4.7, 4.8)** — the CompleteTrail exports we receive carry no UPI-ID or phone columns. Confirm which NCRP export variant the department will provide, or whether these arrive only via bank statements.
4. **Account age and KYC documentation quality (3.4, 3.8)** — mule-score indicators requiring bank KYC data not present in any specified input. Confirm data source or accept documented proxies (pass-through ratio, identity variance).
5. **Cryptocurrency exchange detection (3.21)** — from account-trail data, only detectable via a watchlist of known exchange accounts/IFSC/names. Confirm this approach satisfies the clause.
6. **Encryption of network transmission (6.7)** — in standalone desktop mode all traffic is loopback (never leaves the machine). Confirm TLS requirement is scoped to the optional LAN deployment.
7. **"20+ concurrent cases" (acceptance)** — confirm meaning: (a) 20+ open cases stored and switchable, (b) 20+ simultaneously processing analyses, or (c) 20+ simultaneous users. (a) is near; (b)/(c) require the scale/auth work.
8. **Risk score range (3.1)** — our scoring intentionally exceeds 100 for extreme cases (validated against CypherSOL). Trivial to cap for display; confirm preferred presentation.
9. **NCRP portal investigation-status categories (5.2)** — need the authoritative category list to implement matching statuses.
10. **OCR 90% acceptance methodology (2.2)** — which corpus, which fields, character- or field-level accuracy? Also request sample statements from the 20 target banks for development/testing.
11. **Warranty term** — general condition #2 says 3-year warranty from installation; Section 7 says minimum 1-year free updates. Confirm the governing term for pricing (vendor/commercial, not code).
12. **Fuzzy name matching semantics (4.3)** — confirm expected behavior (typo tolerance? phonetic/transliteration matching for Indian names?) since it drives library/algorithm choice.

---

## 6. Dependency map — which gaps block which

1. **Bank-statement parsing engine (2.1, 2.3) blocks:** OCR + its accuracy testing (2.2), 20-bank import acceptance, batch import & per-file log for statements (2.4, 2.5), value-date/balance/debit-credit extraction (2.14–2.17), the 7 scaffold pages of the bankStatement module, and UPI/phone data if it arrives via statements (2.10 → 4.7/4.8).
2. **Auth + RBAC (6.4, 6.5) blocks:** multi-user operation (5.13), client-server LAN mode (6.2) and its TLS story (6.7), audit-log user identity — which in turn gates honest "tamper-proof audit" (6.8) and investigator attribution in an ATR (5.4).
3. **Case/investigation entity (5.8) blocks:** multi-complaint linking (2.12), case folders/lifecycle statuses (5.9), case clubbing (3.24), statutory reminders & tasks (5.11, 5.12), investigation-status reporting (5.2), the "all complaints involving this account" element of the mule profile report (5.6), and meaningful "20+ concurrent cases".
4. **Scale re-architecture (6.3: worker-thread analysis + relational result persistence + streaming parse + guarded cycle detection) blocks:** 1M-transaction capacity, 20+ concurrent case *processing*, and the performance-benchmarking acceptance item. Note: fixing the monolithic `analysis_json` blob also fixes read-path latency everywhere (every endpoint currently re-parses the whole blob).
5. **Account-level graph component + image-export pipeline (3.9, 3.13) blocks:** 50+ node diagrams, path highlighting (3.11), diagram amount filters (3.12), court-ready high-res exhibits, per-account network-position visualization for the mule profile report (5.6), and amount-subdivision tree diagrams (4.13). The interactive source-transaction trace (4.11) is the natural data feed for this component — build them together.
6. **i18n framework + bundled Devanagari fonts across all three render pipelines (6.13) blocks:** Hindi acceptance, Hindi reports/letters, and Hindi training-material alignment (7.1). Removing the PDF `asciiSafe` sanitizer is a hard prerequisite for any non-ASCII output.
7. **`repeat_accounts` hardening (canonical account keys, idempotent per-report upserts, cleanup on delete — 3.22) blocks:** trustworthy automatic alerts (3.23), the mule intelligence DB/profiles, cross-case search, and cross-case MO matching (4.20). Cheap to fix; do it before anything is built on top.
8. **Schema additions (`upi_id`, `phone`, `victim_name`, freeze/recovery/arrest fields) block:** UPI/mobile search (4.7, 4.8), victim details (2.9), and the freeze/recovery/arrest elements of reports (5.1, 5.3) — small individually, but they gate multiple visible features and are contingent on clarifications #2/#3.

---

*Audit complete. Phase planning intentionally excluded per brief — this document is the ground truth input for it.*
