# Telegram MikroTik Backup Bot

Bot Telegram mandiri yang menghubungkan ke perangkat MikroTik melalui SSH, membuat file cadangan `.backup` dan `.rsc`, lalu mengirimkannya ke chat Telegram setiap hari pukul 18:00 (dapat dikonfigurasi).

## Fitur
- Backup terjadwal (default jam 18:00) menggunakan `node-cron`.
- Format lengkap: binary `.backup` dan skrip konfigurasi `.rsc`.
- Menu tombol inline untuk menjalankan perintah tanpa mengetik manual.
- Perintah Telegram:
  - `/start` – informasi singkat bot.
  - `/menu` – memunculkan tombol utama.
  - `/status` – lihat daftar router, jadwal, dan riwayat backup terbaru.
  - `/backup_now [nama_router]` – jalankan backup manual untuk semua router atau router tertentu.
  - `/add_router` – mulai wizard penambahan router lewat chat.
  - `/remove_router` – pilih router yang ingin dihapus lewat tombol.
  - `/list_routers` – tampilkan daftar router terdaftar.
  - `/test_connection <nama>` – uji koneksi SSH ke MikroTik tertentu.
  - `/cancel` – batalkan wizard/aksi yang sedang berjalan.
- Dukungan whitelist chat ID sehingga hanya admin tertentu yang bisa memakai bot.

## Prasyarat
- Node.js 18+
- Router MikroTik dapat diakses lewat SSH (port 22 default).
- Token bot Telegram dari BotFather.
- Chat ID Telegram untuk menerima file (dapat diperoleh via bot @userinfobot).

## Instalasi
```bash
cd telegram-bot
cp env.example .env   # isi sesuai lingkungan Anda
npm install
npm start
```

## Konfigurasi `.env`
| Variabel | Deskripsi |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Token bot dari BotFather |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Daftar chat ID yang diizinkan, pisahkan dengan koma |
| `TELEGRAM_DEFAULT_CHAT_ID` | Chat ID tujuan backup terjadwal |
| `BACKUP_DIRECTORY` | Folder lokal penyimpanan arsip |
| `BACKUP_CRON_SCHEDULE` | Ekspresi cron (default `0 18 * * *`) |
| `ROUTER_TIMEZONE` | Zona waktu jadwal cron (mis. `Asia/Jakarta`) |

## Menggunakan Menu Tombol
1. Jalankan `/start` atau `/menu` untuk memunculkan tombol utama.
2. Pilih aksi yang diinginkan:
   - **📊 Status Backup** – menampilkan ringkasan jadwal dan riwayat backup.
   - **💾 Backup Semua Router** – menjalankan backup untuk seluruh router terdaftar.
   - **📍 Backup Router Tertentu** – pilih router tertentu, lalu bot mengirimkan file backup-nya.
   - **📋 Daftar Router** – menampilkan seluruh router yang tersimpan.
   - **➕ Tambah Router** – memulai wizard penambahan router (bot akan meminta nama, host, username, password, port).
   - **➖ Hapus Router** – pilih router yang ingin dihapus.
   - **🧪 Test Koneksi Router** – pilih router untuk diuji koneksinya.
3. Jika wizard penambahan sedang berjalan namun ingin dibatalkan, kirim `/cancel`.

### Menambahkan Router via Wizard
1. Tekan tombol **➕ Tambah Router** atau jalankan `/add_router`.
2. Bot akan menanyakan nama → host/IP → username → password → port SSH secara berurutan.
3. Setelah semua data diberikan, router otomatis tersimpan ke `data/routers.json`.
4. Gunakan tombol **📍 Backup Router Tertentu** atau `/backup_now <nama>` untuk mengujinya.

Semua router tersimpan pada berkas `data/routers.json` (diabaikan oleh git). Jangan lupa mengamankan server tempat bot berjalan karena file ini berisi kredensial.

## Struktur Proyek
```
telegram-bot/
├── backups/              # hasil backup lokal (ignored)
├── data/
│   └── routers.json      # dibuat otomatis saat menambah router
├── src/
│   ├── config.js         # baca variabel lingkungan
│   ├── index.js          # entry bot + scheduler + perintah Telegram
│   └── services/
│       ├── mikrotikService.js  # koneksi SSH & pengambilan file
│       └── routerStore.js      # manajemen daftar router
├── env.example
├── package.json
└── README.md
```

## Catatan
- Pastikan akun RouterOS yang dipakai memiliki hak menjalankan `/system backup` dan `/export`.
- File remote tidak dihapus otomatis; jika ingin dikosongkan, tambah perintah `/file remove` setelah unduh.
- Jalankan bot 24/7 pada server/VM agar jadwal berjalan konsisten.
- Simpan cadangan `data/routers.json` secara aman jika memindahkan bot ke mesin lain.

