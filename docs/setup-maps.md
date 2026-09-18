# Tempat & navigasi (Google Maps)

Dengan ini Milo bisa menjawab:

- "carikan restoran enak yang terdekat" (setelah pengguna membagikan lokasinya)
- "SPBU terdekat yang buka sekarang"
- "kopi enak di Kemang, rating di atas 4,5"
- "saya mau ke Mall Kelapa Gading, arahkan saya" → Milo balas link navigasi Google Maps

Berbeda dengan Kalender, Gmail, dan Drive, ini **bukan data pengguna**: tidak ada scope baru, tidak ada consent
screen, dan tidak menambah beban verifikasi Google.

## Dua sumber data

| | OpenStreetMap (default) | Google Places |
| --- | --- | --- |
| Biaya | **gratis**, tanpa API key | ditagih per pencarian |
| Nama, alamat, jarak | ✅ | ✅ |
| Rating & jumlah ulasan | ❌ tidak ada di OSM | ✅ |
| Buka/tutup sekarang | ❌ | ✅ |
| Kisaran harga | ❌ | ✅ |
| Cocok untuk | "SPBU terdekat", "ATM terdekat", "apotek terdekat" | "restoran yang enak" |

Milo memakai OpenStreetMap kalau `GOOGLE_MAPS_API_KEY` kosong, dan otomatis pindah ke Google begitu key-nya diisi.
Paksa salah satu dengan `PLACES_PROVIDER=osm` atau `=google`; `=off` mematikan pencarian tempat.

Untuk "yang terdekat" OSM sudah cukup — yang Anda mau memang yang paling dekat, bukan yang paling bagus.

Untuk **"yang enak"**, Milo menggabungkan dua tool yang sudah ada:

1. `web_search` mencari rekomendasi di daerah itu ("restoran enak Kemang"), lalu `web_read` membuka satu-dua
   halaman yang layak dibaca dan mengambil nama-nama yang benar-benar dipuji.
2. Tiap nama itu dicek lagi lewat `place_search` dengan `name_lookup`, supaya dapat alamat, jarak, dan link peta
   yang benar. Nama yang tidak ketemu di peta **tidak** disebut sebagai rekomendasi.

Jadi penilaiannya datang dari tulisan orang, dan alamat serta jaraknya datang dari peta. Milo juga menyebut dari
situs mana rekomendasi itu berasal. Batasnya jujur saja: kualitasnya seikut kualitas artikel yang ditemukan —
listicle SEO dan endorse berbayar banyak, dan SearXNG bisa kena batas dari mesin pencari kalau dipakai terlalu
sering. Untuk penilaian yang konsisten, Google Places tetap lebih baik.

**Link navigasi selalu gratis**, apa pun sumbernya: itu URL Google Maps biasa, bukan panggilan API. Jadi "arahkan
saya ke Mall Kelapa Gading" jalan tanpa API key sama sekali.

## Batas pemakaian OpenStreetMap

Overpass dan Nominatim adalah infrastruktur sumbangan dengan aturan pakai. Milo mematuhinya: satu permintaan pada
satu waktu, jeda minimal satu detik, dan User-Agent yang jujur. Kalau nanti pemakaiannya ramai, pasang sendiri
Overpass untuk wilayah Indonesia dan arahkan `OVERPASS_URL` ke sana — persis seperti SearXNG.

```
PLACES_PROVIDER=auto
OVERPASS_URL=https://overpass-api.de/api/interpreter
NOMINATIM_URL=https://nominatim.openstreetmap.org/search
```

## Mengaktifkan Google Places (opsional)

1. Google Cloud Console → **APIs & Services → Library** → aktifkan **Places API (New)**.
2. **Credentials → Create credentials → API key.**
3. Klik kunci itu → **API restrictions** → pilih *Restrict key* → centang **Places API (New)** saja.
   Jangan pakai kunci yang sama dengan kunci Maps di aplikasi web/mobile, dan jangan taruh di kode klien.
4. Isi `.env` di server, lalu `docker compose up -d app`:

```
GOOGLE_MAPS_API_KEY=AIza...
PLACE_SEARCHES_PER_DAY=30
```

Kosongkan `GOOGLE_MAPS_API_KEY` untuk kembali ke OpenStreetMap yang gratis.

## Biaya (hanya kalau memakai Google)

Places API ditagih per pencarian, dengan kuota gratis bulanan dari Google. Satu pertanyaan pengguna = satu
pencarian; `place_directions` juga memakai satu pencarian untuk memastikan tempat tujuannya benar. Link navigasi
yang dikirim ke pengguna **gratis** — itu URL Google Maps biasa, bukan panggilan API.

`PLACE_SEARCHES_PER_DAY` membatasi per pengguna per hari (default 30). Pemakaian tercatat di `usage_ledger`
dengan `kind = 'places'`:

```sql
select date(created_at), count(*) from usage_ledger where kind = 'places' group by 1 order by 1 desc;
```

Cek tagihan sesungguhnya di Google Cloud → Billing, dan pasang budget alert.

## Lokasi pengguna

"Terdekat" butuh titik. Ada empat cara titik itu sampai, dan semuanya disimpan sebagai titik terakhir di profil
pengguna (`profile.lastPlace`), supaya pertanyaan berikutnya tidak perlu kirim ulang:

1. **Share lokasi di WhatsApp** (📎 lalu *Lokasi*). Fonnte meneruskannya di field `location` ("lat,long"), bersama
   teks pengganti `non-text message`. Milo membaca `location` lebih dulu, jadi pesan ini tidak lagi dianggap file
   yang hilang.
2. **Tempel link Google Maps**: tombol *Bagikan* di Maps menghasilkan `maps.app.goo.gl/...`. Milo mengikuti link
   pendek itu (hanya lewat host Google) dan membaca titik pin-nya. Koordinat yang diketik saja
   (`-6.2607, 106.8134`) juga dikenali.
3. **Ketik LOKASI**: Milo mengirim link pribadi `/l/<token>` (berlaku 30 menit). Halamannya meminta izin GPS
   browser HP, lalu titiknya masuk seperti lokasi yang dibagikan. Cara ini tidak bergantung pada apa yang
   diteruskan Fonnte, jadi tetap jalan kalau cara 1 gagal. Butuh `PUBLIC_BASE_URL` atau webhook yang sudah pernah
   masuk (untuk tahu alamat publiknya).
4. **Sebut tempatnya**: "saya lagi di Grand Indonesia". Model memanggil `location_set`, yang mencari titiknya di
   OpenStreetMap. Butuh pencarian tempat aktif (`PLACES_PROVIDER` bukan `off`).

Aturan penyimpanan:

- Tersimpan satu titik saja, bukan riwayat.
- Lokasi yang lebih tua dari 7 hari tidak dipakai untuk "terdekat"; Milo minta yang baru.
- Link navigasi memakai titik tersimpan sebagai titik awal hanya kalau dikirim dalam satu jam terakhir. Selebihnya
  Google Maps mulai dari posisi HP saat link dibuka.
- Ikut terhapus saat pengguna mengetik **HAPUS**, karena disimpan di baris pengguna itu sendiri.

### Kalau share lokasi di WhatsApp tetap tidak terbaca

Setiap pesan Fonnte yang tidak bisa dibaca dicatat bersama *nama* field yang dikirim (tanpa isinya):

```sh
docker compose logs app | grep "tidak terbaca"
```

Kalau `location` tidak ada di daftar itu, Fonnte memang tidak meneruskan lokasinya (misalnya *live location*).
Pakai cara 2, 3, atau 4; pengguna yang mengirimnya juga otomatis diberi tahu soal **LOKASI**.
