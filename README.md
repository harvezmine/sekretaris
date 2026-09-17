# Milo — asisten pribadi via WhatsApp (POC)

Satu nomor WhatsApp, satu asisten. Pengguna mengirim pesan, dokumen, foto, pesan suara, atau kartu kontak; Milo
menyimpannya, menjawab pertanyaan tentangnya, membuat pengingat, dan menyusun pesan untuk orang lain.

Yang ada di POC ini:

- **Onboarding tanpa LLM**: sambutan, harga, FAQ, dan tombol — tidak ada biaya model sampai pengguna aktif.
- **Kode undangan** untuk masa coba 14 hari dan Harga Pendiri.
- **Pembayaran QRIS** di balik satu interface, dengan **mode bypass** untuk uji dan slot adapter untuk gateway-mu.
- **Agent Claude** dengan 10 tool (file tersimpan, pengingat, kontak, fakta, draf pesan, status akun), prompt cache
  1 jam, dan fallback server-side.
- **Debounce 4 detik**: pesan beruntun digabung jadi satu giliran.
- **Pengingat** yang menghormati jendela 24 jam WhatsApp.
- **Laporan pemakaian**: biaya per giliran, porsi cache, sebaran ringan/sedang/berat — angka yang dibutuhkan untuk
  memvalidasi rancangan harga.
- **STOP** dan **HAPUS** (UU PDP), **MENU** dan **MULAI**.

## Menjalankan (Docker)

Semua jalan di Docker: app, Postgres, dan Cloudflare Tunnel. Data tersimpan di volume bernama, jadi mudah dipindah.

```bash
cp .env.example .env        # lalu isi POSTGRES_PASSWORD dan ADMIN_TOKEN (openssl rand -hex 24)
docker compose up -d --build
curl http://127.0.0.1:3000/healthz
```

Port lokal diatur lewat `LOCAL_PORT` (hanya bisa diakses dari mesin itu sendiri). Dari internet, app hanya bisa
dicapai lewat tunnel.

### Mencoba tanpa Meta

Dengan `WA_DRY_RUN=true`, Milo tidak memanggil Meta — setiap balasan dicetak ke log, dan gambar QR disimpan di
`/app/data/dry-run/`.

```bash
docker compose logs -f app &                                   # lihat balasan Milo
docker compose exec app node dist/cli.js code trial            # buat kode masa coba
docker compose exec app node dist/cli.js say 6281234567890 halo
docker compose exec app node dist/cli.js tap 6281234567890 code
docker compose exec app node dist/cli.js say 6281234567890 COBA-XXXXX
docker compose exec app node dist/cli.js tap 6281234567890 subscribe   # alur bayar (bypass)
```

Tombol yang bisa ditekan lewat `tap`: `code`, `price`, `faq`, `subscribe`, `executive`, `resend_qr`, `cancel_pay`,
`delete_yes`, `delete_no`.

Agent butuh `ANTHROPIC_API_KEY`. Tanpa itu, onboarding tetap jalan dan pengguna aktif mendapat pesan gangguan yang sopan.

### Menghubungkan ke WhatsApp sungguhan

Dua kanal, dipilih lewat `WA_PROVIDER`:

| Kanal | Untuk | Panduan |
|---|---|---|
| `meta` | Jalur resmi: WhatsApp Cloud API | [docs/setup-meta.md](docs/setup-meta.md) |
| `fonnte` | POC cepat lewat gateway tidak resmi — tanpa tombol, nomor bisa diblokir | [docs/setup-fonnte.md](docs/setup-fonnte.md) |

Di Fonnte, menu tampil sebagai daftar bernomor dan balasan "1"/"2"/"3" (atau judul pilihannya) diterjemahkan jadi
tombol. Pengingat selalu terkirim karena tidak ada jendela 24 jam. Gambar QR diganti tautan bayar bila paket
Fonnte-mu tidak mendukung lampiran.

`scripts/public-url.sh` mencetak alamat publik dan URL webhook yang harus diisi di dashboard.

### Cloudflare Tunnel (home server)

Tanpa domain, pakai **quick tunnel**: `COMPOSE_PROFILES=quicktunnel` → `docker compose up -d` →
`scripts/public-url.sh`. Alamatnya berganti setiap kali container-nya dibuat ulang. Untuk alamat tetap:

1. Domain sudah memakai nameserver Cloudflare.
2. **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared**, beri nama `milo`.
3. Salin token dari perintah instalasi yang ditampilkan (bagian setelah `--token`) ke `TUNNEL_TOKEN`.
4. **Public hostname**: subdomain `milo`, domainmu, service **HTTP**, URL `app:3000`.
5. Di `.env`: `COMPOSE_PROFILES=tunnel`, lalu `docker compose up -d`.
6. Disarankan: lindungi `https://milo.domainmu.com/admin*` dengan **Cloudflare Access** (Zero Trust → Access →
   Applications → Self-hosted), selain `ADMIN_TOKEN`.

### Perkenalan, menu cepat, dan ringkasan pagi

Setelah masa coba atau langganan aktif, Milo mengajukan 5 pertanyaan tanpa memanggil AI: panggilan, pekerjaan,
kepribadian dan nama asisten, panjang jawaban, serta jam ringkasan agenda pagi. Semua pertanyaan bisa dilewati.
Kalau pengguna malah mengirim permintaan, perkenalan dijeda dan permintaannya diproses seperti biasa. Jawaban
disimpan di `users.profile` dan dikirim ke model di setiap sesi. Model juga bisa mengubahnya lewat
`profile_update`.

**MENU** membuka menu cepat: daftar interaktif di Meta, daftar bernomor di Fonnte. Isinya agenda hari ini, buat
pengingat, kirim file, pesan ke orang lain, cek server, ganti gaya, profil, contoh perintah, dan paket. Kata kunci
**AGENDA**, **GAYA**, **FILE**, **PROFIL**, dan **BANTUAN** langsung membuka menu yang sesuai. Semua jawaban menu
bersifat statis, tapi tetap dicatat di percakapan supaya AI tahu konteksnya.

Ringkasan pagi dikirim scheduler sekali sehari pada jam pilihan pengguna, berisi pengingat hari itu. Kalau
terlambat lebih dari 3 jam (misalnya app sempat mati), ringkasan hari itu dilewati.

### Google: Kalender, Gmail, Drive

Pengguna menghubungkan akun Google-nya dari langkah terakhir perkenalan, dari **MENU → Koneksi akun**, atau lewat
kata kunci **KONEKSI**. Setelah terhubung, Milo bisa:

- membaca dan membuat acara, mencari waktu kosong, serta menggabungkan kalender ke AGENDA dan ringkasan pagi;
- mencari dan membaca email, menyimpan lampiran, serta menulis dan membalas email;
- mencari dan membaca file Drive, serta menyimpan file ke folder "Milo".

Mengirim email, mengirim undangan, dan menghapus acara selalu menunggu pengguna menekan tombol konfirmasi. Panduan
Google Cloud ada di [docs/setup-google.md](docs/setup-google.md).

### File dan pesan ke orang lain (Fonnte)

Paket Fonnte Free tidak meneruskan lampiran, jadi pengguna mengetik **FILE** untuk mendapatkan link unggah
pribadi. File yang diunggah dibaca seperti lampiran biasa. Nomor di `SERVER_ADMIN_NUMBERS` juga bisa menyuruh Milo
mengirim pesan ke kontaknya: pesan terkirim setelah pengguna menekan **Kirim**, dan balasannya diteruskan balik.
Lihat [docs/setup-fonnte.md](docs/setup-fonnte.md).

### Akses server

Dengan `SERVER_ACCESS=all`, setiap pengguna bisa menghubungkan server Linux-nya lewat chat. Milo membuat SSH key
khusus, pengguna menempel satu perintah di servernya, lalu bisa bertanya "server aman?" atau "ada error apa di
aplikasi saya?". Semua cek hanya membaca: tidak ada restart, deploy, atau shell bebas. Nomor operator juga
melihat mesin tempat Milo berjalan (lewat service `dockerproxy`) dan server di `servers/servers.json`. Lihat
[docs/setup-server.md](docs/setup-server.md).

```bash
docker compose exec app node dist/cli.js servers
docker compose exec app node dist/cli.js server server-milo overview
```

## Kode undangan

```bash
docker compose exec app node dist/cli.js code trial --count 10 --source acara-jakarta
docker compose exec app node dist/cli.js code pendiri --count 25 --expires 30
```

Kode sekali pakai secara default (`--uses N` untuk mengubah), terikat ke satu nomor, dan kedaluwarsa dalam 30 hari.
`--source` dipakai untuk atribusi: dari mana pengguna datang.

## Pembayaran

- `PAYMENT_MODE=bypass` (default): QR uji dikirim, lalu pembayaran dikonfirmasi otomatis setelah
  `PAYMENT_BYPASS_DELAY_MS`. Isi `-1` untuk konfirmasi manual:
  `docker compose exec app node dist/cli.js paid <provider_ref>`
- `PAYMENT_MODE=instanpay`: QRIS sungguhan lewat [InstanPay](https://pay.instanlive.id/docs).
  - Isi `INSTANPAY_API_KEY`. Dengan `sk_test_…`, transaksi ditandai lunas otomatis lewat endpoint simulasi sandbox
    (`INSTANPAY_SANDBOX_AUTOPAY_MS`), sehingga alur callback sungguhan ikut teruji.
  - Di dashboard InstanPay, isi Callback URL dengan `<alamat publik>/pay/webhook`. Callback diverifikasi dengan
    tanda tangan HMAC dan `ref_id`-nya harus cocok dengan transaksi.
  - Pelanggan membayar **nominal unik** (mis. Rp500.017) yang ditampilkan Milo, dan menerima tautan halaman bayar
    InstanPay di samping gambar QR.
  - Milo mengecek status transaksi terbuka tiap ±30 detik, karena di mode live InstanPay mencocokkan mutasi saat
    status dicek. Pembatalan di Milo juga membatalkan transaksi di InstanPay.
  - Mode live membatasi IP pemanggil. Tambahkan IP publik server ke allowlist; di home server dengan IP dinamis,
    pembuatan transaksi gagal (`ip_not_allowed`) setiap kali IP berganti.

Konfirmasi pembayaran bersifat idempoten: notifikasi yang berulang tidak memperpanjang langganan dua kali.

## Mengukur POC

```bash
docker compose exec app node dist/cli.js usage --days 7
```

| Kolom | Artinya | Target rancangan harga |
|---|---|---|
| `$/giliran` | Biaya Claude rata-rata per giliran | ~$0,013 (Pribadi) – $0,019 (dengan Google) |
| `porsi cache` | Bagian prompt yang dibaca dari cache | > 0,6 setelah pemanasan |
| `ringan/sedang/berat` | Giliran dengan 1 / 2 / 3+ panggilan model | sekitar 60 / 30 / 10 |
| `pesan/giliran` | Berapa pesan digabung per giliran | > 1 berarti debounce bekerja |
| `latensi ms` | Waktu jawab agent | < 5000 untuk teks |

Versi JSON: `GET /admin/usage?days=7` dengan header `Authorization: Bearer <ADMIN_TOKEN>`.

### Uji dengan API sungguhan

```bash
docker compose exec app node dist/smoke.js                   # model pertama yang tersedia
docker compose exec app node dist/smoke.js deepseek-flash
docker compose exec app node dist/smoke.js claude-sonnet-5
```

Dua giliran sungguhan ke model yang dipilih (Claude beberapa sen, DeepSeek di bawah satu sen), mencetak pemakaian
token, dan memeriksa bahwa panggilan berikutnya membaca dari cache. Pengguna sementara dihapus setelahnya.

### Model dan uji banding

Milo bisa membagi pengguna ke beberapa model lewat `MILO_MODELS`:

```
MILO_MODELS=claude-opus-5:1,deepseek-flash:1
```

- Tiap pengguna mendapat **satu model yang tetap** (disimpan di `users.llm_model`), karena cache dan sesi terikat ke
  model. Mengubah bobot hanya memengaruhi pengguna baru.
- **Model yang API key-nya kosong dilewati.** Dengan hanya `DEEPSEEK_API_KEY`, semua pengguna ke DeepSeek; begitu
  `ANTHROPIC_API_KEY` diisi, pengguna baru mulai terbagi.
- Model yang didukung: `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`, `claude-fable-5-1`, `deepseek-flash`,
  `deepseek-v4-pro`. Rancangan harga dihitung dengan Claude Sonnet 5.
- `cli.js usage` menampilkan tabel **per model**: biaya per giliran, porsi cache, sebaran ringan/sedang/berat,
  latensi, dan giliran yang gagal. Keputusan model diambil dari tabel itu.

**DeepSeek** dipakai lewat endpoint kompatibel Anthropic (`DEEPSEEK_BASE_URL`). Penanda cache dan fallback Claude
tidak dikirim ke sana; DeepSeek punya cache prefiks otomatisnya sendiri. Harga dihitung menurut jadwalnya: jam sibuk
08.00–11.00 dan 13.00–17.00 WIB (Senin–Jumat), di luar itu setengah harga. Perhatikan bahwa DeepSeek memproses dan
menyimpan data di Republik Rakyat Tiongkok — pakai untuk penguji yang paham, dan sebutkan di teks privasi sebelum
dipakai pengguna umum.

`MILO_FALLBACKS=default` menyalakan fallback server-side untuk Claude Opus 5: kalau model menolak permintaan karena
kebijakan keamanan, API menjalankan ulang di model lain dalam panggilan yang sama. Set `off` untuk mematikan.

## Tes

```bash
npm install
npm test                                         # unit test
docker run -d --name milo-test-pg -e POSTGRES_USER=milo -e POSTGRES_PASSWORD=milo \
  -e POSTGRES_DB=milo_test -p 127.0.0.1:55432:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://milo:milo@127.0.0.1:55432/milo_test npm test   # + end-to-end
```

Tes end-to-end memakai klien Claude palsu, jadi tidak memakai kredit. Salah satunya memastikan riwayat percakapan
diputar ulang **byte-per-byte** dari database — kalau tidak, prompt cache meleset di setiap giliran tanpa ada error.

## Backup dan pindah server

Langkah lengkap pindah ke home server dengan Cloudflare Tunnel (bisa diikuti Claude Code): [DEPLOY.md](DEPLOY.md).

```bash
scripts/backup.sh                          # → backups/milo-YYYYmmdd-HHMMSS.tgz (database + file + .env)
```

Di server baru: salin repo dan arsipnya, lalu

```bash
scripts/restore.sh backups/milo-YYYYmmdd-HHMMSS.tgz
```

Arsip berisi `.env` beserta semua token. Simpan di tempat aman.

## Struktur

```
src/
  index.ts            titik masuk: migrasi, server, scheduler
  app.ts              HTTP: webhook WhatsApp, webhook pembayaran, /admin, /healthz
  pipeline.ts         mesin status onboarding + penanganan pesan pengguna aktif
  debounce.ts         penggabung pesan beruntun per pengguna
  agent/              loop Claude, prompt, tool, sesi, harga token
  wa/                 klien Cloud API, Fonnte & dry-run, parser webhook, menu bernomor, format WhatsApp, outbox
  onboarding/         teks statis dan kode undangan
  payments/           interface provider, bypass, InstanPay, aktivasi langganan
  capture/            unduh media, ekstraksi PDF/DOCX/teks
  voice/              transkripsi pesan suara (API kompatibel OpenAI, default Groq)
  reminders/          pengiriman pengingat & kedaluwarsa QR
  admin/              laporan pemakaian dan rute admin
  uploads/            link & halaman unggah file (untuk kanal tanpa lampiran)
  relay/              pesan ke orang lain atas nama pengguna, konfirmasi, dan penerusan balasan
  persona/            katalog nama & kepribadian asisten
  profile/            profil pengguna, agenda hari ini, ringkasan pagi
  google/             login Google (OAuth + PKCE), Kalender, Gmail, Drive, halaman koneksi
  actions/            aksi yang menunggu tombol konfirmasi (kirim email, undangan, hapus acara)
  web/                tampilan bersama halaman web (unggah file, koneksi Google)
  servers/            cek server hanya-baca: server pengguna (kunci terenkripsi), servers.json, SSH, Docker API
  cli.ts, smoke.ts    alat baris perintah dan uji API sungguhan
```

## Belum ada di POC

- **Enkripsi at-rest** untuk file dan percakapan — wajib sebelum pengguna sungguhan (UU PDP).
- Verifikasi aplikasi Google (dan audit CASA untuk baca inbox/seluruh Drive), nomor sendiri per pelanggan (Embedded Signup), dan Jalur B.
- Balasan suara (TTS) dan telepon.
- Aksi server (restart, deploy). Akses server saat ini hanya membaca.
- Isi ulang kuota. Saat batas kewajaran tercapai, Milo beralih ke mode hemat dan memberi tahu sekali.
- Template untuk nudge masa coba di luar jendela 24 jam.
- Pengingat yang sedang terkirim saat app mati akan dijadwalkan ulang saat start, jadi bisa terkirim dua kali.
