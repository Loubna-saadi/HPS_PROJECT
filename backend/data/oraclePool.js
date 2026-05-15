/**
 * oraclePool.js
 * ─────────────────────────────────────────────────────────
 * Creates ad-hoc Oracle connections using credentials stored
 * in the user's environment profiles (environments.json).
 *
 * No DB links needed — we connect directly to each database.
 * ─────────────────────────────────────────────────────────
 */

const oracledb = require('oracledb');

// Use Thin mode (no Oracle Client needed on developer laptops)
// If you have Oracle Instant Client installed, comment this line out.
oracledb.initOracleClient(); // remove if you want Thin mode only

// Default fetch size for large result sets
oracledb.fetchArraySize = 200;
oracledb.outFormat      = oracledb.OUT_FORMAT_OBJECT;

/**
 * Get a single connection for an environment profile.
 * @param {object} profile - { username, password, connectString }
 *   connectString examples:
 *     "localhost:1521/XEPDB1"
 *     "192.168.1.10:1521/ORCLPDB"
 */
async function getConnection(profile) {
  return oracledb.getConnection({
    user:          profile.username,
    password:      profile.password,
    connectString: profile.connectString,
  });
}

/**
 * Run a query on an environment and return all rows.
 * Automatically closes the connection.
 */
async function queryEnv(profile, sql, binds = []) {
  let conn;
  try {
    conn = await getConnection(profile);
    const result = await conn.execute(sql, binds, {
      outFormat:  oracledb.OUT_FORMAT_OBJECT,
      fetchArraySize: 500,
    });
    return result.rows ?? [];
  } finally {
    if (conn) await conn.close();
  }
}

/**
 * Get all auditable tables from an Oracle schema.
 * Excludes system + internal tables.
 */
async function getTables(profile) {
  const sql = `
    SELECT table_name
    FROM   user_tables
    WHERE  table_name NOT IN (
             'PARAMETRAGE','ANOMALIE','OPERATION',
             'ENVIRONNEMENT','UTILISATEUR','SCRIPT','IMPORT_LOG'
           )
      AND  table_name NOT LIKE 'BIN$%'
    ORDER BY table_name
  `;
  return queryEnv(profile, sql);
}

/**
 * Get auditable columns for a table.
 * Excludes audit trail columns.
 */
async function getColumns(profile, tableName) {
  const sql = `
    SELECT column_name, data_type, nullable
    FROM   user_tab_columns
    WHERE  table_name  = :1
      AND  column_name NOT IN (
             'USER_CREATE','DATE_CREATE','USER_MODIF','DATE_MODIF'
           )
    ORDER BY column_id
  `;
  return queryEnv(profile, sql, [tableName.toUpperCase()]);
}

/**
 * Get primary key column(s) for a table.
 * Falls back to unique index, then first column.
 */
async function getPrimaryKey(profile, tableName) {
  const tbl = tableName.toUpperCase();

  // 1. PK constraint
  const pkSql = `
    SELECT cols.column_name
    FROM   user_constraints  cons
    JOIN   user_cons_columns cols ON cols.constraint_name = cons.constraint_name
    WHERE  cons.table_name      = :1
      AND  cons.constraint_type = 'P'
    ORDER BY cols.position
  `;
  let rows = await queryEnv(profile, pkSql, [tbl]);
  if (rows.length > 0) return rows.map(r => r.COLUMN_NAME);

  // 2. Unique index fallback
  const uiSql = `
    SELECT ic.column_name
    FROM   user_indexes     i
    JOIN   user_ind_columns ic ON ic.index_name = i.index_name
    WHERE  i.table_name = :1
      AND  i.uniqueness  = 'UNIQUE'
      AND  ROWNUM <= 1
    ORDER BY ic.column_position
  `;
  rows = await queryEnv(profile, uiSql, [tbl]);
  if (rows.length > 0) return rows.map(r => r.COLUMN_NAME);

  // 3. Last resort — first column
  const firstSql = `
    SELECT column_name
    FROM   user_tab_columns
    WHERE  table_name = :1 AND column_id = 1
  `;
  rows = await queryEnv(profile, firstSql, [tbl]);
  return rows.map(r => r.COLUMN_NAME);
}

/**
 * Fetch all rows from a table as key-value pairs.
 * Returns: [{ pk: "VAL1-VAL2", column: "COL_NAME", value: "..." }]
 */
async function fetchTableData(profile, tableName, pkCols, dataCols) {
  if (pkCols.length === 0 || dataCols.length === 0) return [];

  const tbl = tableName.toUpperCase();
  const pkExpr   = pkCols.map(c => `TO_CHAR(${c})`).join(`||'-'||`);
  const colSelect = dataCols.map(c => `SUBSTR(TO_CHAR(${c}),1,3900) AS ${c}`).join(', ');

  const sql = `SELECT ${pkExpr} AS PK_KEY, ${colSelect} FROM ${tbl}`;
  const rows = await queryEnv(profile, sql);

  // Flatten into one record per (pk, column)
  const flat = [];
  for (const row of rows) {
    const pk = row['PK_KEY'] ?? '';
    for (const col of dataCols) {
      flat.push({
        pk_key:  pk,
        column:  col,
        value:   row[col] !== undefined ? String(row[col] ?? '') : null,
      });
    }
  }
  return flat;
}

/**
 * Test connection to an environment profile.
 * Returns { ok: true } or { ok: false, error: "..." }
 */
async function testConnection(profile) {
  let conn;
  try {
    conn = await getConnection(profile);
    await conn.execute('SELECT 1 FROM DUAL');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (conn) await conn.close();
  }
}

module.exports = { getConnection, queryEnv, getTables, getColumns, getPrimaryKey, fetchTableData, testConnection };