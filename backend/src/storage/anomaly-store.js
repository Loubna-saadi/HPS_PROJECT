/**
 * storage/anomaly-store.js
 *
 * Stores anomalies in per-operation files: data/anomalies/op_<id>.json
 * This prevents a single shared anomalies.json from growing unbounded.
 *
 * Each file holds ONLY the anomalies for one operation — small and bounded.
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data', 'anomalies');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function opFile(opId) {
  return path.join(DATA_DIR, `op_${opId}.json`);
}

function readOp(opId) {
  const fp = opFile(opId);
  if (!fs.existsSync(fp)) return [];
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch (_) { return []; }
}

function writeOp(opId, records) {
  const fp  = opFile(opId);
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(records), 'utf8');
  fs.renameSync(tmp, fp);
}

// Insert many anomalies for an operation (append-safe)
function insertMany(opId, records) {
  if (!records || records.length === 0) return;
  const existing = readOp(opId);
  writeOp(opId, existing.concat(records));
}

// Get all anomalies for an operation
function getAll(opId) {
  return readOp(opId);
}

// Count anomalies (non-identical) for an operation
function countDiffs(opId) {
  return readOp(opId).filter(a => a.alerte_statut !== 'IDENTIQUE').length;
}

// Delete all anomalies for an operation (cleanup)
function deleteOp(opId) {
  const fp = opFile(opId);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
}

// Get anomaly stats for a list of recent operation IDs (for dashboard)
function getStatsForOps(opIds) {
  const tableMap = new Map();
  for (const opId of opIds) {
    for (const a of readOp(opId)) {
      if (a.alerte_statut === 'IDENTIQUE') continue;
      const tbl = a.nom_table;
      if (!tbl) continue;
      if (!tableMap.has(tbl)) {
        tableMap.set(tbl, { nom_table: tbl, total: 0, absent_cible: 0, absent_source: 0, differente: 0, null_val: 0 });
      }
      const t = tableMap.get(tbl);
      t.total++;
      const s = (a.alerte_statut ?? '').toUpperCase();
      if      (s.includes('ABSENT_DANS_CIBLE'))  t.absent_cible++;
      else if (s.includes('ABSENT_DANS_SOURCE')) t.absent_source++;
      else if (s.includes('NULL'))               t.null_val++;
      else                                       t.differente++;
    }
  }
  return [...tableMap.values()].sort((a, b) => b.total - a.total).slice(0, 8);
}

module.exports = { insertMany, getAll, countDiffs, deleteOp, getStatsForOps };
