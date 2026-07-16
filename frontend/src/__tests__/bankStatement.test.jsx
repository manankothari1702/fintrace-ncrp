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
  };
});

import BankStatementApp from '../modules/bankStatement/BankStatementApp.jsx';
import {
  listStatements, uploadStatement, getStatementTransactions,
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

  test('an unrecognised file shows "Not recognised" and opens the mapping wizard with real sniffed headers', async () => {
    uploadStatement.mockResolvedValue({
      recognized: false,
      filename: 'other_bank.xlsx',
      format: 'excel',
      detectedHeaders: ['Txn Date', 'Particulars', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
    });
    const { container } = render(<BankStatementApp />);

    uploadFileTo(container, 'other_bank.xlsx');

    await screen.findByText('Not recognised');
    fireEvent.click(screen.getByRole('button', { name: /Map columns/ }));

    // Wizard renders the SERVER-sniffed headers with sensible suggestions.
    expect(screen.getByText('Map columns to canonical fields')).toBeInTheDocument();
    expect(screen.getByText('Particulars')).toBeInTheDocument();
    expect(screen.getByLabelText('Map column "Withdrawal Amt." to')).toHaveValue('debit');
    expect(screen.getByLabelText('Map column "Deposit Amt." to')).toHaveValue('credit');
    expect(screen.getByLabelText('Map column "Closing Balance" to')).toHaveValue('balance');
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
