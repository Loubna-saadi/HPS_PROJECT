/**
 * routes/connection-profiles.js
 *
 * Manages per-environment Oracle connection credentials.
 * All data is stored in data/connection-profiles.json (local file — no hardcoding).
 *
 * The user fills this page first. Without a profile for an environment,
 * any compare/table/column call against that env will return a clear error.
 *
 * Endpoints:
 *   GET    /v1/audit/connection-profiles            list all (password masked)
 *   POST   /v1/audit/connection-profiles            create or update a profile
 *   DELETE /v1/audit/connection-profiles/:envCode   delete a profile
 *   POST   /v1/audit/connection-profiles/test       test live connectivity
 */

const express  = require('express');
const router   = express.Router();
const store    = require('../storage/store');
const oracle   = require('../oracle/connections');
const dbLinks  = require('../services/db-links');

const ALL_ENVS = ['DEV', 'DEV_VAL', 'UAT', 'SIT', 'PROD'];

// ── GET /v1/audit/connection-profiles ─────────────────────────────────────────
router.get('/connection-profiles', (req, res) => {
  const profiles = store.findAll('connection-profiles');

  const safe = profiles.map(p => ({
    ...p,
    db_password:  '••••••••',   // NEVER send the real password to the client
    link_exists:  1,
  }));

  res.json({ items: safe });
});

// ── POST /v1/audit/connection-profiles ────────────────────────────────────────
// Body: { env_code, host, port?, service_name, db_username, db_password, description?, user_id? }
router.post('/connection-profiles', async (req, res) => {
  const {
    env_code,
    host,
    port         = 1521,
    service_name,
    db_username,
    db_password,
    description  = '',
    user_id,
  } = req.body;

  // ── Validation ────────────────────────────────────────────────────────────
  if (!env_code)     return res.status(400).json({ error: 'env_code is required' });
  if (!host)         return res.status(400).json({ error: 'host is required' });
  if (!service_name) return res.status(400).json({ error: 'service_name is required' });
  if (!db_username)  return res.status(400).json({ error: 'db_username is required' });
  if (!db_password)  return res.status(400).json({ error: 'db_password is required' });

  const code = env_code.toUpperCase();
  if (!ALL_ENVS.includes(code)) {
    return res.status(400).json({ error: `Unknown environment "${code}". Valid values: ${ALL_ENVS.join(', ')}` });
  }

  // ── Upsert ────────────────────────────────────────────────────────────────
  const profiles = store.findAll('connection-profiles');
  const existing = profiles.find(p => p.env_code === code);
  let profile;

  if (existing) {
    // Keep the stored password if the UI sends back the masked placeholder
    const finalPass = (db_password === '••••••••') ? existing.db_password : db_password;
    profile = store.updateById('connection-profiles', existing.id, {
      host,
      port:         Number(port),
      service_name,
      db_username,
      db_password:  finalPass,
      description,
    });
  } else {
    profile = store.insert('connection-profiles', {
      env_code:     code,
      host,
      port:         Number(port),
      service_name,
      db_username,
      db_password,
      description,
      created_by:   user_id || null,
      last_test_ok: null,
      last_tested_at: null,
    });
  }

  // Invalidate any cached pool so the next query uses the new credentials
  await oracle.invalidatePool(code);

  // Auto-create DB links between this env and all others
  const allProfiles = store.findAll('connection-profiles');
  const linkSummary = await dbLinks.syncLinksForProfile(profile, allProfiles);
  console.log(`[profiles] DB links sync: ${linkSummary.created.length} created, ${linkSummary.failed.length} failed`);

  res.json({
    id:           profile.id,
    env_code:     profile.env_code,
    links_created: linkSummary.created,
    links_failed:  linkSummary.failed,
    link_result:  'OK',
    success:      true,
  });
});

// ── DELETE /v1/audit/connection-profiles/:envCode ─────────────────────────────
router.delete('/connection-profiles/:envCode', async (req, res) => {
  const code     = req.params.envCode.toUpperCase();
  const profiles = store.findAll('connection-profiles');
  const profile  = profiles.find(p => p.env_code === code);

  if (!profile) {
    return res.status(404).json({ error: `No profile found for environment "${code}"` });
  }

  store.deleteById('connection-profiles', profile.id);

  // Close the pool for this env — credentials are gone
  await oracle.invalidatePool(code);

  res.json({ success: true, env_code: code });
});

// ── POST /v1/audit/connection-profiles/test ───────────────────────────────────
// Body: { env_code }
// Must be defined BEFORE the /:envCode DELETE route so Express doesn't
// treat "test" as an envCode parameter.
router.post('/connection-profiles/test', async (req, res) => {
  const { env_code } = req.body;
  if (!env_code) return res.status(400).json({ error: 'env_code is required' });

  const code = env_code.toUpperCase();

  // Check the profile exists before trying to connect
  const profiles = store.findAll('connection-profiles');
  const profile  = profiles.find(p => p.env_code === code);
  if (!profile) {
    return res.status(404).json({
      env_code: code,
      ok: 0,
      message: `No connection profile found for "${code}". Please save the profile first.`,
      latency_ms: 0,
    });
  }

  const result = await oracle.testConnection(code);

  // Persist the test result
  store.updateById('connection-profiles', profile.id, {
    last_test_ok:   result.ok ? 1 : 0,
    last_tested_at: new Date().toISOString(),
  });

  res.json({
    env_code:   code,
    ok:         result.ok ? 1 : 0,
    message:    result.message,
    latency_ms: result.latencyMs,
  });
});

module.exports = router;
