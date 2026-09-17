#!/usr/bin/env bash
# Membuat satu arsip berisi database, file pengguna, .env, dan folder servers/ — cukup untuk pindah server.
set -euo pipefail
cd "$(dirname "$0")/.."

stamp="$(date +%Y%m%d-%H%M%S)"
work="backups/milo-${stamp}"
mkdir -p "$work"

echo "→ dump database"
docker compose exec -T db pg_dump -U milo -d milo --format=custom > "${work}/db.dump"

echo "→ arsipkan file pengguna"
docker compose run --rm --no-deps -T --entrypoint tar app -C /app/data -czf - . > "${work}/data.tgz"

cp .env "${work}/env"
if [[ -d servers ]]; then
  tar -czf "${work}/servers.tgz" servers
fi

umask 077
tar -czf "backups/milo-${stamp}.tgz" -C backups "milo-${stamp}"
rm -rf "$work"

echo "Selesai: backups/milo-${stamp}.tgz"
echo "Arsip ini berisi .env (token, kata sandi, SERVER_KEY_SECRET) dan kunci SSH. Simpan di tempat aman."
