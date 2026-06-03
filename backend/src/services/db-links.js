/**
 * services/db-links.js
 *
 * When a connection profile is saved, automatically create Oracle DB links
 * between all environments and store them in data/environments.json.
 *
 * Link naming: DEV_VAL → DEVVAL_LINK  (underscores removed + _LINK suffix)
 *
 * data/environments.json shape:
 * {
 *   "links": [
 *     { "from_env": "DEV", "to_env": "DEV_VAL", "link_name": "DEVVAL_LINK", "created_at": "..." },
 *     { "from_env": "DEV_VAL", "to_env": "DEV",     "link_name": "DEV_LINK",    "created_at": "..." }
 *   ]
 * }
 */

const fs     = require('fs');
const path   = require('path');
const oracle = require('../oracle/connections');

const ENV_FILE = path.resolve(process.env.DATA_DIR || './data', 'environments.json');

// ── Derive a DB link name from an env_code ────────────────────────────────────
function linkName(envCode) {
  return envCode.replace(/_/g, '') + '_LINK';
}

// ── Read / write environments file ───────────────────────────────────────────
function readEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return { links: [] };
  try { return JSON.parse(fs.readFileSync(ENV_FILE, 'utf8')); }
  catch (_) { return { links: [] }; }
}

function writeEnvFile(data) {
  const tmp = ENV_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, ENV_FILE);
}

// ── Public: get stored link name ──────────────────────────────────────────────
function getLinkForEnv(fromEnv, toEnv) {
  const { links } = readEnvFile();
  const found = links.find(
    l => l.from_env === fromEnv.toUpperCase() && l.to_env === toEnv.toUpperCase()
  );
  return found ? found.link_name : linkName(toEnv);
}

// ── Create ONE db link inside fromEnv pointing to toProfile ──────────────────
async function createLink(fromProfile, toProfile) {
  const name      = linkName(toProfile.env_code);
  const connectStr =
    `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${toProfile.host})(PORT=${toProfile.port}))` +
    `(CONNECT_DATA=(SERVICE_NAME=${toProfile.service_name})))`;

  const sql = `CREATE OR REPLACE DATABASE LINK "${name}"
  CONNECT TO "${toProfile.db_username}" IDENTIFIED BY "${toProfile.db_password}"
  USING '${connectStr}'`;

  await oracle.query(fromProfile.env_code, sql);
  console.log(`[db-links] Created ${name} in ${fromProfile.env_code} → ${toProfile.env_code}`);
  return name;
}

// ── Main: called after a profile is saved ────────────────────────────────────
// Creates links between the new profile and all existing ones (both directions).
// Returns a summary of what was created/failed.
async function syncLinksForProfile(newProfile, allProfiles) {
  const others = allProfiles.filter(p => p.env_code !== newProfile.env_code);
  if (others.length === 0) return { created: [], failed: [] };

  const data    = readEnvFile();
  const created = [];
  const failed  = [];

  for (const other of others) {
    // new → other
    try {
      const name = await createLink(newProfile, other);
      upsertLink(data, newProfile.env_code, other.env_code, name);
      created.push({ from: newProfile.env_code, to: other.env_code, link: name });
    } catch (err) {
      console.warn(`[db-links] Failed ${newProfile.env_code}→${other.env_code}:`, err.message);
      failed.push({ from: newProfile.env_code, to: other.env_code, error: err.message });
      // Still store derived name so script generation can use it
      upsertLink(data, newProfile.env_code, other.env_code, linkName(other.env_code));
    }

    // other → new
    try {
      const name = await createLink(other, newProfile);
      upsertLink(data, other.env_code, newProfile.env_code, name);
      created.push({ from: other.env_code, to: newProfile.env_code, link: name });
    } catch (err) {
      console.warn(`[db-links] Failed ${other.env_code}→${newProfile.env_code}:`, err.message);
      failed.push({ from: other.env_code, to: newProfile.env_code, error: err.message });
      upsertLink(data, other.env_code, newProfile.env_code, linkName(newProfile.env_code));
    }
  }

  writeEnvFile(data);
  return { created, failed };
}

function upsertLink(data, fromEnv, toEnv, name) {
  const existing = data.links.findIndex(
    l => l.from_env === fromEnv && l.to_env === toEnv
  );
  const entry = { from_env: fromEnv, to_env: toEnv, link_name: name, updated_at: new Date().toISOString() };
  if (existing >= 0) data.links[existing] = entry;
  else data.links.push(entry);
}

module.exports = { syncLinksForProfile, getLinkForEnv, linkName, readEnvFile };
