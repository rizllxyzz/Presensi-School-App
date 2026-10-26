<?php
/**
 * seed_absensi.php
 * ---------------------------------------------------------------------------
 * Pengisi data absensi demo untuk SEMUA siswa aktif.
 *
 * Tujuan: setelah dijalankan, setiap siswa punya catatan presensi (masuk dan
 * pulang) untuk seluruh hari sekolah dalam rentang tanggal yang dipilih,
 * sehingga dashboard, rekap harian, dan riwayat bulanan langsung terisi.
 *
 * SIFAT SKRIP
 *   - Hanya MENAMBAH baris yang belum ada. Data lama tidak dihapus/diubah.
 *   - Aman dijalankan berulang kali (idempoten) karena memakai INSERT IGNORE
 *     / INSERT OR IGNORE pada kunci unik (user_id, tanggal, scan_type).
 *   - Sabtu dan Minggu dilewati secara bawaan. Pakai --include-weekends bila
 *     memang ingin mengisi semua tanggal kalender.
 *   - Nilai waktu, GPS, dan wajah dibuat deterministik dari tanggal + user,
 *     jadi hasilnya stabil dan tidak acak setiap kali dijalankan.
 *
 * CARA PAKAI (CLI)
 *   php seed_absensi.php
 *   php seed_absensi.php --month=2026-09
 *   php seed_absensi.php --from=2026-09-01 --to=2026-10-26
 *   php seed_absensi.php --from=2026-09-01 --to=2026-10-26 --dry-run
 *
 * CARA PAKAI (BROWSER)
 *   Login sebagai admin, lalu buka /seed_absensi.php
 *
 * Rentang bawaan: tanggal 1 bulan lalu sampai hari ini.
 * ---------------------------------------------------------------------------
 */

declare(strict_types=1);

require_once __DIR__ . '/config/app-config.php';
require_once __DIR__ . '/config/database.php';
require_once __DIR__ . '/config/helper.php';

$isCli = (PHP_SAPI === 'cli');

if (!$isCli) {
    require_once __DIR__ . '/auth/session.php';
    require_login('admin');
}

/* ==================================================================
 |  BANTUAN
 * ================================================================== */

function seed_valid_date(string $value): bool
{
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $value)) {
        return false;
    }
    $d = DateTimeImmutable::createFromFormat('!Y-m-d', $value);
    return $d instanceof DateTimeImmutable && $d->format('Y-m-d') === $value;
}

/** Angka 0..1 yang stabil untuk sebuah kunci. */
function seed_frac(string $key): float
{
    $hex = substr(hash('sha256', $key), 0, 8);
    return hexdec($hex) / 4294967295;
}

/** Titik pusat sekolah yang sedang aktif. */
function seed_titik_sekolah(): array
{
    $row = db_one(
        'SELECT lat, lng, radius_m FROM lokasi_sekolah
          WHERE is_active = 1
       ORDER BY id ASC LIMIT 1',
        [],
        null
    );

    if ($row !== null && is_numeric($row['lat']) && is_numeric($row['lng'])) {
        return [
            'lat'      => (float) $row['lat'],
            'lng'      => (float) $row['lng'],
            'radius_m' => (int) ($row['radius_m'] ?? SEKOLAH_RADIUS_M),
        ];
    }

    return [
        'lat'      => (float) SEKOLAH_LAT,
        'lng'      => (float) SEKOLAH_LNG,
        'radius_m' => (int) SEKOLAH_RADIUS_M,
    ];
}

function seed_semua_siswa(): array
{
    return db_all(
        "SELECT id, nama_lengkap, username
           FROM users
          WHERE role = 'siswa' AND is_active = 1
       ORDER BY id ASC"
    );
}

/**
 * Waktu scan untuk satu siswa pada satu tanggal.
 *
 * Mengembalikan null bila waktunya belum terjadi (khusus hari ini), supaya
 * skrip tidak membuat presensi di masa depan.
 */
function seed_waktu_scan(
    string $tanggal,
    string $tipe,
    int $userId,
    string $hariIni,
    DateTimeImmutable $sekarang
): ?string {
    $pecahan = seed_frac($tanggal . '|' . $userId . '|' . $tipe . '|jam');

    if ($tipe === 'masuk') {
        $menit = (6 * 60) + 35 + (int) floor($pecahan * 50); // 06:35 - 07:24
    } else {
        $menit = (14 * 60) + (int) floor($pecahan * 90);     // 14:00 - 15:29
    }

    if ($tanggal === $hariIni) {
        $sekarangMenit = ((int) $sekarang->format('H') * 60) + (int) $sekarang->format('i');
        $batas = $sekarangMenit - 3;

        if ($menit > $batas) {
            if ($tipe === 'masuk') {
                return null;
            }
            /* Hari ini jam pulang belum sampai. Rapatkan ke jam pulang yang
             * masih mungkin terjadi, atau lewati bila belum lewat tengah hari. */
            $awalPulang = (12 * 60) + 5;
            if ($batas < $awalPulang) {
                return null;
            }
            $menit = $awalPulang + (int) floor($pecahan * max(1, $batas - $awalPulang));
        }
    }

    $detik = (int) floor(seed_frac($tanggal . '|' . $userId . '|' . $tipe . '|detik') * 60);

    return sprintf(
        '%s %02d:%02d:%02d',
        $tanggal,
        intdiv($menit, 60),
        $menit % 60,
        $detik
    );
}

/**
 * Isi attendance untuk rentang tanggal.
 *
 * @return array<string,mixed>
 */
function seed_absensi_rentang(
    string $dari,
    string $sampai,
    bool $dryRun = false,
    bool $includeWeekends = false
): array {
    $siswa = seed_semua_siswa();
    if ($siswa === []) {
        throw new RuntimeException('Tidak ada siswa aktif. Tambahkan siswa terlebih dahulu.');
    }

    $hasil = [
        'dari'       => $dari,
        'sampai'     => $sampai,
        'siswa'      => count($siswa),
        'hari'       => 0,
        'dilewati'   => 0,
        'baru'       => 0,
        'sudah_ada'  => 0,
        'dry_run'    => $dryRun,
    ];

    $titik = seed_titik_sekolah();
    $tz    = new DateTimeZone(TIMEZONE);
    $now   = new DateTimeImmutable('now', $tz);
    $hariIni = $now->format('Y-m-d');

    /* INSERT yang tidak error saat baris sudah ada. */
    $driver = db_driver();
    if ($driver === 'sqlite') {
        $awalan  = 'INSERT OR IGNORE';
        $akhiran = '';
    } elseif ($driver === 'pgsql') {
        $awalan  = 'INSERT';
        $akhiran = ' ON CONFLICT (user_id, tanggal, scan_type) DO NOTHING';
    } else {
        $awalan  = 'INSERT IGNORE';
        $akhiran = '';
    }

    $sql = $awalan . ' INTO attendance
        (user_id, tanggal, scan_type, waktu, status,
         lat, lng, accuracy_m, distance_m, gps_verdict, gps_score,
         is_late, late_minutes, face_distance, face_confidence,
         liveness_codes, device_fingerprint, ip_address, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)' . $akhiran;

    $stmt = $dryRun ? null : db()->prepare($sql);

    $kursor = new DateTimeImmutable($dari . ' 00:00:00', $tz);
    $akhir  = new DateTimeImmutable($sampai . ' 00:00:00', $tz);

    while ($kursor <= $akhir) {
        $tanggal = $kursor->format('Y-m-d');
        $hariKe  = (int) $kursor->format('N');

        if (!$includeWeekends && $hariKe > 5) {
            $hasil['dilewati']++;
            $kursor = $kursor->modify('+1 day');
            continue;
        }

        $hasil['hari']++;

        foreach ($siswa as $s) {
            $uid = (int) $s['id'];

            foreach (['masuk', 'pulang'] as $tipe) {
                $waktu = seed_waktu_scan($tanggal, $tipe, $uid, $hariIni, $now);
                if ($waktu === null) {
                    $hasil['dilewati']++;
                    continue;
                }

                /* Sebar posisi 5-60 meter dari titik sekolah. */
                $jarak   = 5.0 + (seed_frac($tanggal . '|' . $uid . '|jarak') * 55.0);
                $arah    = seed_frac($tanggal . '|' . $uid . '|arah') * 2 * M_PI;
                $dLat    = ($jarak * cos($arah)) / 111320.0;
                $dLng    = ($jarak * sin($arah))
                         / (111320.0 * max(0.000001, cos(deg2rad($titik['lat']))));

                $lat      = round($titik['lat'] + $dLat, 7);
                $lng      = round($titik['lng'] + $dLng, 7);
                $akurasi  = round(4.0 + seed_frac($tanggal . '|' . $uid . '|akurasi') * 16.0, 2);
                $wajahD   = round(0.08 + seed_frac($tanggal . '|' . $uid . '|wajah') * 0.30, 4);
                $wajahC   = round(max(0.60, 1.0 - ($wajahD * 0.9)), 4);
                $sidik    = substr(hash('sha256', 'seed-device|' . $uid), 0, 16);

                $params = [
                    $uid,
                    $tanggal,
                    $tipe,
                    $waktu,
                    'hadir',
                    $lat,
                    $lng,
                    $akurasi,
                    round($jarak, 1),
                    'DITERIMA',
                    100,
                    0,
                    null,
                    $wajahD,
                    $wajahC,
                    'nod,turn_left',
                    $sidik,
                    '127.0.0.1',
                    $waktu,
                ];

                if ($dryRun) {
                    $sudahAda = db_value(
                        'SELECT 1 FROM attendance
                          WHERE user_id = ? AND tanggal = ? AND scan_type = ?
                          LIMIT 1',
                        [$uid, $tanggal, $tipe],
                        null
                    );
                    if ($sudahAda === null) {
                        $hasil['baru']++;
                    } else {
                        $hasil['sudah_ada']++;
                    }
                    continue;
                }

                $stmt->execute($params);
                if ($stmt->rowCount() > 0) {
                    $hasil['baru']++;
                } else {
                    $hasil['sudah_ada']++;
                }
            }
        }

        $kursor = $kursor->modify('+1 day');
    }

    if (!$dryRun && $hasil['baru'] > 0) {
        $pelaku = PHP_SAPI === 'cli' ? null : (int) (current_user()['id'] ?? 0);
        audit_log(
            $pelaku,
            'SEED_ATTENDANCE',
            'info',
            sprintf(
                'Data absensi demo diisi: %s s.d. %s, %d baris baru, %d siswa.',
                $dari,
                $sampai,
                $hasil['baru'],
                $hasil['siswa']
            )
        );
    }

    return $hasil;
}

/* ==================================================================
 |  CLI
 * ================================================================== */

if ($isCli) {
    $opsi = [];
    foreach (array_slice($argv, 1) as $arg) {
        if (preg_match('/^--([a-z-]+)(?:=(.*))?$/', $arg, $m)) {
            $opsi[$m[1]] = $m[2] ?? true;
        }
    }

    if (isset($opsi['help'])) {
        echo "Penggunaan:\n";
        echo "  php seed_absensi.php [--month=YYYY-MM] [--from=YYYY-MM-DD --to=YYYY-MM-DD]\n";
        echo "                         [--include-weekends] [--dry-run]\n\n";
        echo "Rentang bawaan: tanggal 1 bulan lalu sampai hari ini.\n";
        exit(0);
    }

    $hariIni = date('Y-m-d');
    $bawalDari = date('Y-m-01', strtotime('first day of previous month'));

    $dari   = isset($opsi['from']) ? (string) $opsi['from'] : $bawalDari;
    $sampai = isset($opsi['to']) ? (string) $opsi['to'] : $hariIni;

    if (isset($opsi['month'])) {
        $bulan = (string) $opsi['month'];
        if (!preg_match('/^\d{4}-\d{2}$/', $bulan)) {
            fwrite(STDERR, "Format --month harus YYYY-MM.\n");
            exit(1);
        }
        $dari   = $bulan . '-01';
        $sampai = date('Y-m-t', strtotime($dari));
        if (!isset($opsi['to']) && $sampai > $hariIni) {
            $sampai = $hariIni;
        }
    }

    if (!seed_valid_date($dari) || !seed_valid_date($sampai)) {
        fwrite(STDERR, "Tanggal tidak valid. Gunakan format YYYY-MM-DD.\n");
        exit(1);
    }
    if ($dari > $sampai) {
        fwrite(STDERR, "Tanggal awal tidak boleh setelah tanggal akhir.\n");
        exit(1);
    }
    if ($sampai > $hariIni) {
        $sampai = $hariIni;
    }

    try {
        $hasil = seed_absensi_rentang(
            $dari,
            $sampai,
            isset($opsi['dry-run']),
            isset($opsi['include-weekends'])
        );
    } catch (Throwable $e) {
        fwrite(STDERR, 'Gagal: ' . $e->getMessage() . "\n");
        exit(1);
    }

    echo "Driver       : " . db_driver() . "\n";
    echo "Rentang      : {$hasil['dari']} s.d. {$hasil['sampai']}\n";
    echo "Siswa aktif  : {$hasil['siswa']}\n";
    echo "Hari diproses: {$hasil['hari']}\n";
    echo "Baris baru   : {$hasil['baru']}\n";
    echo "Sudah ada    : {$hasil['sudah_ada']}\n";
    echo "Dilewati     : {$hasil['dilewati']} (akhir pekan / waktu belum terjadi)\n";
    if ($hasil['dry_run']) {
        echo "Mode UJI     : tidak ada data yang ditulis.\n";
    }
    exit(0);
}

/* ==================================================================
 |  BROWSER (khusus admin)
 * ================================================================== */

$hariIni   = date('Y-m-d');
$bawalDari = date('Y-m-01', strtotime('first day of previous month'));

$dari       = (string) ($_POST['dari'] ?? $bawalDari);
$sampai     = (string) ($_POST['sampai'] ?? $hariIni);
$weekend    = !empty($_POST['include_weekends']);
$hasil      = null;
$galat      = null;

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    if (!csrf_check($_POST['csrf'] ?? null)) {
        http_response_code(419);
        exit('Token keamanan tidak valid. Muat ulang halaman.');
    }

    if (!seed_valid_date($dari) || !seed_valid_date($sampai)) {
        $galat = 'Tanggal tidak valid. Gunakan format YYYY-MM-DD.';
    } elseif ($dari > $sampai) {
        $galat = 'Tanggal awal tidak boleh setelah tanggal akhir.';
    } else {
        if ($sampai > $hariIni) {
            $sampai = $hariIni;
        }
        try {
            $hasil = seed_absensi_rentang($dari, $sampai, false, $weekend);
        } catch (Throwable $e) {
            $galat = $e->getMessage();
        }
    }
}

$totalAbsensi = (int) db_value('SELECT COUNT(*) FROM attendance', [], 0);
$totalSiswa   = (int) db_value("SELECT COUNT(*) FROM users WHERE role = 'siswa' AND is_active = 1", [], 0);
?><!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Isi Data Absensi Demo</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; background: #f1f5f9;
         margin: 0; padding: 2rem 1rem; color: #0f172a; }
  .card { max-width: 720px; margin: 0 auto; background: #fff; border-radius: 12px;
          padding: 1.75rem; box-shadow: 0 4px 20px rgba(0,0,0,.08); }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
  .sub { color: #64748b; font-size: .9rem; margin-bottom: 1.25rem; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  label { display: block; font-size: .8rem; font-weight: 600; margin: .75rem 0 .25rem; }
  input[type=date] { width: 100%; padding: .55rem .7rem; border: 1px solid #cbd5e1;
                     border-radius: 6px; font-size: .95rem; box-sizing: border-box; }
  .check { display: flex; gap: .5rem; align-items: center; margin-top: 1rem;
           font-size: .9rem; }
  button { margin-top: 1.25rem; width: 100%; padding: .75rem; border: 0; border-radius: 6px;
           background: #2563eb; color: #fff; font-size: .95rem; font-weight: 600;
           cursor: pointer; }
  button:hover { background: #1d4ed8; }
  .alert { padding: .8rem .95rem; border-radius: 6px; font-size: .875rem; margin: 1rem 0; }
  .ok { background: #dcfce7; color: #166534; }
  .err { background: #fee2e2; color: #991b1b; }
  .info { background: #e0f2fe; color: #075985; }
  table { width: 100%; border-collapse: collapse; font-size: .875rem; margin-top: 1rem; }
  th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid #e2e8f0; }
  .muted { color: #64748b; font-size: .82rem; line-height: 1.5; }
  code { background: #f1f5f9; padding: .1rem .3rem; border-radius: 4px; font-size: .85em; }
  a { color: #2563eb; }
</style>
</head>
<body>
<div class="card">
  <h1>Isi Data Absensi Demo</h1>
  <p class="sub">
    Melengkapi catatan presensi masuk &amp; pulang untuk semua siswa aktif.
    Data lama tidak dihapus dan tidak diubah.
  </p>

  <?php if ($galat !== null): ?>
    <div class="alert err"><?= htmlspecialchars($galat) ?></div>
  <?php endif; ?>

  <?php if ($hasil !== null): ?>
    <div class="alert ok">
      Selesai. <strong><?= number_format($hasil['baru']) ?></strong> baris baru ditambahkan,
      <strong><?= number_format($hasil['sudah_ada']) ?></strong> baris sudah ada dan dilewati.
    </div>
    <table>
      <tr><th>Rentang</th><td><?= htmlspecialchars($hasil['dari']) ?> s.d. <?= htmlspecialchars($hasil['sampai']) ?></td></tr>
      <tr><th>Siswa aktif</th><td><?= number_format($hasil['siswa']) ?></td></tr>
      <tr><th>Hari diproses</th><td><?= number_format($hasil['hari']) ?></td></tr>
      <tr><th>Baris baru</th><td><?= number_format($hasil['baru']) ?></td></tr>
      <tr><th>Sudah ada</th><td><?= number_format($hasil['sudah_ada']) ?></td></tr>
    </table>
  <?php endif; ?>

  <div class="alert info">
    Saat ini: <strong><?= number_format($totalSiswa) ?></strong> siswa aktif,
    <strong><?= number_format($totalAbsensi) ?></strong> baris absensi di database.
  </div>

  <form method="post" autocomplete="off">
    <input type="hidden" name="csrf" value="<?= htmlspecialchars(csrf_token()) ?>">
    <div class="grid">
      <div>
        <label for="dari">Dari tanggal</label>
        <input id="dari" name="dari" type="date" value="<?= htmlspecialchars($dari) ?>" required>
      </div>
      <div>
        <label for="sampai">Sampai tanggal</label>
        <input id="sampai" name="sampai" type="date" value="<?= htmlspecialchars($sampai) ?>" required>
      </div>
    </div>
    <label class="check">
      <input type="checkbox" name="include_weekends" value="1" <?= $weekend ? 'checked' : '' ?>>
      Ikutkan Sabtu &amp; Minggu
    </label>
    <button type="submit">Isi data absensi</button>
  </form>

  <p class="muted" style="margin-top:1.25rem">
    Bawaan: tanggal 1 bulan lalu sampai hari ini, hanya hari kerja.
    Untuk menjalankan lewat terminal: <code>php seed_absensi.php</code>.
    Hapus file ini setelah data dirasa cukup bila aplikasi dipakai di server publik.
  </p>
  <p class="muted"><a href="/admin/index.php">&larr; Kembali ke dashboard</a></p>
</div>
</body>
</html>
