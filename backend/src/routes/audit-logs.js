/**
 * routes/audit-logs.js
 *
 * Matches exact ORDS paths called by audit-logs.ts:
 *
 *   GET /v1/audit/logs/superuser?superuserId=<id>
 *   GET /v1/audit/logs/admin
 *   GET /v1/audit/results/:opId          ← also used by audit-logs detail panel
 *   GET /v1/audit/scripts?operationId=   ← note: operationId (camelCase) from audit-logs.ts
 *   POST /v1/audit/validate-script
 *   POST /v1/audit/execute-script
 */

const express = require('express');
const router  = express.Router();
const store   = require('../storage/store');

// ── Helper: build enriched log shape matching what the frontend expects ────────
function buildLog(op) {
  const anomalies = store.findAll('anomalies', a => a.operation_id === op.id);
  const tables    = [...new Set(anomalies.map(a => a.nom_table).filter(Boolean))];

  return {
    id:               op.id,
    type:             op.type             ?? 'COMPARAISON_TABLE',
    statut:           op.statut           ?? 'TERMINE',
    date_operation:   op.created_at       ?? op.updated_at,
    source_env:       op.env_source       ?? '',
    cible_env:        op.env_cible        ?? '',
    performed_by:     op.performed_by     ?? `user_${op.utilisateur_id ?? 0}`,
    user_role:        op.user_role        ?? 'USER',
    superuser_login:  op.superuser_login  ?? null,
    tables_impactees: tables.length,
    nb_anomalies:     anomalies.filter(a => a.alerte_statut !== 'IDENTIQUE').length,
    // keep raw fields for detail panel
    nom_table:        op.nom_table        ?? null,
    script_id:        op.script_id        ?? null,
  };
}

// ── GET /v1/audit/logs/superuser?superuserId=<id> ─────────────────────────────
router.get('/logs/superuser', (req, res) => {
  const superuserId = Number(req.query.superuserId);

  let ops = store.findAll('operations');
  if (superuserId) {
    ops = ops.filter(o =>
      o.utilisateur_id === superuserId ||
      o.parent_user_id === superuserId
    );
  }

  const items = ops
    .filter(o => o.statut !== 'EN_COURS')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map(buildLog);

  res.json({ items });
});

// ── GET /v1/audit/logs/admin ──────────────────────────────────────────────────
router.get('/logs/admin', (req, res) => {
  const ops = store.findAll('operations')
    .filter(o => o.statut !== 'EN_COURS')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map(buildLog);

  res.json({ items: ops });
});

// ── GET /v1/audit/scripts?operationId=<id>  (camelCase — from audit-logs.ts) ──
// Also supports ?operation_id= for export.ts compatibility
router.get('/scripts', (req, res) => {
  const opId = Number(req.query.operationId ?? req.query.operation_id);
  if (!opId) return res.status(400).json({ error: 'operationId is required' });

  const items = store.findAll('scripts', s => s.operation_id === opId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json({ items });
});

module.exports = router;
