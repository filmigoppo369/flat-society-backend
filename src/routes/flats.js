const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const { Readable } = require('stream');
const supabase = require('../lib/supabase');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }
});

router.post('/import', adminAuth, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No CSV file uploaded. Please send a file with form-data key "file".' });
  }

  const results = [];

  Readable.from(req.file.buffer)
    .pipe(csv())
    .on('data', (row) => {
      const flatNumber = row.flat_number?.trim().toUpperCase();
      const ownerName = row.owner_name?.trim();

      if (flatNumber && ownerName) {
        results.push({
          flat_number: flatNumber,
          owner_name: ownerName,
          phone: row.phone?.trim() || null,
          email: row.email?.trim() || null,
          monthly_maintenance: row.monthly_maintenance ? Number(row.monthly_maintenance) : null
        });
      }
    })
    .on('end', async () => {
      if (results.length === 0) {
        return res.status(400).json({ error: 'CSV file is empty or missing required columns (flat_number, owner_name)' });
      }

      const { data, error } = await supabase
        .from('flats')
        .upsert(results, { onConflict: 'flat_number' })
        .select();

      if (error) {
        return res.status(500).json({ error: 'Database error: ' + error.message });
      }

      res.json({
        success: true,
        message: `${results.length} flats imported/updated successfully`,
        count: results.length
      });
    })
    .on('error', (err) => {
      res.status(500).json({ error: 'Error parsing CSV: ' + err.message });
    });
});

module.exports = router;