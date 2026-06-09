/**
 * ParamSync Backend — Express Entry Point
 * http://localhost:3000/v1/audit/...
 */

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const morgan  = require('morgan');

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '5mb' }));
app.use(morgan('dev'));

// ── Load routes — each wrapped so a bad require doesn't kill the whole server ─
const base = '/v1/audit';

function safeMount(path, file) {
  try {
    app.use(path, require(file));
    console.log(`[routes] ✓ loaded ${file}`);
  } catch (err) {
    console.error(`[routes] ✗ failed to load ${file}:`, err.message);
    // Mount a fallback that explains the error
    app.use(path, (_req, res) => {
      res.status(500).json({ error: `Route module failed to load: ${err.message}` });
    });
  }
}

safeMount('/v1/auth', './routes/auth');
safeMount(base, './routes/dashboard');
safeMount(base, './routes/compare');
safeMount(base, './routes/oracle');
safeMount(base, './routes/scripts');
safeMount(base, './routes/audit-logs');
safeMount(base, './routes/connection-profiles');
safeMount(base, './routes/export');

// ── Health check (always works, even if routes fail) ─────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── 404 fallback ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  console.warn(`[404] ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 ParamSync Backend → http://localhost:${PORT}`);
  console.log(`   Health check:       http://localhost:${PORT}/health`);
  console.log(`   Angular ORDS const: http://localhost:${PORT}/v1\n`);
});

module.exports = app;
