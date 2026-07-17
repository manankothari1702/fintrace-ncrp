/**
 * Bank Statement module — real Upload flow + Transactions table.
 *
 * The module api client is mocked at the network functions only
 * (listStatements / uploadStatement / getStatementTransactions); everything
 * else (suggestFieldForHeader, page logic, MappingPanel) runs for real.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../modules/bankStatement/utils/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listStatements: vi.fn().mockResolvedValue([]),
    uploadStatement: vi.fn(),
    getStatementTransactions: vi.fn(),
    applyMapping: vi.fn(),
    getStatementAnalysis: vi.fn(),
  };
});

import BankStatementApp from '../modules/bankStatement/BankStatementApp.jsx';
import {
  listStatements, uploadStatement, getStatementTransactions, applyMapping,
  getStatementAnalysis,
} from '../modules/bankStatement/utils/api.js';

const RECOGNIZED_RESPONSE = {
  recognized: true,
  statementId: 7,
  bank: 'PNB',
  bankName: 'Punjab National Bank',
  confidence: 0.99,
  format: 'excel',
  account: { account_number: '4563000100036079', account_holder: 'ABHISHEK BHARDWAJ', ifsc: 'PUNB0456300' },
  txnCount: 96,
  sourceSha256: 'a'.repeat(64),
  warnings: [],
};

const STATEMENT_ROW = {
  id: 7,
  account_number: '4563000100036079',
  account_holder: 'ABHISHEK BHARDWAJ',
  ifsc: 'PUNB0456300',
  bank_name: 'Punjab National Bank',
  branch: 'DELHI MAMS CD-BLOCK PITAMPURA',
  statement_period_from: '2026-06-02T00:00:00.000Z',
  statement_period_to: '2026-07-02T00:00:00.000Z',
  original_filename: 'pnb_statement.xls',
  source_format: 'excel',
  source_sha256: 'a'.repeat(64),
  txn_count: 96,
  uploaded_at: '2026-07-16 10:00:00',
};

const TXN_PAGE = {
  data: [
    {
      id: 1, statement_id: 7, txn_date: '2026-07-02T00:00:00.000Z', value_date: null,
      narration: 'UPI/CR/168797098045/Mrs Lale/IDIB/9631574663-2@yb/',
      debit_amount: null, credit_amount: 500, balance: 2274.95, balance_type: 'Cr',
      ref_no: 'U12010768', source_row: 20,
      counterparty_name: 'Mrs Lale', counterparty_bank_code: 'IDIB',
      counterparty_ifsc: null, counterparty_vpa: '9631574663-2@yb',
      counterparty_phone: null, txn_channel: 'UPI', extraction_confidence: 'high',
    },
    {
      id: 2, statement_id: 7, txn_date: '2026-07-01T00:00:00.000Z', value_date: null,
      narration: 'UPI/DR/360729244657/RAM BAHA/NOT-A-CODE/8004806574@axl/P',
      debit_amount: 300, credit_amount: null, balance: 1774.95, balance_type: 'Cr',
      ref_no: 'T48579145', source_row: 21,
      counterparty_name: 'RAM BAHA', counterparty_bank_code: null,
      counterparty_ifsc: null, counterparty_vpa: '8004806574@axl',
      counterparty_phone: null, txn_channel: 'UPI', extraction_confidence: 'low',
    },
    {
      id: 3, statement_id: 7, txn_date: '2026-06-02T00:00:00.000Z', value_date: null,
      narration: '4563000100036079:Int.Pd:01-03-2026 to 31-05-2026',
      debit_amount: null, credit_amount: 141, balance: 8759.95, balance_type: 'Cr',
      ref_no: 'U90904741', source_row: 115,
      counterparty_name: null, counterparty_bank_code: null,
      counterparty_ifsc: null, counterparty_vpa: null,
      counterparty_phone: null, txn_channel: 'INTEREST', extraction_confidence: 'none',
    },
  ],
  total: 3, page: 1, limit: 500, total_pages: 1,
};

function uploadFileTo(container, name) {
  const input = container.querySelector('input[type="file"]');
  const file = new File(['statement-bytes'], name, { type: 'application/vnd.ms-excel' });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

/** Single-statement analysis document matching TXN_PAGE's rows. */
const ANALYSIS_DOC = {
  engine_version: 1,
  summary: {
    total_credit: 43852, total_debit: 50196, net_flow: -6344,
    credit_count: 11, debit_count: 85, txn_count: 96,
    period_from: '2026-06-02T00:00:00.000Z', period_to: '2026-07-02T00:00:00.000Z',
    opening_balance: 8618.95, closing_balance: 2274.95,
    ledger_order: 'newest-first', low_confidence_count: 1, non_counterparty_count: 1,
  },
  counterparties: [
    {
      key: 'vpa:9631574663-2@yb', id_kind: 'vpa', confidence: 'high',
      display_name: 'MRS LALE', names: ['MRS LALE'],
      vpa: '9631574663-2@yb', ifsc: null, bank_code: 'IDIB', phone: null,
      sent_total: 0, received_total: 500, net: 500, volume: 500,
      sent_count: 0, received_count: 1, txn_count: 1,
      first_seen: '2026-07-02T00:00:00.000Z', last_seen: '2026-07-02T00:00:00.000Z',
      txn_ids: [1],
    },
    {
      key: 'low|vpa:8004806574@axl', id_kind: 'vpa', confidence: 'low',
      display_name: 'RAM BAHA', names: ['RAM BAHA'],
      vpa: '8004806574@axl', ifsc: null, bank_code: null, phone: null,
      sent_total: 300, received_total: 0, net: -300, volume: 300,
      sent_count: 1, received_count: 0, txn_count: 1,
      first_seen: '2026-07-01T00:00:00.000Z', last_seen: '2026-07-01T00:00:00.000Z',
      txn_ids: [2],
    },
  ],
  unattributed_count: 0,
  top_by_amount: ['vpa:9631574663-2@yb', 'low|vpa:8004806574@axl'],
  top_by_frequency: ['vpa:9631574663-2@yb', 'low|vpa:8004806574@axl'],
  low_confidence_counterparty_count: 1,
  flags: [
    {
      id: 'pass_through_days',
      severity: 'signal',
      value: { days: [{ day: '2026-06-14', credited: 16000, debited: 17860, out_ratio: 1.12 }] },
      why: '1 day(s) where at least 80% of ≥₹5000 credited left the account the SAME day.',
    },
    {
      id: 'low_confidence_distribution',
      severity: 'info',
      value: { low_confidence_groups: 1, unattributed: 0 },
      why: 'Verify low-confidence counterparties against the raw narration.',
    },
  ],
  thresholds: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  listStatements.mockResolvedValue([]);
  // Header analysis is optional garnish — reject by default so existing
  // upload/ledger tests exercise the "ledger works without analysis" path.
  getStatementAnalysis.mockRejectedValue(new Error('no analysis'));
});

describe('Upload page — real ingestion flow', () => {
  test('a recognised PNB upload shows the bank, confidence, and parsed txn count', async () => {
    uploadStatement.mockResolvedValue(RECOGNIZED_RESPONSE);
    const { container } = render(<BankStatementApp />);

    const file = uploadFileTo(container, 'pnb_statement.xls');

    // Bank name appears in the card's detect meta (and again in the toast).
    await screen.findAllByText(/Punjab National Bank/);
    expect(uploadStatement).toHaveBeenCalledWith(file);
    expect(screen.getByText('Detected')).toBeInTheDocument();
    expect(screen.getAllByText(/96 transactions/).length).toBeGreaterThan(0);
    expect(screen.getByText(/…6079/)).toBeInTheDocument();
    expect(screen.getByText(/99\s*%/)).toBeInTheDocument();
    // Toast confirms the parse result.
    expect(await screen.findByRole('status')).toHaveTextContent('Parsed 96 transactions from Punjab National Bank.');
  });

  const WIZARD_RESPONSE = {
    recognized: false,
    wizardEligible: true,
    fileId: 'bankstmt-00000000-0000-4000-8000-000000000001.csv',
    filename: 'maple_bank.csv',
    format: 'csv',
    detectedHeaders: ['Txn Date', 'Particulars', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
    suggested: {
      'Txn Date': 'date', Particulars: 'narration', 'Withdrawal Amt.': 'debit',
      'Deposit Amt.': 'credit', 'Closing Balance': 'balance',
    },
    preview: [['28/06/2026', 'RTGS; PROPERTY ADVANCE RECEIVED', '', '2,50,000.00', '3,05,210.40 Cr.']],
    inferred: { ifsc: 'MUCB0000062', accountNumber: '5566778899001122', bankName: 'Maple Urban Co-op Bank' },
  };

  test('an unrecognised CSV opens the wizard with server headers, suggestions, preview and inferred bank', async () => {
    uploadStatement.mockResolvedValue(WIZARD_RESPONSE);
    const { container } = render(<BankStatementApp />);

    uploadFileTo(container, 'maple_bank.csv');

    await screen.findByText('Not recognised');
    fireEvent.click(screen.getByRole('button', { name: /Map columns/ }));

    // Wizard renders the SERVER-sniffed headers with the SERVER's suggestions.
    expect(screen.getByText('Map columns to canonical fields')).toBeInTheDocument();
    expect(screen.getByLabelText('Map column "Withdrawal Amt." to')).toHaveValue('debit');
    expect(screen.getByLabelText('Map column "Deposit Amt." to')).toHaveValue('credit');
    expect(screen.getByLabelText('Map column "Closing Balance" to')).toHaveValue('balance');
    // Real preview rows keep the mapping honest.
    expect(screen.getByText('RTGS; PROPERTY ADVANCE RECEIVED')).toBeInTheDocument();
    // Bank name pre-filled from the preamble-inferred IFSC.
    expect(screen.getByLabelText('Bank name for the template')).toHaveValue('Maple Urban Co-op Bank');
    // Split debit/credit selection → direction hint, no token inputs.
    expect(screen.getByText(/which of the Debit \/ Credit columns is filled/)).toBeInTheDocument();
  });

  test('applying the mapping parses the file, saves the template, and flips the card to Detected', async () => {
    uploadStatement.mockResolvedValue(WIZARD_RESPONSE);
    applyMapping.mockResolvedValue({
      recognized: true,
      via: 'wizard',
      statementId: 11,
      templateId: 3,
      bank: 'Maple Urban Co-op Bank',
      bankName: 'Maple Urban Co-op Bank',
      format: 'csv',
      account: { account_number: '5566778899001122', ifsc: 'MUCB0000062' },
      txnCount: 5,
      warnings: ['Balance continuity verified: 5 rows reconcile (newest-first)'],
      continuity: { checked: true, direction: 'newest-first', breakCount: 0 },
    });
    const { container } = render(<BankStatementApp />);

    uploadFileTo(container, 'maple_bank.csv');
    await screen.findByText('Not recognised');
    fireEvent.click(screen.getByRole('button', { name: /Map columns/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply mapping' }));

    await waitFor(() => expect(applyMapping).toHaveBeenCalledTimes(1));
    expect(applyMapping).toHaveBeenCalledWith({
      fileId: WIZARD_RESPONSE.fileId,
      filename: 'maple_bank.csv',
      mapping: {
        version: 1,
        columns: {
          'Txn Date': 'date', Particulars: 'narration', 'Withdrawal Amt.': 'debit',
          'Deposit Amt.': 'credit', 'Closing Balance': 'balance',
        },
        options: { dateFormat: 'auto' },
      },
      bankName: 'Maple Urban Co-op Bank',
      saveAsTemplate: true,
    });

    // Card flips to Detected with the parsed count; toast reports the template.
    await screen.findByText('Detected');
    expect(screen.getByText(/5 transactions · a\/c …1122 · CSV/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/Template saved — this bank will auto-detect next time/);
  });

  test('wizard validation blocks applying without a date column', async () => {
    uploadStatement.mockResolvedValue(WIZARD_RESPONSE);
    const { container } = render(<BankStatementApp />);

    uploadFileTo(container, 'maple_bank.csv');
    await screen.findByText('Not recognised');
    fireEvent.click(screen.getByRole('button', { name: /Map columns/ }));

    // Un-map the date column, then try to apply.
    fireEvent.change(screen.getByLabelText('Map column "Txn Date" to'), { target: { value: 'ignore' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply mapping' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Map one column to Date.');
    expect(applyMapping).not.toHaveBeenCalled();
  });

  test('a statement matching a saved template skips the wizard entirely', async () => {
    uploadStatement.mockResolvedValue({
      recognized: true,
      via: 'template',
      templateId: 3,
      statementId: 12,
      bank: 'Maple Urban Co-op Bank',
      bankName: 'Maple Urban Co-op Bank',
      format: 'csv',
      account: { account_number: '5566778899001122' },
      txnCount: 5,
      warnings: [],
      continuity: { checked: true, direction: 'newest-first', breakCount: 0 },
    });
    const { container } = render(<BankStatementApp />);

    uploadFileTo(container, 'maple_bank_july.csv');

    await screen.findByText('Detected');
    expect(screen.queryByRole('button', { name: /Map columns/ })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Auto-detected via saved template — parsed 5 transactions from Maple Urban Co-op Bank.',
    );
  });

  test('an unrecognised PDF explains that a dedicated parser is needed — no wizard', async () => {
    uploadStatement.mockResolvedValue({
      recognized: false,
      wizardEligible: false,
      reason: 'PDF_NEEDS_DEDICATED_PARSER',
      message: 'This PDF layout is not recognised. PDF statements need a dedicated per-bank parser — upload the bank\'s Excel/CSV export instead to map its columns with the wizard.',
      filename: 'unknown_bank.pdf',
      format: 'pdf',
    });
    const { container } = render(<BankStatementApp />);

    uploadFileTo(container, 'unknown_bank.pdf');

    await screen.findByText('Needs dedicated parser');
    expect(screen.getByText(/dedicated per-bank parser/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Map columns/ })).not.toBeInTheDocument();
  });

  test('a failed upload surfaces an error card', async () => {
    uploadStatement.mockRejectedValue(new Error('File content does not match its extension (failed magic-byte check).'));
    const { container } = render(<BankStatementApp />);

    uploadFileTo(container, 'suspicious.xls');

    await screen.findByText('Failed');
    // The reason shows on the card meta (and again in the toast).
    expect(screen.getAllByText(/failed magic-byte check/).length).toBeGreaterThan(0);
  });

  test('previously ingested statements load from the backend on mount', async () => {
    listStatements.mockResolvedValue([STATEMENT_ROW]);
    render(<BankStatementApp />);

    await screen.findByText('pnb_statement.xls');
    expect(screen.getByText('Punjab National Bank')).toBeInTheDocument();
    expect(screen.getByText(/96 transactions/)).toBeInTheDocument();
  });
});

describe('Transactions page — parsed ledger', () => {
  test('renders the selected statement\'s transactions in the DataTable', async () => {
    listStatements.mockResolvedValue([STATEMENT_ROW]);
    getStatementTransactions.mockResolvedValue(TXN_PAGE);
    render(<BankStatementApp />);

    fireEvent.click(screen.getByRole('link', { name: /Transactions/ }));

    // Table rows come straight from the API payload.
    await screen.findByText('UPI/CR/168797098045/Mrs Lale/IDIB/9631574663-2@yb/');
    expect(getStatementTransactions).toHaveBeenCalledWith(7, { page: 1, limit: 500 });

    const table = screen.getByRole('table');
    expect(within(table).getByText('2 Jul 2026')).toBeInTheDocument();
    expect(within(table).getByText('₹500.00')).toBeInTheDocument();      // credit
    expect(within(table).getByText('₹300.00')).toBeInTheDocument();      // debit
    expect(within(table).getByText('₹2,274.95 Cr')).toBeInTheDocument(); // balance + type
    // Account identity appears (page subtitle and/or statement selector).
    expect(screen.getAllByText(/a\/c …6079/).length).toBeGreaterThan(0);
    expect(screen.getByText(/ABHISHEK BHARDWAJ/)).toBeInTheDocument();
  });

  test('counterparty columns augment the ledger; low confidence is marked, narration stays visible', async () => {
    listStatements.mockResolvedValue([STATEMENT_ROW]);
    getStatementTransactions.mockResolvedValue(TXN_PAGE);
    render(<BankStatementApp />);
    fireEvent.click(screen.getByRole('link', { name: /Transactions/ }));

    const table = within(await screen.findByRole('table'));

    // Extracted counterparty fields render alongside the RAW narration.
    expect(table.getByText('Mrs Lale')).toBeInTheDocument();
    expect(table.getByText('9631574663-2@yb')).toBeInTheDocument();
    expect(table.getAllByText('UPI')).toHaveLength(2);       // channel chips
    expect(table.getByText('INTEREST')).toBeInTheDocument();
    expect(table.getByText('UPI/CR/168797098045/Mrs Lale/IDIB/9631574663-2@yb/')).toBeInTheDocument();

    // Low-confidence extraction (row 2) carries the ≈ marker + tooltip;
    // the high-confidence and non-counterparty rows do not.
    const markers = table.getAllByLabelText('Partial extraction — verify against narration');
    expect(markers).toHaveLength(2); // name cell + identifier cell of row 2
    expect(markers[0]).toHaveAttribute('title', 'Partial extraction — verify against narration');

    // Non-counterparty rows stay honestly blank (dashes, no fabrication).
    const interestRow = table.getByText('4563000100036079:Int.Pd:01-03-2026 to 31-05-2026').closest('tr');
    expect(within(interestRow).getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  test('shows the upload-first empty state when no statements exist', async () => {
    listStatements.mockResolvedValue([]);
    render(<BankStatementApp />);

    fireEvent.click(screen.getByRole('link', { name: /Transactions/ }));

    await screen.findByText(/upload a bank statement first/i);
    expect(getStatementTransactions).not.toHaveBeenCalled();
  });

  test('summary header: in/out stat cards + behavioral flag chips with why-tooltips', async () => {
    listStatements.mockResolvedValue([STATEMENT_ROW]);
    getStatementTransactions.mockResolvedValue(TXN_PAGE);
    getStatementAnalysis.mockResolvedValue({ statementId: 7, analyzed_at: 'x', analysis: ANALYSIS_DOC });
    render(<BankStatementApp />);
    fireEvent.click(screen.getByRole('link', { name: /Transactions/ }));

    // Aggregation headline (reconciles with ingestion totals).
    await screen.findByText('Total In');
    expect(screen.getByText('₹43,852.00')).toBeInTheDocument();
    expect(screen.getByText('₹50,196.00')).toBeInTheDocument();
    expect(screen.getByText('-₹6,344.00')).toBeInTheDocument();
    expect(screen.getByText(/opened at ₹8,618.95/)).toBeInTheDocument();

    // Flags render as chips whose tooltip carries the plain-language why.
    const flagsRow = screen.getByRole('list', { name: 'Behavioral flags' });
    expect(within(flagsRow).getByText('Pass-through')).toBeInTheDocument();
    expect(within(flagsRow).getByText('Verify low-confidence')).toBeInTheDocument();
    expect(screen.getByTitle(/left the account the SAME day/)).toBeInTheDocument();
  });

  test('the ledger stays fully usable when the analysis fetch fails', async () => {
    listStatements.mockResolvedValue([STATEMENT_ROW]);
    getStatementTransactions.mockResolvedValue(TXN_PAGE);
    // default getStatementAnalysis mock rejects
    render(<BankStatementApp />);
    fireEvent.click(screen.getByRole('link', { name: /Transactions/ }));

    await screen.findByText('UPI/CR/168797098045/Mrs Lale/IDIB/9631574663-2@yb/');
    expect(screen.queryByText('Total In')).not.toBeInTheDocument();
  });
});

describe('Counterparty page — distribution, top-N, honesty caveat, drill-down', () => {
  beforeEach(() => {
    listStatements.mockResolvedValue([STATEMENT_ROW]);
    getStatementTransactions.mockResolvedValue(TXN_PAGE);
    getStatementAnalysis.mockResolvedValue({ statementId: 7, analyzed_at: 'x', analysis: ANALYSIS_DOC });
  });

  test('renders the distribution with confidence markers and the caveat banner', async () => {
    render(<BankStatementApp />);
    fireEvent.click(screen.getByRole('link', { name: /Counterparty/ }));

    // Appears in BOTH top-5 cards and the distribution table.
    expect(await screen.findAllByText('MRS LALE')).toHaveLength(3);
    // Caveat surfaces the low-confidence honesty note.
    expect(screen.getByText(/includes 1 low-confidence counterparty group/)).toBeInTheDocument();
    // Distribution table: identifiers, kind chips, amounts.
    const table = within(screen.getByRole('table'));
    expect(table.getByText('9631574663-2@yb')).toBeInTheDocument();
    expect(table.getAllByText('VPA').length).toBeGreaterThan(0);
    expect(table.getAllByText('₹500.00').length).toBeGreaterThan(0); // received + net cells
    // The low-confidence group wears the ≈ marker inside the table too.
    expect(table.getAllByLabelText(/verify against narration/i).length).toBeGreaterThan(0);
    // Top-5 cards present both rankings.
    expect(screen.getByText('Top by amount')).toBeInTheDocument();
    expect(screen.getByText('Top by frequency')).toBeInTheDocument();
    // Distinct-counterparty count appears in the header.
    expect(screen.getByText(/2 distinct counterparties/)).toBeInTheDocument();
  });

  test('expanding a counterparty row reveals its transactions with the RAW narration', async () => {
    render(<BankStatementApp />);
    fireEvent.click(screen.getByRole('link', { name: /Counterparty/ }));

    const cells = await screen.findAllByText('MRS LALE');
    const nameCell = cells.find((el) => el.closest('tr')); // the table instance
    fireEvent.click(nameCell.closest('tr'));

    await screen.findByText('UPI/CR/168797098045/Mrs Lale/IDIB/9631574663-2@yb/');
    expect(screen.getByText('Narration (raw)')).toBeInTheDocument();
  });

  test('shows the upload-first empty state when no statements exist', async () => {
    listStatements.mockResolvedValue([]);
    render(<BankStatementApp />);
    fireEvent.click(screen.getByRole('link', { name: /Counterparty/ }));

    await screen.findByText(/upload a bank statement first/i);
    expect(getStatementAnalysis).not.toHaveBeenCalled();
  });
});
