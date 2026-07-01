/**
 * Static mock data for the Bank Statement module scaffold.
 *
 * This is a UI/UX pass only — there is no real parsing or bank-detection logic
 * yet. Everything here is hand-authored sample data so the Upload page can
 * demonstrate the intended flow (detected vs. unrecognised files, confidence
 * scores, header mapping) end to end. When the real parser lands, these arrays
 * are replaced by responses from GET /api/bank-statement/* (see ./api.js).
 */

/** Extensions the drop zone advertises (UI-only — nothing is parsed yet). */
export const ACCEPTED_EXTENSIONS = ['.pdf', '.xlsx', '.xls', '.csv'];

/**
 * Canonical fields a source column can be mapped to. `ignore` drops the column.
 * The real engine will consume exactly these keys.
 */
export const CANONICAL_FIELDS = [
  { value: 'date', label: 'Date' },
  { value: 'narration', label: 'Narration' },
  { value: 'debit', label: 'Debit' },
  { value: 'credit', label: 'Credit' },
  { value: 'balance', label: 'Balance' },
  { value: 'ignore', label: 'Ignore' },
];

/**
 * Headers a not-recognised file is pretending to expose, each with the mapping
 * the (future) detector would tentatively suggest. The UI pre-selects
 * `suggested` in each dropdown; the officer confirms or corrects it.
 */
export const MOCK_DETECTED_HEADERS = [
  { header: 'Txn Date', suggested: 'date' },
  { header: 'Particulars', suggested: 'narration' },
  { header: 'Withdrawal Amt.', suggested: 'debit' },
  { header: 'Deposit Amt.', suggested: 'credit' },
  { header: 'Closing Balance', suggested: 'balance' },
];

/**
 * The seed file list shown on the Upload page. Mirrors what the detector would
 * return: recognised files carry a bank + confidence; unrecognised ones carry
 * the raw headers so the officer can map them.
 */
export const MOCK_FILES = [
  {
    id: 'mock-1',
    name: 'HDFC_savings_Apr-Jun2024.xlsx',
    size: 184_320,
    status: 'detected',
    bank: 'HDFC Bank',
    confidence: 98,
  },
  {
    id: 'mock-2',
    name: 'SBI_statement_Q2.csv',
    size: 96_512,
    status: 'detected',
    bank: 'State Bank of India',
    confidence: 91,
  },
  {
    id: 'mock-3',
    name: 'icici-current-acct.pdf',
    size: 512_000,
    status: 'detected',
    bank: 'ICICI Bank',
    confidence: 86,
  },
  {
    id: 'mock-4',
    name: 'account_export_2024.xlsx',
    size: 148_992,
    status: 'unrecognized',
    detectedHeaders: MOCK_DETECTED_HEADERS,
  },
  {
    id: 'mock-5',
    name: 'scanned_passbook_0007.pdf',
    size: 733_184,
    status: 'unrecognized',
    detectedHeaders: MOCK_DETECTED_HEADERS,
  },
];

/**
 * Toy bank detector for files the officer adds in this pass — purely so a real
 * drag-and-drop produces a plausible chip. Filenames hinting at a known bank
 * come back "detected"; everything else is "unrecognised" and routes into the
 * column-mapping flow. Replaced wholesale by the real detector later.
 */
const KNOWN_BANKS = [
  { keyword: 'hdfc', bank: 'HDFC Bank', confidence: 97 },
  { keyword: 'sbi', bank: 'State Bank of India', confidence: 93 },
  { keyword: 'icici', bank: 'ICICI Bank', confidence: 90 },
  { keyword: 'axis', bank: 'Axis Bank', confidence: 89 },
  { keyword: 'kotak', bank: 'Kotak Mahindra Bank', confidence: 88 },
  { keyword: 'pnb', bank: 'Punjab National Bank', confidence: 85 },
];

export function mockDetect(fileName) {
  const lower = (fileName || '').toLowerCase();
  const match = KNOWN_BANKS.find((b) => lower.includes(b.keyword));
  if (match) {
    return { status: 'detected', bank: match.bank, confidence: match.confidence };
  }
  return { status: 'unrecognized', detectedHeaders: MOCK_DETECTED_HEADERS };
}
