const express = require('express');
const supabase = require('../lib/supabase');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { start, end: next };
}

// Helper: ledger summary = opening + credits - debits
async function getLedgerSummary() {
  const { data: settings } = await supabase
    .from('settings')
    .select('opening_balance')
    .eq('id', 1)
    .single();

  const { data: ledgerRows } = await supabase.from('ledger').select('type, amount');

  const openingBalance = Number(settings?.opening_balance || 0);
  let credits = 0;
  let debits = 0;

  (ledgerRows || []).forEach((row) => {
    if (row.type === 'credit') credits += Number(row.amount);
    else debits += Number(row.amount);
  });

  return {
    openingBalance,
    totalCredits: credits,
    totalDebits: debits,
    currentBalance: openingBalance + credits - debits
  };
}

// POST /api/admin/expenses
router.post('/expenses', adminAuth, async (req, res) => {
  try {
    const { expense_date, title, category, payment_mode, reference_no, notes, amount } = req.body || {};

    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'title is required' });
    }

    const amountNumber = Number(amount);
    if (!amountNumber || amountNumber <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    const dateValue = expense_date || new Date().toISOString().slice(0, 10);
    if (!DATE_REGEX.test(dateValue)) {
      return res.status(400).json({ error: 'expense_date must be in YYYY-MM-DD format' });
    }

    // 1. Insert expense row
    const { data: expense, error: expenseError } = await supabase
      .from('expenses')
      .insert([
        {
          expense_date: dateValue,
          title: String(title).trim(),
          category: category || null,
          amount: amountNumber,
          payment_mode: payment_mode || null,
          reference_no: reference_no || null,
          notes: notes || null
        }
      ])
      .select()
      .single();

    if (expenseError) return res.status(500).json({ error: expenseError.message });

    // 2. Create debit ledger entry
    const summary = await getLedgerSummary();
    const balanceAfter = summary.currentBalance - amountNumber;

    const { error: ledgerError } = await supabase.from('ledger').insert([
      {
        entry_date: dateValue,
        type: 'debit',
        amount: amountNumber,
        reference_type: 'expense',
        reference_id: expense.id,
        description: String(title).trim(),
        balance_after_transaction: balanceAfter
      }
    ]);

    if (ledgerError) {
      return res.status(500).json({ error: 'Expense saved but ledger entry failed: ' + ledgerError.message });
    }

    return res.status(201).json({
      success: true,
      message: `Expense added. Rs ${amountNumber} deducted from society account.`,
      expenseId: expense.id,
      balance_after: balanceAfter
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/expenses?month=2026-09
router.get('/expenses', adminAuth, async (req, res) => {
  try {
    const { month } = req.query;

    let query = supabase
      .from('expenses')
      .select('id, expense_date, title, category, amount, payment_mode, reference_no, notes, created_at')
      .order('expense_date', { ascending: false });

    if (month) {
      if (!MONTH_REGEX.test(month)) {
        return res.status(400).json({ error: 'month must be in YYYY-MM format' });
      }
      const range = monthRange(month);
      query = query.gte('expense_date', range.start).lt('expense_date', range.end);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const total = (data || []).reduce((s, e) => s + Number(e.amount), 0);

    return res.json({ success: true, count: (data || []).length, total, data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/bank-balance
router.get('/bank-balance', adminAuth, async (req, res) => {
  try {
    const summary = await getLedgerSummary();
    return res.json({ success: true, ...summary });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
// DELETE /api/admin/expenses/:id
router.delete('/expenses/:id', adminAuth, async (req, res) => {
  try {
    // 1. Load expense
    const { data: expense, error: fetchError } = await supabase
      .from('expenses')
      .select('id, title, amount')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !expense) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    // 2. Delete linked ledger debit entry so balance recalculates
    const { error: ledgerError } = await supabase
      .from('ledger')
      .delete()
      .eq('reference_type', 'expense')
      .eq('reference_id', expense.id);

    if (ledgerError) {
      return res.status(500).json({ error: 'Ledger cleanup failed: ' + ledgerError.message });
    }

    // 3. Delete the expense row
    const { error: deleteError } = await supabase
      .from('expenses')
      .delete()
      .eq('id', expense.id);

    if (deleteError) {
      return res.status(500).json({ error: deleteError.message });
    }

    return res.json({
      success: true,
      message: `Expense deleted. Rs ${expense.amount} added back to bank balance.`
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
module.exports = router;