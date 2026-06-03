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

// ── Pre-load lookup maps (one file read each, not one per operation) ──────────
function buildLookups() {
  // Group anomalies by operation_id
  const allAnomalies = store.findAll('anomalies');
  const anomalyMap   = new Map();
  for (const a of allAnomalies) {
    const key = a.operation_id;
    if (!anomalyMap.has(key)) anomalyMap.set(key, []);
    anomalyMap.get(key).push(a);
  }

  // Map users by id
  const userMap = new Map();
  for (const u of store.findAll('users')) userMap.set(u.id, u);

  return { anomalyMap, userMap };
}

// ── Helper: build enriched log shape ──────────────────────────────────────────
function buildLog(op, anomalyMap, userMap) {
  const anomalies = anomalyMap.get(op.id) ?? [];
  const tables    = [...new Set(anomalies.map(a => a.nom_table).filter(Boolean))];

  // Use pre-stored counts when available (avoids re-scanning anomalies)
  const nbDiff    = op.total_diff      ?? anomalies.filter(a => a.alerte_statut !== 'IDENTIQUE').length;
  const nbTables  = op.tables_scanned  ?? tables.length;

  // Resolve display name
  let performedBy = op.performed_by ?? null;
  if (!performedBy && op.utilisateur_id) {
    const user = userMap.get(Number(op.utilisateur_id));
    if (user) performedBy = user.nom || user.login;
  }
  performedBy = performedBy ?? `user_${op.utilisateur_id ?? 0}`;

  return {
    id:               op.id,
    type:             op.type           ?? 'COMPARAISON_TABLE',
    statut:           op.statut         ?? 'TERMINE',
    date_operation:   op.created_at     ?? op.updated_at,
    source_env:       op.env_source     ?? '',
    cible_env:        op.env_cible      ?? '',
    performed_by:     performedBy,
    user_role:        op.user_role      ?? 'USER',
    superuser_login:  op.superuser_login ?? null,
    tables_impactees: nbTables,
    nb_anomalies:     nbDiff,
    nom_table:        op.nom_table      ?? null,
    script_id:        op.script_id      ?? null,
  };
}

// ── GET /v1/audit/logs/superuser?superuserId=<id> ─────────────────────────────
router.get('/logs/superuser', (req, res) => {
  const superuserId      = Number(req.query.superuserId);
  const { anomalyMap, userMap } = buildLookups();

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
    .map(op => buildLog(op, anomalyMap, userMap));

  res.json({ items });
});

// ── GET /v1/audit/logs/admin ──────────────────────────────────────────────────
router.get('/logs/admin', (_req, res) => {
  const { anomalyMap, userMap } = buildLookups();

  const items = store.findAll('operations')
    .filter(o => o.statut !== 'EN_COURS')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map(op => buildLog(op, anomalyMap, userMap));

  res.json({ items });
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
