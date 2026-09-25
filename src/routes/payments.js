const express = require('express');
const multer = require('multer');
const supabase = require('../lib/supabase');

const router = express.Router();

// Keep uploaded file in memory, then push straight to Supabase Storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }, // 4 MB max (serverless platform limit)
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPG, PNG or WEBP images are allowed'));
    }
  }
});

// POST /api/payments  (public route for flat owners)
router.post('/', upload.single('screenshot'), async (req, res) => {
  try {
    const { flat_id, month, amount, upi_reference } = req.body;

    // 1. Basic validation
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

    if (!req.file) {
      return res.status(400).json({ error: 'UPI screenshot is required' });
    }

    // 2. Get flat details for snapshot
    const { data: flat, error: flatError } = await supabase
      .from('flats')
      .select('id, flat_number, owner_name')
      .eq('id', flat_id)
      .single();

    if (flatError || !flat) {
      return res.status(400).json({ error: 'Invalid flat_id' });
    }

    // 3. Duplicate check: block if pending or approved payment exists
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

    // 4. Upload screenshot to Supabase Storage
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const filePath = `payments/${month}/${flat.flat_number}/${Date.now()}-${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from('payment-screenshots')
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });

    if (uploadError) {
      return res.status(500).json({ error: 'Screenshot upload failed: ' + uploadError.message });
    }

    // 5. Save payment record as pending
    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .insert([
        {
          flat_id: flat.id,
          flat_number_snapshot: flat.flat_number,
          owner_name_snapshot: flat.owner_name,
          month,
          amount: amountNumber,
          upi_reference: upi_reference || null,
          screenshot_path: filePath,
          status: 'pending',
                   source: ['manual_upload', 'android_share', 'pwa_share', 'admin', 'cash'].includes(req.body.source)
            ? req.body.source
            : 'manual_upload',
        }
      ])
      .select()
      .single();

    if (paymentError) {
      return res.status(500).json({ error: 'Payment save failed: ' + paymentError.message });
    }

    return res.status(201).json({
      success: true,
      message: 'Payment submitted. Waiting for admin approval.',
      paymentId: payment.id
    });
  } catch (err) {
    // multer errors (wrong file type, file too large) land here
    return res.status(400).json({ error: err.message });
  }
});

module.exports = router;