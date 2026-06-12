'use strict';

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'paramsync-dev-secret';

/**
 * Reads Authorization: Bearer <token>, verifies with JWT_SECRET.
 * On success sets req.user = { id, login, role }.
 * Returns 401 if the header is missing or the token is invalid/expired.
 */
function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] ?? '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized — missing or malformed token' });
  }
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized — invalid or expired token' });
  }
}

/**
 * Factory: returns middleware that allows only the listed roles.
 * Must be used AFTER authMiddleware (req.user must already be set).
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (!roles.includes((req.user.role ?? '').toUpperCase())) {
      return res.status(403).json({ error: `Forbidden — requires one of: ${roles.join(', ')}` });
    }
    next();
  };
}

module.exports = { authMiddleware, requireRole };
