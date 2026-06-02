/**
 * services/compare.js — Comparison Engine
 *
 * Replaces: EXEC_AUDIT_TABLE_V2, RUN_FULL_SCHEMA_AUDIT, VALIDER_ET_STOCKER_ANOMALIES
 *           and the V_PREVIEW_COMPARAISON view — all in pure Node.js.
 *
 * HOW IT WORKS:
 *   1. Detect primary key columns for the table (in source env)
 *   2. Fetch all rows from source env (HPS Oracle)
 *   3. Fetch all rows from target env (HPS Oracle)
 *   4. Compare row-by-row using the PK as the key
 *   5. For each difference → create an anomaly record (stored locally in JSON)
 *   6. Save an operation record (stored locally in JSON)
 *
 * ANOMALY TYPES (same values the frontend already handles):
 *   ABSENT_DANS_CIBLE   — row exists in source, missing in target
 *   ABSENT_DANS_SOURCE  — row exists in target, missing in source
 *   VALEUR_DIFFERENTE   — row exists in both, but a column value differs
 *   VALEUR_NULL         — one side is NULL, the other is not
 *   IDENTIQUE           — row is identical (we still store for stats)
 */

const oracle = require('../oracle/connections');
const store  = require('../storage/store');

// ── PK detection ─────────────────────────────────────────────────────────────

/**
 * Detect primary key columns for a table.
 * Falls back: PK constraint → unique index → first column.
 */
async function detectPK(envCode, tableName) {
  // 1. Try PK constraint
  try {
    const rows = await oracle.query(envCode, `
      SELECT col.column_name
      FROM   all_constraints  con
      JOIN   all_cons_columns col
             ON  col.constraint_name = con.constraint_name
             AND col.owner           = con.owner
      WHERE  con.constraint_type = 'P'
      AND    UPPER(con.table_name) = :tbl
      ORDER BY col.position
    `, [tableName.toUpperCase()]);

    if (rows.length > 0) return rows.map(r => r.column_name);
  } catch (_) {}

  // 2. Try first unique index
  try {
    const rows = await oracle.query(envCode, `
      SELECT col.column_name
      FROM   all_indexes     idx
      JOIN   all_ind_columns col
             ON  col.index_name = idx.index_name
             AND col.table_owner = idx.owner
      WHERE  idx.uniqueness = 'UNIQUE'
      AND    UPPER(idx.table_name) = :tbl
      AND    ROWNUM <= 5
      ORDER BY col.column_position
    `, [tableName.toUpperCase()]);

    if (rows.length > 0) return rows.map(r => r.column_name);
  } catch (_) {}

  // 3. Fallback: first column by column_id
  const cols = await oracle.query(envCode, `
    SELECT column_name
    FROM   all_tab_columns
    WHERE  UPPER(table_name) = :tbl
    ORDER BY column_id
    FETCH FIRST 1 ROWS ONLY
  `, [tableName.toUpperCase()]);

  if (cols.length === 0) throw new Error(`Table "${tableName}" not found in ${envCode}`);
  return [cols[0].column_name];
}

// ── Fetch all rows ────────────────────────────────────────────────────────────

async function fetchAllRows(envCode, tableName, excludedColumns = []) {
  const excl = excludedColumns.map(c => c.toUpperCase());

  // Get all column names first
  const colRows = await oracle.query(envCode, `
    SELECT column_name
    FROM   all_tab_columns
    WHERE  UPPER(table_name) = :tbl
    ORDER BY column_id
  `, [tableName.toUpperCase()]);

  const columns = colRows
    .map(r => r.column_name)
    .filter(c => !excl.includes(c.toUpperCase()));

  if (columns.length === 0) throw new Error(`No columns found for table "${tableName}" in ${envCode}`);

  const sql = `SELECT ${columns.join(', ')} FROM ${tableName}`;
  const rows = await oracle.query(envCode, sql);
  return { rows, columns };
}

// ── Build a keyed Map from rows ───────────────────────────────────────────────

function buildMap(rows, pkCols) {
  const map = new Map();
  for (const row of rows) {
    const keyObj = {};
    for (const pk of pkCols) {
      keyObj[pk] = row[pk.toLowerCase()] ?? row[pk];
    }
    const keyStr = JSON.stringify(keyObj);
    map.set(keyStr, row);
  }
  return map;
}

// ── String-safe comparison ────────────────────────────────────────────────────

function valStr(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

// ── Compare two tables ────────────────────────────────────────────────────────

/**
 * Compare one table between source and target envs.
 * Returns an array of anomaly objects (not yet saved).
 */
async function compareTable(envSrc, envCbl, tableName, excludedColumns = []) {
  const pkCols = await detectPK(envSrc, tableName);

  const [src, cbl] = await Promise.all([
    fetchAllRows(envSrc, tableName, excludedColumns),
    fetchAllRows(envCbl, tableName, excludedColumns),
  ]);

  const srcMap = buildMap(src.rows, pkCols);
  const cblMap = buildMap(cbl.rows, pkCols);

  // All columns present in either side
  const allCols = [...new Set([...src.columns, ...cbl.columns])].map(c => c.toLowerCase());
  const pkLower = pkCols.map(c => c.toLowerCase());

  const anomalies = [];

  // ── Rows in source ────────────────────────────────────────────────────────
  for (const [keyStr, srcRow] of srcMap) {
    if (!cblMap.has(keyStr)) {
      // Entire row absent in target
      anomalies.push({
        cle:              keyStr,
        nom_table:        tableName,
        type_difference:  'ROW',
        valeur_source:    JSON.stringify(srcRow),
        valeur_cible:     null,
        alerte_statut:    'ABSENT_DANS_CIBLE',
        description:      `Row with key ${keyStr} exists in ${envSrc} but not in ${envCbl}`,
        statut:           'OUVERT',
      });
      continue;
    }

    const cblRow = cblMap.get(keyStr);

    // Column-level diff
    for (const col of allCols) {
      if (pkLower.includes(col)) continue;  // don't diff the PK itself

      const sv = valStr(srcRow[col]);
      const cv = valStr(cblRow[col]);

      if (sv === cv) {
        anomalies.push({
          cle:              keyStr,
          nom_table:        tableName,
          type_difference:  col.toUpperCase(),
          valeur_source:    sv,
          valeur_cible:     cv,
          alerte_statut:    'IDENTIQUE',
          description:      `Column ${col.toUpperCase()} is identical`,
          statut:           'IDENTIQUE',
        });
        continue;
      }

      // Determine anomaly type
      let alerteStatut;
      if (sv === null && cv !== null)       alerteStatut = 'VALEUR_NULL';
      else if (sv !== null && cv === null)  alerteStatut = 'VALEUR_NULL';
      else                                  alerteStatut = 'VALEUR_DIFFERENTE';

      anomalies.push({
        cle:              keyStr,
        nom_table:        tableName,
        type_difference:  col.toUpperCase(),
        valeur_source:    sv,
        valeur_cible:     cv,
        alerte_statut:    alerteStatut,
        description:      `Column ${col.toUpperCase()}: "${sv}" vs "${cv}"`,
        statut:           'OUVERT',
      });
    }
  }

  // ── Rows in target only ───────────────────────────────────────────────────
  for (const [keyStr, cblRow] of cblMap) {
    if (!srcMap.has(keyStr)) {
      anomalies.push({
        cle:              keyStr,
        nom_table:        tableName,
        type_difference:  'ROW',
        valeur_source:    null,
        valeur_cible:     JSON.stringify(cblRow),
        alerte_statut:    'ABSENT_DANS_SOURCE',
        description:      `Row with key ${keyStr} exists in ${envCbl} but not in ${envSrc}`,
        statut:           'OUVERT',
      });
    }
  }

  return anomalies;
}

// ── Full schema scan ──────────────────────────────────────────────────────────

/**
 * Get all user tables in an env.
 */
async function getAllTables(envCode, excludedTables = []) {
  const excl = excludedTables.map(t => t.toUpperCase());
  const rows = await oracle.query(envCode, `
    SELECT table_name
    FROM   user_tables
    ORDER BY table_name
  `);
  return rows
    .map(r => r.table_name)
    .filter(t => !excl.includes(t));
}

// ── Public: run one table compare & persist ───────────────────────────────────

/**
 * Run comparison for ONE table, save operation + anomalies locally.
 * Returns the saved operation record.
 */
async function runTableCompare({ envSrc, envCbl, tableName, excludedColumns = [], userId }) {
  const excl = typeof excludedColumns === 'string'
    ? excludedColumns.split(',').filter(Boolean)
    : excludedColumns;

  // Create operation record
  const operation = store.insert('operations', {
    env_source:    envSrc,
    env_cible:     envCbl,
    nom_table:     tableName,
    statut:        'EN_COURS',
    type:          'COMPARAISON_TABLE',
    utilisateur_id: userId,
    excluded_cols: excl.join(','),
  });

  try {
    const anomalies = await compareTable(envSrc, envCbl, tableName, excl);

    // Save all anomalies in bulk
    const saved = store.insertMany('anomalies',
      anomalies.map(a => ({ ...a, operation_id: operation.id }))
    );

    // Update operation as done
    store.updateById('operations', operation.id, {
      statut:        'TERMINE',
      total_lignes:  anomalies.length,
      total_diff:    anomalies.filter(a => a.alerte_statut !== 'IDENTIQUE').length,
    });

    return { ...operation, statut: 'TERMINE', anomalyCount: saved.length };

  } catch (err) {
    store.updateById('operations', operation.id, {
      statut:  'ERREUR',
      message: err.message,
    });
    throw err;
  }
}

/**
 * Run full schema scan — loops all tables in source env.
 * Returns the saved operation record.
 */
async function runFullScan({ envSrc, envCbl, excludedTables = [], userId }) {
  const excl = typeof excludedTables === 'string'
    ? excludedTables.split(',').filter(Boolean)
    : excludedTables;

  const operation = store.insert('operations', {
    env_source:    envSrc,
    env_cible:     envCbl,
    nom_table:     'FULL_SCAN',
    statut:        'EN_COURS',
    type:          'COMPARAISON_SCHEMA',
    utilisateur_id: userId,
    excluded_tables: excl.join(','),
  });

  try {
    const tables = await getAllTables(envSrc, excl);
    let allAnomalies = [];

    for (const tbl of tables) {
      try {
        const anomalies = await compareTable(envSrc, envCbl, tbl, []);
        allAnomalies = allAnomalies.concat(
          anomalies.map(a => ({ ...a, operation_id: operation.id }))
        );
      } catch (err) {
        console.warn(`[compare] Skipping table ${tbl}: ${err.message}`);
      }
    }

    store.insertMany('anomalies', allAnomalies);

    store.updateById('operations', operation.id, {
      statut:        'TERMINE',
      total_lignes:  allAnomalies.length,
      total_diff:    allAnomalies.filter(a => a.alerte_statut !== 'IDENTIQUE').length,
      tables_scanned: tables.length,
    });

    return { ...operation, statut: 'TERMINE', anomalyCount: allAnomalies.length };

  } catch (err) {
    store.updateById('operations', operation.id, { statut: 'ERREUR', message: err.message });
    throw err;
  }
}

module.exports = { runTableCompare, runFullScan, getAllTables, detectPK };
