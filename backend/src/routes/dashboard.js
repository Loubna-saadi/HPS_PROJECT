/**
 * routes/dashboard.js
 *
 * GET /v1/audit/dashboard
 *
 * FAST: reads only operations.json, connection-profiles.json, users.json.
 * Does NOT read anomalies.json — uses pre-computed total_diff from operations.
 * Only the top-tables section reads a limited slice of anomalies.
 */

const express      = require('express');
const router       = express.Router();
const store        = require('../storage/store');
const anomalyStore = require('../storage/anomaly-store');

router.get('/dashboard', (_req, res) => {
  const operations = store.findAll('operations');
  const profiles   = store.findAll('connection-profiles');
  const users      = store.findAll('users');

  const userMap  = new Map(users.map(u => [u.id, u.nom || u.login]));
  const completed = operations.filter(o => o.statut !== 'EN_COURS');
  const sorted    = [...completed].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // ── KPIs — all from operations, zero anomaly reads ──────────────────────────
  const totalOps   = completed.length;
  const totalDiffs = completed.reduce((sum, op) => sum + (op.total_diff ?? 0), 0);
  const cleanOps   = completed.filter(o => (o.total_diff ?? 0) === 0).length;
  const syncRate   = totalOps > 0 ? Math.round((cleanOps / totalOps) * 100) : 100;

  // ── Recent operations (last 10) ──────────────────────────────────────────────
  const recentOps = sorted.slice(0, 10).map(op => ({
    id:             op.id,
    type:           op.type           ?? 'COMPARAISON_TABLE',
    statut:         op.statut         ?? 'TERMINE',
    date_operation: op.created_at,
    source_env:     op.env_source     ?? '',
    cible_env:      op.env_cible      ?? '',
    nom_table:      op.nom_table      ?? '',
    nb_anomalies:   op.total_diff     ?? 0,
    tables_scanned: op.tables_scanned ?? 1,
    performed_by:   userMap.get(Number(op.utilisateur_id)) ?? `user_${op.utilisateur_id ?? 0}`,
  }));

  // ── Top tables — read only the most recent operation's anomalies ─────────────
  // Avoids scanning the entire (potentially huge) anomalies.json.
  const topTables = [];
  if (sorted.length > 0) {
    const recentOpIds = sorted.slice(0, 5).map(o => o.id);
    topTables.push(...anomalyStore.getStatsForOps(recentOpIds));
  }

  // ── Operations by status ──────────────────────────────────────────────────────
  const byStatus = {};
  for (const op of completed) {
    const s = op.statut ?? 'TERMINE';
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }

  // ── Environment health ────────────────────────────────────────────────────────
  const envHealth = profiles.map(p => ({
    env_code:       p.env_code,
    last_test_ok:   p.last_test_ok,
    last_tested_at: p.last_tested_at,
    host:           p.host,
    port:           p.port,
  }));

  res.json({
    kpis: {
      last_audit_date:  sorted[0]?.created_at ?? null,
      total_operations: totalOps,
      open_anomalies:   totalDiffs,
      sync_rate:        syncRate,
    },
    recent_operations: recentOps,
    top_tables:        topTables,
    breakdown:         {},
    by_status:         byStatus,
    env_health:        envHealth,
  });
});

module.exports = router;
