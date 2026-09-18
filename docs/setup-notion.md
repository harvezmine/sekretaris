# Menghubungkan Notion

Pengguna menghubungkan workspace Notion-nya sendiri lewat WhatsApp: ketik **KONEKSI**, pilih **Notion**, lalu buka
link pribadi yang dikirim Milo. Di layar Notion, pengguna **mencentang halaman dan database** yang boleh diakses.
Itulah seluruh model izinnya: tidak ada daftar scope seperti Google, yang ada hanya daftar halaman.

Milo tidak pernah melihat password, dan akses bisa dicabut kapan saja dari **Connections** di Notion atau dari
menu KONEKSI di WhatsApp.

## Yang bisa dilakukan

| Permintaan pengguna | Yang terjadi |
| --- | --- |
| _simpan notulen rapat tadi di Notion_ | halaman baru berisi judul, poin, dan kotak centang |
| _tambahkan ke catatan rapat kemarin: vendor minta DP 30%_ | baris ditambahkan di akhir halaman itu |
| _apa isi SOP penagihan?_ | isi halaman dibacakan di chat |
| _tambah tugas: kirim penawaran ke PT Karya, tenggat Jumat_ | satu baris masuk ke database Tugas |
| _tugas saya yang belum selesai apa?_ | baris database dibacakan dan diringkas |
| _tandai tugas kirim penawaran selesai_ | kolom Status baris itu diubah |

Angka boleh ditulis sewajarnya: `Rp 4.200.000`, `4,2 juta`, `500rb`, dan `1,5jt` semuanya masuk sebagai angka,
bukan teks.

## Dua batas yang perlu diketahui pengguna

**Milo hanya melihat yang dicentang.** Workspace yang tersambung tanpa satu pun halaman dicentang akan terasa
rusak padahal sebenarnya kosong. Halaman koneksi sudah mengatakan ini sebelum pengguna meninggalkan halamannya.

**Pencarian Notion membaca judul, bukan isi halaman.** Jadi "cari catatan soal vendor" hanya menemukan halaman
yang judulnya menyebut vendor. Milo mengatakan ini apa adanya, bukan berpura-pura sudah membaca seluruh
workspace.

## Pembagian tugas dengan Google

Google tetap tujuan bawaan untuk notulen dan catatan angka. Notion dipakai kalau pengguna menyebutnya
("simpan di Notion"), atau kalau Google tidak terhubung sementara Notion terhubung. Tidak pernah keduanya
sekaligus untuk hal yang sama.

## 1. Buat integration di Notion

1. Buka [notion.so/my-integrations](https://www.notion.so/my-integrations) → **New integration**.
2. **Type:** Public. Isi nama, ikon, dan alamat situs.
3. **Redirect URI:** `https://app.secretary.my.id/notion/callback`. Harus sama persis.
4. Salin **OAuth client ID** dan **OAuth client secret**.

Tidak ada proses peninjauan seperti Google, jadi integration langsung bisa dipakai.

## 2. Isi `.env` lalu jalankan ulang

```
NOTION_CLIENT_ID=...
NOTION_CLIENT_SECRET=...
```

Keduanya kosong = fitur Notion mati total: tool-nya tidak ditawarkan ke AI dan barisnya tidak muncul di menu
KONEKSI. Token workspace disimpan terenkripsi memakai `SERVER_KEY_SECRET`, sama seperti kunci server.

## Catatan teknis

- Versi API yang dipakai `2026-03-11`, dikirim di setiap permintaan.
- Sejak versi 2025-09-03, database adalah wadah yang berisi satu atau lebih *data source*, dan baris tinggal di
  data source. Milo menelusuri database ke data source-nya dulu sebelum membaca atau menulis baris, dan tetap
  bekerja untuk workspace lama yang belum punya lapisan itu.
- Ukuran halaman hasil selalu disebut eksplisit, karena Notion menurunkan nilai bawaannya dari 100 ke 50 pada
  Februari 2026.
- Notion membatasi sekitar tiga permintaan per detik. Satu giliran chat tidak pernah mendekati itu.

## Masalah umum

| Gejala | Periksa |
| --- | --- |
| "Notion belum terhubung" padahal sudah | Token dicabut dari Connections di Notion, atau `SERVER_KEY_SECRET` berubah sehingga token lama tidak bisa dibuka. Hubungkan ulang lewat KONEKSI. |
| Milo bilang halaman tidak ditemukan | Halaman itu belum dicentang saat menghubungkan. Buka halamannya di Notion → menu titik tiga → Connections → tambahkan. |
| Kolom tidak terisi saat menambah baris | Nama kolom harus sama dengan yang ada di database. Jawaban tool menyebutkan kolom apa saja yang tersedia. |
| Halaman baru masuk ke tempat yang tidak diduga | Tanpa induk yang disebut, halaman difilekan di bawah halaman yang paling baru diubah. Sebut induknya: _simpan di bawah halaman Proyek_. |
