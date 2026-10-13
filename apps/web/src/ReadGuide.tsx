export function ReadGuide() {
  return (
    <main id="main-content" tabIndex={-1} className="main-shell experience-page read-guide">
      <header className="experience-intro" aria-labelledby="read-guide-title">
        <p className="experience-kicker">Panduan opsional · bisa dibuka lagi</p>
        <h1 id="read-guide-title">Cara membaca laporan</h1>
        <p className="experience-lead">
          Periksa apa yang dilaporkan, kapan informasi ditinjau, bukti yang mendukungnya,
          dan alasan laporan mungkin berkaitan dengan minat Anda.
        </p>
        <a className="experience-action experience-action--primary" href="#jelajah">
          Lewati panduan, jelajahi laporan
        </a>
      </header>

      <div className="experience-card-grid" aria-label="Empat hal yang perlu dibedakan">
        <section className="experience-card" aria-labelledby="guide-lifecycle-title">
          <p className="experience-kicker">01 · Kejadian</p>
          <h2 id="guide-lifecycle-title">Status kejadian atau dampak</h2>
          <p>
            “Direncanakan”, “Berlangsung”, “Selesai”, atau “Dibatalkan” menjelaskan
            keadaan kejadian atau dampak menurut bukti. Status dampak, seperti layanan
            yang terganggu, dapat berbeda dari status kejadian utamanya.
          </p>
          <p className="experience-note">Jika bukti belum menjelaskannya, statusnya “Belum diketahui”.</p>
        </section>

        <section className="experience-card" aria-labelledby="guide-freshness-title">
          <p className="experience-kicker">02 · Tinjauan</p>
          <h2 id="guide-freshness-title">Kesegaran informasi</h2>
          <p>
            “Dalam batas tinjau saat evaluasi” berarti waktu tinjau yang ditetapkan
            layanan belum lewat saat status dihitung. “Perlu diperbarui” berarti waktu
            tinjau itu sudah lewat; ini tidak otomatis berarti kejadian selesai.
            “Masa berlaku sumber berakhir” berarti rentang berlaku yang ditetapkan
            penerbit telah berakhir; ini berbeda dari waktu tinjau.
          </p>
          <p className="experience-note">
            Kedaluwarsa atau perlu ditinjau ulang tidak berarti kejadian selesai atau wilayah aman.
          </p>
        </section>

        <section className="experience-card" aria-labelledby="guide-evidence-title">
          <p className="experience-kicker">03 · Bukti</p>
          <h2 id="guide-evidence-title">Dukungan untuk klaim</h2>
          <p>
            Label bukti menjelaskan siapa yang menerbitkan atau melaporkan suatu klaim,
            misalnya pemberitahuan resmi dari penerbit yang berwenang, laporan warga,
            atau laporan yang didukung sumber independen.
          </p>
          <p className="experience-note">
            Baca atribusi dan tautan sumber. Kecocokan atau keyakinan model bukan tanda “terverifikasi”.
          </p>
        </section>

        <section className="experience-card" aria-labelledby="guide-relevance-title">
          <p className="experience-kicker">04 · Keterkaitan</p>
          <h2 id="guide-relevance-title">Mengapa laporan muncul</h2>
          <p>
            Keterkaitan menerangkan kecocokan dengan tempat, layanan, institusi,
            kelompok, kategori, atau filter yang dipilih. Ini bukan penilaian kebenaran,
            tingkat bahaya, atau tanda bahwa Anda berada di lokasi tersebut.
          </p>
        </section>
      </div>

      <section className="experience-card experience-card--wide" aria-labelledby="guide-time-title">
        <p className="experience-kicker">Waktu mempunyai arti yang berbeda</p>
        <h2 id="guide-time-title">Perhatikan label waktunya</h2>
        <ul className="experience-list">
          <li><strong>Waktu kejadian:</strong> kapan kejadian berlangsung, jika sumber menyatakannya.</li>
          <li><strong>Waktu pengamatan:</strong> kapan sumber melihat atau mencatat keadaan tersebut.</li>
          <li><strong>Waktu terbit sumber:</strong> kapan penerbit mengeluarkan informasi.</li>
          <li><strong>Waktu sistem mengambil sumber:</strong> kapan layanan memuat sumber; ini tidak mengubah waktu kejadian.</li>
          <li><strong>Masa berlaku:</strong> rentang yang dinyatakan penerbit dan ditampilkan terpisah dari batas tinjau.</li>
        </ul>
        <p className="experience-note">Jam ditampilkan dalam WIB jika ketepatan sumber memungkinkan; tanggal atau rentang tidak diubah menjadi menit yang tidak diketahui.</p>
      </section>

      <section className="experience-card experience-card--wide" aria-labelledby="guide-map-title">
        <p className="experience-kicker">Peta mengikuti bukti</p>
        <h2 id="guide-map-title">Bentuk peta bukan perkiraan bahaya</h2>
        <ul className="experience-list">
          <li>Titik menunjukkan lokasi laporan pada ketelitian yang didukung sumber.</li>
          <li>Batas hanya ditampilkan jika penerbit mendefinisikan wilayah itu beserta cakupannya.</li>
          <li>Ruas jalan atau layanan hanya ditampilkan jika ada dukungan untuk ruas tersebut.</li>
          <li>Informasi tanpa geometri yang berguna tetap tersedia di daftar. “Tidak dipetakan” tidak berarti tidak relevan.</li>
        </ul>
        <p className="experience-caution">
          Titik tidak diperluas menjadi radius bahaya. Peta tidak menjamin rute aman, dan tidak ada laporan yang cocok bukan pernyataan bahwa wilayah aman.
        </p>
      </section>

      <nav className="experience-actions" aria-label="Tindakan panduan">
        <a className="experience-action experience-action--primary" href="#jelajah">Mulai jelajah</a>
        <a className="experience-action experience-action--quiet" href="#privasi">Lihat penggunaan data</a>
      </nav>
    </main>
  );
}
