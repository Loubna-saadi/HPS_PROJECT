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
// Returns the operation ID immediately — scan runs in the background.
router.post('/full', async (req, res) => {
  const {
    env_src,
    env_cbl,
    user_id,
    excluded_tables = '',
  } = req.body;

  if (!env_src) return res.status(400).json({ error: 'env_src is required' });
  if (!env_cbl) return res.status(400).json({ error: 'env_cbl is required' });

  // Create the operation record immediately so we have an ID to return
  const store = require('../storage/store');
  const operation = store.insert('operations', {
    env_source:       env_src,
    env_cible:        env_cbl,
    nom_table:        'FULL_SCAN',
    statut:           'EN_COURS',
    type:             'COMPARAISON_SCHEMA',
    utilisateur_id:   user_id,
    excluded_tables:  excluded_tables,
  });

  // Respond immediately with the operation ID
  res.json({ message: 'ok', operationId: operation.id, id: operation.id });

  // Run the scan in the background — does NOT block the HTTP response
  compareService.runFullScan({
    envSrc:         env_src,
    envCbl:         env_cbl,
    excludedTables: excluded_tables,
    userId:         user_id,
    operationId:    operation.id,     // reuse the already-created operation
  }).catch(err => {
    console.error('[POST /full background]', err.message);
    store.updateById('operations', operation.id, { statut: 'ERREUR', message: err.message });
  });
});

const store        = require('../storage/store');
const anomalyStore = require('../storage/anomaly-store');

// ── GET /v1/audit/operation-status/:opId ─────────────────────────────────────
// Lightweight poll endpoint — returns operation status + progress, no anomalies.
router.get('/operation-status/:opId', (req, res) => {
  const opId = Number(req.params.opId);
  if (!opId) return res.status(400).json({ error: 'opId is required' });

  const op = store.findById('operations', opId);
  if (!op) return res.status(404).json({ error: `Operation ${opId} not found` });

  res.json({
    id:            op.id,
    statut:        op.statut,
    tables_done:   op.tables_done   ?? null,
    tables_total:  op.tables_total  ?? null,
    total_diff:    op.total_diff    ?? 0,
    message:       op.message       ?? null,
  });
});

// ── GET /v1/audit/results/:opId ───────────────────────────────────────────────
// Returns all anomalies for an operation — ORDS collection shape { items: [...] }
router.get('/results/:opId', (req, res) => {
  const opId = Number(req.params.opId);
  if (!opId) return res.status(400).json({ error: 'opId is required' });

  const items = anomalyStore.getAll(opId);
  res.json({ items });
});

module.exports = router;
