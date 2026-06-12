/**
 * routes/auth.js
 *
 *   POST /v1/auth/signup  — create account
 *   POST /v1/auth/login   — authenticate
 */

const express  = require('express');
const crypto   = require('crypto');
const router   = express.Router();
const store    = require('../storage/store');

const SECRET = process.env.JWT_SECRET || 'paramsync-secret-2024';

function hashPassword(password, salt) {
  return crypto.createHmac('sha256', salt).update(password).digest('hex');
}

function generateToken(user) {
  const payload = Buffer.from(JSON.stringify({
    id:    user.id,
    login: user.login,
    role:  user.role,
    exp:   Date.now() + 24 * 60 * 60 * 1000,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

// ── POST /v1/auth/signup ──────────────────────────────────────────────────────
router.post('/signup', (req, res) => {
  const { login, password, nom = '' } = req.body || {};

  if (!login || !password) {
    return res.status(400).json({ error: 'login and password are required' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }

  const existing = store.findAll('users', u => u.login === login);
  if (existing.length > 0) {
    return res.status(409).json({ error: `Login "${login}" is already taken` });
  }

  const salt         = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);

  const existingUsers = store.findAll('users');
  // const role = existingUsers.length === 0 ? 'admin' : 'user';
  const role = 'admin';

  const user = store.insert('users', {
    login,
    nom,
    password_hash: passwordHash,
    salt,
    role,
  });

  const token = generateToken(user);
  console.log(`[auth] signup: ${login}`);
  res.status(201).json({ token, id: user.id, login: user.login, role: user.role, nom: user.nom });
});

// ── POST /v1/auth/login ───────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { login, password } = req.body || {};

  if (!login || !password) {
    return res.status(400).json({ error: 'login and password are required' });
  }

  const [user] = store.findAll('users', u => u.login === login);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const hash = hashPassword(password, user.salt);
  if (hash !== user.password_hash) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = generateToken(user);
  console.log(`[auth] login: ${login}`);
  res.json({ token, id: user.id, login: user.login, role: user.role, nom: user.nom });
});

module.exports = router;
