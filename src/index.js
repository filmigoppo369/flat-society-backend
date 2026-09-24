require('dotenv').config();
const app = require('./app');
const cron = require('node-cron');
const { cleanupOldScreenshots } = require('./jobs/cleanupScreenshots');

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});

// Local/dev cron. On Netlify we use an external daily ping instead.
cleanupOldScreenshots();
cron.schedule('0 3 * * *', () => {
  cleanupOldScreenshots();
});