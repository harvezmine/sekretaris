# Deploy Milo ke home server (Cloudflare Tunnel)

Runbook ini ditulis untuk **Claude Code yang berjalan di home server**. Jalankan langkahnya berurutan dan cek
hasil tiap langkah sebelum lanjut. Kalau hasil tidak sesuai, berhenti dan laporkan ke pengguna.

Bagian bertanda **👤 Pengguna** harus dikerjakan pengguna sendiri (di Mac lama, dashboard Cloudflare, atau
dashboard Fonnte). Minta pengguna mengerjakannya, lalu tunggu konfirmasi.

## Aturan selama deploy

- **Jangan tampilkan isi `.env`.** Kalau perlu memeriksa, tampilkan nama variabelnya saja, misalnya
  `grep -E '^[A-Z_]+=' .env | sed 's/=.*/=***/'`.
- **Jangan buat `SERVER_KEY_SECRET` baru** kalau nilainya sudah ada dari Mac. Kalau diganti, kunci SSH semua server
  pengguna tidak bisa dibuka lagi.
- **Hanya satu instance Milo yang boleh aktif.** Kalau Mac dan home server sama-sama menyala, pengingat terkirim
  dua kali dan webhook berebut.
- **Jangan membuka port ke internet.** Semua lalu lintas lewat Cloudflare Tunnel, dan app hanya listen di
  `127.0.0.1`.
- **Jangan ubah pengaturan service `dockerproxy`** (`POST: 0`, socket read-only). Itu yang membuat akses Milo ke
  Docker hanya-baca.
- **Jangan jalankan `docker compose down -v`**, karena `-v` menghapus database.

## 0. Yang dibutuhkan

- **Home server:** Linux (Ubuntu/Debian disarankan) yang menyala 24 jam, terhubung ke internet, dan user-nya
  punya `sudo`.
- **Cloudflare:** domain yang nameserver-nya sudah di Cloudflare, untuk alamat tetap. Tanpa domain, pakai quick
  tunnel (lihat langkah 5B). Alamatnya berubah setiap restart.
- **Akses:** pengguna bisa login ke dashboard Fonnte dan Cloudflare Zero Trust.

## 1. Siapkan Docker

```bash
docker --version && docker compose version
```

Kalau salah satu tidak ada, **tanyakan dulu ke pengguna** sebelum memasang, karena butuh sudo. Pemasangan resmi:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"      # lalu logout-login, atau: newgrp docker
sudo systemctl enable --now docker
```

Cek:

```bash
docker run --rm hello-world
ls -l /var/run/docker.sock           # harus ada (dipakai dockerproxy)
```

Kalau Docker berjalan dalam mode rootless, socket-nya bukan di `/var/run/docker.sock`. Laporkan ke pengguna:
path volume `dockerproxy` di `docker-compose.yml` perlu disesuaikan, atau isi `DOCKER_PROXY_URL=` di `.env`
untuk mematikan fitur itu.

## 2. 👤 Pengguna: backup di Mac lama dan salin ke home server

Di Mac, dari folder `milo-ai`:

```bash
scripts/backup.sh                           # → backups/milo-YYYYmmdd-HHMMSS.tgz
docker compose down                         # hentikan Milo di Mac (TANPA -v)
rsync -av --exclude node_modules --exclude dist --exclude backups \
  ./ USER@HOME-SERVER:~/milo-ai/
scp backups/milo-YYYYmmdd-HHMMSS.tgz USER@HOME-SERVER:~/milo-ai/backups/
```

- `rsync` ikut menyalin `.env` dan `servers/` dari Mac. Ini disengaja, supaya nilainya sama persis.
- Arsip backup berisi database, file pengguna, `.env` (termasuk `SERVER_KEY_SECRET`), dan folder `servers/`.
  Arsip ini rahasia.
- Setelah `docker compose down`, Milo tidak membalas WhatsApp sampai langkah 7 selesai. Kerjakan langkah 3–7
  tanpa jeda panjang.

Di home server, pastikan hasil salinannya lengkap:

```bash
cd ~/milo-ai
ls docker-compose.yml Dockerfile package-lock.json scripts/restore.sh
ls -l backups/*.tgz
```

## 3. Pulihkan data

```bash
cd ~/milo-ai
mkdir -p backups servers && chmod 700 backups
scripts/restore.sh backups/milo-YYYYmmdd-HHMMSS.tgz
```

- Skrip ini memulihkan `.env` hanya kalau `.env` belum ada di server.
- Skrip meminta konfirmasi. **Tanyakan dulu ke pengguna**, lalu masukkan `YA` hanya kalau ini server baru, atau
  pengguna memang setuju data Milo di server ini ditimpa.
- Skrip akan build image, memulihkan database dan file pengguna, lalu menyalakan semua service.

Cek:

```bash
docker compose ps                       # db healthy, app healthy, dockerproxy running
chmod 600 .env
grep -E '^(COMPOSE_PROFILES|PUBLIC_BASE_URL|LOCAL_PORT|SERVER_ACCESS|WA_PROVIDER|WA_DRY_RUN)=' .env
grep -cE '^SERVER_KEY_SECRET=.{32,}' .env   # harus 1
```

## 4. Sesuaikan `.env` untuk server ini

Edit `.env`. Jangan ubah variabel lain tanpa bertanya ke pengguna.

| Variabel | Nilai |
| --- | --- |
| `LOCAL_PORT` | Port lokal yang belum dipakai. Cek dengan `ss -tln \| grep :3310`. Default dari Mac: `3310`. |
| `COMPOSE_PROFILES` | `tunnel` (langkah 5A) atau `quicktunnel` (langkah 5B). |
| `TUNNEL_TOKEN` | Dari langkah 5A. |
| `PUBLIC_BASE_URL` | `https://milo.DOMAIN-PENGGUNA` (5A), atau kosong (5B). |

Kalau servernya berbasis Linux (bukan Docker Desktop), cek `servers/keys/` bisa dibaca app (uid 1000):

```bash
[ -d servers/keys ] && sudo chown -R 1000 servers/keys && chmod 700 servers/keys && chmod 600 servers/keys/*
```

## 5A. 👤 Pengguna: Cloudflare Tunnel dengan domain (disarankan)

Di dashboard Cloudflare:

1. **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared**, beri nama `milo-home`.
2. Pada langkah instalasi, salin **token** (teks panjang setelah `--token`). Jangan pasang cloudflared dari
   halaman itu, karena cloudflared sudah berjalan sebagai container.
3. **Public hostname**: subdomain `milo`, pilih domain, **Type** `HTTP`, **URL** `app:3000`.
4. Disarankan: **Access → Applications → Self-hosted**, lindungi `milo.DOMAIN/admin*` dengan login email.
   Jangan lindungi `/fonnte/*`, `/pay/*`, atau `/wa/*`, karena webhook harus bisa masuk.

Pengguna mengirim token itu ke Claude Code. Tulis token langsung ke `.env` tanpa menampilkannya lagi, lalu:

```bash
sed -i 's/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=tunnel/' .env
docker compose --profile quicktunnel rm -sf quicktunnel   # matikan quick tunnel bawaan dari Mac
docker compose up -d
docker compose logs tunnel --since 2m | grep -iE "registered|error"   # harus ada "Registered tunnel connection"
curl -fsS https://milo.DOMAIN-PENGGUNA/healthz
```

`/healthz` harus mengembalikan `"ok":true`, `"channel":"fonnte"`, dan `"dryRun":false`.

## 5B. Tanpa domain: quick tunnel

```bash
sed -i 's/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=quicktunnel/' .env
docker compose up -d
scripts/public-url.sh
```

Alamat `trycloudflare.com` berubah setiap kali container `quicktunnel` dibuat ulang, termasuk setelah server
restart. Setiap kali itu terjadi, langkah 6 harus diulang. Beri tahu pengguna soal keterbatasan ini.

## 6. 👤 Pengguna: arahkan webhook Fonnte ke server baru

```bash
scripts/public-url.sh
```

Perintah ini mencetak URL webhook yang berisi secret. Kirim URL itu **hanya** ke pengguna, jangan simpan di
tempat lain. Pengguna lalu mengisinya di **dashboard Fonnte → Device → Edit → Webhook**, dan menyimpan.

`PAYMENT_MODE` saat ini `bypass`. Kalau nanti diganti ke `instanpay`, callback URL InstanPay juga harus diganti
ke `https://…/pay/webhook`, dan IP publik home server ditambahkan ke allowlist InstanPay.

## 7. Uji menyeluruh

```bash
docker compose ps
curl -fsS "http://127.0.0.1:$(grep -E '^LOCAL_PORT=' .env | cut -d= -f2)/healthz"
docker compose exec -T app node dist/cli.js users
docker compose exec -T app node dist/cli.js servers
docker compose exec -T app node dist/cli.js server server-milo overview
```

Minta pengguna mengirim **"halo"** ke nomor Milo, lalu pantau:

```bash
docker compose logs -f app | grep -E "fonnte/webhook|giliran agent|gagal|error"
```

Uji dianggap lulus bila:
- **Webhook masuk:** ada request `POST /fonnte/webhook/…` dengan status 200.
- **Balasan terkirim:** pengguna menerima balasan dalam beberapa detik.
- **Data lama utuh:** kirim `GAYA`, lalu pastikan nama dan gaya asisten masih sama seperti di Mac. Tanyakan
  "server saya apa saja?", lalu pastikan server yang sudah terhubung masih terdaftar.
- **Server pengguna bisa dicek:** minta Milo mengecek salah satu server pengguna. Kalau muncul "Sidik jari host
  berubah" atau "tidak bisa dibuka", **berhenti dan laporkan**. Jangan menghapus server pengguna.

## 8. Menyala otomatis setelah listrik padam

Semua service memakai `restart: unless-stopped`, dan Docker sudah di-enable di langkah 1. Cek:

```bash
systemctl is-enabled docker        # enabled
```

Kalau pengguna setuju, uji dengan `sudo reboot`. Setelah server menyala lagi, ulangi pemeriksaan di langkah 7.

## 9. Backup harian

**Tanyakan dulu ke pengguna** sebelum menambah cron. Kalau disetujui:

```bash
( crontab -l 2>/dev/null; echo "30 2 * * * cd $HOME/milo-ai && scripts/backup.sh >> backups/backup.log 2>&1 && find backups -name 'milo-*.tgz' -mtime +14 -delete" ) | crontab -
crontab -l
```

Arsip backup berisi semua rahasia. Sarankan pengguna menyalinnya secara berkala ke tempat lain yang aman,
misalnya drive terenkripsi. Tanpa `SERVER_KEY_SECRET` dari `.env`, server milik pengguna tidak bisa dipulihkan.

## 10. Update aplikasi di kemudian hari

👤 Pengguna menyalin kode baru dari Mac, **tanpa** menimpa `.env`, `servers/`, dan `backups/` di home server:

```bash
rsync -av --exclude node_modules --exclude dist --exclude backups --exclude .env --exclude servers \
  ./ USER@HOME-SERVER:~/milo-ai/
```

Lalu di home server:

```bash
cd ~/milo-ai
scripts/backup.sh
docker compose up -d --build app
docker compose ps
docker compose logs app --since 2m | grep -E "Milo siap|error"
```

Migrasi database berjalan otomatis saat app start. Container `tunnel` tidak perlu dibuat ulang. Untuk quick
tunnel, jangan membuat ulang `quicktunnel` supaya alamatnya tidak berubah.

## Masalah umum

| Gejala | Periksa |
| --- | --- |
| Tidak ada balasan WhatsApp | `docker compose logs app \| grep fonnte/webhook`. Kalau kosong, URL webhook Fonnte salah atau tunnel mati (`docker compose logs tunnel`). |
| Webhook masuk tapi tidak dibalas | `docker compose logs app \| grep -E "duplikat\|gagal\|error"`. Cek `DEEPSEEK_API_KEY`/`ANTHROPIC_API_KEY` dan `FONNTE_TOKEN`. |
| `app` unhealthy | `docker compose logs app --tail 50`. Error konfigurasi menyebut nama variabelnya. |
| `server-milo` gagal dicek | `docker compose ps dockerproxy` dan `ls -l /var/run/docker.sock`. |
| Cek server pengguna: "tidak bisa dibuka; SERVER_KEY_SECRET mungkin berubah" | `SERVER_KEY_SECRET` di `.env` harus sama persis dengan milik Mac. Salin ulang dari arsip backup (file `env`). |
| Port bentrok | Ganti `LOCAL_PORT`, lalu `docker compose up -d app`. |
