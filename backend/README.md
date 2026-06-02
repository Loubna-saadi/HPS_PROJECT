# ParamSync — Node.js/Express Backend

Replaces the Oracle ORDS gateway with a Node.js + Express API.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Angular Frontend                           │
│  comparison.ts / export.ts / audit-logs.ts / connection-profiles│
└──────────────────────┬──────────────────────────────────────────┘
                       │ HTTP (same URL shape as ORDS)
                       │ OLD: http://localhost:8080/ords/v1
                       │ NEW: http://localhost:3000/v1
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│               Express Backend  (this project)                   │
│                                                                 │
│  routes/compare.js         POST /compare, /compare-full        │
│  routes/anomalies.js       GET  /anomalies                     │
│  routes/scripts.js         POST /scripts, /validate-script     │
│  routes/export.js          GET  /export/...                    │
│  routes/audit-logs.js      GET  /operations, /operations/:id   │
│  routes/connection-profiles.js  GET/POST/DELETE /connection-.. │
│  routes/oracle.js          GET  /tables, /columns/:table       │
│                                                                 │
│  services/compare.js  ←── Core comparison engine               │
│  storage/store.js     ←── Local JSON file store                │
│  oracle/connections.js←── OracleDB pools (read-only, HPS)     │
└──────────┬──────────────────────────┬───────────────────────────┘
           │                          │
           ▼ LOCAL JSON files         ▼ Oracle DB (HPS — read-only)
   data/operations.json          PowerCard tables
   data/anomalies.json           (fetch for comparison)
   data/scripts.json
   data/connection-profiles.json
```

---

## What stays in Oracle

| Purpose                          | Still uses Oracle? |
|----------------------------------|--------------------|
| Fetch PowerCard tables/columns   | ✅ Yes (read-only) |
| Run comparison between envs      | ✅ Yes (read rows) |
| Store operations, anomalies      | ❌ No → local JSON |
| Store scripts                    | ❌ No → local JSON |
| Store users, sessions            | ❌ No → local JSON |
| Store connection profiles        | ❌ No → local JSON |

---

## Setup

```bash
cd paramsync-backend
npm install

# Copy .env.example to .env and fill in your Oracle connection details
cp .env.example .env

npm run dev   # starts with nodemon on port 3000
```

---

## One change needed in Angular

In your Angular project, change the `ORDS` constant in **each** component:

```typescript
// BEFORE (every .ts file)
const ORDS = 'http://localhost:8080/ords/v1';

// AFTER
const ORDS = 'http://localhost:3000/v1';
```

Files to update:
- `comparison.ts`
- `export.ts`
- `audit-logs.ts`
- `connection-profiles.ts`
- Any `compare.service.ts` file in `core/services/`

> **Tip:** Better yet, move `ORDS` to `environment.ts` once and reference it everywhere.

---

## API Endpoint Mapping

| Old ORDS endpoint                        | New Express endpoint                    |
|------------------------------------------|-----------------------------------------|
| `POST /ords/v1/audit/compare`            | `POST /v1/audit/compare`               |
| `POST /ords/v1/audit/compare-full`       | `POST /v1/audit/compare-full`           |
| `GET  /ords/v1/audit/anomalies`          | `GET  /v1/audit/anomalies`              |
| `GET  /ords/v1/audit/tables`             | `GET  /v1/audit/tables`                 |
| `GET  /ords/v1/audit/columns/:table`     | `GET  /v1/audit/columns/:table`         |
| `POST /ords/v1/audit/scripts`            | `POST /v1/audit/scripts`                |
| `POST /ords/v1/audit/validate-script`    | `POST /v1/audit/validate-script`        |
| `GET  /ords/v1/audit/connection-profiles`| `GET  /v1/audit/connection-profiles`    |
| `POST /ords/v1/audit/connection-profiles`| `POST /v1/audit/connection-profiles`    |
| `POST /ords/v1/audit/connection-profiles/test` | `POST /v1/audit/connection-profiles/test` |

Response shapes are **identical** to ORDS — no Angular component changes needed.

---

## Project Structure

```
paramsync-backend/
├── src/
│   ├── index.js                 ← Express entry point
│   ├── routes/
│   │   ├── compare.js           ← POST /compare, /compare-full
│   │   ├── anomalies.js         ← GET  /anomalies
│   │   ├── scripts.js           ← POST /scripts, /validate-script
│   │   ├── export.js            ← GET  /export/...
│   │   ├── audit-logs.js        ← GET  /operations
│   │   ├── connection-profiles.js
│   │   └── oracle.js            ← GET  /tables, /columns/:table
│   ├── services/
│   │   └── compare.js           ← Core diff engine
│   ├── storage/
│   │   └── store.js             ← Local JSON file store
│   └── oracle/
│       └── connections.js       ← OracleDB pool manager
├── data/                        ← Auto-created on first run
│   ├── operations.json
│   ├── anomalies.json
│   ├── scripts.json
│   └── connection-profiles.json
├── .env.example
└── package.json
```

---

## Next steps (other modules)

After testing the Comparison module end-to-end:

1. `connection-profiles` page → already wired, test the UI
2. `export` page → test with a real operation ID
3. `audit-logs` page → test the operations list
4. Add user authentication (currently `user_id` is passed in body)
5. Add CORS restriction for production (replace `origin: '*'`)
