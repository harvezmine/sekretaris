# POC WhatsApp lewat Fonnte

Fonnte menghubungkan nomor WhatsApp biasa seperti WhatsApp Web. Ini **tidak resmi**:

- nomornya bisa diblokir WhatsApp — pakai nomor cadangan, jangan nomor utama;
- tidak ada tombol, jadi menu Milo tampil sebagai daftar bernomor ("balas 1, 2, atau 3");
- sesi WhatsApp-nya dipegang Fonnte.

Cocok untuk POC dan penguji yang paham. Untuk pelanggan berbayar, pindah ke jalur resmi (Cloud API atau BSP).

## Nomor

- Pakai **SIM cadangan**. Satu HP dual-SIM bisa menjalankan WhatsApp biasa (nomor pribadi) dan
  **WhatsApp Business** (nomor Milo) bersamaan.
- Nomor baru sebaiknya dipakai wajar dulu beberapa hari (chat dengan teman) sebelum dipakai bot.
- HP tidak harus selalu online setelah terhubung, tapi WhatsApp mengeluarkan perangkat tertaut kalau HP tidak
  aktif lebih dari 14 hari.

## Paket Fonnte

| Kebutuhan Milo | Paket |
|---|---|
| Chat teks, pengingat, kontak lewat teks | Free (1.000 pesan/bulan) — **pastikan webhook bisa diisi di paketmu** |
| Menerima dokumen, foto, pesan suara; mengirim gambar QR | Paket dengan lampiran. Dokumentasi API Fonnte menyebut Super/Advanced/Ultra — cek di dashboard sebelum membayar |

Cek status device kapan saja (tidak mengirim pesan):

```bash
curl -s -X POST https://api.fonnte.com/device -H "Authorization: <FONNTE_TOKEN>"
```

`attachment: false` berarti lampiran belum aktif di paketmu.

### Tanpa paket lampiran: link unggah

Di paket Free, Fonnte tidak meneruskan file, foto, atau pesan suara ke webhook, jadi Milo tidak pernah menerimanya.
Karena itu, Milo memakai **link unggah pribadi**:

- **Cara membukanya:** pengguna mengetik **FILE** (atau meminta di chat, misalnya "saya mau kirim PDF"). Milo
  membalas dengan link yang berlaku `UPLOAD_LINK_HOURS` jam.
- **Isi halaman:** PDF, Word, teks, foto, atau rekaman suara, maksimal `UPLOAD_MAX_MB`, beserta pertanyaan
  opsional.
- **Setelah diunggah:** file diproses persis seperti lampiran WhatsApp. Milo menyimpannya, membaca isinya, lalu
  menjawab di WhatsApp.
- **Pesan lampiran kosong:** kalau Fonnte mengirim webhook tanpa isi, Milo otomatis membalas dengan link ini.
- **Alamat link:** diambil dari `PUBLIC_BASE_URL`, atau dari alamat tunnel tempat webhook terakhir masuk.

Setelah upgrade ke paket berlampiran, isi `FONNTE_ATTACHMENTS=true` supaya teks sambutan kembali menyarankan
kirim file langsung. Link unggah tetap tersedia.

### Mengirim pesan ke orang lain

Dengan `MESSAGE_SEND_ACCESS=admin` (atau `all`), Milo bisa mengirim pesan ke kontak pengguna dari nomor Fonnte.

- **Konfirmasi wajib:** AI hanya menyusun draf. Pesan baru terkirim setelah pengguna membalas **Kirim** (atau
  angka 1) dalam 15 menit. Pesan itu diberi tanda "— Milo, asisten pribadi <nama>".
- **Balasan diteruskan:** balasan penerima dalam `RELAY_REPLY_HOURS` jam diteruskan ke pengguna. Penerima tidak
  mendapat menu pendaftaran, dan diberi ucapan terima kasih sekali.
- **Batasan:**
  - maksimal `MESSAGE_SEND_DAILY_LIMIT` pesan per 24 jam;
  - satu penerima per pesan;
  - penerima yang pernah mengetik STOP tidak bisa dikirimi.
- **Risiko:** nomor Fonnte dipakai bersama semua pengguna. WhatsApp bisa memblokir nomor yang sering mengirim ke
  orang yang tidak pernah chat lebih dulu. Karena itu, fitur ini sebaiknya tetap terbatas.

## Menyalakan

1. Di `.env`:
   ```
   WA_PROVIDER=fonnte
   WA_DRY_RUN=false
   FONNTE_TOKEN=<token device>
   FONNTE_WEBHOOK_SECRET=<openssl rand -hex 16>
   COMPOSE_PROFILES=quicktunnel
   ```
2. `docker compose up -d --build`
3. `scripts/public-url.sh` → salin **Webhook Fonnte**.
4. Dashboard Fonnte → **Device → Edit**:
   - **Webhook**: tempel URL dari langkah 3
   - **Autoread**: On
   - **Autoreply**: Off (autoreply Fonnte tidak jalan bersamaan dengan webhook)
5. Buat kode: `docker compose exec app node dist/cli.js code trial --uses 10`
6. Dari WhatsApp lain, kirim **halo** ke nomor Fonnte → balas **1** → ketik kodenya.

## Quick tunnel

`quicktunnel` memberi alamat `https://…trycloudflare.com` tanpa akun atau domain. Alamatnya **berganti setiap
kali container-nya dibuat ulang** (`docker compose up` setelah `down`, restart mesin, dan sebagainya). Setiap kali
berganti, jalankan `scripts/public-url.sh` lagi dan perbarui webhook di Fonnte.

Untuk alamat tetap, pakai Cloudflare Tunnel bernama (lihat README) dan ganti profilnya ke `tunnel`.

## Kalau Milo tidak membalas

```bash
docker compose logs -f app          # pesan masuk & error
scripts/public-url.sh               # alamat sekarang masih sama dengan yang di Fonnte?
```

- Tidak ada log sama sekali → webhook belum terpasang, alamat tunnel sudah berganti, atau paketmu tidak mendukung webhook.
- Log `Fonnte: ...` → pengiriman ditolak Fonnte (kuota habis, device terputus, lampiran tidak didukung).
- Balasan "gangguan" → cek `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY`.
