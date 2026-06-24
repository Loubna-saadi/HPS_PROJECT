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

const oracle       = require('../oracle/connections');
const store        = require('../storage/store');
const anomalyStore = require('../storage/anomaly-store');
const { queryStream } = oracle;

// Columns always excluded from comparison regardless of user input
const ALWAYS_EXCLUDED = [
  'DATE_MODIF',
  'USER_MODIF',
  'DATE_CREATE',
  'USER_CREATE',
  'SENSITIVE_OPERATION_RECORD',
];

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

// ── String-safe comparison ────────────────────────────────────────────────────

function valStr(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString(); // fallback: fetchTypeHandler should prevent this
  return String(v);
}

// ── Compare two tables — streaming, low memory ────────────────────────────────
//
// Strategy:
//   Phase A — stream source into a Map (500 rows at a time, never a full array)
//   Phase B — stream target: match against Map, delete entries as they match
//             (Map shrinks during this phase, freeing memory continuously)
//   Phase C — remaining Map entries = rows absent in target
//
// onlyDiffs=true skips IDENTIQUE records (used for full-scan to save memory/disk)
//
// pkMap / colMap are optional pre-fetched bulk caches from runFullScan.
// When provided, no Oracle round-trip is needed for PK/column detection.
async function compareTable(envSrc, envCbl, tableName, excludedColumns = [], onlyDiffs = false, pkMap = null, colMap = null) {
  const excl = [...new Set([...ALWAYS_EXCLUDED, ...excludedColumns.map(c => c.toUpperCase())])];

  // PK: use bulk cache if available, else query Oracle
  let pkCols;
  if (pkMap && pkMap.has(tableName)) {
    pkCols = pkMap.get(tableName);
  } else {
    pkCols = await detectPK(envSrc, tableName);
  }

  // Columns: use bulk cache if available, else query Oracle
  let columns;
  if (colMap && colMap.has(tableName)) {
    columns = colMap.get(tableName).filter(c => !excl.includes(c.toUpperCase()));
  } else {
    const colRows = await oracle.query(envSrc, `
      SELECT column_name FROM all_tab_columns
      WHERE  UPPER(table_name) = :tbl ORDER BY column_id
    `, [tableName.toUpperCase()]);
    columns = [...new Set(colRows.map(r => r.column_name).filter(c => !excl.includes(c.toUpperCase())))];
  }

  if (columns.length === 0) throw new Error(`No columns found for "${tableName}" in ${envSrc}`);

  const pkLower = pkCols.map(c => c.toLowerCase());
  const colsLow = columns.map(c => c.toLowerCase());
  const sql     = `SELECT ${columns.join(', ')} FROM ${tableName}`;

  // Build a PK-based key (for display/grouping in anomalies)
  function makePkKey(row) {
    const obj = {};
    for (const pk of pkCols) obj[pk] = row[pk.toLowerCase()] ?? row[pk];
    return JSON.stringify(obj);
  }

  // Build a full-row normalized key (used when PK is not unique)
  function makeFullKey(row) {
    const obj = {};
    for (const c of colsLow) obj[c] = valStr(row[c]);
    return JSON.stringify(obj);
  }

  // ── Phase A: stream source → Map, detect PK collision ────────────────────
  const srcMap = new Map(); // Map<keyStr, row[]>
  let hasCollision = false;

  await queryStream(envSrc, sql, [], row => {
    const keyStr = makePkKey(row);
    if (srcMap.has(keyStr)) hasCollision = true;
    if (!srcMap.has(keyStr)) srcMap.set(keyStr, []);
    srcMap.get(keyStr).push(row);
  });

  // PK is not unique → rebuild srcMap keyed by full row values.
  // This switches to existence-based comparison: a row is either present in both
  // environments (all columns identical) or absent from one side.
  if (hasCollision) {
    const newMap = new Map();
    for (const bucket of srcMap.values()) {
      for (const srcRow of bucket) {
        const fullKey = makeFullKey(srcRow);
        if (!newMap.has(fullKey)) newMap.set(fullKey, []);
        newMap.get(fullKey).push(srcRow);
      }
    }
    srcMap.clear();
    for (const [k, v] of newMap) srcMap.set(k, v);
  }

  // ── Phase B: stream target, compare and free source entries ──────────────
  const anomalies = [];

  await queryStream(envCbl, sql, [], row => {
    const pkKey  = makePkKey(row);
    const mapKey = hasCollision ? makeFullKey(row) : pkKey;

    const bucket = srcMap.get(mapKey);
    if (!bucket || bucket.length === 0) {
      anomalies.push({
        cle: pkKey, nom_table: tableName, type_difference: 'ROW',
        valeur_source: null, valeur_cible: safeStr(row),
        alerte_statut: 'ABSENT_DANS_SOURCE',
        description: `Row ${pkKey} exists in ${envCbl} but not in ${envSrc}`,
        statut: 'OUVERT',
      });
      return;
    }

    const srcRow = bucket.shift();
    if (bucket.length === 0) srcMap.delete(mapKey);

    // Full-row match: all columns are identical by definition (that was the key)
    if (hasCollision) {
      if (!onlyDiffs) {
        anomalies.push({
          cle: pkKey, nom_table: tableName, type_difference: 'ROW',
          valeur_source: safeStr(srcRow), valeur_cible: safeStr(row),
          alerte_statut: 'IDENTIQUE', description: `Row ${pkKey} identical`,
          statut: 'IDENTIQUE',
        });
      }
      return;
    }

    // Unique PK: column-level comparison
    for (const col of colsLow) {
      if (pkLower.includes(col)) continue;
      const sv = valStr(srcRow[col]);
      const cv = valStr(row[col]);

      if (sv === cv) {
        if (!onlyDiffs) {
          anomalies.push({
            cle: pkKey, nom_table: tableName, type_difference: col.toUpperCase(),
            valeur_source: sv, valeur_cible: cv,
            alerte_statut: 'IDENTIQUE', description: `Column ${col.toUpperCase()} identical`,
            statut: 'IDENTIQUE',
          });
        }
        continue;
      }

      const alerteStatut = (sv === null || cv === null) ? 'VALEUR_NULL' : 'VALEUR_DIFFERENTE';
      anomalies.push({
        cle: pkKey, nom_table: tableName, type_difference: col.toUpperCase(),
        valeur_source: sv, valeur_cible: cv, alerte_statut: alerteStatut,
        description: `Column ${col.toUpperCase()}: "${sv}" vs "${cv}"`,
        statut: 'OUVERT',
      });
    }
  });

  // ── Phase C: leftover source entries = absent in target ──────────────────
  for (const [mapKey, bucket] of srcMap) {
    for (const srcRow of bucket) {
      const pkKey = hasCollision ? makePkKey(srcRow) : mapKey;
      anomalies.push({
        cle: pkKey, nom_table: tableName, type_difference: 'ROW',
        valeur_source: safeStr(srcRow), valeur_cible: null,
        alerte_statut: 'ABSENT_DANS_CIBLE',
        description: `Row ${pkKey} exists in ${envSrc} but not in ${envCbl}`,
        statut: 'OUVERT',
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

    anomalyStore.insertMany(operation.id, anomalies.map(a => ({ ...a, operation_id: operation.id })));
    const saved = anomalies;

    const totalDiff = anomalies.filter(a => a.alerte_statut !== 'IDENTIQUE').length;
    const statut    = totalDiff > 0 ? 'ANOMALIES_GENEREES' : 'TERMINE';

    store.updateById('operations', operation.id, {
      statut,
      total_lignes: anomalies.length,
      total_diff:   totalDiff,
    });

    return { ...operation, statut, anomalyCount: saved.length };

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
const FULL_SCAN_CONCURRENCY  = 4;     // concurrent table comparisons (2 connections each = 8 pool slots)
const COUNT_CONCURRENCY      = 10;    // concurrent COUNT(*) queries when sizing tables
const FLUSH_BATCH_SIZE       = 200;   // write to disk every N diff records
const MAX_ROWS_PER_TABLE     = 50000; // tables larger than this are skipped (too slow to stream)

// ── Bulk schema pre-fetch ─────────────────────────────────────────────────────
// Fetches ALL PKs and column lists for the entire schema in 2 queries.
// Returns Maps so per-table lookup is O(1) with no Oracle round-trip.

async function fetchAllPKs(envCode) {
  const map = new Map(); // tableName → [colName, ...]
  try {
    const rows = await oracle.query(envCode, `
      SELECT c.table_name, k.column_name, k.position
      FROM   user_constraints c
      JOIN   user_cons_columns k
             ON k.constraint_name = c.constraint_name
      WHERE  c.constraint_type = 'P'
      ORDER  BY c.table_name, k.position
    `);
    for (const r of rows) {
      const tbl = r.table_name;
      if (!map.has(tbl)) map.set(tbl, []);
      map.get(tbl).push(r.column_name);
    }
  } catch (err) {
    console.warn('[compare] fetchAllPKs failed:', err.message);
  }
  return map;
}

async function fetchAllColumns(envCode, excludedCols = []) {
  const excl = excludedCols.map(c => c.toUpperCase());
  const map  = new Map(); // tableName → [colName, ...]
  try {
    const rows = await oracle.query(envCode, `
      SELECT table_name, column_name
      FROM   user_tab_columns
      ORDER  BY table_name, column_id
    `);
    for (const r of rows) {
      const tbl = r.table_name;
      const col = r.column_name;
      if (excl.includes(col.toUpperCase())) continue;
      if (!map.has(tbl)) map.set(tbl, []);
      map.get(tbl).push(col);
    }
  } catch (err) {
    console.warn('[compare] fetchAllColumns failed:', err.message);
  }
  return map;
}

// Counts all tables with COUNT_CONCURRENCY parallel queries — accurate and robust.
// Returns Map: tableName → exact row count (-1 = unreadable/skip)
async function fetchAllTableCounts(envCode, tables) {
  const map     = new Map();
  const results = await runWithLimit(tables, COUNT_CONCURRENCY, async (tbl) => {
    try {
      const rows = await oracle.query(envCode, `SELECT COUNT(*) AS cnt FROM "${tbl}"`);
      return { tbl, cnt: Number(rows[0]?.cnt ?? 0) };
    } catch (_) {
      return { tbl, cnt: -1 };
    }
  });
  for (const r of results) if (r) map.set(r.tbl, r.cnt);
  return map;
}


// ── Worker-queue runner — keeps LIMIT workers busy at all times ───────────────
async function runWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let   next    = 0;

  async function worker() {
    while (next < items.length) {
      const idx = next++;
      try       { results[idx] = await fn(items[idx], idx); }
      catch (e) { results[idx] = { error: e.message };      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Safe stringify — avoids circular reference crashes on Oracle internal objects
function safeStr(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v !== 'object') return String(v);
  try { return JSON.stringify(v); } catch (_) { return '[unserializable]'; }
}

async function runFullScan({ envSrc, envCbl, excludedTables = [], userId, operationId = null }) {
  const excl = typeof excludedTables === 'string'
    ? excludedTables.split(',').filter(Boolean)
    : excludedTables;

  // Reuse a pre-created operation if the route already inserted one
  const operation = operationId
    ? { id: operationId }
    : store.insert('operations', {
        env_source:      envSrc,
        env_cible:       envCbl,
        nom_table:       'FULL_SCAN',
        statut:          'EN_COURS',
        type:            'COMPARAISON_SCHEMA',
        utilisateur_id:  userId,
        excluded_tables: excl.join(','),
      });

  try {
    const tables = await getAllTables(envSrc, excl);

    // Pre-fetch PKs and columns once for the whole schema (avoids one Oracle
    // round-trip per table — transparent cache, does not change the comparison logic)
    console.log(`[compare] Fetching schema metadata for ${tables.length} tables…`);
    const [srcStats, pkMap, colMap] = await Promise.all([
      fetchAllTableCounts(envSrc, tables),
      fetchAllPKs(envSrc),
      fetchAllColumns(envSrc, ALWAYS_EXCLUDED),
    ]);

    // Skip tables that are empty in source or too large to stream row-by-row
    const toCompare = tables.filter(tbl => {
      const cnt = srcStats.get(tbl) ?? 0;
      return cnt > 0 && cnt <= MAX_ROWS_PER_TABLE;
    });

    console.log(`[compare] ${toCompare.length} / ${tables.length} tables will be compared row-by-row`);
    console.log(`[compare] ${tables.length - toCompare.length} tables skipped (empty or > ${MAX_ROWS_PER_TABLE} rows)`);

    store.updateById('operations', operation.id, {
      tables_total: toCompare.length,
      tables_done:  0,
    });

    let pending   = [];
    let totalDiff = 0;
    let done      = 0;

    // Same logic as runTableCompare — compareTable for every table
    await runWithLimit(toCompare, FULL_SCAN_CONCURRENCY, async (tbl) => {
      try {
        const diffs = await compareTable(envSrc, envCbl, tbl, [], true, pkMap, colMap);
        if (diffs.length > 0) {
          pending.push(...diffs.map(a => ({ ...a, operation_id: operation.id })));
          totalDiff += diffs.length;
        }
      } catch (err) {
        console.warn(`[compare] Skipping ${tbl}: ${err.message}`);
      }

      done++;

      if (pending.length >= FLUSH_BATCH_SIZE) {
        anomalyStore.insertMany(operation.id, pending);
        pending = [];
      }

      if (done % 20 === 0 || done === toCompare.length) {
        store.updateById('operations', operation.id, { tables_done: done, total_diff: totalDiff });
      }
    });

    // Final flush
    if (pending.length > 0) anomalyStore.insertMany(operation.id, pending);

    const statut = totalDiff > 0 ? 'ANOMALIES_GENEREES' : 'TERMINE';
    store.updateById('operations', operation.id, {
      statut,
      total_diff:     totalDiff,
      total_lignes:   totalDiff,
      tables_scanned: tables.length,
      tables_done:    done,
    });

    return { ...operation, statut, anomalyCount: totalDiff };

  } catch (err) {
    store.updateById('operations', operation.id, { statut: 'ERREUR', message: err.message });
    throw err;
  }
}

module.exports = { runTableCompare, runFullScan, getAllTables, detectPK };
