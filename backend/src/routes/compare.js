/**
 * routes/compare.js
 *
 * Matches the EXACT ORDS endpoint paths the Angular frontend already calls:
 *
 *   POST /v1/audit/table          ← compareService.compareTable(...)
 *   POST /v1/audit/full           ← compareService.compareFull(...)
 *   GET  /v1/audit/results/:opId  ← compareService.getAnomalies(opId)
 *
 * Body fields match what the old ORDS handlers accepted:
 *   table: { env_src, env_cbl, nom_table, user_id, excluded_cols? }
 *   full:  { env_src, env_cbl, user_id, excluded_tables? }
 */

const express        = require('express');
const router         = express.Router();
const compareService = require('../services/compare');

// ── POST /v1/audit/table ──────────────────────────────────────────────────────
// Body: { env_src, env_cbl, nom_table, user_id, excluded_cols? }
router.post('/table', async (req, res) => {
  const {
    env_src,
    env_cbl,
    nom_table,
    user_id,
    excluded_cols = '',
  } = req.body;

  if (!env_src)   return res.status(400).json({ error: 'env_src is required' });
  if (!env_cbl)   return res.status(400).json({ error: 'env_cbl is required' });
  if (!nom_table) return res.status(400).json({ error: 'nom_table is required' });

  try {
    const operation = await compareService.runTableCompare({
      envSrc:          env_src,
      envCbl:          env_cbl,
      tableName:       nom_table.trim().toUpperCase(),
      excludedColumns: excluded_cols,
      userId:          user_id,
    });

    res.json({
      message:     'ok',
      operationId: operation.id,
      id:          operation.id,
    });
  } catch (err) {
    console.error('[POST /table]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /v1/audit/full ───────────────────────────────────────────────────────
// Body: { env_src, env_cbl, user_id, excluded_tables? }
router.post('/full', async (req, res) => {
  const {
    env_src,
    env_cbl,
    user_id,
    excluded_tables = '',
  } = req.body;

  if (!env_src) return res.status(400).json({ error: 'env_src is required' });
  if (!env_cbl) return res.status(400).json({ error: 'env_cbl is required' });

  try {
    const operation = await compareService.runFullScan({
      envSrc:         env_src,
      envCbl:         env_cbl,
      excludedTables: excluded_tables,
      userId:         user_id,
    });

    res.json({
      message:     'ok',
      operationId: operation.id,
      id:          operation.id,
    });
  } catch (err) {
    console.error('[POST /full]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /v1/audit/results/:opId ───────────────────────────────────────────────
// Returns all anomalies for an operation — ORDS collection shape { items: [...] }
const store = require('../storage/store');

router.get('/results/:opId', (req, res) => {
  const opId = Number(req.params.opId);
  if (!opId) return res.status(400).json({ error: 'opId is required' });

  const items = store.findAll('anomalies', a => a.operation_id === opId);
  res.json({ items });
});

module.exports = router;
