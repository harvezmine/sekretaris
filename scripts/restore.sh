#!/usr/bin/env bash
# Memulihkan arsip dari backup.sh ke server ini. Data Milo yang ada di server ini akan ditimpa.
set -euo pipefail
cd "$(dirname "$0")/.."

archive="${1:-}"
if [[ -z "$archive" || ! -f "$archive" ]]; then
  echo "pakai: scripts/restore.sh backups/milo-YYYYmmdd-HHMMSS.tgz" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$archive" -C "$tmp"
src="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n1)"

if [[ -f .env ]]; then
  echo "→ .env sudah ada, tidak ditimpa (arsip menyimpan salinannya di ${archive})"
else
  cp "${src}/env" .env
  chmod 600 .env
  echo "→ .env dipulihkan"
fi

if [[ -f "${src}/servers.tgz" ]]; then
  if [[ -f servers/servers.json ]] && [[ "$(tr -d '[:space:]' < servers/servers.json)" != '{"servers":[]}' ]]; then
    echo "→ servers/servers.json sudah berisi server, tidak ditimpa (salinan ada di arsip)"
  else
    tar -xzf "${src}/servers.tgz"
    chmod 700 servers/keys 2>/dev/null || true
    echo "→ folder servers/ dipulihkan"
  fi
fi

read -r -p "Timpa database dan file Milo di server ini? [ketik YA] " answer
[[ "$answer" == "YA" ]] || { echo "Dibatalkan."; exit 1; }

docker compose build app
docker compose up -d db
echo "→ tunggu database siap"
until docker compose exec -T db pg_isready -U milo -d milo >/dev/null 2>&1; do sleep 1; done

docker compose stop app >/dev/null 2>&1 || true
echo "→ pulihkan database"
docker compose exec -T db pg_restore -U milo -d milo --clean --if-exists --no-owner < "${src}/db.dump"

echo "→ pulihkan file pengguna"
docker compose run --rm --no-deps -T --entrypoint sh app -c 'find /app/data -mindepth 1 -delete && tar -xzf - -C /app/data' < "${src}/data.tgz"

docker compose up -d
echo "Selesai. Cek: docker compose ps"
