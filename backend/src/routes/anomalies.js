const express      = require('express');
const router       = express.Router();
const anomalyStore = require('../storage/anomaly-store');

// ── GET /v1/audit/anomalies?operation_id=<id> ─────────────────────────────────
router.get('/anomalies', (req, res) => {
  const opId = Number(req.query.operation_id);
  if (!opId) return res.status(400).json({ error: 'operation_id query param is required' });
  res.json({ items: anomalyStore.getAll(opId) });
});

// ── GET /v1/audit/anomalies/:id ───────────────────────────────────────────────
// With per-op files we need operation_id to locate the record.
// Support ?operation_id=X as a query param alongside the anomaly id.
router.get('/anomalies/:id', (req, res) => {
  const anomId = Number(req.params.id);
  const opId   = Number(req.query.operation_id);
  if (!opId) return res.status(400).json({ error: 'operation_id query param is required' });
  const item = anomalyStore.getAll(opId).find(a => a.id === anomId);
  if (!item) return res.status(404).json({ error: 'Anomaly not found' });
  res.json(item);
});

module.exports = router;
