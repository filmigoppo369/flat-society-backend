const express = require('express');
const adminAuth = require('../middleware/adminAuth');
const { cleanupOldScreenshots } = require('../jobs/cleanupScreenshots');

const router = express.Router();

// POST /api/admin/maintenance/cleanup-screenshots  (manual or cron trigger)
router.post('/cleanup-screenshots', adminAuth, async (req, res) => {
  const result = await cleanupOldScreenshots();
  if (result.error) {
    return res.status(500).json({ error: result.error });
  }
  return res.json({
    success: true,
    message: `${result.deleted} old screenshot(s) deleted`,
    deleted: result.deleted
  });
});

module.exports = router;