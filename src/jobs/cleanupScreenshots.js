const supabase = require('../lib/supabase');

const MONTHS_TO_KEEP = 3;

async function cleanupOldScreenshots() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - MONTHS_TO_KEEP);
  const cutoffIso = cutoff.toISOString();

  const { data: rows, error } = await supabase
    .from('payments')
    .select('id, screenshot_path')
    .not('screenshot_path', 'is', null)
    .is('screenshot_deleted_at', null)
    .lt('submitted_at', cutoffIso);

  if (error) {
    console.error('[cleanup] query error:', error.message);
    return { deleted: 0, error: error.message };
  }

  if (!rows || rows.length === 0) {
    console.log('[cleanup] no old screenshots to delete');
    return { deleted: 0 };
  }

  const paths = rows.map((r) => r.screenshot_path);
  const ids = rows.map((r) => r.id);

  const { error: removeError } = await supabase.storage
    .from('payment-screenshots')
    .remove(paths);

  if (removeError) {
    console.error('[cleanup] storage remove error:', removeError.message);
    return { deleted: 0, error: removeError.message };
  }

  const { error: updateError } = await supabase
    .from('payments')
    .update({ screenshot_deleted_at: new Date().toISOString() })
    .in('id', ids);

  if (updateError) {
    console.error('[cleanup] update error:', updateError.message);
    return { deleted: rows.length, error: updateError.message };
  }

  console.log(`[cleanup] deleted ${rows.length} old screenshot(s)`);
  return { deleted: rows.length };
}

module.exports = { cleanupOldScreenshots };