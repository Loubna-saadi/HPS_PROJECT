# ParamSync — Developer Setup Guide

ParamSync is a desktop app (Electron + Angular + Express) for comparing PowerCard parameter tables across Oracle environments (DEV, DEV_VAL, UAT, SIT, PROD).

---

## Prerequisites

| Tool | Version | Download |
|------|---------|----------|
| Node.js | v20 or higher | https://nodejs.org |
| npm | v9 or higher (comes with Node) | — |
| Git | any recent version | https://git-scm.com |

> No Oracle Client installation needed — the backend uses oracledb in **thin mode** (pure JS driver).

---

## Project Structure

```
HPS_PROJECT/
├── backend/          ← Node.js/Express API server (port 3000)
│   ├── main.js       ← Electron entry point
│   ├── src/
│   │   ├── index.js  ← Express entry point (dev mode)
│   │   ├── routes/   ← API route handlers
│   │   ├── oracle/   ← Oracle connection manager
│   │   └── storage/  ← Local JSON file store (users, profiles, logs)
│   └── data/         ← Auto-created on first run (JSON data files)
└── frentend/         ← Angular 21 SPA
    └── src/
```

---

## Installation

Run these commands once after cloning the project.

**1 — Install backend dependencies**
```bash
cd backend
npm install
```

**2 — Install frontend dependencies**
```bash
cd frentend
npm install
```

---

## Running in Development Mode

You need **two terminals** running at the same time.

**Terminal 1 — Backend (Express API)**
```bash
cd backend
npm run dev
```
The API will start at `http://localhost:3000`. You should see:
```
🚀 ParamSync Backend → http://localhost:3000
```

**Terminal 2 — Frontend (Angular)**
```bash
cd frentend
npm start
```
The UI will open at `http://localhost:4200`.

---

## First-Time Configuration

### 1. Create an account
Go to `http://localhost:4200` → click **Sign Up** → create your user account.

### 2. Configure Oracle connection profiles
Go to the **Connection Profiles** page in the app and add credentials for each Oracle environment you want to use:

| Field | Example |
|-------|---------|
| Environment | DEV |
| Host | 192.168.x.x *(ask your DBA for the server IP)* |
| Port | 1522 |
| Service Name | PCARD |
| DB Username | your_oracle_user |
| DB Password | your_oracle_password |

> **Important:** The connection credentials are stored locally in `backend/data/connection-profiles.json`. Never commit this file — it is already in `.gitignore`.

---

## Building the Electron Desktop App (for distribution)

**Step 1 — Build the Angular frontend**
```bash
cd frentend
npm run build
```

**Step 2 — Package the Electron app**
```bash
cd backend
npm run build
```

Output: `backend/dist/win-unpacked/` — zip this folder and share it.
Recipients extract the zip and run `ParamSync.exe` — no Node.js required on their machine.

> After running `npm run build`, if you want to go back to dev mode, run:
> ```bash
> cd backend
> npm rebuild oracledb
> ```
> This is needed because the packager recompiles native modules for Electron's Node.js version.

---

## Common Errors

### `ERR_CONNECTION_REFUSED` on the frontend
The backend is not running. Start it with `npm run dev` in the `backend` folder.

### `NJS-503: connection to host X could not be established`
The Oracle connection profile for that environment has wrong credentials or an unreachable host. Go to **Connection Profiles** in the app and verify/update the host and port.

### `500 Internal Server Error` on columns/tables endpoints
Same as above — the environment's Oracle server is not reachable. Check the connection profile for that environment.

---

## Environment Variables (optional)

The backend reads an optional `.env` file. Copy the example and edit it:
```bash
cd backend
copy .env.example .env
```

The only values that matter for dev mode:

```env
PORT=3000          # API port (default: 3000)
NODE_ENV=development
DATA_DIR=./data    # Where JSON data files are stored (default: ./data)
```

Oracle credentials are configured via the app UI, not via `.env`.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Electron 33 |
| Frontend | Angular 21, Bootstrap 5 |
| Backend | Node.js, Express 4 |
| Database | Oracle DB (thin mode via oracledb v6) |
| Local storage | JSON files (no local DB needed) |
