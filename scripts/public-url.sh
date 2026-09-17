#!/usr/bin/env bash
# Mencetak alamat publik Milo dan URL webhook yang harus diisi di dashboard Fonnte / InstanPay.
set -euo pipefail
cd "$(dirname "$0")/.."

url="$(docker compose logs quicktunnel 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -n1 || true)"
if [[ -z "$url" ]]; then
  base="$(grep -E '^PUBLIC_BASE_URL=' .env | cut -d= -f2- || true)"
  url="${base%/}"
fi
if [[ -z "$url" ]]; then
  echo "Belum ada alamat publik. Nyalakan: COMPOSE_PROFILES=quicktunnel di .env lalu docker compose up -d" >&2
  exit 1
fi

secret="$(grep -E '^FONNTE_WEBHOOK_SECRET=' .env | cut -d= -f2-)"
echo "Alamat publik     : ${url}"
echo "Cek kesehatan     : ${url}/healthz"
echo "Webhook Fonnte    : ${url}/fonnte/webhook/${secret}"
echo "Callback InstanPay: ${url}/pay/webhook"
