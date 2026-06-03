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
const oracle  = require('../oracle/connections');

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

// ── Helpers ───────────────────────────────────────────────────────────────────

// Strip @LINK_NAME so statements run directly on the target connection.
// e.g.  UPDATE CARD@DEVVAL_LINK SET ...  →  UPDATE CARD SET ...
function stripDbLinks(sql) {
  return sql.replace(/@\w+/g, '');
}

// Convert ISO-8601 date strings to Oracle TO_DATE literals.
// e.g.  '2026-09-30T22:00:00.000Z'  →  TO_DATE('2026-09-30 22:00:00','YYYY-MM-DD HH24:MI:SS')
function fixDates(sql) {
  return sql.replace(
    /'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?Z?'/g,
    (_, dt) => `TO_DATE('${dt.replace('T', ' ')}','YYYY-MM-DD HH24:MI:SS')`
  );
}

// Parse a full script into individual executable statements.
// Skips comment-only lines and COMMIT (handled separately).
function parseStatements(fullSql) {
  return fullSql
    .split(';')
    .map(s => {
      // Remove leading comment lines, keep only actual SQL lines
      const lines = s.split('\n').filter(l => !l.trim().startsWith('--'));
      return lines.join('\n').trim();
    })
    .filter(s => s.length > 0)
    .filter(s => !/^COMMIT$/i.test(s));
}

// ── POST /v1/audit/execute-script ────────────────────────────────────────────
// Body: { script_id, operation_id, target_env, executed_by }
router.post('/execute-script', async (req, res) => {
  const { script_id, operation_id, target_env, executed_by } = req.body;
  if (!script_id)  return res.status(400).json({ error: 'script_id is required' });
  if (!target_env) return res.status(400).json({ error: 'target_env is required' });

  const script = store.findById('scripts', script_id);
  if (!script) return res.status(404).json({ error: `Script ${script_id} not found` });

  const rawSql    = (script.contenu_sql || script.contenusql || '').trim();
  const statements = parseStatements(rawSql);

  const errors   = [];
  const warnings = [];
  let   statementsRun = 0;
  let   conn = null;

  try {
    conn = await oracle.getConnection(target_env);

    for (const stmt of statements) {
      const upper = stmt.toUpperCase().trim();

      // Only execute DML
      if (!upper.startsWith('UPDATE') && !upper.startsWith('INSERT') && !upper.startsWith('DELETE')) {
        continue;
      }

      // INSERT … SELECT needs DB links — skip and warn
      if (upper.startsWith('INSERT') && upper.includes('SELECT')) {
        warnings.push(`INSERT via SELECT requires DB links — skipped: ${stmt.substring(0, 80)}…`);
        continue;
      }

      const cleanSql = fixDates(stripDbLinks(stmt));

      try {
        await conn.execute(cleanSql, [], { autoCommit: false });
        statementsRun++;
      } catch (err) {
        errors.push(`[${statementsRun + 1}] ${err.message} — SQL: ${cleanSql.substring(0, 120)}`);
      }
    }

    if (errors.length === 0) {
      await conn.commit();
    } else {
      await conn.rollback();
    }

  } catch (connErr) {
    return res.status(500).json({ error: `Cannot connect to ${target_env}: ${connErr.message}` });
  } finally {
    await oracle.releaseConnection(conn);
  }

  const success = errors.length === 0;

  if (success) {
    store.updateById('scripts', script_id, {
      statut:      'IMPORTE',
      executed_by,
      executed_at: new Date().toISOString(),
      target_env,
    });
    if (operation_id) {
      store.updateById('operations', operation_id, { statut: 'IMPORTE' });
    }
  }

  res.json({
    success,
    statements_run: statementsRun,
    errors,
    warnings,
    executed_at: new Date().toISOString(),
    environment: target_env,
  });
});

module.exports = router;
