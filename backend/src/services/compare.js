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
  if (v instanceof Date) return v.toISOString();
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
  const sql     = `SELECT ${columns.join(', ')} FROM ${tableName}`;

  // ── Phase A: stream source → Map ─────────────────────────────────────────
  const srcMap = new Map();
  await queryStream(envSrc, sql, [], row => {
    const keyObj = {};
    for (const pk of pkCols) keyObj[pk] = row[pk.toLowerCase()] ?? row[pk];
    srcMap.set(JSON.stringify(keyObj), row);
  });

  // ── Phase B: stream target, compare and free source entries ──────────────
  const anomalies = [];

  await queryStream(envCbl, sql, [], row => {
    const keyObj = {};
    for (const pk of pkCols) keyObj[pk] = row[pk.toLowerCase()] ?? row[pk];
    const keyStr = JSON.stringify(keyObj);

    if (!srcMap.has(keyStr)) {
      anomalies.push({
        cle: keyStr, nom_table: tableName, type_difference: 'ROW',
        valeur_source: null, valeur_cible: safeStr(row),
        alerte_statut: 'ABSENT_DANS_SOURCE',
        description: `Row ${keyStr} exists in ${envCbl} but not in ${envSrc}`,
        statut: 'OUVERT',
      });
      return;
    }

    const srcRow = srcMap.get(keyStr);
    srcMap.delete(keyStr);  // free memory immediately after matching

    for (const col of columns.map(c => c.toLowerCase())) {
      if (pkLower.includes(col)) continue;
      const sv = valStr(srcRow[col]);
      const cv = valStr(row[col]);

      if (sv === cv) {
        if (!onlyDiffs) {
          anomalies.push({
            cle: keyStr, nom_table: tableName, type_difference: col.toUpperCase(),
            valeur_source: sv, valeur_cible: cv,
            alerte_statut: 'IDENTIQUE', description: `Column ${col.toUpperCase()} identical`,
            statut: 'IDENTIQUE',
          });
        }
        continue;
      }

      const alerteStatut = (sv === null || cv === null) ? 'VALEUR_NULL' : 'VALEUR_DIFFERENTE';
      anomalies.push({
        cle: keyStr, nom_table: tableName, type_difference: col.toUpperCase(),
        valeur_source: sv, valeur_cible: cv, alerte_statut: alerteStatut,
        description: `Column ${col.toUpperCase()}: "${sv}" vs "${cv}"`,
        statut: 'OUVERT',
      });
    }
  });

  // ── Phase C: leftover source entries = absent in target ──────────────────
  for (const [keyStr, srcRow] of srcMap) {
    anomalies.push({
      cle: keyStr, nom_table: tableName, type_difference: 'ROW',
      valeur_source: safeStr(srcRow), valeur_cible: null,
      alerte_statut: 'ABSENT_DANS_CIBLE',
      description: `Row ${keyStr} exists in ${envSrc} but not in ${envCbl}`,
      statut: 'OUVERT',
    });
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
const FULL_SCAN_CONCURRENCY  = 4;   // concurrent row comparisons (2 connections each = 8 pool slots)
const COUNT_CONCURRENCY      = 10;  // concurrent COUNT queries for Phase 1
const FLUSH_BATCH_SIZE       = 200; // write to disk every N diff records
const MAX_ROWS_PER_TABLE     = 50000; // tables larger than this skip row comparison

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

    // ── Phase 1: bulk stats — 4 queries total, no per-table round-trips ───────
    console.log(`[compare] Phase 1: fetching schema stats for ${tables.length} tables…`);
    const tableSet = new Set(tables);

    // Run all four bulk fetches in parallel:
    // - COUNT(*) per table on each env (COUNT_CONCURRENCY parallel queries, accurate)
    // - All PKs from source schema (one query)
    // - All columns from source schema (one query)
    console.log(`[compare] Phase 1: counting ${tables.length} tables at concurrency ${COUNT_CONCURRENCY}…`);
    const [srcStats, cblStats, pkMap, colMap] = await Promise.all([
      fetchAllTableCounts(envSrc, tables),
      fetchAllTableCounts(envCbl, tables),
      fetchAllPKs(envSrc),
      fetchAllColumns(envSrc, ALWAYS_EXCLUDED),
    ]);

    const counts = tables
      .filter(tbl => tableSet.has(tbl))
      .map(tbl => ({
        tbl,
        src: srcStats.get(tbl) ?? 0,
        cbl: cblStats.get(tbl) ?? 0,
      }));

    const toCompare = counts.filter(c => !(c.src === 0 && c.cbl === 0) && c.src >= 0);
    const skipped   = tables.length - toCompare.length;

    // ── Phase 1 result: immediately create anomalies for count mismatches ─────
    // Tables where src_count ≠ cbl_count definitely have missing/extra rows.
    // No row fetch needed — the counts say it all.
    const countMismatch  = toCompare.filter(c => c.src !== c.cbl);
    const countMatched   = toCompare.filter(c => c.src === c.cbl);
    // Only do row-level comparison on small equal-count tables (value changes)
    const rowCompare     = countMatched.filter(c => c.src <= MAX_ROWS_PER_TABLE);

    console.log(`[compare] Phase 1 done: ${toCompare.length} non-empty tables.`);
    console.log(`[compare]   ${countMismatch.length} count mismatches → instant anomalies`);
    console.log(`[compare]   ${rowCompare.length} small equal-count tables → row comparison`);
    console.log(`[compare]   ${countMatched.length - rowCompare.length} large equal-count tables → skipped (too large)`);
    console.log(`[compare]   ${skipped} empty tables → skipped`);

    let pending   = [];
    let totalDiff = 0;
    let done      = 0;
    const totalWork = countMismatch.length + rowCompare.length;

    store.updateById('operations', operation.id, {
      tables_total: totalWork,
      tables_done:  0,
    });

    // ── Phase 2a: count-mismatch anomalies (instant — no Oracle calls) ────────
    for (const { tbl, src, cbl } of countMismatch) {
      const type = src > cbl ? 'ABSENT_DANS_CIBLE' : 'ABSENT_DANS_SOURCE';
      pending.push({
        operation_id:    operation.id,
        nom_table:       tbl,
        cle:             'COUNT',
        type_difference: 'ROW_COUNT',
        valeur_source:   String(src),
        valeur_cible:    String(cbl),
        alerte_statut:   type,
        description:     `${tbl}: ${src} rows in ${envSrc} vs ${cbl} rows in ${envCbl}`,
        statut:          'OUVERT',
      });
      totalDiff++;
      done++;
    }
    if (pending.length > 0) {
      store.insertMany('anomalies', pending);
      pending = [];
    }
    store.updateById('operations', operation.id, { tables_done: done, total_diff: totalDiff });
    console.log(`[compare] Phase 2a done: ${countMismatch.length} count-mismatch anomalies saved.`);

    // ── Phase 2b: row-level comparison on small equal-count tables ────────────
    await runWithLimit(rowCompare, FULL_SCAN_CONCURRENCY, async ({ tbl }) => {
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

      if (done % 20 === 0 || done === totalWork) {
        store.updateById('operations', operation.id, { tables_done: done, total_diff: totalDiff });
      }
    });

    // Final flush
    if (pending.length > 0) store.insertMany('anomalies', pending);

    const statut = totalDiff > 0 ? 'ANOMALIES_GENEREES' : 'TERMINE';
    store.updateById('operations', operation.id, {
      statut,
      total_diff:     totalDiff,
      total_lignes:   totalDiff,
      tables_scanned: tables.length,
      tables_done:    toCompare.length,
    });

    return { ...operation, statut, anomalyCount: totalDiff };

  } catch (err) {
    store.updateById('operations', operation.id, { statut: 'ERREUR', message: err.message });
    throw err;
  }
}

module.exports = { runTableCompare, runFullScan, getAllTables, detectPK };
