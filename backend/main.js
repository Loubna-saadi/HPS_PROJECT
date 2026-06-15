'use strict';

/**
 * Electron main process — ParamSync desktop app
 *
 * Startup sequence:
 *   1. Enforce single instance
 *   2. Start the Express backend (src/index.js)
 *   3. Poll /health every 300 ms until the server responds
 *   4. Open the BrowserWindow and load the Angular SPA
 */

const { app, BrowserWindow, Menu, protocol } = require('electron');
const http  = require('http');
const path  = require('path');

// ── Single-instance lock ──────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ── Resolve the Angular index.csr.html (dev vs packaged) ─────────────────────────
function getIndexPath() {
  if (app.isPackaged) {
    // extraFiles copies ../frentend/dist → <install_dir>/frentend/dist
    return path.join(
      path.dirname(process.execPath),
      'frentend', 'dist', 'config-sync-app', 'browser', 'index.csr.html'
    );
  }
  return path.join(
    __dirname, '..', 'frentend', 'dist', 'config-sync-app', 'browser', 'index.csr.html'
  );
}

const INDEX_HTML = getIndexPath();

// ── Redirect local JSON data to writable AppData folder when packaged ─────────
process.env.DATA_DIR = path.join(app.getPath('userData'), 'data');

// ── Start Express backend ─────────────────────────────────────────────────────
require('./src/index.js');

// ── Poll until the backend is ready ──────────────────────────────────────────
function waitForBackend(resolve) {
  http.get('http://localhost:3000/health', res => {
    if (res.statusCode === 200) resolve();
    else setTimeout(() => waitForBackend(resolve), 300);
  }).on('error', () => setTimeout(() => waitForBackend(resolve), 300));
}

// ── Create window ─────────────────────────────────────────────────────────────
let win;

function createWindow() {
  Menu.setApplicationMenu(null);

  win = new BrowserWindow({
    width:  1400,
    height: 900,
    show:   false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
    },
    icon: path.join(__dirname, 'assets', 'icon.ico'),
  });

  // Intercept file:// navigations so Angular's router works without a server
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://') && !url.endsWith('.html')) {
      event.preventDefault();
      win.loadFile(INDEX_HTML);
    }
  });

  win.loadFile(INDEX_HTML);

  win.once('ready-to-show', () => win.show());

  if (process.env.NODE_ENV === 'development') {
    win.webContents.openDevTools();
  }

  win.on('closed', () => { win = null; });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  new Promise(resolve => waitForBackend(resolve)).then(createWindow);

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
});

app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (!win) createWindow(); });
