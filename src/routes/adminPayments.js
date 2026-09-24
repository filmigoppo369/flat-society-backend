const express = require('express');
const supabase = require('../lib/supabase');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

// GET /api/admin/payments?status=pending&month=2026-09
router.get('/', adminAuth, async (req, res) => {
  try {
    const { status, month } = req.query;

    let query = supabase
      .from('payments')
      .select('id, flat_number_snapshot, owner_name_snapshot, month, amount, upi_reference, screenshot_path, status, source, submitted_at, approved_at, remarks')
      .order('submitted_at', { ascending: false });

    if (status) query = query.eq('status', status);
    if (month) query = query.eq('month', month);

    const { data, error } = await query;

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ success: true, count: data.length, data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
// POST /api/admin/payments/cash → admin records cash maintenance (auto approved)
router.post('/cash', adminAuth, async (req, res) => {
  try {
    const { flat_id, month, amount, remarks } = req.body || {};

    if (!flat_id || !month || !amount) {
      return res.status(400).json({ error: 'flat_id, month and amount are required' });
    }

    const monthRegex = /^\d{4}-(0[1-9]|1[0-2])$/;
    if (!monthRegex.test(month)) {
      return res.status(400).json({ error: 'month must be in YYYY-MM format, e.g. 2026-09' });
    }

    const amountNumber = Number(amount);
    if (!amountNumber || amountNumber <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    // Flat must exist
    const { data: flat, error: flatError } = await supabase
      .from('flats')
      .select('id, flat_number, owner_name')
      .eq('id', flat_id)
      .single();

    if (flatError || !flat) {
      return res.status(400).json({ error: 'Invalid flat_id' });
    }

    // Duplicate check: same flat + month already pending or approved?
    const { data: existing } = await supabase
      .from('payments')
      .select('id, status')
      .eq('flat_id', flat_id)
      .eq('month', month)
      .in('status', ['pending', 'approved'])
      .maybeSingle();

    if (existing) {
      return res.status(400).json({
        error: `A ${existing.status} payment already exists for this flat and month`
      });
    }

    // Insert as approved cash payment (no screenshot)
    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .insert([
        {
          flat_id: flat.id,
          flat_number_snapshot: flat.flat_number,
          owner_name_snapshot: flat.owner_name,
          month,
          amount: amountNumber,
          upi_reference: null,
          screenshot_path: null,
          status: 'approved',
          source: 'cash',
          remarks: remarks || 'Cash payment received by admin',
          approved_at: new Date().toISOString()
        }
      ])
      .select()
      .single();

    if (paymentError) {
      return res.status(500).json({ error: paymentError.message });
    }

    // Create ledger credit so bank balance updates
    const { data: settings } = await supabase
      .from('settings')
      .select('opening_balance')
      .eq('id', 1)
      .single();

    const { data: ledgerRows } = await supabase.from('ledger').select('type, amount');

    let balance = Number(settings?.opening_balance || 0);
    (ledgerRows || []).forEach((row) => {
      balance += row.type === 'credit' ? Number(row.amount) : -Number(row.amount);
    });

    const balanceAfter = balance + amountNumber;

    const { error: ledgerError } = await supabase.from('ledger').insert([
      {
        entry_date: new Date().toISOString(),
        type: 'credit',
        amount: amountNumber,
        reference_type: 'payment',
        reference_id: payment.id,
        description: `Cash maintenance ${flat.flat_number} ${month}`,
        balance_after_transaction: balanceAfter
      }
    ]);

    if (ledgerError) {
      return res.status(500).json({ error: 'Payment saved but ledger entry failed: ' + ledgerError.message });
    }

    return res.status(201).json({
      success: true,
      message: `Cash payment of Rs ${amountNumber} recorded for ${flat.flat_number} (${month}). Auto-approved.`,
      paymentId: payment.id,
      balance_after: balanceAfter
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
// GET /api/admin/payments/:id/screenshot
router.get('/:id/screenshot', adminAuth, async (req, res) => {
  try {
    const { data: payment, error } = await supabase
      .from('payments')
      .select('id, screenshot_path')
      .eq('id', req.params.id)
      .single();

    if (error || !payment) return res.status(404).json({ error: 'Payment not found' });

    // Signed URL valid for 600 seconds (10 minutes)
    const { data: signed, error: signError } = await supabase.storage
      .from('payment-screenshots')
      .createSignedUrl(payment.screenshot_path, 600);

    if (signError) return res.status(500).json({ error: signError.message });

    return res.json({ success: true, signedUrl: signed.signedUrl });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/payments/:id/approve
router.post('/:id/approve', adminAuth, async (req, res) => {
  try {
    // 1. Load payment
    const { data: payment, error: fetchError } = await supabase
      .from('payments')
      .select('id, flat_number_snapshot, owner_name_snapshot, month, amount, status')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !payment) return res.status(404).json({ error: 'Payment not found' });

    if (payment.status !== 'pending') {
      return res.status(400).json({ error: `Payment is already ${payment.status}` });
    }

    // 2. Mark approved (only if still pending)
    const { error: updateError } = await supabase
      .from('payments')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', payment.id)
      .eq('status', 'pending');

    if (updateError) return res.status(500).json({ error: updateError.message });

    // 3. Calculate current bank balance before this credit
    const { data: settings } = await supabase
      .from('settings')
      .select('opening_balance')
      .eq('id', 1)
      .single();

    const { data: ledgerRows } = await supabase.from('ledger').select('type, amount');

    let balance = Number(settings?.opening_balance || 0);
    (ledgerRows || []).forEach((row) => {
      balance += row.type === 'credit' ? Number(row.amount) : -Number(row.amount);
    });

    const balanceAfter = balance + Number(payment.amount);

    // 4. Insert credit ledger entry
    const { error: ledgerError } = await supabase.from('ledger').insert([
      {
        entry_date: new Date().toISOString(),
        type: 'credit',
        amount: Number(payment.amount),
        reference_type: 'payment',
        reference_id: payment.id,
        description: `Maintenance ${payment.flat_number_snapshot} ${payment.month}`,
        balance_after_transaction: balanceAfter
      }
    ]);

    if (ledgerError) {
      return res.status(500).json({ error: 'Approved but ledger entry failed: ' + ledgerError.message });
    }

    return res.json({
      success: true,
      message: `Payment approved. Rs ${payment.amount} added to society account.`,
      balance_after: balanceAfter
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/payments/:id/reject
router.post('/:id/reject', adminAuth, async (req, res) => {
  try {
    const { remarks } = req.body || {};

    const { data: payment, error: fetchError } = await supabase
      .from('payments')
      .select('id, status')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !payment) return res.status(404).json({ error: 'Payment not found' });

    if (payment.status !== 'pending') {
      return res.status(400).json({ error: `Payment is already ${payment.status}` });
    }

    const { error: updateError } = await supabase
      .from('payments')
      .update({ status: 'rejected', remarks: remarks || null })
      .eq('id', payment.id)
      .eq('status', 'pending');

    if (updateError) return res.status(500).json({ error: updateError.message });

    return res.json({ success: true, message: 'Payment rejected. No ledger entry created.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
// DELETE /api/admin/payments/:id
router.delete('/:id', adminAuth, async (req, res) => {
  try {
    // 1. Load payment
    const { data: payment, error: fetchError } = await supabase
      .from('payments')
      .select('id, flat_number_snapshot, month, amount, status')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // 2. Remove linked ledger entry (credit) so balance recalculates
    const { error: ledgerError } = await supabase
      .from('ledger')
      .delete()
      .eq('reference_type', 'payment')
      .eq('reference_id', payment.id);

    if (ledgerError) {
      return res.status(500).json({ error: 'Ledger cleanup failed: ' + ledgerError.message });
    }

    // 3. Delete the payment row
    const { error: deleteError } = await supabase
      .from('payments')
      .delete()
      .eq('id', payment.id);

    if (deleteError) {
      return res.status(500).json({ error: deleteError.message });
    }

    return res.json({
      success: true,
      message: `Payment of Rs ${payment.amount} for ${payment.flat_number_snapshot} (${payment.month}) deleted. Balance updated.`
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;