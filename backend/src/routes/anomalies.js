/**
 * routes/anomalies.js
 *
 * Replaces ORDS endpoint:
 *   GET /audit/anomalies?operation_id=<id>
 *
 * Frontend calls (comparison.ts → CompareService.getAnomalies):
 *   GET /v1/audit/anomalies?operation_id=123
 *
 * Response shape: { items: [ anomaly, ... ] }
 * (ORDS collection feeds return { items: [...] } — we keep the same shape)
 */

const express = require('express');
const router  = express.Router();
const store   = require('../storage/store');

// ── GET /v1/audit/anomalies?operation_id=<id> ─────────────────────────────────
router.get('/anomalies', (req, res) => {
  const opId = Number(req.query.operation_id);
  if (!opId) {
    return res.status(400).json({ error: 'operation_id query param is required' });
  }

  const items = store.findAll('anomalies', a => a.operation_id === opId);

  // Return in ORDS collection shape so no Angular changes needed
  res.json({ items });
});

// ── GET /v1/audit/anomalies/:id ───────────────────────────────────────────────
router.get('/anomalies/:id', (req, res) => {
  const item = store.findById('anomalies', req.params.id);
  if (!item) return res.status(404).json({ error: 'Anomaly not found' });
  res.json(item);
});

// ── PATCH /v1/audit/anomalies/:id ────────────────────────────────────────────
// Update anomaly status (e.g. mark as RESOLU, IGNORE, etc.)
router.patch('/anomalies/:id', (req, res) => {
  const updated = store.updateById('anomalies', req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Anomaly not found' });
  res.json(updated);
});

module.exports = router;
