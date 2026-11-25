#!/usr/bin/env bash
# CompostTwin Station — ESP32 & API curl examples
# Usage:
#   DEVICE_API_KEY="your-device-key" BASE_URL="http://localhost:3000" ./tests/curl-example.sh

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
DEVICE_API_KEY="${DEVICE_API_KEY:-replace-with-strong-esp32-api-key}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-replace-with-strong-admin-password}"

echo "1) Simulating ESP32 sensor reading (POST /api/readings)..."
curl -sS -X POST "${BASE_URL}/api/readings" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${DEVICE_API_KEY}" \
  -d '{
    "device_id": "station-01",
    "temperature": 54.6,
    "soil_moisture": 56.2,
    "oxygen": 15.4
  }'
echo -e "\n"

echo "2) Checking latest in-memory/DB reading (GET /api/latest)..."
curl -sS "${BASE_URL}/api/latest"
echo -e "\n"

echo "3) Recording a manual pH entry as Admin (POST /api/ph)..."
curl -sS -X POST "${BASE_URL}/api/ph" \
  -H "Content-Type: application/json" \
  -H "x-admin-password: ${ADMIN_PASSWORD}" \
  -d '{
    "value": 6.95,
    "note": "Test curl check after turning compost",
    "device_id": "station-01"
  }'
echo -e "\n"
