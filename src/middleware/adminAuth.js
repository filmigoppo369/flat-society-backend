// Load .env so we can read ADMIN_API_KEY
require('dotenv').config();

// The middleware function. Express always passes (req, res, next)
function adminAuth(req, res, next) {

  // 1. Read the custom header "x-admin-key" from the incoming request
  const adminKey = req.headers['x-admin-key'];

  // 2. If header is missing OR does not match our secret key → reject
  if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
    return res.status(403).json({          // 403 = Forbidden
      error: 'Unauthorized. Invalid admin key.'
    });
    // We "return" here, so the request NEVER reaches the real route.
  }

  // 3. Key is correct → allow request to continue to the route handler
  next();
}

// Export so index.js can use it
module.exports = adminAuth;