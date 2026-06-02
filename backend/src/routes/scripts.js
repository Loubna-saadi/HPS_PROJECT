/**
 * routes/scripts.js
 *
 * Matches exact ORDS paths:
 *   POST /v1/audit/scripts                → save a generated SQL script
 *   POST /v1/audit/validate-script        → syntax-check the script
 *   POST /v1/audit/execute-script         → mark script as executed (import)
 *
 * GET /v1/audit/scripts is handled in audit-logs.js (shares the router mount)
 */

const express = require('express');
const router  = express.Router();
const store   = require('../storage/store');

// ── POST /v1/audit/scripts ────────────────────────────────────────────────────
// Body: { operation_id, contenu_sql, direction, scope, statut }
router.post('/scripts', (req, res) => {
  const { operation_id, contenu_sql, direction, scope, statut } = req.body;

  if (!operation_id) return res.status(400).json({ error: 'operation_id is required' });

  const operation = store.findById('operations', operation_id);
  if (!operation) return res.status(404).json({ error: `Operation ${operation_id} not found` });

  const script = store.insert('scripts', {
    operation_id:   Number(operation_id),
    contenu_sql:    contenu_sql  || '',
    contenusql:     contenu_sql  || '',   // alias — audit-logs.ts reads contenusql
    direction:      direction    || 'source',
    scope:          scope        || 'all',
    statut:         statut       || 'SCRIPT_GENERE',
    est_valide:     0,
    utilisateur_id: operation.utilisateur_id,
    dategeneration: new Date().toISOString(),
  });

  // Link script to operation
  store.updateById('operations', operation_id, {
    statut:    statut || 'SCRIPT_GENERE',
    type:      'GENERATION_SCRIPT',
    script_id: script.id,
  });

  res.json({
    id:           script.id,
    operation_id: script.operation_id,
    user_id:      script.utilisateur_id,
  });
});

// ── POST /v1/audit/validate-script ───────────────────────────────────────────
// Body: { script_id, operation_id, executed_by }
router.post('/validate-script', (req, res) => {
  const { script_id, operation_id, executed_by } = req.body;
  if (!script_id) return res.status(400).json({ error: 'script_id is required' });

  const script = store.findById('scripts', script_id);
  if (!script) return res.status(404).json({ error: `Script ${script_id} not found` });

  const sql        = (script.contenu_sql || script.contenusql || '').trim();
  const errors     = [];
  const warnings   = [];
  const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
  let stmtsChecked = 0;

  for (const stmt of statements) {
    stmtsChecked++;
    const upper = stmt.toUpperCase();

    if (!upper.startsWith('UPDATE') && !upper.startsWith('INSERT') && !upper.startsWith('DELETE')) {
      warnings.push(`Statement ${stmtsChecked}: expected UPDATE/INSERT/DELETE`);
    }
    if (upper.startsWith('UPDATE') && !upper.includes('WHERE')) {
      errors.push(`Statement ${stmtsChecked}: UPDATE without WHERE clause (unsafe)`);
    }
    if (upper.startsWith('DELETE') && !upper.includes('WHERE')) {
      errors.push(`Statement ${stmtsChecked}: DELETE without WHERE clause (unsafe)`);
    }
    const quotes = (stmt.match(/'/g) || []).length;
    if (quotes % 2 !== 0) {
      errors.push(`Statement ${stmtsChecked}: unclosed single quote`);
    }
  }

  const valid = errors.length === 0 ? 1 : 0;

  store.updateById('scripts', script_id, {
    est_valide:   valid,
    validated_by: executed_by,
    validated_at: new Date().toISOString(),
    statut:       valid ? 'VALIDE' : 'INVALIDE',
  });

  res.json({ valid, statements_checked: stmtsChecked, errors, warnings });
});

// ── POST /v1/audit/execute-script ────────────────────────────────────────────
// Body: { script_id, operation_id, target_env, executed_by }
// In our architecture we don't execute against Oracle directly from the backend
// (that's the import step done manually). We mark the operation as IMPORTE.
router.post('/execute-script', (req, res) => {
  const { script_id, operation_id, target_env, executed_by } = req.body;
  if (!script_id) return res.status(400).json({ error: 'script_id is required' });

  const script = store.findById('scripts', script_id);
  if (!script) return res.status(404).json({ error: `Script ${script_id} not found` });

  // Count statements as a proxy for "statements_run"
  const sql = (script.contenu_sql || script.contenusql || '').trim();
  const statementsRun = sql.split(';').filter(s => s.trim().length > 0).length;

  store.updateById('scripts', script_id, {
    statut:      'IMPORTE',
    executed_by: executed_by,
    executed_at: new Date().toISOString(),
    target_env:  target_env,
  });

  if (operation_id) {
    store.updateById('operations', operation_id, { statut: 'IMPORTE' });
  }

  res.json({
    success:        true,
    statements_run: statementsRun,
    errors:         [],
    warnings:       [],
    executed_at:    new Date().toISOString(),
    environment:    target_env,
  });
});

module.exports = router;
