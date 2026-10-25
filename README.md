# Sistem Presensi Sekolah — Face Recognition + GPS

> **Dokumen ini adalah briefing untuk AI dan developer manusia.**
> Jika kamu adalah AI (Gemini, Claude, atau lainnya) yang diminta mengubah kode
> di repo ini: **baca dokumen ini dan `README.md` di folder yang kamu ubah
> sampai habis SEBELUM menulis satu baris kode pun.** Bagian
> [ATURAN KERAS](#aturan-keras-tidak-boleh-dilanggar) mengikat dan tidak
> bisa dikompromikan demi sekadar membuat kode berjalan.

---

## 1. Konsep yang ingin dicapai

Sistem absensi siswa untuk sekolah. Setiap pagi dan sore, siswa memindai
wajahnya sendiri di gerbang sekolah, lalu sistem mencatat kehadiran **hanya
jika semua ini benar sekaligus**:

| Syarat | Kenapa ada |
|---|---|
| Wajahnya terdaftar | Absen harus milik orang yang benar |
| Sedang **masih hidup** (liveness) | Cegah absen pakai foto HP atau video |
| Berada **di dalam radius sekolah** | Cegah absen dari rumah |
| **Dalam jam absen** | Cegah absen kapan saja |
| **Belum absen hari ini** untuk tipe itu | Cegah absen dobel |

Tiga hal yang jadi>**tidak bisa ditawar** dan membentuk seluruh arsitektur:

1. **Server yang memutuskan, bukan HP.** Semua angka yang dikirim browser
   (descriptor wajah, koordinat GPS, skor liveness) diperlakukan sebagai klaim
   yang harus dihitung ulang di server. Hasil di layar HP cuma untuk tampilan.
2. **Foto wajah tidak pernah disimpan.** Yang disimpan hanya descriptor
   128 float (512 byte) — angka, bukan gambar. Lihat
   [alasan teknis](#kenapa-foto-wajah-tidak-disimpan).
3. **Bukti jejak audit.** Setiap kegagalan dan setiap pencatatan presensi
   masuk tabel `audit_log` dengan alasan yang bisa dibaca.

---

## 2. Cara kerja (alur nyata)

```
Siswa buka /siswa/scan-absen.php
  │
  ├─ bukaKamera()  +  loadModels()      ← jalan BERIRINGAN, bukan berurutan
  │     (getUserMedia + unduh model ~6MB sekaligus)
  │
  ├─ POST /api/v1/attendance/scan-nonce.php
  │     server memilih acak 2 challenge dari 6, terbitkan token sekali pakai
  │
  ├─ liveness: kedip mata (wajib) + 2 challenge acak
  │     client kirim daftar challenge yang DIBENARKAN server
  │
  ├─ scan-engine: descriptor 128 float + koordinat GPS dikirim
  │
  └─ POST /api/v1/attendance/scan-check.php
        1. metode + Content-Type
        2. sesi siswa
        3. rate limit scan        (3 percobaan gagal lalu terkunci)
        4. token anti-replay      (sekali pakai, TTL 120 dtk)
        5. validasi bentuk descriptor
        6. Cocokkan wajah  ← OTORITATIF
        7. Verifikasi lokasi ← OTORITATIF
        8. jadwal absen
        9. anti duplikat
       10. tulis attendance + audit_log
```

Langkah 6 dan 7 diulang di server dengan rumus yang sama persis dengan
yang dipakai browser. Keduanya harus selalusinkron — kalau tidak, ambang
0,55 berlaku di satu tempat saja dan sistem bocor.

---

## 3. Aturan keras (tidak boleh dilanggar)

Baris ini tidak bisa ditawar. Mengubah salah satunya berarti membatalkan
alasan seluruh sistem.

### 3.1 Server harus tetap otoritatif
- **Dilarang** menerima keputusan final dari nilai yang dikirim klien tanpa
  dihitung ulang. `descriptor`, `gps`, `liveness` = klaim, bukan fakta.
- Pencocokan wajah **wajib** mengiterasi galeri di server
  (`face_templates` dengan `is_centroid = 1`), bukan menerima
  `userId` dari klien.
- Lokasi **wajib** dihitung ulang dengan `verify_location()`.

### 3.2 Jangan simpan foto wajah
- **Tidak boleh** ada kode yang menulis PNG/JPEG hasil kamera ke `uploads/`
  atau ke mana pun. Descriptor sudah cukup untuk pencocokan.
- `uploads/` ada hanya sebagai pagar (`ref-faces/`, `temp-captures/` masih
  ada tapi **tidak dipakai**). Jangan hapus `uploads/.htaccess`.

### 3.3 Rumus pencocokan harus identik di PHP dan JS
- Metrik adalah **jarak EUCLID** (`sqrt(sum((a-b)^2))`), **bukan** cosine.
  Cosine salah dan diam-diam menggeser ambang batas.
- `face_distance()` di `config/helper.php` dan `distanceToRow()` /
  `match()` di `assets/js/scan-engine.js` harus selalu mengimplementasikan
  rumus yang sama.
- Keyakinan = `1 - (jarak / ambang)`, dibulatkan 4 desimal.
- Panjang descriptor tetap **128**. Yang mengubahnya harus mengubah
  `FACE_DESCRIPTOR_SIZE` **dan** galeri (yang harus diDaftar ulang dari nol).

### 3.4 Ambang tidak boleh dinaikkan asal
- `FACE_MATCH_THRESHOLD` (0.55) = jarak Euclid maksimum, tidak boleh diubah
  tanpa mengukur ulang jarak pada sampel wajah **asli**.
- `FACE_MIN_CONFIDENCE` (0.20) mencegah orang yang sangat mirip lolos dengan keyakinan
  rendah. **Naikkan** `FACE_MIN_CONFIDENCE` → jarak efektif mengecil →
  hampir semua siswa ditolak. Turunkan sedikit kalau hanya ingin sedikit
  longgar, jangan naikkan.
- `FACE_MATCH_STRICT` (0.45) juga dipakai sebagai `FACE_ENROLL_MAX_SPREAD`.
  Ada **satu** angka penentu "seberapa mirip dua capture dianggap orang
  yang sama" — jangan duplikasi angka ini di tempat lain.

### 3.5 Anti-replay
- Setiap scan memakai token sekali pakai dari `scan-nonce.php`,
  TTL `SCAN_NONCE_TTL` (120 detik), ditandatangani `API_FINGERPRINT_KEY`.
- Token **wajib** consume saat dipakai, walau validasi selanjutnya gagal.
- Endpoint nonce dibatasi `NONCE_MAX_PER_WINDOW` (10/60 dtk) supaya satu
  akun tidak meminta token tanpa henti.

### 3.6 Liveness
- Daftar challenge yang sah ada **hanya** di
  `LIVENESS_CHALLENGES` (`config/app-config.php`) **dan** harus cocok dengan
  `Liveness.runChallenge()` di `assets/js/liveness-detection.js`.
- Server **memilih acak**, klien tidak boleh menentukan sendiri.
- Klien **wajib** menyertakan daftar challenge yang dikirim server pada
  `liveness.challenges`; server menolak challenge tak dikenal
  (`LIVENESS_FAKE`).
- `blink` **bukan** challenge acak — itu tahap pasif selalu jalan sebelum
  challenge. Jangan taruh di `LIVENESS_CHALLENGES`.
- Catatan jujur: verifikasi liveness saat ini hanya berjalan di sisi klien,
  jadi ini kenaikan modalitas, bukan jaminan. Pengaman sesungguhnya ada
  pada pencocokan server + lokasi + jadwal.

### 3.7 Cakupan akses (role)
| Peran | Boleh |
|---|---|
| `siswa` | scan, daftar wajah (dengan syarat), lihat miliknya |
| `guru` | dashboard admin |
| `admin` | semua, termasuk uji akurasi |

- `admin/uji-akurasi.php` **wajib** dibatasi `admin`. Ia adalah alat
  diagnosa, bukan untuk siswa.
- `get-descriptors.php` dengan `scope=all` **hanya** untuk admin; siswa
  hanya boleh `scope=self` (HP 403).
- **Jangan** sediakan halaman daftar akun publik. Akun dibuat admin.

### 3.8 Privasi
- Halaman uji akurasi **tidak boleh** menyentuh endpoint presensi dan
  **tidak boleh** menyimpan foto. Hanya ukur descriptor di memori.
- Koordinat GPS **jangan** pernah ditulis ke HTML halaman scan
  (cegah kebocoran lewat DOM).

---

## 4. Kenapa foto wajah tidak disimpan

Foto wajah adalah data pribadi paling sensitif, dan **tidak pernah dibutuhkan**
untuk pencocokan. Yang dibutuhkan hanya descriptor 128 float.

Kalau suatu saat kamu merasa "kita perlu simpan foto", **berhenti dan
tanyakan ulang** — kemungkinan besar yang sebenarnya dibutuhkan adalah
thumbnail untuk UI, dan itu bisa dari kamera saat itu juga, bukan disimpan.

---

## 5. Struktur folder

```
laragon/www/                    ← document root Apache
├── index.php                   entry point → login
├── .htaccess                   security headers, blokir config/, dsb
├── database.sql                skema MySQL (referensi; aktif pakai SQLite)
├── install.php
│
├── config/                     ⚙️  backend & aturan main
│   ├── app-config.php          KONSTANTA semua ambang & jadwal
│   ├── database.php            koneksi PDO (SQLite/MySQL), db_now/db_now_sql
│   └── helper.php              face_distance, verify_location, nonce, throttle, audit
│
├── auth/                       🔐  sesi, login, logout, CSRF
│   ├── session.php             start_session, current_user, require_login, csrf_*
│   ├── login.php
│   └── logout.php
│
├── api/v1/                     🔌  endpoint JSON (authoritative)
│   ├── attendance/
│   │   ├── scan-nonce.php      terbitkan token + challenge acak
│   │   └── scan-check.php      SATU-SATUNYA tempat memutuskan hadir
│   └── student/
│       ├── get-descriptors.php  galeri (scope dibatasi peran)
│       └── register-face.php    daftar wajah (pakai sample + centroid)
│
├── assets/
│   ├── js/
│   │   ├── scan-engine.js      muat model, deteksi, kumpulkan descriptor, match
│   │   ├── liveness-detection.js kedip + challenge dari server
│   │   ├── gps-verifier.js     haversine, plausibilitas, anti-fake
│   │   ├── app.js              alur UI scan siswa
│   │   ├── uji-akurasi.js      alur UI uji admin
│   │   └── uji-akurasi-math.js statistik + saran ambang
│   └── css/                    app, kamera, uji akurasi
│
├── admin/                      🛠️  dashboard admin/guru + uji akurasi
├── siswa/                      🎒  scan absen siswa
├── database/                   💾 presensi.sqlite (file .sqlite)
├── uploads/                    🚫 pagar, tidak dipakai
└── vendor/
```

---

## 6. Konfigurasi kunci (`config/app-config.php`)

Semua angka yang bisa diubah liegen di satu file. **Nilai default saat ini
adalah untuk_skema, bukan data produksi** — ganti sebelum dipakai sungguhan.

| Konstanta | Nilai | Arti |
|---|---|---|
| `FACE_MATCH_THRESHOLD` | `0.55` | jarak Euclid maksimum |
| `FACE_MATCH_STRICT` | `0.45` | verifikasi 1:1 saat pendaftaran |
| `FACE_MIN_CONFIDENCE` | `0.20` | lantai keyakinan |
| `FACE_ENROLL_MAX_SPREAD` | = STRICT | sebaran antar-sampel saat daftar |
| `FACE_SAMPLE_COUNT` / `..._MAX_SAMPLES` | `5` | sampel per pendaftaran |
| `FACE_DESCRIPTOR_SIZE` | `128` | dimensi descriptor |
| `LIVENESS_REQUIRED` | `2` | challenge yang harus dipenuhi |
| `JAM_MASUK` | `06:30`–`08:00` | window absen pagi |
| `JAM_PULANG` | `14:30`–`17:00` | window absen siang |
| `TOLERANSI_TELAT_MENIT` | `15` | lewat ini ditandai `is_late` |
| `SEKOLAH_RADIUS_M` | `100` | radius absen (dari tabel `lokasi_sekolah`) |
| `GPS_MAX_ACCURACY_M` | `50` | akurasi GPS maksimum |
| `MAX_SCAN_ATTEMPTS` | `3` | gagal scan sebelum terkunci |
| `SCAN_NONCE_TTL` | `120` | masa pakai token scan |
| `TIMEZONE` | `Asia/Jakarta` | zona waktu aplikasi |

> **Peringatan timezone:** `db_now()` (nilai PHP) dan `db_now_sql()`
> (ekspresi SQL) **harus menghasilkan waktu yang sama**. `datetime('now')`
> di SQLite itu **UTC**, sedangkan aplikasi memakai `Asia/Jakarta`.
> Karena itu `db_now_sql()` menambahkan offset `date('P')`. Kalau kamu
> "", ubah `db_now_sql()` sehingga tetap konsisten.

> **`API_FINGERPRINT_KEY` masih placeholder.** Untuk produksi:
> `bin2hex(random_bytes(32))`.

---

## 7. Skema database (SQLite aktif)

`database/presensi.sqlite`. Referensi MySQL ada di `database.sql`.

| Tabel | Isi | Catatan |
|---|---|---|
| `users` | akun | `role`, `login_attempts`, `locked_until`, `last_login` |
| `kelas` | kelas | `wali_kelas` → `users.id` |
| `lokasi_sekolah` | titik & radius GPS | `is_active=1` dipakai |
| `face_templates` | descriptor wajah | `is_centroid=1` yang dicocokkan; BLOB 512 byte |
| `attendance` | catatan presensi | 20 kolom termasuk `face_distance`, `gps_verdict` |
| `scan_nonces` | token sekali pakai | anti-replay |
| `audit_log` | jejak audit | `event_type`, `severity` |
| `device_log` | sidik jari perangkat | untuk deteksi penyimpangan |
| `pengaturan` | key-value | konfigurasi runtime |

---

## 8. Kebutuhan & menjalankan

| Komponen | Versi | Catatan |
|---|---|---|
| PHP | 8.3 | ext: `pdo_sqlite` (atau `pdo_mysql`), `json`, `mbstring`, `gd` |
| Server | Apache 2.4 | `mod_rewrite`, `mod_headers`, `mod_expires` |
| DB | SQLite | file di `database/presensi.sqlite` |

### Kamera butuh HTTPS
`getUserMedia` (kamera) dan `navigator.geolocation` (GPS) **tidak jalan di
HTTP biasa**. Untuk mencoba dari HP:
- pakai **ngrok** (`ngrok http 80`) → HTTPS otomatis, atau
- Chrome Android `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.

### Model dari CDN
face-api.js dan bobot model diambil dari jsDelivr
(`@vladmandic/face-api@1.7.15`). Yang dikirim ke CDN hanya library dan
model — **foto dan descriptor wajah tidak pernah ke sana**; deteksi jalan
di browser.

---

## 9. Cara menguji perubahan

Skrip uji ada di `C:\Users\Advan\AppData\Local\Temp\presensi-test\`.

```powershell
# suite penuh
& "$env:TEMP\presensi-test\all.ps1"
```

Yang diuji: descriptor validation, negatif/anti-replay/rate-limit,
liveness, batas penerbitan nonce, alur sukses, mesin scan, matematika uji
akurasi, halaman scan, endpoint descriptor + daftar wajah.

---

## 10. Kalau kamu AI dan diminta mengubah apa pun

1. Baca `README.md` ini sampai habis.
2. Baca `README.md` di folder yang akan kamu ubah.
3. **Jangan** mengubah `config/app-config.php` kecuali diminta.
4. Kalau kamu menambah endpoint atau halaman baru, ikuti pola yang sudah
   ada: `declare(strict_types=1)`, `require_once` dari `session.php`/
   `database.php`, validasi peran **sebelum** logika bisnis, prepared
   statement, dan `audit_log()` untuk kejadian penting.
5. Setelah mengubah, jalankan suite uji di atas dan pastikan tetap hijau.
6. Kalau kamu tidak yakin sebuah angka, **jangan** mengarang angka baru —
   baca lagi konstanta yang relevan dan tulis alasannya.

---

## 11. Yang **tidak** ada (jangan cari-cari)

Dulu README versi lama menyebut file-file ini. **Tidak pernah ada di
build sekarang** — jangan buat, jangan rujuk:

`register.php` (publik) · `admin/kelola-siswa.php` ·
`admin/register-wajah-siswa.php` · `admin/kelola-kelas.php` ·
`admin/rekap-absensi.php` · `admin/pengaturan-lokasi.php` ·
`admin/log-audit.php` · `siswa/riwayat.php` · `api/v1/auth/login.php` ·
`api/v1/attendance/history.php` · `api/v1/export/*` ·
`templates/header.php` · `assets/models/*` (lokal) ·
foto di `uploads/` · konstanta `JWT_SECRET` · `MODEL_PATH` ·
`FINGERPRINT_PATH`.

Also, nama database: **SQLite**, bukan MySQL. Dan metrik pencocokan:
**Euclid**, bukan cosine.
