# Menghubungkan Google (Kalender, Gmail, Drive, Kontak, Tasks, Formulir)

Pengguna menghubungkan akun Google-nya sendiri lewat WhatsApp. Ada tiga jalan: langkah terakhir perkenalan,
**MENU → Koneksi akun**, atau kata kunci **KONEKSI**. Milo mengirim link pribadi yang berlaku 30 menit. Di halaman
itu pengguna memilih layanan, lalu masuk dengan Google, dan Milo mengonfirmasi di WhatsApp. Milo tidak pernah
melihat password pengguna.

| Layanan | Yang bisa dilakukan Milo | Izin (scope) | Kategori Google |
| --- | --- | --- | --- |
| Kalender | lihat agenda, cari waktu kosong, buat acara, hapus acara, kirim undangan | `calendar.events` | sensitif |
| Gmail | kirim/balas email | `gmail.send` | sensitif |
| Gmail | cari & baca email, simpan lampiran | `gmail.readonly` | **restricted** |
| Drive | simpan file ke folder "Milo", baca file buatan Milo | `drive.file` | non-sensitif |
| Docs | tulis notulen/surat jadi Google Docs | `drive.file` (tanpa izin baru) | non-sensitif |
| Sheets | catat omzet/pengeluaran ke spreadsheet buatan Milo | `drive.file` (tanpa izin baru) | non-sensitif |
| Drive | cari & baca semua file | `drive.readonly` | **restricted** |
| Kontak | cari nomor & email orang dari kontak Google pengguna | `contacts.readonly` | sensitif |
| Tasks | lihat, tambah, dan centang tugas di Google Tasks | `tasks` | sensitif |
| Formulir | buat form pesanan/absensi/survei dan baca jawabannya | `forms.body` + `forms.responses.readonly` + `drive.file` | sensitif |

## Pencarian YouTube (opsional, dan biasanya tidak perlu)

Milo bisa mencari video dengan dua cara, dan yang pertama tidak butuh apa pun dari Google.

**Tanpa kunci, lewat SearXNG sendiri.** SearXNG yang sudah jalan di compose punya kategori video dengan mesin
YouTube di dalamnya. Milo memakai itu kalau `YOUTUBE_API_KEY` kosong. Hasilnya judul, durasi, dan tautan. Tidak
ada kuota, tidak ada kredensial, dan tidak ada tagihan.

**Dengan kunci, lewat YouTube Data API v3.** Tambahannya cuma nama channel, tanggal unggah, dan jumlah tayangan.
Kalau tetap mau: aktifkan **YouTube Data API v3** di Library, lalu **Credentials → Create credentials → API key**,
batasi key itu ke API tersebut, dan isi `YOUTUBE_API_KEY`. Datanya publik, jadi ini API key biasa, bukan OAuth:
tidak ada akun pengguna yang dibuka dan tidak ada izin yang perlu diminta ke mereka.

Kuota gratisnya 10.000 unit per hari untuk seluruh layanan, dan satu pencarian memakan 100 unit, jadi sekitar
seratus pencarian sehari dibagi semua pengguna. Karena itu ada `YOUTUBE_SEARCHES_PER_DAY` (bawaan 5) per pengguna,
yang berlaku untuk kedua jalur.

Transkrip video tidak tersedia lewat API resmi kecuali videonya milik pengguna sendiri, jadi "ringkas video ini"
belum bisa dijanjikan; "carikan video tentang ini" bisa.

## Dua hal yang perlu diketahui

**Google Tasks hanya menyimpan tanggal, bukan jam.** API-nya membuang bagian jam dari tenggat. Karena itu pengingat
tetap milik Milo sendiri (lengkap dengan jamnya), sedangkan Tasks dipakai untuk pekerjaan yang cukup "hari ini".
Tugas yang jatuh tempo hari ini ikut muncul di **AGENDA** dan di sapaan pagi.

**Formulir baru harus dibuka dulu supaya bisa diisi orang lain.** Form yang dibuat lewat API awalnya hanya bisa
dibuka pembuatnya. Milo otomatis menerbitkannya (`setPublishSettings`) lalu memberi izin Drive
`role: reader, type: anyone, view: published`. Kalau langkah izin itu ditolak Google, Milo memberi tahu bahwa
linknya mungkin belum bisa dibuka orang lain, bukan diam-diam mengirim link yang rusak. Milo hanya bisa membaca
formulir yang ia buat sendiri.

**Tidak ada yang terkirim atau terhapus tanpa persetujuan pengguna.** Mengirim email, mengirim undangan kalender,
dan menghapus acara selalu menunggu pengguna menekan tombol konfirmasi di WhatsApp. Tombol itu ditangani Milo
tanpa AI dan berlaku 15 menit.

Untuk proyek ini: alamat Milo `https://app.secretary.my.id`, authorized domain `secretary.my.id`, dan redirect URI
`https://app.secretary.my.id/google/callback`.

## 1. Prasyarat

- **Alamat tetap Milo.** Untuk proyek ini `https://app.secretary.my.id`, lewat Cloudflare Tunnel
  ([DEPLOY.md](../DEPLOY.md) langkah 5A). Google menolak alamat trycloudflare yang berubah-ubah.
- **Isi `.env`:**
  - `PUBLIC_BASE_URL=https://app.secretary.my.id`
  - `SERVER_KEY_SECRET` sudah terisi. Token Google dienkripsi dengan kunci ini.

## 2. Google Cloud Console

Buka [console.cloud.google.com](https://console.cloud.google.com) dengan akun Google milik bisnis Anda.

1. **Buat project**, misalnya `Milo`.
2. **APIs & Services → Library.** Aktifkan **Google Calendar API**, **Gmail API**, **Google Drive API**, **People API** (untuk kontak), **Google Tasks API**, dan **Google Forms API**.
3. **Google Auth Platform → Branding** (dulu "OAuth consent screen"):
   - **App name:** `Milo`.
   - **User support email** dan **Developer contact:** email Anda.
   - **Authorized domains:** `secretary.my.id`.
4. **Audience:**
   - **User type:** External.
   - **Publishing status:** biarkan **Testing**.
   - **Test users → Add users:** tambahkan setiap Gmail yang akan menghubungkan Milo. Maksimal 100 alamat, dan
     tiap alamat harus ditambahkan manual.
5. **Data Access → Add or remove scopes:** tambahkan `…/auth/calendar.events`, `…/auth/gmail.send`,
   `…/auth/gmail.readonly`, `…/auth/drive.file`, `…/auth/drive.readonly`, `…/auth/contacts.readonly`,
   `…/auth/tasks`, `…/auth/forms.body`, dan `…/auth/forms.responses.readonly`.
6. **Clients → Create client:**
   - **Application type:** Web application. **Name:** `Milo server`.
   - **Authorized redirect URIs:** `https://app.secretary.my.id/google/callback`. Harus sama persis, tanpa garis
     miring di akhir.
   - Klik **Create**, lalu salin **Client ID** dan **Client secret**.

## 3. Isi `.env` dan jalankan ulang

```
GOOGLE_CLIENT_ID=1234567890-xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_SERVICES=calendar,gmail,drive
GOOGLE_GMAIL_READ=true
GOOGLE_DRIVE_FULL=true
```

```bash
docker compose up -d app
docker compose logs app --since 1m | grep -i google   # "koneksi Google aktif", beserta alamat redirect
```

Uji: kirim **KONEKSI** ke Milo, buka link-nya, lalu masuk dengan Gmail yang sudah didaftarkan sebagai test user.
Pesan "✅ Google terhubung (email)" akan muncul di WhatsApp.

## Batasan mode Testing

- **Login kedaluwarsa tiap 7 hari.** Google membatasi masa berlaku token di mode Testing. Milo mendeteksinya lalu
  mengirim link login ulang sekali lewat WhatsApp. Selama belum login ulang, AGENDA dan ringkasan pagi memberi
  tahu bahwa kalender tidak bisa dibaca.
- **Peringatan "Google belum memverifikasi aplikasi ini".** Pengguna memilih *Lanjutan → Lanjutkan*. Petunjuk
  ini juga tertulis di halaman koneksi.
- **Hanya test user.** Email di luar daftar test user akan mendapat pesan "Akses diblokir".

## Sebelum dibuka untuk umum

1. **Siapkan halaman publik:** beranda dan kebijakan privasi di domain Anda. Verifikasi domain lewat Google Search
   Console.
2. **Ajukan verifikasi:** di **Verification Center**, lengkapi alasan penggunaan tiap scope dan video demo.
   Kalender dan `gmail.send` termasuk *sensitif*: cukup verifikasi, tanpa biaya.
3. **Untuk scope restricted** (`gmail.readonly`, `drive.readonly`), ada dua pilihan:
   - lulus **audit CASA** (diulang setiap tahun); atau
   - matikan scope itu: `GOOGLE_GMAIL_READ=false` dan `GOOGLE_DRIVE_FULL=false`. Milo tetap bisa mengirim email
     dan menyimpan file ke Drive, tapi tidak bisa membaca inbox atau mencari seluruh Drive.
4. **Ubah status ke In production.**

## Keamanan

- **Token terenkripsi.** Refresh token dan access token disimpan terenkripsi (AES-256-GCM, `SERVER_KEY_SECRET`)
  dan tidak pernah dikirim ke model AI.
- **Akses bisa dicabut.** *Putuskan Google* di menu Koneksi dan perintah **HAPUS** sama-sama mencabut akses di
  Google. Pengguna juga bisa mencabutnya di [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
- **Isi email dan file hanya data.** Model diinstruksikan untuk tidak pernah mengikuti instruksi di dalamnya, dan
  semua aksi keluar tetap butuh tombol konfirmasi.
- **Isi email dan dokumen diproses model AI** yang dipakai pengguna. Untuk DeepSeek, pemrosesan terjadi di RRT.

## Masalah umum

| Gejala | Penyebab |
| --- | --- |
| `redirect_uri_mismatch` | URI di Google Cloud tidak sama persis dengan `<PUBLIC_BASE_URL>/google/callback` |
| "Akses diblokir: aplikasi belum menyelesaikan verifikasi" | email belum ditambahkan sebagai test user |
| Milo bilang Gmail/Drive belum diizinkan | pengguna tidak mencentang semua kotak izin. Ketik **KONEKSI** dan ulangi |
| Link koneksi "belum bisa dibuat" | `PUBLIC_BASE_URL` kosong dan belum ada webhook yang masuk |
| Tiap minggu harus login ulang | normal di mode Testing |
