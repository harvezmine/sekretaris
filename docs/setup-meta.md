# Menyiapkan WhatsApp Cloud API (nomor uji Meta)

Panduan ini untuk POC: memakai **nomor uji gratis dari Meta**, tanpa verifikasi bisnis. Nomor uji hanya bisa
bercakap dengan **maksimal 5 nomor** yang kamu daftarkan sendiri.

Tampilan dasbor Meta cukup sering berubah. Kalau nama menu sedikit berbeda, cari padanannya — urutannya tetap sama.

## 1. Akun developer

1. Buka **developers.facebook.com** dan masuk dengan akun Facebook.
2. Klik **Get Started / Mulai**, ikuti pendaftaran developer (verifikasi email atau nomor HP, setujui ketentuan).

## 2. Buat app

1. **My Apps → Create App**.
2. Saat ditanya kegunaan, pilih opsi yang berhubungan dengan **WhatsApp** (mis. *Connect with customers through WhatsApp*).
   Kalau diminta memilih tipe, pilih **Business**.
3. Pilih atau buat **akun bisnis Meta** (Business Portfolio). Untuk POC boleh buat baru; verifikasi dokumennya bisa menyusul.
4. Selesaikan pembuatan app.

## 3. Ambil nomor uji

1. Di app, buka **WhatsApp → API Setup** (kadang bernama *Quickstart*).
2. Meta otomatis menyiapkan **nomor uji** dan akun WhatsApp Business uji. Catat:
   - **Phone number ID** → isi ke `WA_PHONE_NUMBER_ID`
   - **WhatsApp Business Account ID** (untuk referensi)
3. Di kolom **To**, tambahkan nomor HP-mu. Meta mengirim kode verifikasi lewat WhatsApp; masukkan kodenya.
   Ulangi untuk paling banyak 4 nomor penguji lain.
4. Klik **Send message** untuk mengirim template `hello_world`. Pastikan pesannya masuk di HP.

## 4. Token permanen

Token dari tombol *Generate access token* di API Setup hanya berlaku sebentar. Untuk server, buat token permanen:

1. Buka **business.facebook.com/settings** → **Users → System users** → **Add**. Beri nama (mis. `milo-server`),
   peran **Admin**.
2. Pilih system user itu → **Add assets**:
   - **Apps** → app tadi → izin penuh (*Manage app*)
   - **WhatsApp accounts** → akun WhatsApp uji → izin penuh
3. Klik **Generate new token** → pilih app tadi → centang izin:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
4. Masa berlaku: **Never**. Salin token → isi ke `WA_ACCESS_TOKEN`. Token hanya ditampilkan sekali.

## 5. App secret

**App settings → Basic → App secret → Show** → salin ke `WA_APP_SECRET`.
Milo memakai ini untuk memastikan setiap webhook benar-benar datang dari Meta.

## 6. Jalankan Milo dan buka tunnel

1. Di `.env`: `WA_DRY_RUN=false`, isi `WA_PHONE_NUMBER_ID`, `WA_ACCESS_TOKEN`, `WA_APP_SECRET`, dan `WA_VERIFY_TOKEN`
   (teks bebas minimal 8 karakter — kamu yang menentukan).
2. Siapkan Cloudflare Tunnel (lihat README) sehingga `https://milo.domainmu.com/healthz` bisa dibuka dari internet.
3. `docker compose up -d`

## 7. Pasang webhook

1. Di app Meta: **WhatsApp → Configuration → Webhook → Edit**.
2. **Callback URL**: `https://milo.domainmu.com/wa/webhook`
3. **Verify token**: sama persis dengan `WA_VERIFY_TOKEN`.
4. **Verify and save**. Meta langsung memanggil server; kalau gagal, cek `docker compose logs app` dan pastikan tunnel aktif.
5. Di **Webhook fields**, klik **Manage** dan **subscribe** ke `messages`.

## 8. Coba

1. Dari HP yang sudah didaftarkan, kirim **"halo"** ke nomor uji. Milo membalas dengan sambutan dan tiga tombol.
2. Buat kode uji: `docker compose exec app node dist/cli.js code trial --count 5 --source penguji`
3. Tekan **Punya Kode** dan ketik salah satu kode. Setelah aktif, coba tanya apa saja, kirim PDF, atau minta pengingat.

## Hal yang perlu diingat

- **Jendela 24 jam tetap berlaku di nomor uji.** Milo hanya bisa mengirim teks bebas kalau pengguna menulis dalam
  24 jam terakhir. Pengingat di luar itu butuh template yang disetujui (`WA_REMINDER_TEMPLATE`).
- **Nama tampil nomor uji generik**, bukan "Milo". Nama sendiri baru bisa setelah memakai nomor asli dan lolos review.
- **Mode Development** di app sudah cukup untuk nomor uji; tidak perlu App Review untuk POC.
- Saat pindah ke nomor asli: nomor itu **tidak boleh sedang aktif di aplikasi WhatsApp biasa**. Hapus akun WhatsApp-nya
  dulu, lalu daftarkan lewat **WhatsApp Manager → Phone numbers → Add**.
