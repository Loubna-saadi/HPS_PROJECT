/**
 * export.routes.js
 * ─────────────────────────────────────────────────────────
 * Replaces ORDS:
 *   POST /audit/scripts          → save a correction script
 *   GET  /audit/scripts          → load a script by operationId
 *   POST /audit/validate-script  → mark as validated
 *   POST /audit/execute-script   → execute script on target env
 * ─────────────────────────────────────────────────────────
 */

const express = require('express');
const router  = express.Router();
const db      = require('../data/fileStore');
const authMW  = require('../middleware/auth.middleware');
const oracle  = require('../data/oraclePool');

router.use(authMW);

function findEnvByCode(userId, code) {
  return db.findOneWhere(
    'environments',
    e => e.user_id === Number(userId) && e.code.toUpperCase() === code.toUpperCase()
  );
}

// ── POST /v1/audit/scripts ───────────────────────────────────────────────────
router.post('/scripts', (req, res) => {
  try {
    const { operation_id, contenu_sql, direction, scope, statut } = req.body;
    if (!operation_id || !contenu_sql)
      return res.status(400).json({ error: 'operation_id and contenu_sql are required' });

    const op = db.findById('operations', operation_id);
    if (!op) return res.status(404).json({ error: `Operation ${operation_id} not found` });

    const script = db.insert('scripts', {
      operation_id: Number(operation_id),
      contenu_sql,
      direction:    direction ?? 'source',
      scope:        scope     ?? 'all',
      est_valide:   0,
      utilisateur_id: op.utilisateur_id,
      dategeneration: new Date().toISOString(),
    });

    db.updateById('operations', operation_id, {
      statut:    'SCRIPT_GENERE',
      script_id: script.id,
    });

    res.json({ id: script.id, operation_id, user_id: op.utilisateur_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /v1/audit/scripts?operationId=X ──────────────────────────────────────
router.get('/scripts', (req, res) => {
  const opId = Number(req.query.operationId);
  if (!opId) return res.status(400).json({ error: 'operationId is required' });

  const scripts = db.findWhere('scripts', s => s.operation_id === opId);
  if (scripts.length === 0) return res.json({ items: [] });

  const op = db.findById('operations', opId);
  const s  = scripts[0];

  res.json({
    items: [{
      id:           s.id,
      operation_id: s.operation_id,
      contenu_sql:  s.contenu_sql,
      direction:    s.direction,
      scope:        s.scope,
      est_valide:   s.est_valide,
      statut:       op?.statut ?? '',
      created_at:   s.dategeneration,
    }]
  });
});

// ── POST /v1/audit/validate-script ───────────────────────────────────────────
router.post('/validate-script', (req, res) => {
  try {
    const { script_id, operation_id, executed_by } = req.body;
    if (!script_id) return res.status(400).json({ error: 'script_id is required' });

    const script = db.findById('scripts', script_id);
    if (!script) return res.status(404).json({ error: `Script ${script_id} not found` });

    // Lexical validation — count statements, warn on DROP/UPDATE-without-WHERE
    const sql       = script.contenu_sql ?? '';
    const stmts     = sql.split(';').map(s => s.trim()).filter(s =>
      s.length > 5 && !s.startsWith('--') && !/^COMMIT/i.test(s)
    );
    const warnings  = [];
    for (let i = 0; i < stmts.length; i++) {
      const up = stmts[i].toUpperCase();
      if (/\bDROP\b|\bTRUNCATE\b/.test(up))
        warnings.push(`Stmt #${i+1}: contains DROP/TRUNCATE — verify manually`);
      if (/^UPDATE\b/.test(up.trimStart()) && !/\bWHERE\b/.test(up))
        warnings.push(`Stmt #${i+1}: UPDATE without WHERE clause`);
    }

    db.updateById('scripts', script_id, {
      est_valide:    1,
      validated_at:  new Date().toISOString(),
      validated_by:  executed_by ?? req.user.id,
    });

    if (operation_id) {
      db.updateById('operations', operation_id, { statut: 'SCRIPT_VALIDE' });
    }

    res.json({
      valid:              1,
      statements_checked: stmts.length,
      errors:             [],
      warnings,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, valid: 0, errors: [], warnings: [] });
  }
});

// ── POST /v1/audit/execute-script ────────────────────────────────────────────
router.post('/execute-script', async (req, res) => {
  try {
    const { script_id, operation_id, target_env, executed_by } = req.body;
    if (!script_id || !target_env)
      return res.status(400).json({ error: 'script_id and target_env are required' });

    const script = db.findById('scripts', script_id);
    if (!script) return res.status(404).json({ error: `Script ${script_id} not found` });

    const profile = findEnvByCode(executed_by ?? req.user.id, target_env);
    if (!profile)  return res.status(400).json({ error: `Unknown environment: ${target_env}` });

    const log = db.insert('import_logs', {
      script_id:    Number(script_id),
      operation_id: Number(operation_id),
      target_env:   target_env.toUpperCase(),
      executed_by:  executed_by ?? req.user.id,
      executed_at:  new Date().toISOString(),
      statut:       'EN_COURS',
      statements_run: 0,
    });

    // Execute statements on the target Oracle env
    const sql    = script.contenu_sql ?? '';
    const stmts  = sql.split(';').map(s => s.trim()).filter(s =>
      s.length > 5 && !s.startsWith('--') && !/^COMMIT/i.test(s)
    );

    let conn;
    const errors = [];
    let  stmtsDone = 0;
    try {
      conn = await oracle.getConnection(profile);
      for (let i = 0; i < stmts.length; i++) {
        try {
          await conn.execute(stmts[i]);
          stmtsDone++;
        } catch (err) {
          errors.push(`Stmt #${i+1}: ${err.message.substring(0, 200)}`);
        }
      }
      await conn.commit();
    } finally {
      if (conn) await conn.close();
    }

    const success = errors.length === 0;
    db.updateById('import_logs', log.id, {
      statut:         success ? 'OK' : 'ERREUR',
      statements_run: stmtsDone,
      error_detail:   errors.join('\n') || null,
    });

    if (operation_id) {
      db.updateById('operations', operation_id, { statut: 'IMPORTE' });
    }

    res.json({
      success,
      statements_run: stmtsDone,
      error_count:    errors.length,
      environment:    target_env.toUpperCase(),
      executed_at:    new Date().toISOString(),
      log_id:         log.id,
      errors,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, success: false });
  }
});

module.exports = router;