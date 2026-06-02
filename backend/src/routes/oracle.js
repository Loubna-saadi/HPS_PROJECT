/**
 * routes/oracle.js
 *
 * Read-only calls to the HPS Oracle DBs.
 * These require a connection profile to be saved first for the requested env.
 *
 *   GET /v1/audit/tables?env=DEV          → list tables in that env
 *   GET /v1/audit/columns/:table?env=DEV  → list columns of a table
 */

const express = require('express');
const router  = express.Router();
const oracle  = require('../oracle/connections');
const store   = require('../storage/store');

/**
 * Guard: check a profile exists for this env before trying to query Oracle.
 * Returns false and sends the error response if not configured.
 */
function requireProfile(envCode, res) {
  const profiles = store.findAll('connection-profiles');
  const exists   = profiles.some(p => p.env_code === envCode.toUpperCase());
  if (!exists) {
    res.status(400).json({
      error: `No connection profile configured for environment "${envCode}". ` +
             `Please go to the Connection Profiles page and save credentials for ${envCode} first.`,
      code: 'PROFILE_NOT_CONFIGURED',
    });
    return false;
  }
  return true;
}

// ── GET /v1/audit/tables?env=DEV ─────────────────────────────────────────────
router.get('/tables', async (req, res) => {
  const env = (req.query.env || 'DEV').toUpperCase();

  if (!requireProfile(env, res)) return;

  try {
    const rows = await oracle.query(env, `
      SELECT table_name
      FROM   user_tables
      ORDER BY table_name
    `);
    res.json({ items: rows });
  } catch (err) {
    console.error(`[oracle/tables] ${env}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /v1/audit/columns/:table?env=DEV ─────────────────────────────────────
router.get('/columns/:table', async (req, res) => {
  const env   = (req.query.env || 'DEV').toUpperCase();
  const table = req.params.table.toUpperCase();

  if (!requireProfile(env, res)) return;

  try {
    const rows = await oracle.query(env, `
      SELECT column_name, data_type, nullable, data_length, column_id
      FROM   all_tab_columns
      WHERE  UPPER(table_name) = :tbl
      ORDER BY column_id
    `, [table]);

    if (rows.length === 0) {
      return res.status(404).json({ error: `Table "${table}" not found in ${env}` });
    }
    res.json({ items: rows });
  } catch (err) {
    console.error(`[oracle/columns] ${env}/${table}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
