require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const { initDataDir } = require('./data/fileStore');

const authRoutes         = require('./routes/auth.routes');
const environmentRoutes  = require('./routes/environments.routes');
const auditRoutes        = require('./routes/audit.routes');
const exportRoutes       = require('./routes/export.routes');
const logsRoutes         = require('./routes/logs.routes');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({ origin: 'http://localhost:4200', credentials: true }));
app.use(express.json({ limit: '10mb' }));

// ── Init local JSON data directory ──────────────────────────────────────────
initDataDir();

// ── Routes  (same URL pattern as your old ORDS endpoints) ──────────────────
app.use('/v1/auth',         authRoutes);
app.use('/v1/environments', environmentRoutes);
app.use('/v1/audit',        auditRoutes);
app.use('/v1/export',       exportRoutes);
app.use('/v1/audit',        logsRoutes);

// ── Health check ────────────────────────────────────────────────────────────
app.get('/v1/health', (_req, res) => res.json({ status: 'ok', time: new Date() }));

// ── Global error handler ────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`✅  ParamSync backend running on http://localhost:${PORT}`);
});