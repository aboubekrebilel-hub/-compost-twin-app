# CompostTwin Station — Project Report

## 1. What Was Built

### Backend (`Node.js` + `Express` + `@supabase/supabase-js`)
- **Configuration & Security**:
  - Environment configuration in `src/config.js` (`.env.example` and `.gitignore` provided).
  - Security middleware in `src/app.js`: `helmet` (with CSP allowing Chart.js CDN and Google Fonts), `cors`, `express-rate-limit` (separate general API, ESP32 ingestion, and admin brute-force limiters), and centralized error handling (`src/middleware/errorHandler.js`).
  - Timing-safe authentication (`src/middleware/auth.js`) for ESP32 (`x-api-key`) and Admin (`x-admin-password`).
- **Real-time + Storage Buffering (`src/services/readingBuffer.js`, `src/services/sseHub.js`)**:
  - Incoming ~5s ESP32 telemetry (`POST /api/readings`) is validated, kept in memory per `device_id`, and broadcast immediately over SSE (`GET /api/stream`) with 20s proxy heartbeats.
  - Readings accumulate in memory and flush **one averaged row per device** every `STORE_INTERVAL_SEC` seconds (default `60`) to Supabase Postgres (`src/services/readingsStore.js`).
  - On restart, `GET /api/latest` falls back to the latest sensor row per device and latest non-null pH row in Supabase.
- **Exports & Google Sheets Sync**:
  - `GET /api/export.csv` (UTF-8 BOM + RFC-4180 escaping) and `GET /api/export.xlsx` (`exceljs` styled workbook), both supporting `?from=&to=&device_id=`.
  - Optional `GOOGLE_SHEET_WEBHOOK` sync (`src/services/googleSheets.js`) triggered asynchronously after each stored row, with Apps Script setup documented in `docs/google-sheets.md`.
- **Database Schema & Seeding**:
  - Postgres schema + indexes in `sql/schema.sql` and additive migration in `sql/migration_motor_control.sql` (`control_log` and `control_config`, ending with `notify pgrst, 'reload schema';`).
  - Seed script (`npm run seed` -> `scripts/seed.js`) generating 7 days of simulated compost readings and manual pH entries.
  - Render deployment blueprint in `render.yaml` (including `MAX_RUN_SEC=60`).
- **Motor Control & Automatic Mixing (`src/services/motorControl.js`, `src/services/controlStore.js`, `src/routes/control.js`)**:
  - Fail-safe in-memory relay states (`{ relay1: false, relay2: false }` on boot/restart) with hard `MAX_RUN_SEC` safety timers and immediate manual `STOP` override.
  - Persistent per-device configuration (`control_config`) with safe defaults if table/row is missing, and audit trail in `control_log`.
  - Non-blocking `try/catch` rule evaluation on `POST /api/readings` (`temperature > temp_max`, `oxygen < oxygen_min`, `soil_moisture > moisture_max`), freshness check (`<= 30s`), cooldown tracking (with `control_log` restart fallback), and low-moisture `add_water` alert that blocks motor actuation.
  - Real-time `control_state` and `control_config` SSE broadcasts, plus tiny `GET /api/device/commands` payload (`{"relay1":bool,"relay2":bool}`).
- **Backward-Compatible Partial Readings (`src/utils/validators.js`, `src/services/readingBuffer.js`)**:
  - `POST /api/readings` accepts missing/`null` sensor fields if `device_id` and at least one valid sensor value are present, averaging each metric independently on flush and storing missing fields as `NULL`.

### Frontend (`public/`)
- **Public Dashboard (`/` -> `public/index.html`, `public/js/dashboard.js`)**:
  - Login-free live KPI cards (Temperature °C, Soil Moisture %, Oxygen %, Last Manual pH) with icons and optimal-range status pills.
  - Online/Offline badge (automatically switches to Offline after 30s without data).
  - Live updates via `EventSource('/api/stream')` with automatic 5s polling fallback (`GET /api/latest`) on SSE failure.
  - Interactive Chart.js line charts with `1h`, `24h`, `7d`, and `custom` date-range selectors.
- **Data & Admin Page (`/data` -> `public/data.html`, `public/js/data.js`)**:
  - Paginated table with date-range filters and CSV/Excel export buttons.
  - Admin login modal storing the password in `sessionStorage` and sending it via `x-admin-password` after backend verification (`POST /api/admin/verify`).
  - Admin-only Manual pH entry form (also shown on Dashboard when signed in) and delete controls (per-row, date range, and delete-all with explicit confirmation modal).
  - Admin-only **Motor Control** card on Dashboard (`public/index.html`, `public/js/dashboard.js`) with 2-channel START/STOP buttons, duration selector (`10s/30s/60s`), live remaining seconds, offline disable/warning, automatic mixing threshold editor, `Last mix` / `Next mix possible in` countdown, and `Add water` warning.
  - Partial readings display `--` on Dashboard KPIs and skip `null` points in Chart.js without plotting `0`.
- **Branding & Localization (`public/css/styles.css`, `public/js/i18n.js`, `public/assets/`)**:
  - Exact palette CSS variables (`#1B4D3E`, `#143B2F`, `#2E7D5B`, `#4CAF7A`, `#FFFFFF`, `#B7D3C6`, `#F2B84B`, `#E5634D`), Poppins/Inter fonts, rounded `16px` cards.
  - Attached brand assets saved as `station.png`, `background.jpg`, and `logo.png` in `public/assets/`, with CSS framing for `logo.png` (matching `#204735` header background), `mix-blend-mode: multiply` light card for `station.png`, darkened overlay for `background.jpg`, and `favicon.png` cropped from the leaf-in-circle icon.
  - French (default), Arabic (`dir="rtl"`), and English language switcher.

---

## 2. API Endpoints

| Method & Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/health` | Public | Server & Supabase configuration status |
| `POST /api/readings` | `x-api-key` | Validate & ingest ~5s ESP32 telemetry into memory + SSE |
| `GET /api/latest` | Public | Latest reading per device (memory + DB fallback) & latest pH |
| `GET /api/stream` | Public | Server-Sent Events live stream (`snapshot`, `reading`, `ph`, `reset`) |
| `GET /api/readings` | Public | Paginated stored history (`from`, `to`, `limit`, `page`, `device_id`) |
| `POST /api/admin/verify` | `x-admin-password` | Validate admin password for frontend session |
| `POST /api/ph` | `x-admin-password` | Store manual pH (`0–14`, optional `note`, `timestamp`) |
| `DELETE /api/readings/:id` | `x-admin-password` | Delete a single stored row |
| `DELETE /api/readings?from=&to=` | `x-admin-password` | Delete stored rows in date range |
| `DELETE /api/readings/all` | `x-admin-password` | Wipe all stored rows (requires `{ "confirm": true }` or `?confirm=true`) |
| `GET /api/export.csv` | Public | Export filtered readings as CSV |
| `GET /api/export.xlsx` | Public | Export filtered readings as Excel `.xlsx` |
| `POST /api/control` | `x-admin-password` | Manual relay control (`channel: 1\|2`, `state: 'on'\|'off'`, `duration_sec <= MAX_RUN_SEC`) |
| `GET /api/control/state` | Public | Read relay states, remaining seconds, online flag, last mix, and alerts |
| `GET /api/control/config` | Public | Read automatic mixing configuration for a device |
| `PUT /api/control/config` | `x-admin-password` | Validate and save automatic mixing configuration |
| `GET /api/device/commands` | `x-api-key` | Tiny ESP32 polling payload: `{"relay1":true\|false,"relay2":true\|false}` |

---

## 3. How to Test

1. **Automated integration tests (offline mock store)**:
   ```bash
   npm test
   ```
   Verified result: 7/7 tests passing in `tests/api.test.js`, covering:
   - API key enforcement, payload range validation, in-memory buffering, 1-row averaging on `flush()`, and Google Sheets sync hook.
   - `GET /api/latest` DB fallback after restart.
   - `GET /api/stream` SSE `snapshot` and live `reading` push.
   - Manual `POST /api/ph`, pagination, CSV & XLSX exports, single-row delete, and `DELETE /api/readings/all` confirmation enforcement.
   - Manual motor control (`POST /api/control`, `GET /api/control/state`, `GET /api/device/commands`), `MAX_RUN_SEC` cap, auto-off timer, and `control_log` audit entries.
   - Automatic mixing rules (`PUT /api/control/config`, threshold triggers, cooldown enforcement, low-moisture `add_water` motor block, stale reading rejection, and manual `STOP` interrupting an active auto-run).
   - Partial readings (missing/`null` sensors accepted, all-missing/invalid rejected, per-metric averaging on flush).

2. **Frontend routes & static assets smoke check**:
   - Verified `200 OK` responses for `/api/health`, `/`, `/data`, `/assets/logo.png`, `/assets/station.png`, `/assets/background.jpg`, `/assets/favicon.png`, `/css/styles.css`, `/js/i18n.js`, `/js/common.js`, `/js/dashboard.js`, and `/js/data.js`.

3. **Manual live test with Supabase & ESP32 simulation**:
   - Create `.env` from `.env.example` with live `SUPABASE_URL`, `SUPABASE_KEY`, `DEVICE_API_KEY`, and `ADMIN_PASSWORD`.
   - Apply `sql/schema.sql` in Supabase SQL Editor.
   - Optionally run `npm run seed`.
   - Run `npm start`, open `http://localhost:3000`, and run `./tests/curl-example.sh`.

---

## 4. Known Limitations

- **Live Supabase / Render deployment not executed locally**: Automated tests (`tests/api.test.js`) exercise all Express routes, validation, averaging, exports, and SSE against an in-memory mock of `readingsStore.js` because live Supabase credentials were not provided in the workspace.
- **Render free-tier spin-down & single-instance memory**: Render's free tier sleeps after ~15 minutes of inactivity and runs a single Node process. Because the 60s averaging buffer lives in memory, a sudden platform sleep/restart discards any un-flushed partial (<60s) samples (already-flushed rows are safely persisted in Supabase, and graceful `SIGTERM` triggers a final `flush()`).
- **Export row cap**: `GET /api/export.csv` and `GET /api/export.xlsx` cap queries at 10,000 rows per request (`maxRows = 10000`) to protect free-tier memory limits; use `?from=&to=` date filters for larger archives.
- **Simple admin auth**: Admin authentication uses a shared `ADMIN_PASSWORD` stored in browser `sessionStorage` and sent in `x-admin-password`, per specification (no multi-user RBAC or JWT expiration).

---

## 5. Safety Design

- **Fail-safe boot state**: Relay states live in memory and reset to `{ relay1: false, relay2: false }` on every server restart.
- **Hard runtime cap**: Both manual (`POST /api/control`) and automatic mixing enforce `MAX_RUN_SEC` (default `60s`) with automatic server-side off timers.
- **Immediate manual override**: `POST /api/control` with `state: "off"` always executes immediately and cancels any running timer (manual or automatic).
- **Dry-compost motor interlock**: When `soil_moisture < moisture_min_alert`, automatic mixing is blocked and only an `add_water` alert is raised.
- **Non-blocking telemetry**: Auto-mixing evaluation in `POST /api/readings` is wrapped in `try/catch` and database logging (`control_log`) fails safely without impacting sensor ingestion.
- **Additive-only DB migration**: Existing `readings` columns (`temperature`, `soil_moisture`, `oxygen`) are already nullable; new tables `control_log` and `control_config` use `create table if not exists` and end with `notify pgrst, 'reload schema';`.
