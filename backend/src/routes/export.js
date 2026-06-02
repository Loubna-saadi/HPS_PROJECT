/**
 * routes/export.js
 *
 * Replaces ORDS endpoints used by the export page (export.ts):
 *   GET  /audit/export/anomalies?operation_id=   → get anomalies for an op
 *   GET  /audit/export/operation/:id             → get operation details
 *
 * These are just reads from local store — no Oracle calls.
 */

const express = require('express');
const router  = express.Router();
const store   = require('../storage/store');

// ── GET /v1/audit/export/operation/:id ───────────────────────────────────────
router.get('/export/operation/:id', (req, res) => {
  const op = store.findById('operations', req.params.id);
  if (!op) return res.status(404).json({ error: 'Operation not found' });
  res.json(op);
});

// ── GET /v1/audit/export/anomalies?operation_id=<id>&scope=all|diff ──────────
router.get('/export/anomalies', (req, res) => {
  const opId  = Number(req.query.operation_id);
  const scope = req.query.scope || 'all';

  if (!opId) return res.status(400).json({ error: 'operation_id is required' });

  let items = store.findAll('anomalies', a => a.operation_id === opId);

  if (scope === 'diff') {
    items = items.filter(a => a.alerte_statut && !a.alerte_statut.includes('IDENTIQUE'));
  }

  res.json({ items });
});

module.exports = router;
