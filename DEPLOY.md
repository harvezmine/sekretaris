# Deploy Milo ke home server (Cloudflare Tunnel)

Runbook ini ditulis untuk **Claude Code yang berjalan di home server**. Jalankan langkahnya berurutan dan cek
hasil tiap langkah sebelum lanjut. Kalau hasil tidak sesuai, berhenti dan laporkan ke pengguna.

Bagian bertanda **👤 Pengguna** harus dikerjakan pengguna sendiri (di Mac, dashboard Cloudflare, Google Cloud,
atau dashboard Fonnte). Minta pengguna mengerjakannya, lalu tunggu konfirmasi.

## Nilai untuk proyek ini

| | |
| --- | --- |
| Repo | `https://github.com/harvezmine/sekretaris.git`, branch `main` |
| Folder repo di server | `/home/sekretaris` (tempat `./deploy.sh` dijalankan) |
| Arsip backup dari Mac | `backups/milo-20260917-165948.tgz` (Milo di Mac sudah dimatikan sejak backup ini dibuat) |
| Domain (Cloudflare) | `secretary.my.id` |
| Alamat Milo | `app.secretary.my.id` → tunnel ke `http://app:3000` |
| `PUBLIC_BASE_URL` | `https://app.secretary.my.id` |
| Webhook Fonnte | `https://app.secretary.my.id/fonnte/webhook/<FONNTE_WEBHOOK_SECRET>` |
| Redirect login Google | `https://app.secretary.my.id/google/callback` |

`secretary.my.id` (tanpa subdomain) sengaja dibiarkan kosong untuk halaman depan dan kebijakan privasi nanti.
Halaman itu dibutuhkan saat verifikasi Google.

Kalau folder repo di server ternyata berbeda, pakai folder itu di semua perintah di bawah.

## Aturan selama deploy

- **Jangan tampilkan rahasia.** Ini berlaku untuk isi `.env`, `.deploy.env`, token tunnel, token GitHub, dan
  secret Google. Kalau perlu memeriksa, tampilkan nama variabelnya saja, misalnya
  `grep -E '^[A-Z_]+=' .env | sed 's/=.*/=***/'`.
- **Jangan buat `SERVER_KEY_SECRET` baru.** Nilainya berasal dari Mac lewat arsip backup. Kalau diganti, kunci
  SSH server pengguna dan token Google tidak bisa dibuka lagi.
- **Hanya satu instance Milo yang boleh aktif.** Kalau Mac dan home server sama-sama menyala, pengingat terkirim
  dua kali dan webhook berebut.
- **Jangan membuka port ke internet.** Semua lalu lintas lewat Cloudflare Tunnel, dan app hanya listen di
  `127.0.0.1`. Service `searxng` (mesin pencari) juga tidak boleh diberi port atau hostname publik.
- **Jangan ubah pengaturan service `dockerproxy`** (`POST: 0`, socket read-only). Itu yang membuat akses Milo ke
  Docker hanya-baca.
- **Jangan jalankan `docker compose down -v`**, karena `-v` menghapus database.
- **Jangan edit file yang dilacak git langsung di server.** `deploy.sh` menolak jalan kalau working tree kotor.
  Perubahan kode dibuat di Mac, lalu di-push. File server yang boleh diedit hanya `.env`, `.deploy.env`, dan
  `servers/servers.json`.

## 0. Yang dibutuhkan

- **Home server:** Linux (Ubuntu/Debian disarankan) yang menyala 24 jam, terhubung ke internet, dan user-nya
  punya `sudo`.
- **Akses pengguna:** pengguna bisa login ke GitHub, Cloudflare, Fonnte, dan (opsional) Google Cloud.
- **Domain aktif:** `secretary.my.id` harus sudah dikelola Cloudflare supaya alamat Milo tetap. Selama domain
  belum aktif, Milo tetap bisa jalan dengan quick tunnel (langkah 6B), tapi alamatnya berubah setiap restart dan
  login Google belum bisa dipakai.

## 1. Siapkan Docker dan git

```bash
docker --version && docker compose version && git --version && curl --version | head -1
```

Kalau ada yang belum terpasang, **tanyakan dulu ke pengguna** sebelum memasang, karena butuh sudo:

```bash
sudo apt-get update && sudo apt-get install -y git curl
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

## 2. Ambil kode dari GitHub

Kalau `/home/sekretaris` sudah ada dan **tidak kosong**, berhenti dan tanyakan ke pengguna.

**Repo publik:**

```bash
sudo mkdir -p /home/sekretaris && sudo chown "$USER": /home/sekretaris
git clone https://github.com/harvezmine/sekretaris.git /home/sekretaris
```

**Repo privat.** 👤 Pengguna membuat *fine-grained token* di GitHub (Settings → Developer settings → Personal
access tokens) untuk repo `sekretaris` saja, dengan izin **Contents: Read-only**. Lalu pengguna menjalankan
perintah ini sendiri di terminal server, supaya tokennya tidak pernah tampil:

```bash
sudo mkdir -p /home/sekretaris && sudo chown "$USER": /home/sekretaris
read -rsp "Token GitHub: " GIT_TOKEN && echo
git -c http.extraHeader="Authorization: Basic $(printf 'x-access-token:%s' "$GIT_TOKEN" | base64 -w0)" \
  clone https://github.com/harvezmine/sekretaris.git /home/sekretaris
( umask 077 && printf 'GIT_TOKEN=%s\n' "$GIT_TOKEN" > /home/sekretaris/.deploy.env )
unset GIT_TOKEN
```

Token hanya disimpan di `.deploy.env` (diabaikan git, mode 600), dan `deploy.sh` memakainya untuk `git fetch`.
Token tidak pernah ditulis ke `.git/config`.

Cek:

```bash
cd /home/sekretaris
git log --oneline -1
ls docker-compose.yml Dockerfile deploy.sh scripts/restore.sh
```

## 3. 👤 Pengguna: salin arsip backup dari Mac

Di Mac, dari folder `milo-ai`:

```bash
ssh USER@HOME-SERVER 'mkdir -p /home/sekretaris/backups && chmod 700 /home/sekretaris/backups'
scp backups/milo-20260917-165948.tgz USER@HOME-SERVER:/home/sekretaris/backups/
```

- **Isi arsip:** database, file pengguna, `.env` (termasuk `SERVER_KEY_SECRET`), dan folder `servers/`. Arsip ini
  rahasia. Kode tidak perlu disalin karena sudah diambil dari GitHub.
- **Kalau Milo di Mac sempat dinyalakan lagi** setelah backup itu dibuat, buat backup baru dulu
  (`scripts/backup.sh`), matikan lagi (`docker compose down`, **tanpa** `-v`), lalu salin arsip yang baru.

## 4. Pulihkan data

Skrip ini menimpa database dan file Milo di server. **Tanyakan dulu ke pengguna**, dan lanjutkan hanya kalau ini
server baru atau pengguna memang setuju datanya ditimpa. Skrip meminta jawaban `YA`. Karena prompt interaktif
tidak bisa diisi dari Claude Code, jawabannya dialirkan lewat pipe:

```bash
cd /home/sekretaris
printf 'YA\n' | scripts/restore.sh backups/milo-20260917-165948.tgz
```

- **`.env` dan `servers/`:** skrip memulihkan `.env` dari arsip (karena belum ada di server) serta folder
  `servers/` (daftar server dan kunci SSH).
- **Hasil:** skrip membangun image, memulihkan database dan file pengguna, lalu menyalakan semua service. Karena
  `.env` dari Mac masih berisi `COMPOSE_PROFILES=quicktunnel`, quick tunnel ikut menyala. Itu tidak masalah
  sampai langkah 6.

Cek:

```bash
docker compose ps                                   # db healthy, app healthy, dockerproxy running
chmod 600 .env
git status --short                                  # harus kosong (kalau tidak, laporkan)
grep -E '^(COMPOSE_PROFILES|PUBLIC_BASE_URL|LOCAL_PORT|SERVER_ACCESS|SERVER_ADMIN_NUMBERS|MESSAGE_SEND_ACCESS|WA_PROVIDER|WA_DRY_RUN)=' .env
grep -cE '^SERVER_KEY_SECRET=.{32,}' .env           # harus 1
[ -d servers/keys ] && sudo chown -R 1000 servers/keys && chmod 700 servers/keys && chmod 600 servers/keys/*
```

Perintah terakhir membuat kunci SSH di `servers/keys/` bisa dibaca app, yang berjalan sebagai uid 1000 di dalam
container.

## 5. Sesuaikan `.env` untuk server ini

Edit `.env`. Jangan ubah variabel lain tanpa bertanya ke pengguna.

| Variabel | Nilai |
| --- | --- |
| `LOCAL_PORT` | Port lokal yang belum dipakai. Cek dengan `ss -tln \| grep :3310`. Nilai dari Mac: `3310`. |
| `COMPOSE_PROFILES` | `tunnel` setelah langkah 6A, atau tetap `quicktunnel` selama domain belum aktif (6B). |
| `TUNNEL_TOKEN` | Dari langkah 6A. |
| `PUBLIC_BASE_URL` | `https://app.secretary.my.id` setelah 6A. Biarkan kosong selama memakai quick tunnel. |
| `SEARXNG_SECRET` | Kunci internal mesin pencari: `openssl rand -hex 24`. Wajib ada kalau `SEARXNG_URL` diisi. |

Variabel baru yang belum ada di `.env` dari Mac tidak wajib diisi, karena semuanya punya nilai default
(`deploy.sh` akan menyebutkannya sebagai peringatan). Yang perlu diisi hanya variabel Google di langkah 8.

## 6A. 👤 Pengguna: domain dan Cloudflare Tunnel (disarankan)

**Pindahkan domain ke Cloudflare** (sekali saja):

1. Di [dash.cloudflare.com](https://dash.cloudflare.com), pilih **Add a domain**, isi `secretary.my.id`, lalu pilih
   paket **Free**.
2. Cloudflare memberi dua nameserver. Di panel registrar (resellercamp/liqu.id), ganti nameserver
   `NS1.LIQU.ID`/`NS2.LIQU.ID` dengan keduanya. Domain `.my.id` biasanya juga butuh verifikasi KTP di registrar
   sebelum aktif.
3. Tunggu sampai status domain di Cloudflare menjadi **Active**. Claude Code bisa mengecek:

   ```bash
   dig +short NS secretary.my.id @1.1.1.1    # harus berupa *.ns.cloudflare.com
   ```

**Buat tunnel:**

1. **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared**, beri nama `milo-home`.
2. Pada langkah instalasi, salin **token** (teks panjang setelah `--token`). Jangan pasang cloudflared dari
   halaman itu, karena cloudflared sudah berjalan sebagai container.
3. **Public hostname:** subdomain `app`, domain `secretary.my.id`, **Type** `HTTP`, **URL** `app:3000`.
4. **Disarankan:** di **Access → Applications → Self-hosted**, lindungi `app.secretary.my.id/admin*` dengan
   login email. Jangan lindungi `/fonnte/*`, `/pay/*`, `/wa/*`, `/u/*`, `/connect/*`, atau `/google/*`. Webhook
   harus bisa masuk, sedangkan sisanya adalah halaman untuk pengguna (unggah file dan login Google).

Pengguna memasukkan token tunnel ke `.env` sendiri, atau memberikannya ke Claude Code untuk ditulis langsung
tanpa ditampilkan lagi. Setelah itu:

```bash
cd /home/sekretaris
sed -i 's/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=tunnel/' .env
grep -q '^PUBLIC_BASE_URL=' .env \
  && sed -i 's#^PUBLIC_BASE_URL=.*#PUBLIC_BASE_URL=https://app.secretary.my.id#' .env \
  || echo 'PUBLIC_BASE_URL=https://app.secretary.my.id' >> .env
docker compose --profile quicktunnel rm -sf quicktunnel   # matikan quick tunnel
docker compose up -d
docker compose logs tunnel --since 2m | grep -iE "registered|error"   # harus ada "Registered tunnel connection"
curl -fsS https://app.secretary.my.id/healthz
```

`/healthz` harus mengembalikan `"ok":true`, `"channel":"fonnte"`, dan `"dryRun":false`.

## 6B. Sementara domain belum aktif: quick tunnel

```bash
cd /home/sekretaris
sed -i 's/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=quicktunnel/' .env
docker compose up -d
scripts/public-url.sh
```

- **Alamat berubah:** alamat `trycloudflare.com` berganti setiap kali container `quicktunnel` dibuat ulang atau
  server restart. Setiap kali itu terjadi, langkah 7 harus diulang.
- **Login Google belum bisa dipakai:** Google hanya menerima alamat tetap.
- **Kalau domain sudah aktif:** lanjutkan ke 6A.

## 7. 👤 Pengguna: arahkan webhook Fonnte ke server ini

```bash
cd /home/sekretaris && scripts/public-url.sh
```

Perintah ini mencetak URL webhook yang berisi secret. Kirim URL itu **hanya** ke pengguna, jangan simpan di
tempat lain. Pengguna lalu mengisinya di **dashboard Fonnte → Device → Edit → Webhook**, dan menyimpan. Dengan
domain (6A), URL-nya selalu `https://app.secretary.my.id/fonnte/webhook/<secret>`.

`PAYMENT_MODE` saat ini `bypass`. Kalau nanti diganti ke `instanpay`, callback URL InstanPay juga harus diganti
ke `https://app.secretary.my.id/pay/webhook`, dan IP publik home server ditambahkan ke allowlist InstanPay.

## 8. Opsional: koneksi Google (Kalender, Gmail, Drive)

Langkah ini butuh 6A. 👤 Pengguna mengikuti [docs/setup-google.md](docs/setup-google.md) di Google Cloud Console:
- aktifkan API Kalender, Gmail, dan Drive;
- set consent screen ke *External, Testing*, lalu tambahkan Gmail pengguna sebagai test user;
- buat OAuth Client (Web) dengan redirect URI `https://app.secretary.my.id/google/callback`.

Isi di `.env` (pengguna menempelkan secret-nya sendiri):

```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
GOOGLE_SERVICES=calendar,gmail,drive
GOOGLE_GMAIL_READ=true
GOOGLE_DRIVE_FULL=true
```

Lalu:

```bash
cd /home/sekretaris
docker compose up -d                                  # app dibuat ulang dengan .env baru
docker compose logs app --since 1m | grep -i google   # "koneksi Google aktif", redirect .../google/callback
```

Uji: pengguna mengirim **KONEKSI** ke Milo, membuka link-nya, lalu masuk dengan Gmail yang terdaftar sebagai test
user. Pesan "✅ Google terhubung (email)" harus muncul.

## 9. Uji menyeluruh

```bash
cd /home/sekretaris
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
- **Data lama utuh:** kirim **PROFIL**, lalu pastikan panggilan, nama, dan gaya asisten masih sama seperti di Mac.
  Tanyakan "server saya apa saja?", lalu pastikan server yang sudah terhubung masih terdaftar.
- **Menu dan file berfungsi:** **MENU** menampilkan menu bernomor, dan **FILE** memberi link unggah dengan alamat
  server ini (`app.secretary.my.id` bila 6A).
- **Server pengguna bisa dicek:** minta Milo mengecek salah satu server pengguna. Kalau muncul "Sidik jari host
  berubah" atau "tidak bisa dibuka", **berhenti dan laporkan**. Jangan menghapus server pengguna.
- **Google (bila langkah 8 dikerjakan):** **AGENDA** menampilkan acara dari Google Kalender.

## 10. Menyala otomatis setelah listrik padam

Semua service memakai `restart: unless-stopped`, dan Docker sudah di-enable di langkah 1. Cek:

```bash
systemctl is-enabled docker        # enabled
```

Kalau pengguna setuju, uji dengan `sudo reboot`. Setelah server menyala lagi, ulangi pemeriksaan di langkah 9.
Dengan quick tunnel (6B), alamat berubah setelah reboot, jadi langkah 7 juga harus diulang.

## 11. Backup harian

**Tanyakan dulu ke pengguna** sebelum menambah cron. Kalau disetujui:

```bash
( crontab -l 2>/dev/null; echo "30 2 * * * cd /home/sekretaris && scripts/backup.sh >> backups/backup.log 2>&1 && find backups -name 'milo-*.tgz' -mtime +14 -delete" ) | crontab -
crontab -l
```

Arsip backup berisi semua rahasia. Sarankan pengguna menyalinnya secara berkala ke tempat lain yang aman,
misalnya drive terenkripsi. Tanpa `SERVER_KEY_SECRET` dari `.env`, server pengguna dan token Google tidak bisa
dipulihkan.

## 12. Update aplikasi

Setelah perubahan di-commit dan di-push dari Mac, jalankan di home server:

```bash
cd /home/sekretaris
./deploy.sh
```

`deploy.sh` menjalankan urutan berikut:
1. `git fetch`, lalu fast-forward.
2. `scripts/backup.sh`.
3. `docker compose build app`.
4. `docker compose up -d`.
5. Menunggu `/healthz` mengembalikan `"ok":true`.

- **Tanpa commit baru**, skrip langsung keluar tanpa menyentuh container.
- **Log** ada di `deploy.log`.
- **Hanya untuk Linux**, karena memakai `flock` dan `base64 -w0`.

Opsi:
- `./deploy.sh --force`: build dan up ulang walaupun tidak ada commit baru, misalnya setelah build gagal atau
  setelah `.env` diubah.
- `SKIP_BACKUP=1 ./deploy.sh`: lewati backup (tidak disarankan).

Skrip menolak jalan kalau ada file terlacak yang diubah langsung di server, atau riwayat lokal menyimpang dari
`origin`. Migrasi database berjalan otomatis saat app start. Container `tunnel` tidak ikut dibuat ulang. Kalau
container `quicktunnel` ikut dibuat ulang, skrip memberi peringatan karena alamatnya berubah, dan langkah 7 harus
diulang.

## Masalah umum

| Gejala | Periksa |
| --- | --- |
| Tidak ada balasan WhatsApp | `docker compose logs app \| grep fonnte/webhook`. Kalau kosong, URL webhook Fonnte salah atau tunnel mati (`docker compose logs tunnel`). |
| Webhook masuk tapi tidak dibalas | `docker compose logs app \| grep -E "duplikat\|gagal\|error"`. Cek `DEEPSEEK_API_KEY`/`ANTHROPIC_API_KEY` dan `FONNTE_TOKEN`. |
| `app` unhealthy | `docker compose logs app --tail 50`. Error konfigurasi menyebut nama variabelnya. |
| `https://app.secretary.my.id` tidak bisa dibuka | `dig +short NS secretary.my.id @1.1.1.1` harus berupa nameserver Cloudflare. Cek public hostname di tunnel dan `docker compose logs tunnel`. |
| `deploy.sh`: "working tree tidak bersih" | `git status`. Kembalikan file yang terlanjur diedit (`git checkout -- <file>`) setelah bertanya ke pengguna. Perubahan harus lewat commit di Mac. |
| `deploy.sh`: "git fetch gagal" | Repo privat: cek `.deploy.env` (nama `GIT_TOKEN`, mode 600) dan masa berlaku tokennya. |
| `server-milo` gagal dicek | `docker compose ps dockerproxy` dan `ls -l /var/run/docker.sock`. |
| Cek server pengguna: "tidak bisa dibuka; SERVER_KEY_SECRET mungkin berubah" | `SERVER_KEY_SECRET` di `.env` harus sama persis dengan milik Mac. Ambil lagi dari arsip backup (file `env` di dalamnya). |
| Login Google: `redirect_uri_mismatch` | Redirect URI di Google Cloud harus persis `https://app.secretary.my.id/google/callback`, dan `PUBLIC_BASE_URL` harus `https://app.secretary.my.id`. |
| Login Google: "Akses diblokir" | Gmail pengguna belum ditambahkan sebagai test user. |
| Milo membalas dengan link wa.me, bukan mengirim sendiri | `docker compose exec app node dist/cli.js status <nomor pengguna>`. Baris "Kirim ke orang lain" harus AKTIF. Kalau MATI: isi `MESSAGE_SEND_ACCESS=all`, atau tambahkan nomor itu ke `SERVER_ADMIN_NUMBERS`, lalu `docker compose up -d app`. |
| Pencarian internet gagal | `docker compose logs searxng --tail 20`. Mesin pencari kadang membatasi; isi `TAVILY_API_KEY` sebagai cadangan, atau kosongkan `SEARXNG_URL` untuk mematikan fitur. |
| Port bentrok | Ganti `LOCAL_PORT`, lalu `docker compose up -d app`. |
