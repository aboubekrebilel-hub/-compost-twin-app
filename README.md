# CompostTwin Station

**Système intelligent de suivi et d'optimisation du compost**

CompostTwin Station is a lightweight, full-stack IoT monitoring web application designed for ESP32-based compost monitoring stations. It streams live telemetry every ~5 seconds over Server-Sent Events (SSE) while keeping Supabase Postgres free-tier storage lean by storing **one averaged row per device per minute** (configurable via `STORE_INTERVAL_SEC`).

---

## Features

- **Real-time Dashboard (`/`)**:
  - Public, login-free read-only monitoring view.
  - Live KPI cards for **Temperature (°C)**, **Soil Moisture (%)**, **Oxygen (%)**, and **Last Manual pH**.
  - Automatic **Online / Offline** status badge (marks station offline if no data received for 30s).
  - Instant updates via **SSE (`GET /api/stream`)** with automatic **5-second polling fallback**.
  - Interactive **Chart.js** line charts with `1h`, `24h`, `7d`, and `custom` date-range selectors.
- **Data History & Admin (`/data`)**:
  - Paginated readings table with date-range filtering.
  - One-click **CSV** and **Excel (`.xlsx`)** exports respecting active date filters.
  - Password-protected Admin mode (`sessionStorage` + `x-admin-password` header):
    - Manual **pH** entry form (0–14, optional note, optional timestamp).
    - Delete individual rows, delete by date range, or delete all rows with explicit confirmation.
- **Multilingual & Responsive UI**:
  - French (default), Arabic (full RTL layout), and English.
  - Mobile-first dark-green AgriTech theme matching CompostTwin Station branding.
- **Optional Google Sheets Sync**:
  - Forwards every stored row to a Google Apps Script webhook (`GOOGLE_SHEET_WEBHOOK`). See [`docs/google-sheets.md`](./docs/google-sheets.md).

---

## Project Structure

```text
compost-twin/
├── docs/
│   └── google-sheets.md       # Google Apps Script & webhook setup guide
├── public/
│   ├── assets/                # Brand images (station.png, background.jpg, logo.png, favicon.png)
│   ├── css/styles.css         # Responsive dark-green theme & RTL support
│   ├── js/
│   │   ├── i18n.js            # FR / AR (RTL) / EN translations
│   │   ├── common.js          # Shared header, auth modal, language switcher, online badge
│   │   ├── dashboard.js       # SSE + 5s polling fallback, KPIs, Chart.js charts
│   │   └── data.js            # Pagination, filters, CSV/XLSX export, admin deletes & pH form
│   ├── index.html             # Public Dashboard page
│   └── data.html              # Data & Admin page
├── scripts/
│   └── seed.js                # Demo data generator (npm run seed)
├── sql/
│   └── schema.sql             # Supabase Postgres table & indexes
├── src/
│   ├── middleware/            # Auth (x-api-key, x-admin-password) & centralized error handling
│   ├── routes/                # Express routes (readings, stream, ph, delete, export)
│   ├── services/              # Supabase store, in-memory averaging buffer, SSE hub, Google Sheets
│   ├── utils/validators.js    # Strict payload & query validation
│   ├── app.js                 # Express app factory (helmet, cors, rate-limit)
│   ├── config.js              # Environment config loader
│   └── server.js              # Entry point & graceful shutdown
├── tests/
│   ├── api.test.js            # Automated integration test suite (node --test)
│   └── curl-example.sh        # ESP32 & API curl test script
├── .env.example
├── .gitignore
├── package.json
└── render.yaml
```

---

## 1. Supabase Setup (SQL)

Create a free-tier project on [Supabase](https://supabase.com/), open the **SQL Editor**, and run [`sql/schema.sql`](./sql/schema.sql):

```sql
create table if not exists public.readings (
  id bigint generated always as identity primary key,
  device_id text not null,
  temperature double precision,
  soil_moisture double precision,
  oxygen double precision,
  ph double precision,
  note text,
  source text not null check (source in ('sensor', 'manual')),
  created_at timestamptz not null default now()
);

create index if not exists idx_readings_created_at_desc
  on public.readings (created_at desc);

create index if not exists idx_readings_device_created_at
  on public.readings (device_id, created_at desc);

create index if not exists idx_readings_ph_created_at
  on public.readings (created_at desc)
  where ph is not null;
```

Copy your **Project URL** (`SUPABASE_URL`) and **Service Role Key** (recommended for backend-only servers, or `anon` key if RLS is configured) into `.env`.

---

## 2. Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP server port (Render injects this automatically) |
| `SUPABASE_URL` | Yes | — | Your Supabase project URL |
| `SUPABASE_KEY` | Yes | — | Supabase `service_role` (or `anon`) key |
| `DEVICE_API_KEY` | Yes | — | Secret key sent by ESP32 in `x-api-key` header |
| `ADMIN_PASSWORD` | Yes | — | Password used for admin login & `x-admin-password` header |
| `STORE_INTERVAL_SEC` | No | `60` | Interval in seconds for flushing averaged sensor rows to DB |
| `GOOGLE_SHEET_WEBHOOK` | No | `""` | Optional Google Apps Script Web App URL |
| `CORS_ORIGIN` | No | `*` | Allowed CORS origin(s) |

---

## 3. Local Run

```bash
npm install
npm run seed    # Optional: insert 7 days of demo compost data into Supabase
npm start       # Starts server on http://localhost:3000
```

Run automated tests (uses an in-memory mock store, no Supabase required):

```bash
npm test
```

Test ESP32 ingestion with curl:

```bash
DEVICE_API_KEY="your-key" BASE_URL="http://localhost:3000" ./tests/curl-example.sh
```

---

## 4. ESP32 Integration

Have your ESP32 send an HTTP `POST` every ~5 seconds to `/api/readings` with header `x-api-key`:

```cpp
#include <WiFi.h>
#include <HTTPClient.h>

const char* SERVER_URL = "https://your-app.onrender.com/api/readings";
const char* DEVICE_API_KEY = "your-device-api-key";

void sendReading(float tempC, float moisturePct, float oxygenPct) {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", DEVICE_API_KEY);

  String payload = "{";
  payload += "\"device_id\":\"station-01\",";
  payload += "\"temperature\":" + String(tempC, 2) + ",";
  payload += "\"soil_moisture\":" + String(moisturePct, 2) + ",";
  payload += "\"oxygen\":" + String(oxygenPct, 2);
  payload += "}";

  int code = http.POST(payload);
  http.end();
}
```

### Validation Ranges (`POST /api/readings`)
- `device_id`: `1–64` characters matching `[a-zA-Z0-9._-]+`
- `temperature`: `-20` to `100` (°C)
- `soil_moisture`: `0` to `100` (%)
- `oxygen`: `0` to `100` (%)

---

## 5. Deploy on Render (Free Tier)

1. Push this repository to GitHub (never commit `.env` — it is ignored by `.gitignore`).
2. In [Render](https://render.com/), create a **New Blueprint** (or **New Web Service**) pointing to your repo.
3. Render automatically reads [`render.yaml`](./render.yaml):
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/api/health`
4. Add your secret environment variables (`SUPABASE_URL`, `SUPABASE_KEY`, `DEVICE_API_KEY`, `ADMIN_PASSWORD`, and optionally `GOOGLE_SHEET_WEBHOOK`) in the Render dashboard.
5. Deploy!

---

## API Reference

| Method & Path | Auth | Description |
|---|---|---|
| `GET /api/health` | Public | Health check & runtime stats |
| `POST /api/readings` | `x-api-key` | Receive ~5s ESP32 telemetry, push via SSE, buffer for 60s average |
| `GET /api/latest` | Public | Latest reading per device (memory + DB fallback) & latest pH |
| `GET /api/stream` | Public | Server-Sent Events live stream (`snapshot`, `reading`, `ph`, `reset`) |
| `GET /api/readings` | Public | Paginated history (`?from=&to=&limit=&page=&device_id=`) |
| `POST /api/admin/verify` | `x-admin-password` | Verify admin password for UI login |
| `POST /api/ph` | `x-admin-password` | Save manual pH entry (`0–14`, optional `note`, `timestamp`) |
| `DELETE /api/readings/:id` | `x-admin-password` | Delete a single stored row |
| `DELETE /api/readings?from=&to=` | `x-admin-password` | Delete stored rows within a date range |
| `DELETE /api/readings/all` | `x-admin-password` | Delete all stored rows (requires `{ "confirm": true }` or `?confirm=true`) |
| `GET /api/export.csv` | Public | Download filtered rows as CSV |
| `GET /api/export.xlsx` | Public | Download filtered rows as Excel (`.xlsx`) |
