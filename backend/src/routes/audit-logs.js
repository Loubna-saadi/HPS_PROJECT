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

const express      = require('express');
const router       = express.Router();
const store        = require('../storage/store');
const anomalyStore = require('../storage/anomaly-store');

// ── Pre-load lookup maps ───────────────────────────────────────────────────────
function buildLookups() {
  const userMap = new Map();
  for (const u of store.findAll('users')) userMap.set(u.id, u);
  // anomalies are now per-operation files — loaded on demand in buildLog
  return { userMap };
}

// ── Helper: build enriched log shape ──────────────────────────────────────────
function buildLog(op, _anomalyMap, userMap) {
  // Use pre-stored totals; only read anomaly file if fields are missing
  const nbDiff   = op.total_diff     ?? anomalyStore.countDiffs(op.id);
  const nbTables = op.tables_scanned ?? 1;

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
  const { userMap } = buildLookups();

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
    .map(op => buildLog(op, null, userMap));

  res.json({ items });
});

// ── GET /v1/audit/logs/admin ──────────────────────────────────────────────────
router.get('/logs/admin', (_req, res) => {
  const { userMap } = buildLookups();

  const items = store.findAll('operations')
    .filter(o => o.statut !== 'EN_COURS')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map(op => buildLog(op, null, userMap));

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
