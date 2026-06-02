/**
 * storage.js — Local JSON file store
 *
 * Replaces: OPERATION, ANOMALIE, SCRIPT, UTILISATEUR, AUDIT_LOG Oracle tables
 *
 * Each "table" is one JSON file under /data/<collection>.json
 * Format: { "records": [ {...}, ... ], "seq": <last_id> }
 *
 * All operations are synchronous + atomic via write-then-rename
 * (good enough for a single-user / small-team tool).
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * Return the file path for a collection name.
 */
function filePath(collection) {
  return path.join(DATA_DIR, `${collection}.json`);
}

/**
 * Read all records from a collection.
 * Returns { records: [], seq: 0 } if the file doesn't exist yet.
 */
function readAll(collection) {
  const fp = filePath(collection);
  if (!fs.existsSync(fp)) return { records: [], seq: 0 };
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return { records: [], seq: 0 };
  }
}

/**
 * Write the store back to disk atomically.
 */
function writeAll(collection, store) {
  const fp  = filePath(collection);
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, fp);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Insert a record. Auto-assigns an integer `id`.
 * Returns the inserted record (with id).
 */
function insert(collection, record) {
  const store = readAll(collection);
  store.seq += 1;
  const row = { id: store.seq, ...record, created_at: new Date().toISOString() };
  store.records.push(row);
  writeAll(collection, store);
  return row;
}

/**
 * Find all records matching a predicate (optional).
 */
function findAll(collection, predicate = null) {
  const { records } = readAll(collection);
  return predicate ? records.filter(predicate) : records;
}

/**
 * Find one record by id.
 */
function findById(collection, id) {
  const { records } = readAll(collection);
  return records.find(r => r.id === Number(id)) || null;
}

/**
 * Update one record by id. Shallow-merges `changes`.
 * Returns the updated record or null if not found.
 */
function updateById(collection, id, changes) {
  const store = readAll(collection);
  const idx   = store.records.findIndex(r => r.id === Number(id));
  if (idx === -1) return null;
  store.records[idx] = { ...store.records[idx], ...changes, updated_at: new Date().toISOString() };
  writeAll(collection, store);
  return store.records[idx];
}

/**
 * Delete one record by id. Returns true if deleted.
 */
function deleteById(collection, id) {
  const store = readAll(collection);
  const before = store.records.length;
  store.records = store.records.filter(r => r.id !== Number(id));
  if (store.records.length === before) return false;
  writeAll(collection, store);
  return true;
}

/**
 * Insert many records at once (bulk). Returns inserted rows.
 */
function insertMany(collection, rows) {
  const store = readAll(collection);
  const inserted = rows.map(record => {
    store.seq += 1;
    return { id: store.seq, ...record, created_at: new Date().toISOString() };
  });
  store.records.push(...inserted);
  writeAll(collection, store);
  return inserted;
}

/**
 * Delete all records matching a predicate.
 * Returns the count of deleted records.
 */
function deleteWhere(collection, predicate) {
  const store  = readAll(collection);
  const before = store.records.length;
  store.records = store.records.filter(r => !predicate(r));
  writeAll(collection, store);
  return before - store.records.length;
}

module.exports = {
  insert,
  insertMany,
  findAll,
  findById,
  updateById,
  deleteById,
  deleteWhere,
};
