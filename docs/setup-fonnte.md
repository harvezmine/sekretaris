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
