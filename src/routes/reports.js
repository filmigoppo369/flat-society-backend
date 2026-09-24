const express = require('express');
const ExcelJS = require('exceljs');
const supabase = require('../lib/supabase');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

// Helper: first and last day boundaries of a month
function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { start, end: next };
}

// Helper: current bank balance from settings + ledger
async function getBankBalance() {
  const { data: settings } = await supabase
    .from('settings')
    .select('opening_balance')
    .eq('id', 1)
    .single();

  const { data: ledgerRows } = await supabase.from('ledger').select('type, amount');

  const openingBalance = Number(settings?.opening_balance || 0);
  let balance = openingBalance;

  (ledgerRows || []).forEach((row) => {
    balance += row.type === 'credit' ? Number(row.amount) : -Number(row.amount);
  });

  return { openingBalance, currentBalance: balance };
}

// Helper: gather all report data for one month
async function getMonthData(month) {
  const range = monthRange(month);

  const { data: approved, error: approvedError } = await supabase
    .from('payments')
    .select('id, flat_number_snapshot, owner_name_snapshot, month, amount, upi_reference, submitted_at, status')
    .eq('month', month)
    .eq('status', 'approved')
    .order('flat_number_snapshot', { ascending: true });

  const { data: pending, error: pendingError } = await supabase
    .from('payments')
    .select('flat_number_snapshot, owner_name_snapshot, month, amount, submitted_at, status')
    .eq('month', month)
    .eq('status', 'pending')
    .order('flat_number_snapshot', { ascending: true });

  const { data: expenses, error: expensesError } = await supabase
    .from('expenses')
    .select('expense_date, title, category, amount, payment_mode, reference_no')
    .gte('expense_date', range.start)
    .lt('expense_date', range.end)
    .order('expense_date', { ascending: true });

  const { data: flats } = await supabase
    .from('flats')
    .select('flat_number, owner_name, monthly_maintenance')
    .eq('is_active', true)
    .order('flat_number', { ascending: true });

  const paidSet = new Set((approved || []).map((p) => p.flat_number_snapshot));
  const defaulters = (flats || []).filter((f) => !paidSet.has(f.flat_number));

  const totalCollected = (approved || []).reduce((s, p) => s + Number(p.amount), 0);
  const totalPendingAmount = (pending || []).reduce((s, p) => s + Number(p.amount), 0);
  const totalExpenses = (expenses || []).reduce((s, e) => s + Number(e.amount), 0);

  const errors = [approvedError, pendingError, expensesError].filter(Boolean);

  return {
    approved: approved || [],
    pending: pending || [],
    expenses: expenses || [],
    defaulters,
    totalCollected,
    totalPendingAmount,
    totalExpenses,
    errors
  };
}

// GET /api/admin/reports/monthly?month=2026-09
router.get('/monthly', adminAuth, async (req, res) => {
  const month = req.query.month;

  if (!MONTH_REGEX.test(month || '')) {
    return res.status(400).json({ error: 'month query required in YYYY-MM format, e.g. 2026-09' });
  }

  const data = await getMonthData(month);
  if (data.errors.length) return res.status(500).json({ error: data.errors[0].message });

  const bank = await getBankBalance();

  return res.json({
    success: true,
    month,
    totalCollected: data.totalCollected,
    collection: data.approved,
    totalPendingAmount: data.totalPendingAmount,
    pending: data.pending,
    totalExpenses: data.totalExpenses,
    expenses: data.expenses,
    notPaidCount: data.defaulters.length,
    notPaid: data.defaulters,
    bank
  });
});

// GET /api/admin/reports/monthly.xlsx?month=2026-09
router.get('/monthly.xlsx', adminAuth, async (req, res) => {
  const month = req.query.month;

  if (!MONTH_REGEX.test(month || '')) {
    return res.status(400).json({ error: 'month query required in YYYY-MM format, e.g. 2026-09' });
  }

  const data = await getMonthData(month);
  if (data.errors.length) return res.status(500).json({ error: data.errors[0].message });

  const bank = await getBankBalance();

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Flat Society Maintenance App';
  workbook.created = new Date();

  // ---------- Sheet 1: Collection ----------
  const ws1 = workbook.addWorksheet('Collection');
  ws1.columns = [
    { header: 'Sr No', key: 'sr', width: 8 },
    { header: 'Flat No', key: 'flat', width: 12 },
    { header: 'Owner Name', key: 'owner', width: 25 },
    { header: 'Month', key: 'month', width: 10 },
    { header: 'Amount', key: 'amount', width: 12 },
    { header: 'UPI Reference', key: 'upi', width: 22 },
    { header: 'Submitted At', key: 'submitted', width: 24 },
    { header: 'Status', key: 'status', width: 12 }
  ];

  data.approved.forEach((p, i) => {
    ws1.addRow({
      sr: i + 1,
      flat: p.flat_number_snapshot,
      owner: p.owner_name_snapshot,
      month: p.month,
      amount: Number(p.amount),
      upi: p.upi_reference || '',
      submitted: p.submitted_at,
      status: p.status
    });
  });

  ws1.addRow({});
  const totalRow = ws1.addRow({ owner: 'Total Collected', amount: data.totalCollected });
  totalRow.font = { bold: true };
  ws1.getRow(1).font = { bold: true };

  // ---------- Sheet 2: Pending ----------
  const ws2 = workbook.addWorksheet('Pending');
  ws2.columns = [
    { header: 'Sr No', key: 'sr', width: 8 },
    { header: 'Flat No', key: 'flat', width: 12 },
    { header: 'Owner Name', key: 'owner', width: 25 },
    { header: 'Month', key: 'month', width: 10 },
    { header: 'Amount', key: 'amount', width: 12 },
    { header: 'Submitted At', key: 'submitted', width: 24 },
    { header: 'Status', key: 'status', width: 12 }
  ];

  data.pending.forEach((p, i) => {
    ws2.addRow({
      sr: i + 1,
      flat: p.flat_number_snapshot,
      owner: p.owner_name_snapshot,
      month: p.month,
      amount: Number(p.amount),
      submitted: p.submitted_at,
      status: p.status
    });
  });

  ws2.addRow({});
  const pendingTotalRow = ws2.addRow({ owner: 'Total Pending', amount: data.totalPendingAmount });
  pendingTotalRow.font = { bold: true };
  ws2.getRow(1).font = { bold: true };

  // ---------- Sheet 3: Not Paid ----------
  const ws3 = workbook.addWorksheet('Not Paid');
  ws3.columns = [
    { header: 'Sr No', key: 'sr', width: 8 },
    { header: 'Flat No', key: 'flat', width: 12 },
    { header: 'Owner Name', key: 'owner', width: 25 },
    { header: 'Expected Amount', key: 'expected', width: 18 }
  ];

  data.defaulters.forEach((f, i) => {
    ws3.addRow({
      sr: i + 1,
      flat: f.flat_number,
      owner: f.owner_name,
      expected: f.monthly_maintenance ? Number(f.monthly_maintenance) : ''
    });
  });

  ws3.getRow(1).font = { bold: true };

  // ---------- Sheet 4: Expenses ----------
  const ws4 = workbook.addWorksheet('Expenses');
  ws4.columns = [
    { header: 'Sr No', key: 'sr', width: 8 },
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Title', key: 'title', width: 30 },
    { header: 'Category', key: 'category', width: 18 },
    { header: 'Amount', key: 'amount', width: 12 },
    { header: 'Payment Mode', key: 'mode', width: 16 },
    { header: 'Reference', key: 'ref', width: 20 }
  ];

  data.expenses.forEach((e, i) => {
    ws4.addRow({
      sr: i + 1,
      date: e.expense_date,
      title: e.title,
      category: e.category || '',
      amount: Number(e.amount),
      mode: e.payment_mode || '',
      ref: e.reference_no || ''
    });
  });

  ws4.addRow({});
  const expenseTotalRow = ws4.addRow({ title: 'Total Expenses', amount: data.totalExpenses });
  expenseTotalRow.font = { bold: true };
  ws4.getRow(1).font = { bold: true };

  // ---------- Sheet 5: Summary ----------
  const ws5 = workbook.addWorksheet('Summary');
  ws5.columns = [
    { header: 'Item', key: 'item', width: 35 },
    { header: 'Value', key: 'value', width: 20 }
  ];

  ws5.addRow({ item: 'Month', value: month });
  ws5.addRow({ item: 'Opening Balance', value: bank.openingBalance });
  ws5.addRow({ item: 'Total Collected', value: data.totalCollected });
  ws5.addRow({ item: 'Total Expenses', value: data.totalExpenses });
  ws5.addRow({ item: 'Current Bank Balance', value: bank.currentBalance });
  ws5.addRow({ item: 'Pending Payments Count', value: data.pending.length });
  ws5.addRow({ item: 'Pending Amount', value: data.totalPendingAmount });
  ws5.addRow({ item: 'Not Paid Flats Count', value: data.defaulters.length });

  ws5.getRow(1).font = { bold: true };
  ws5.getRow(6).font = { bold: true };

  // ---------- Send file ----------
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename=maintenance-report-${month}.xlsx`
  );

  await workbook.xlsx.write(res);
  res.end();
});

module.exports = router;