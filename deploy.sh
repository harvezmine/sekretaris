#!/usr/bin/env bash
# deploy.sh — tarik kode Milo terbaru dari GitHub lalu redeploy hanya yang berubah.
#
# Pemakaian (di server, dari root repo, setelah push):
#   ./deploy.sh            deploy kalau origin punya commit baru
#   ./deploy.sh --force    build + up ulang walaupun tidak ada commit baru
#   SKIP_BACKUP=1 ./deploy.sh   lewati backup sebelum deploy (tidak disarankan)
#
# Alurnya:
#   1. git fetch; kalau origin tidak punya commit baru, keluar — tanpa downtime, tanpa build.
#   2. git merge --ff-only (sama dengan git pull, tapi menolak kalau riwayat menyimpang).
#   3. scripts/backup.sh — migrasi database jalan otomatis saat app start (src/db/index.ts),
#      jadi selalu ada arsip untuk kembali sebelum image baru menyala.
#   4. docker compose build app — cache Docker membuat ini cepat kalau src/ tidak berubah.
#      Kalau build gagal, container lama tetap jalan apa adanya.
#   5. docker compose up -d --remove-orphans — Compose hanya membuat ulang container yang
#      image/konfignya berubah. db tidak disentuh, `down -v` TIDAK pernah dipanggil.
#   6. servers/ di-bind-mount read-only dan tidak dilacak git, jadi tidak perlu ditangani.
#   7. Poll /healthz sampai "ok":true, atau gagal dengan jelas.
#
# Tidak ada rollback otomatis. Kalau health check gagal setelah `up -d`, lihat
# `docker compose logs app --tail 50` dan pulihkan dengan scripts/restore.sh bila perlu.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

LOG_FILE="./deploy.log"
LOCK_FILE="./.deploy.lock"
FORCE=false
[[ "${1:-}" == "--force" ]] && FORCE=true

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE"
}

fail() {
  log "ERROR: $*"
  exit 1
}

env_value() {
  grep -E "^$1=" .env | head -1 | cut -d= -f2- || true
}

# --- concurrency guard -------------------------------------------------
exec 200>"$LOCK_FILE"
flock -n 200 || fail "deploy lain sedang berjalan (lock: $LOCK_FILE). Coba lagi nanti."

# --- preflight -----------------------------------------------------------
command -v git >/dev/null || fail "git tidak ditemukan"
command -v curl >/dev/null || fail "curl tidak ditemukan"
command -v docker >/dev/null || fail "docker tidak ditemukan"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 tidak ditemukan"
[[ -f docker-compose.yml ]] || fail "jalankan dari root repo sekretaris"
[[ -f .env ]] || fail ".env tidak ada. Lihat DEPLOY.md langkah 3–4 sebelum deploy pertama kali."

# Token GitHub opsional untuk repo privat — hanya ada di file ini (gitignored, chmod 600),
# tidak pernah ditulis ke .git/config.
GIT_TOKEN=""
if [[ -f .deploy.env ]]; then
  GIT_TOKEN="$(grep -E '^GIT_TOKEN=' .deploy.env | head -1 | cut -d= -f2- || true)"
fi

BRANCH="$(git symbolic-ref --short HEAD)" || fail "HEAD detached — tidak tahu branch mana yang harus di-pull"

log "=== Deploy start (branch: $BRANCH) ==="

# File untracked tidak menghalangi; git merge sendiri akan menolak kalau ada yang akan tertimpa.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  fail "working tree tidak bersih, deploy dibatalkan supaya git pull tidak konflik:
$(git status --porcelain --untracked-files=no)"
fi

# --- fetch -----------------------------------------------------------------
if [[ -n "$GIT_TOKEN" ]]; then
  AUTH_HEADER="Authorization: Basic $(printf '%s' "x-access-token:${GIT_TOKEN}" | base64 -w0)"
  git -c http.extraHeader="$AUTH_HEADER" fetch origin "$BRANCH" 2>&1 | tee -a "$LOG_FILE" || fail "git fetch gagal"
else
  git fetch origin "$BRANCH" 2>&1 | tee -a "$LOG_FILE" || fail "git fetch gagal"
fi

LOCAL_REV="$(git rev-parse HEAD)"
REMOTE_REV="$(git rev-parse "origin/$BRANCH")"
CHANGED_FILES=""

if [[ "$LOCAL_REV" == "$REMOTE_REV" ]]; then
  if [[ "$FORCE" != "true" ]]; then
    log "Sudah paling baru ($LOCAL_REV). Tidak ada yang di-deploy. (Pakai --force untuk build ulang.)"
    exit 0
  fi
  log "Tidak ada commit baru, tapi --force: build + up ulang di $LOCAL_REV."
else
  MERGE_BASE="$(git merge-base HEAD "origin/$BRANCH")"
  if [[ "$MERGE_BASE" == "$REMOTE_REV" ]]; then
    log "Local ($LOCAL_REV) sudah lebih baru dari origin/$BRANCH ($REMOTE_REV) — tidak ada yang di-pull."
    [[ "$FORCE" == "true" ]] || exit 0
  elif [[ "$MERGE_BASE" != "$LOCAL_REV" ]]; then
    fail "local HEAD ($LOCAL_REV) menyimpang dari origin/$BRANCH ($REMOTE_REV) — tidak bisa fast-forward, perlu penanganan manual."
  else
    log "Update ditemukan: $LOCAL_REV -> $REMOTE_REV"
    CHANGED_FILES="$(git diff --name-only "$LOCAL_REV" "$REMOTE_REV")"
    log "File berubah:
$CHANGED_FILES"
    git merge --ff-only "origin/$BRANCH" 2>&1 | tee -a "$LOG_FILE" || fail "git merge --ff-only gagal"
  fi
fi
NEW_REV="$(git rev-parse HEAD)"

# Variabel baru di .env.example yang belum ada di .env — app bisa gagal start karena ini.
if [[ -f .env.example ]]; then
  MISSING_KEYS="$(comm -23 \
    <(grep -oE '^[A-Z_][A-Z0-9_]*=' .env.example | sort -u) \
    <(grep -oE '^[A-Z_][A-Z0-9_]*=' .env | sort -u) | tr -d '=' | tr '\n' ' ')"
  if [[ -n "$MISSING_KEYS" ]]; then
    log "PERINGATAN: variabel di .env.example yang belum ada di .env: $MISSING_KEYS"
  fi
fi

# --- backup ----------------------------------------------------------------
if [[ "${SKIP_BACKUP:-}" == "1" ]]; then
  log "SKIP_BACKUP=1 — backup dilewati."
elif [[ -n "$(docker compose ps -q --status running db 2>/dev/null)" ]]; then
  log "Backup sebelum deploy (migrasi database jalan saat app start)..."
  scripts/backup.sh 2>&1 | tee -a "$LOG_FILE" \
    || fail "backup gagal — deploy dibatalkan. Kode sudah di $NEW_REV, container lama masih jalan. Ulangi dengan: ./deploy.sh --force"
else
  log "db belum jalan — tidak ada yang perlu di-backup."
fi

# --- build + recreate --------------------------------------------------
# Catat container quicktunnel: kalau dibuat ulang, alamat trycloudflare.com ikut berganti.
QT_BEFORE="$(docker compose ps -q quicktunnel 2>/dev/null || true)"

log "Build image app..."
docker compose build app 2>&1 | tee -a "$LOG_FILE" \
  || fail "docker compose build gagal — container lama tetap jalan apa adanya (kode sudah di $NEW_REV; perbaiki lalu ./deploy.sh --force)"

log "Recreate container yang image/konfignya berubah..."
docker compose up -d --remove-orphans 2>&1 | tee -a "$LOG_FILE" \
  || fail "docker compose up gagal — cek: docker compose logs app --tail 50"

# Landing page: its HTML and CSS are read straight from the repo, so the pull above already put them live.
# Only its nginx template is read at start-up, so the container restarts when that file changed.
if [[ "$FORCE" == "true" ]] || grep -qx 'landing/default.conf.template' <<<"${CHANGED_FILES:-}"; then
  log "Restart landing (template nginx berubah atau --force)..."
  docker compose restart landing 2>&1 | tee -a "$LOG_FILE" \
    || log "PERINGATAN: restart landing gagal. Cek: docker compose logs landing --tail 30"
fi

QT_AFTER="$(docker compose ps -q quicktunnel 2>/dev/null || true)"
if [[ -n "$QT_AFTER" && "$QT_BEFORE" != "$QT_AFTER" ]]; then
  log "PERINGATAN: container quicktunnel dibuat ulang — alamat publik berubah."
  log "Jalankan scripts/public-url.sh dan perbarui webhook di dashboard Fonnte (DEPLOY.md langkah 6)."
fi

# --- health check --------------------------------------------------------
PORT="$(env_value LOCAL_PORT)"
PORT="${PORT:-3000}"
HEALTH_URL="http://127.0.0.1:${PORT}/healthz"

log "Tunggu app siap ($HEALTH_URL)..."
HEALTH_TMP="$(mktemp)"
trap 'rm -f "$HEALTH_TMP"' EXIT

HEALTHY=false
CODE=""
for _ in $(seq 1 18); do
  sleep 5
  CODE="$(curl -s -o "$HEALTH_TMP" -w '%{http_code}' "$HEALTH_URL" || true)"
  if [[ "$CODE" == "200" ]] && grep -q '"ok":true' "$HEALTH_TMP" 2>/dev/null; then
    HEALTHY=true
    break
  fi
done

if [[ "$HEALTHY" != "true" ]]; then
  log "PERINGATAN: /healthz belum sehat setelah 90s (kode terakhir: ${CODE:-none})."
  docker compose logs app --tail 30 2>&1 | tee -a "$LOG_FILE"
  log "Cek: docker compose logs app --tail 50 — pulihkan dengan scripts/restore.sh bila perlu."
  log "=== Deploy SELESAI DENGAN PERINGATAN ($LOCAL_REV -> $NEW_REV) ==="
  exit 1
fi

log "/healthz OK: $(cat "$HEALTH_TMP")"
if grep -q '"dryRun":true' "$HEALTH_TMP"; then
  log "PERINGATAN: WA_DRY_RUN aktif — Milo tidak benar-benar mengirim pesan."
fi

# The landing page is separate from the app: a problem there is reported, not treated as a failed deploy.
LANDING_PORT_VALUE="$(env_value LANDING_PORT)"
LANDING_URL="http://127.0.0.1:${LANDING_PORT_VALUE:-8080}"
if curl -fsS "$LANDING_URL/healthz" >/dev/null 2>&1; then
  LANDING_HTML="$(curl -fsS "$LANDING_URL/" || true)"
  WA_LINKS="$(grep -o 'wa.me/62[0-9]*' <<<"$LANDING_HTML" | wc -l | tr -d ' ')"
  WA_EMPTY="$(grep -o '__WA_NUMBER__' <<<"$LANDING_HTML" | wc -l | tr -d ' ')"
  log "Landing OK ($LANDING_URL), tombol WhatsApp berisi nomor: $WA_LINKS"
  [[ "$WA_EMPTY" == "0" ]] || log "PERINGATAN: $WA_EMPTY tombol WhatsApp belum berisi nomor. Cek LANDING_WA_NUMBER di .env"
else
  log "PERINGATAN: landing tidak menjawab di $LANDING_URL. Cek: docker compose logs landing --tail 30"
fi
docker compose ps 2>&1 | tee -a "$LOG_FILE"
log "=== Deploy sukses: $LOCAL_REV -> $NEW_REV ==="
