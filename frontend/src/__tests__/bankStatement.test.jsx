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
  };
});

import BankStatementApp from '../modules/bankStatement/BankStatementApp.jsx';
import {
  listStatements, uploadStatement, getStatementTransactions, applyMapping,
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
    },
    {
      id: 2, statement_id: 7, txn_date: '2026-07-01T00:00:00.000Z', value_date: null,
      narration: 'UPI/DR/360729244657/RAM BAHA/BARB/8004806574@axl/P',
      debit_amount: 300, credit_amount: null, balance: 1774.95, balance_type: 'Cr',
      ref_no: 'T48579145', source_row: 21,
    },
  ],
  total: 2, page: 1, limit: 500, total_pages: 1,
};

function uploadFileTo(container, name) {
  const input = container.querySelector('input[type="file"]');
  const file = new File(['statement-bytes'], name, { type: 'application/vnd.ms-excel' });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

beforeEach(() => {
  vi.clearAllMocks();
  listStatements.mockResolvedValue([]);
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

  test('shows the upload-first empty state when no statements exist', async () => {
    listStatements.mockResolvedValue([]);
    render(<BankStatementApp />);

    fireEvent.click(screen.getByRole('link', { name: /Transactions/ }));

    await screen.findByText(/upload a bank statement first/i);
    expect(getStatementTransactions).not.toHaveBeenCalled();
  });
});
