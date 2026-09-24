const express = require('express');
const cors = require('cors');

const supabase = require('./lib/supabase');
const adminAuth = require('./middleware/adminAuth');
const flatsRouter = require('./routes/flats');
const paymentsRouter = require('./routes/payments');
const adminPaymentsRouter = require('./routes/adminPayments');
const reportsRouter = require('./routes/reports');
const expensesRouter = require('./routes/expenses');
const maintenanceRouter = require('./routes/maintenance');

const app = express();

app.use(cors());
app.use(express.json());

// Public
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Flat society backend is running' });
});

app.get('/api/flats', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('flats')
      .select('id, flat_number, owner_name, monthly_maintenance')
      .eq('is_active', true)
      .order('flat_number', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/payment-options', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('payment_amount_options')
      .select('id, label, amount')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Admin
app.get('/api/admin/test', adminAuth, (req, res) => {
  res.json({ success: true, message: 'Admin route is working' });
});

app.use('/api/admin/flats', flatsRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/admin/payments', adminPaymentsRouter);
app.use('/api/admin/reports', reportsRouter);
app.use('/api/admin', expensesRouter);
app.use('/api/admin/maintenance', maintenanceRouter);

module.exports = app;