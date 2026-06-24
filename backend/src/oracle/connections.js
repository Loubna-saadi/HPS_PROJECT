/**
 * oracle/connections.js
 *
 * Lazy-loaded Oracle connection manager.
 * oracledb is only required on first actual use — not at startup.
 * This prevents Windows startup crashes if the native module has issues.
 *
 * ALL credentials come exclusively from data/connection-profiles.json
 * (filled by the user via the Connection Profiles UI page).
 * No .env fallback, no hardcoded values.
 */

const store = require('../storage/store');

// Lazy-load oracledb — only when a connection is actually needed
let oracledb = null;

function getOracleDb() {
  if (oracledb) return oracledb;
  try {
    oracledb = require('oracledb');
    oracledb.thin = true;   // Pure JS driver — no Instant Client needed
    console.log('[oracle] oracledb loaded in thin mode');
  } catch (err) {
    throw new Error(
      `Failed to load oracledb: ${err.message}\n` +
      `Run: npm install oracledb`
    );
  }
  return oracledb;
}

// fetchTypeHandler passed to every execute() call.
// Converts Oracle DATE and TIMESTAMP columns to plain strings so that no
// JS timezone conversion is applied — both environments return the exact
// same raw bytes for the same stored value, making comparison reliable.
function makeFetchTypeHandler(db) {
  return (meta) => {
    if (
      meta.dbType === db.DB_TYPE_DATE      ||
      meta.dbType === db.DB_TYPE_TIMESTAMP ||
      meta.dbType === db.DB_TYPE_TIMESTAMP_TZ  ||
      meta.dbType === db.DB_TYPE_TIMESTAMP_LTZ
    ) {
      return { type: db.STRING };
    }
  };
}

// Pool cache: env_code (uppercase) → pool instance
const pools = {};

// ── Profile lookup ────────────────────────────────────────────────────────────

function getProfileForEnv(envCode) {
  const code     = envCode.toUpperCase();
  const profiles = store.findAll('connection-profiles');
  const profile  = profiles.find(p => p.env_code === code);

  if (!profile) {
    throw new Error(
      `No connection profile configured for "${code}". ` +
      `Open the Connection Profiles page and save credentials for ${code} first.`
    );
  }

  const missing = ['host', 'service_name', 'db_username', 'db_password']
    .filter(f => !profile[f]);

  if (missing.length) {
    throw new Error(
      `Profile for "${code}" is incomplete — missing: ${missing.join(', ')}. ` +
      `Please update it in the Connection Profiles page.`
    );
  }

  return {
    host:        profile.host,
    port:        Number(profile.port) || 1521,
    serviceName: profile.service_name,
    user:        profile.db_username,
    password:    profile.db_password,
  };
}

// ── Pool management ───────────────────────────────────────────────────────────

async function getPool(envCode) {
  const code = envCode.toUpperCase();
  if (pools[code]) return pools[code];

  const db = getOracleDb();
  const p  = getProfileForEnv(code);

  const connectString =
    `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${p.host})(PORT=${p.port}))` +
    `(CONNECT_DATA=(SERVICE_NAME=${p.serviceName})))`;

  console.log(`[oracle] Creating pool for ${code} → ${p.host}:${p.port}/${p.serviceName}`);

  pools[code] = await db.createPool({
    user:          p.user,
    password:      p.password,
    connectString,
    poolMin:       2,
    poolMax:       20,
    poolIncrement: 2,
    queueTimeout:  120000,
    poolAlias:     `pool_${code}`,
    // Normalise every new physical connection: UTC session timezone so the
    // driver interprets DATE bytes the same way regardless of DBTIMEZONE,
    // and a fixed NLS_DATE_FORMAT so fetchTypeHandler returns consistent strings.
    sessionCallback: async (conn) => {
      await conn.execute(
        `ALTER SESSION SET TIME_ZONE = 'UTC' NLS_DATE_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS'`
      );
    },
  });

  console.log(`[oracle] Pool ready for ${code}`);
  return pools[code];
}

async function invalidatePool(envCode) {
  const code = envCode.toUpperCase();
  if (pools[code]) {
    try { await pools[code].close(0); } catch (_) {}
    delete pools[code];
    console.log(`[oracle] Pool invalidated for ${code}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

async function getConnection(envCode) {
  const pool = await getPool(envCode);
  return pool.getConnection();
}

async function releaseConnection(conn) {
  if (conn) {
    try { await conn.close(); } catch (_) {}
  }
}

async function testConnection(envCode) {
  const code  = envCode.toUpperCase();
  const start = Date.now();
  let conn;
  try {
    conn = await getConnection(code);
    await conn.execute('SELECT 1 FROM DUAL');
    await releaseConnection(conn);
    conn = null;
    return { ok: true, latencyMs: Date.now() - start, message: 'OK' };
  } catch (err) {
    await releaseConnection(conn);
    return { ok: false, latencyMs: Date.now() - start, message: err.message };
  } finally {
    await invalidatePool(code);
  }
}

async function query(envCode, sql, binds = [], opts = {}) {
  const db   = getOracleDb();
  let conn;
  try {
    conn = await getConnection(envCode);
    const result = await conn.execute(sql, binds, {
      outFormat:       db.OUT_FORMAT_OBJECT,
      fetchArraySize:  1000,
      fetchTypeHandler: makeFetchTypeHandler(db),
      ...opts,
    });
    return (result.rows || []).map(row => {
      const out = {};
      for (const k of Object.keys(row)) out[k.toLowerCase()] = row[k];
      return out;
    });
  } finally {
    await releaseConnection(conn);
  }
}

// Stream rows from Oracle in batches — never loads the whole table into memory.
// rowCallback(row) is called once per row with lowercased keys.
async function queryStream(envCode, sql, binds = [], rowCallback, batchSize = 500) {
  const db = getOracleDb();
  let conn;
  try {
    conn = await getConnection(envCode);
    const result = await conn.execute(sql, binds, {
      outFormat:        db.OUT_FORMAT_OBJECT,
      fetchArraySize:   batchSize,
      resultSet:        true,
      fetchTypeHandler: makeFetchTypeHandler(db),
    });
    const rs = result.resultSet;
    let batch;
    while ((batch = await rs.getRows(batchSize)).length > 0) {
      for (const row of batch) {
        const out = {};
        for (const k of Object.keys(row)) out[k.toLowerCase()] = row[k];
        await rowCallback(out);
      }
    }
    await rs.close();
  } finally {
    await releaseConnection(conn);
  }
}

module.exports = { getConnection, releaseConnection, testConnection, invalidatePool, query, queryStream };
