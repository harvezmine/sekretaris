# Akses server lewat Milo

Pengguna bisa menghubungkan server Linux miliknya ke Milo lewat chat, lalu bertanya misalnya:

- "server toko aman?"
- "disk server toko sisa berapa?"
- "container apa yang mati?"
- "ada error apa di aplikasi saya? foldernya /srv/toko"
- "cek log nginx"
- "tokoku.com bisa dibuka dari server?"

Untuk **membaca**, Milo hanya punya daftar cek tetap: tidak ada perintah bebas. Setiap cek menjalankan
perintah tetap dari daftar di `src/servers/checks.ts`, dan nama container, nama layanan, folder, serta URL
divalidasi dulu. File yang bisa dibaca hanya file log (di bawah `/var/log/` atau berakhiran `.log`, `.out`, atau
`.err`). Token, password, dan API key di keluaran disamarkan sebelum dibaca model.

> Keluaran cek (termasuk potongan log) dikirim ke model AI yang dipakai pengguna itu. Bila pengguna mendapat
> DeepSeek, data itu diproses di server DeepSeek (RRT).

## Mengaktifkan

Di `.env`:

```
SERVER_ACCESS=all                 # off | admin | all — melihat server
SERVER_ACTION_ACCESS=all          # off | admin | all — menjalankan perintah
SERVER_KEY_SECRET=<openssl rand -hex 32>
USER_SERVER_LIMIT=3
SERVER_ADMIN_NUMBERS=6281234567890
```

- `admin`: hanya nomor di `SERVER_ADMIN_NUMBERS` yang mendapat fitur ini.
- `all`: semua pengguna aktif.
- `SERVER_KEY_SECRET` mengenkripsi private key yang Milo buat untuk tiap server (AES-256-GCM). **Jangan diganti**
  setelah dipakai. Kalau diganti, semua server pengguna harus dihapus lalu ditambahkan ulang. Simpan salinannya
  bersama backup database.

## Alur pengguna

1. Pengguna: "tolong hubungkan server saya, sigma@82.25.62.151 port 2222".
2. Milo membuat SSH key khusus untuk pengguna dan server itu, lalu mengirim satu perintah:
   ```
   mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo 'restrict ssh-ed25519 AAAA… milo-21-sigma' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
   ```
3. Pengguna menjalankannya di server itu, sebagai user tersebut, lalu membalas "sudah".
4. Milo menjalankan `overview`. Bila berhasil, sidik jari host key disimpan, dan setelah itu Milo menolak
   terhubung kalau sidik jari berubah.

Aturan pengaman:

- **Tanpa password.** Password tidak pernah dipakai. Kalau pengguna mengirim password, Milo menolak memakainya dan
  menyarankan agar password itu diganti.
- **Opsi `restrict`.** Opsi ini mematikan port forwarding, agent forwarding, dan terminal interaktif untuk key
  tersebut.
- **Hanya alamat publik.** Server pengguna harus beralamat publik. IP privat, localhost, dan nama internal seperti
  `db` atau `dockerproxy` ditolak, dan alamat diperiksa ulang setiap kali terhubung. Tujuannya supaya Milo tidak
  bisa dipakai untuk mengintip jaringan internalnya sendiri.
- **Batas jumlah.** Maksimal `USER_SERVER_LIMIT` server per pengguna.
- **Ikut terhapus.** Saat pengguna mengetik HAPUS, server dan key-nya ikut terhapus.

Cek container (`containers`, `container_logs`, `compose_logs`) hanya jalan bila user SSH bisa memakai Docker
(anggota grup `docker`). Keanggotaan grup itu setara root, jadi sebaiknya hanya untuk server yang memang
dikelola pengguna sendiri. Tanpa grup itu, cek lain tetap jalan.

## Server operator (servers.json)

Nomor di `SERVER_ADMIN_NUMBERS` juga melihat:

- **`server-milo`**, yaitu mesin tempat Milo berjalan. Mesin ini dibaca lewat service `dockerproxy`, yang hanya
  mengizinkan request GET. Cek yang tersedia: `overview`, `disk`, `memory`, `containers`, `container_logs`, dan
  `http`. Di Docker Desktop, angka memori dan disk berasal dari VM Docker. Untuk mematikannya, tulis
  `DOCKER_PROXY_URL=` (kosong).
- **Server di `servers/servers.json`**, yang diatur oleh operator. Contohnya ada di
  `servers/servers.example.json`. Kolom yang dipakai:
  - `key`: path relatif terhadap `servers/`, atau `password_env` berisi nama variabel yang menyimpan password.
  - `host_key` (opsional): sidik jari `SHA256:…`. Ambil di server itu dengan
    `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.
  - `apps` (opsional): lokasi log per aplikasi, supaya Milo langsung tahu harus membaca log di mana:

    ```json
    "apps": [
      { "name": "toko", "description": "toko online", "logs": { "type": "compose", "dir": "/srv/toko", "service": "web" } }
    ]
    ```

    `type` bisa `docker` (`container`), `compose` (`dir`, `service` opsional), `systemd` (`unit`), `file` (`path`),
    atau `pm2` (`name`).

App berjalan sebagai uid 1000 di dalam container. Di Linux, jalankan `sudo chown 1000` pada file key-nya.
Daftar server dibaca saat app start:

```bash
docker compose up -d app
docker compose exec app node dist/cli.js servers
docker compose exec app node dist/cli.js server server-milo overview
docker compose exec app node dist/cli.js app-logs <server>/<app> --errors
```

## Daftar cek

| Cek | SSH | Docker | Isi |
| --- | --- | --- | --- |
| `overview` | ✓ | ✓ | beban, memori, disk, proses teratas, layanan gagal / container bermasalah |
| `disk` | ✓ | ✓ | pemakaian per partisi dan inode / image, volume, build cache |
| `memory` | ✓ | ✓ | memori dan proses/container terbesar |
| `processes` | ✓ | – | proses teratas menurut CPU |
| `containers` | ✓ | ✓ | status container serta CPU/RAM per container |
| `container_logs` | ✓ | ✓ | log satu container |
| `compose_logs` | ✓ | – | log proyek docker compose (folder absolut, service opsional) |
| `services` | ✓ | – | layanan systemd yang gagal dan yang berjalan |
| `service_status` | ✓ | – | status satu layanan, mis. `nginx` |
| `service_logs` | ✓ | – | log satu layanan dari journal |
| `pm2_logs` | ✓ | – | log satu proses pm2 (pm2 harus ada di PATH untuk sesi SSH non-interaktif) |
| `file_logs` | ✓ | – | isi terakhir satu file log |
| `error_logs` | ✓ | – | error sistem 24 jam terakhir |
| `ports` | ✓ | – | port TCP yang terbuka |
| `http` | ✓ | ✓ | status dan waktu respons sebuah URL, diminta dari server itu |

Semua cek log bisa diberi `only_errors`: Milo memindai jendela log 20× lebih panjang dan menyisakan baris yang
terlihat seperti error. Log dibatasi 10–300 baris (default 80), dan tiap keluaran dipotong di 8.000 karakter.

## Menjalankan perintah (deploy, restart)

Selain membaca, Milo bisa menjalankan perintah di server pengguna. Dua aturan memagarinya:

1. **Teks perintahnya selalu ditulis pengguna**, tidak pernah oleh AI. AI hanya bisa memanggil aksi yang sudah
   disimpan, berdasarkan namanya. Ini penting karena Milo membaca email, dokumen, dan balasan orang lain: kalau AI
   boleh mengarang perintah, satu kalimat jahat di dalam email bisa berubah jadi perintah di server. Dengan aturan
   ini, isi email tidak pernah bisa sampai ke langkah konfirmasi sama sekali.
2. **Tidak ada yang berjalan tanpa tombol.** Setiap eksekusi menunggu pengguna menekan *Jalankan*, dan tombol itu
   ditangani pipeline tanpa AI. Konfirmasi berlaku 15 menit.

Perintah yang dikenali (diproses langsung, tanpa AI):

| Ketik | Artinya |
| --- | --- |
| `aksi sigma deploy: cd /home/app && ./deploy.sh` | simpan aksi bernama `deploy` |
| `deploy sigma` (bahasa bebas) | AI memanggil aksi itu → muncul tombol *Jalankan* |
| `jalankan di sigma: docker compose restart app` | sekali pakai, langsung muncul tombol |
| `aksi sigma` · `aksi` | lihat aksi tersimpan |
| `hapus aksi sigma deploy` | hapus aksi |

Batasnya: perintah maksimal 1000 karakter, 20 aksi per server, 20 eksekusi per jam per pengguna, batas waktu 5
menit (maksimal 15). Keluaran disensor dari token/password lalu dipotong 3000 karakter terakhir — bagian akhir yang
disimpan, karena di situlah deploy memberi tahu berhasil atau tidak. Semua eksekusi dicatat di tabel `server_runs`
lengkap dengan perintah, exit code, durasi, dan keluarannya.

## Yang tidak bisa dijangkau

Server pengguna **wajib beralamat publik**. Nama domain di-resolve dulu, semua alamat hasilnya harus publik, dan IP
hasil resolve itu yang dipakai menyambung — jadi jawaban DNS yang berubah setelah pengecekan juga gagal. Alamat
privat (`10.x`, `127.x`, `192.168.x`, `172.16–31.x`, `169.254.x`, `::1`, `fc00::`) ditolak, jadi database Milo dan
jaringan internalnya tidak bisa disentuh lewat fitur ini.

Mesin tempat Milo sendiri berjalan (`server-milo`, lewat Docker socket proxy) **mati secara default**:
`DOCKER_PROXY_URL` kosong dan container `dockerproxy` ada di profil `hostcheck`. Kalaupun dinyalakan operator, ia
hanya bisa dibaca — menjalankan perintah di sana selalu ditolak karena bukan target SSH.
