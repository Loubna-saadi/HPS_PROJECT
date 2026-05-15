/**
 * environments.routes.js
 * ─────────────────────────────────────────────────────────
 * Each user stores their own environment profiles locally.
 * A profile = { name, username, password, connectString }
 * Passwords are stored as-is (local tool — no shared server).
 *
 * Replaces ORDS:
 *   GET  /audit/tables?env=DEV
 *   GET  /audit/columns/:tableName?env=DEV
 * ─────────────────────────────────────────────────────────
 */

const express  = require('express');
const router   = express.Router();
const db       = require('../data/fileStore');
const authMW   = require('../middleware/auth.middleware');
const oracle   = require('../data/oraclePool');

// All routes require auth
router.use(authMW);

// ── Helpers ──────────────────────────────────────────────────────────────────
function userEnvs(userId) {
  return db.findWhere('environments', e => e.user_id === Number(userId));
}
function findEnvByCode(userId, code) {
  return db.findOneWhere(
    'environments',
    e => e.user_id === Number(userId) && e.code.toUpperCase() === code.toUpperCase()
  );
}

// ── GET /v1/environments ────────────────────────────────────────────────────
// Returns all env profiles for the logged-in user (passwords stripped)
router.get('/', (req, res) => {
  const envs = userEnvs(req.user.id).map(({ password: _, ...e }) => e);
  res.json(envs);
});

// ── POST /v1/environments ───────────────────────────────────────────────────
// Create a new environment profile
router.post('/', (req, res) => {
  const { code, label, username, password, connectString } = req.body;
  if (!code || !username || !password || !connectString)
    return res.status(400).json({ error: 'code, username, password, connectString are required' });

  const existing = findEnvByCode(req.user.id, code);
  if (existing)
    return res.status(409).json({ error: `Profile "${code}" already exists` });

  const env = db.insert('environments', {
    user_id:       req.user.id,
    code:          code.toUpperCase(),
    label:         label ?? code,
    username,
    password,      // stored locally only
    connectString,
    created_at:    new Date().toISOString(),
  });

  const { password: _, ...safe } = env;
  res.status(201).json(safe);
});

// ── PUT /v1/environments/:id ────────────────────────────────────────────────
router.put('/:id', (req, res) => {
  const env = db.findById('environments', req.params.id);
  if (!env || env.user_id !== req.user.id)
    return res.status(404).json({ error: 'Profile not found' });

  const updated = db.updateById('environments', req.params.id, req.body);
  const { password: _, ...safe } = updated;
  res.json(safe);
});

// ── DELETE /v1/environments/:id ─────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const env = db.findById('environments', req.params.id);
  if (!env || env.user_id !== req.user.id)
    return res.status(404).json({ error: 'Profile not found' });

  db.deleteById('environments', req.params.id);
  res.json({ message: 'Deleted' });
});

// ── POST /v1/environments/test ───────────────────────────────────────────────
// Test connectivity for a given profile code
router.post('/test', async (req, res) => {
  const { code } = req.body;
  const env = findEnvByCode(req.user.id, code);
  if (!env) return res.status(404).json({ error: 'Profile not found' });

  const result = await oracle.testConnection(env);
  res.json(result);
});

// ── GET /v1/environments/tables?env=DEV ─────────────────────────────────────
// Replaces ORDS GET /audit/tables
router.get('/tables', async (req, res) => {
  try {
    const env = findEnvByCode(req.user.id, req.query.env);
    if (!env) return res.status(404).json({ error: 'Profile not found' });

    const rows = await oracle.getTables(env);
    res.json({ items: rows.map(r => ({ table_name: r.TABLE_NAME ?? r.table_name })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /v1/environments/columns/:tableName?env=DEV ─────────────────────────
// Replaces ORDS GET /audit/columns/:tableName
router.get('/columns/:tableName', async (req, res) => {
  try {
    const env = findEnvByCode(req.user.id, req.query.env);
    if (!env) return res.status(404).json({ error: 'Profile not found' });

    const rows = await oracle.getColumns(env, req.params.tableName);
    res.json({
      items: rows.map(r => ({
        column_name: r.COLUMN_NAME ?? r.column_name,
        data_type:   r.DATA_TYPE   ?? r.data_type,
        nullable:    r.NULLABLE    ?? r.nullable,
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;