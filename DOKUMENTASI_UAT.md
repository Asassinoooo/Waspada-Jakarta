# RENCANA DAN TEMPLAT PENGUJIAN PENERIMAAN PENGGUNA (USER ACCEPTANCE TESTING - UAT)
## SISTEM INFORMASI KESELAMATAN SIPIL REAL-TIME — WASPADA JAKARTA

---

**Mata Kuliah:** Rekayasa Perangkat Lunak (RPL)  
**Proyek:** Waspada Jakarta — Live Civic Safety Intelligence Platform  
**Dokumen:** User Acceptance Testing (UAT) Plan & Beta Testing Guide  
**Versi Dokumen:** 1.0 (Tahap Beta / Rilis Akademik)  
**Tanggal Penyusunan:** November 2026  
**Klasifikasi Target Pengguna:** Warga Umum DKI Jakarta, Komuter Harian, Warga Kawasan Rawan, Relawan Bencana, dan Operator/Moderator Keselamatan Sipil  

---

## 1. PENDAHULUAN & TUJUAN UAT

### 1.1 Latar Belakang
User Acceptance Testing (UAT) merupakan tahap pengujian formal terakhir dalam siklus hidup rekayasa perangkat lunak sebelum sistem Waspada Jakarta dinyatakan siap digunakan dalam operasional nyata atau dievaluasi oleh dewan penguji/dosen. Jika pengujian unit (*unit testing*) memverifikasi kebenaran teknis algoritma dan modul individual dari sudut pandang pengembang, maka UAT memverifikasi sistem dari sudut pandang **pengguna akhir (*end-users*)**: apakah sistem menyelesaikan masalah keselamatan sipil secara intuitif, transparan, cepat, dan dapat dipercaya (*trustworthy*).

### 1.2 Tujuan Pengujian Penerimaan Pengguna
1. **Validasi Alur Perjalanan Pengguna (*User Journeys*):** Memastikan warga dapat mengakses informasi bencana/gangguan sipil secara instan tanpa hambatan pendaftaran (*account-free first access*).
2. **Evaluasi Transparansi Bukti & Integritas AI (*AI Transparency & Trust*):** Menguji apakah pengguna dapat memahami perbedaan antara data fakta mentah dari media terverifikasi (Detik, Antara, BPBD, BMKG) dan hasil rekonsiliasi model AI, tanpa asumsi keliru mengenai "verifikasi mutlak".
3. **Verifikasi Kejelasan Peringatan Kontradiksi (*Discrepancy Alerts*):** Menguji reaksi dan pemahaman pengguna saat sistem menampilkan laporan multi-sumber yang berkonflik (misalnya selisih ketinggian air banjir atau perbedaan angka korban).
4. **Pengujian Kemudahan Penggunaan (*Usability & Accessibility*):** Mengukur metrik kegunaan menggunakan standar *System Usability Scale* (SUS) dan kepatuhan aksesibilitas WCAG 2.1 pada berbagai perangkat (ponsel cerdas, tablet, dan desktop).
5. **Validasi Konsol Moderasi (*Moderator Workflows*):** Memastikan moderator lapangan dapat meninjau antrean proposal, membaca bukti verbatim, dan mengambil keputusan rilis secara efisien.

---

## 2. PROFIL PENGGUNA TARGET & PERSONA BETA TESTER

Pengujian UAT melibatkan perwakilan pengguna yang merefleksikan demografi pengguna sistem Waspada Jakarta:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              TARGET USER PERSONAS                                      │
├──────────────────────┬────────────────────────────────┬────────────────────────────────┤
│ Persona              │ Peran & Karakteristik          │ Kebutuhan Kunci Pengujian      │
├──────────────────────┼────────────────────────────────┼────────────────────────────────┤
│ 1. Komuter Harian    │ Pekerja/mahasiswa yang melin-  │ Peta cepat, filter rute jalan/ │
│    (Daily Commuter)  │ tasi wilayah Jakarta tiap hari │ banjir, akses tanpa perlu login│
├──────────────────────┼────────────────────────────────┼────────────────────────────────┤
│ 2. Warga Kawasan     │ Warga pemukiman rawan genangan │ Detail ketinggian air, waktu   │
│    Rawan Banjir      │ (Kampung Melayu, Rawajati, dll)│ pembaruan, peringatan konflik  │
├──────────────────────┼────────────────────────────────┼────────────────────────────────┤
│ 3. Relawan & Pegiat  │ Komunitas tanggap darurat /    │ Sumber primer (BMKG/BPBD),     │
│    Keselamatan Sipil │ jurnalis warga                 │ riwayat klaim, transparansi data│
├──────────────────────┼────────────────────────────────┼────────────────────────────────┤
│ 4. Operator Moderator│ Tim peninjau verifikasi        │ Antrean proposal multi-sumber, │
│    (Safety Moderator)│ kebenaran laporan publik       │ deteksi anomali, aksi triage   │
├──────────────────────┼────────────────────────────────┼────────────────────────────────┤
│ 5. Evaluator Riset   │ Dosen/asisten/penguji akademik │ Visualisasi vektor 3D PCA,     │
│    & Analis Sistem   │ rekayasa perangkat lunak       │ ketahanan fallback AI, kontrak │
└──────────────────────┴────────────────────────────────┴────────────────────────────────┘
```

---

## 3. KOMPONEN & FITUR YANG DIUJI DALAM BETA TEST

Daftar modul fungsional yang wajib diuji oleh pengguna akhir mencakup 7 komponen inti:

### Komponen 1: Halaman Depan & Panduan Membaca (*Landing & Reading Guide*)
* **Rute Navigasi:** `#landing`
* **Hal yang Diuji:**
  * Keterbacaan teks sambutan dan ilustrasi Jakarta (*non-misleading hero graphics*).
  * Kejelasan tombol akses cepat: *"Jelajahi laporan publik tanpa akun"*.
  * Interaktivitas panel edukasi: Tab *"Laporan"*, *"Bukti"*, dan *"Konteks"* yang menjelaskan batasan data tanpa klaim keselamatan palsu.

### Komponen 2: Peta Geospasial & Feed Laporan Publik (*Interactive Map & Feed*)
* **Rute Navigasi:** `#jelajah` / Halaman Beranda Publik
* **Hal yang Diuji:**
  * Responsivitas navigasi peta (geser/pan, perbesar/zoom, klik pin penanda insiden).
  * Sinkronisasi dua arah: Klik pin di peta otomatis menyorot kartu laporan di daftar bawah, dan sebaliknya.
  * Filter kategori insiden: Banjir/Cuaca (`disasters_weather`), Lalu Lintas/Jalan (`transport_road_incidents`), Kebakaran, dan Layanan Publik.
  * Filter status kesegaran (*freshness*): Terkini (*current*), Perlu Pembaruan (*needs_update*), atau Kadaluarsa (*expired*).
  * Pencarian kata kunci wilayah (misal: "Cilandak", "Grogol", "Tebet").

### Komponen 3: Detail Insiden, Bukti Klaim, & Peringatan Konflik (*Incident Detail & Claims*)
* **Rute Navigasi:** `#detail/api/:eventId`
* **Hal yang Diuji:**
  * Penjelasan waktu kejadian: Membedakan waktu terbit berita vs waktu fisik kejadian (*exact, range, date-only*).
  * Label bukti transparan: Identifikasi apakah klaim didukung oleh pemberitahuan resmi instansi (*issuer_notice*) atau koroborasi independen (*independent_corroboration*).
  * **Peringatan Perbedaan Fakta (*Discrepancy Banner*):** Tampilan visual yang jelas ketika ada perbedaan data tinggi air atau korban antar-media, lengkap dengan kutipan masing-masing sumber.
  * Riwayat pembaruan dan audit revisi laporan (*incident timeline*).

### Komponen 4: Preferensi Minat Wilayah & Pusat Pembaruan (*Preferences & Updates Center*)
* **Rute Navigasi:** `#ringkasan-saya` dan `#updates`
* **Hal yang Diuji:**
  * Pemilihan kelurahan dan kecamatan favorit tanpa memerlukan akun/login.
  * Penyimpanan preferensi secara lokal di peramban pengguna (*browser localStorage privacy*).
  * Pembaruan berkala otomatis (*polling updates*) berdasarkan filter wilayah yang dipilih pengguna.
  * Penanda lencana pembaruan terkini (*unread update badges*).

### Komponen 5: Konsol Moderasi Laporan Multi-Sumber (*Moderator Review Console*)
* **Rute Navigasi:** `#review`
* **Hal yang Diuji:**
  * Antrean proposal insiden hasil rekonsiliasi AI.
  * Tampilan lencana koroborasi multi-sumber (*Multi-Source Corroborated Proposal*).
  * Peninjauan detail konflik fakta sebelum dipublikasikan ke masyarakat luas.
  * Keputusan moderasi: Tombol *Accept* (setujui publikasi), *Hold* (tahan untuk verifikasi lapangan), dan *Reject* (tolak).

### Komponen 6: Visualisasi Vektor Semantik 3D (*3D Embedding Space Exploration*)
* **Rute Navigasi:** `#embedding-3d`
* **Hal yang Diuji:**
  * Interaksi grafis 3D WebGL Three.js: Rotasi kamera orbit, zoom, dan panning dalam ruang 3 dimensi.
  * Pembentukan kluster berita: Berita dengan topik serupa (misal sesama banjir) berkumpul dalam kelompok ruang yang sama.
  * Pemeriksaan titik embedding: Klik salah satu partikel/titik menampilkan teks ringkasan berita aslinya dan 5 tetangga terdekat (*nearest neighbors*).

### Komponen 7: Aksesibilitas & Responsivitas (*A11y, Mobile, & Usability*)
* **Hal yang Diuji:**
  * Tampilan responsif pada ponsel Android/iOS dan layar desktop layar lebar.
  * Dukungan navigasi papan ketik (*Keyboard-only navigation* via tombol Tab dan Enter).
  * Kepatuhan kontras teks terhadap latar belakang (WCAG AAA/AA).
  * Kejelasan pesan saat jaringan terputus (*offline/retry state*).

---

## 4. SKENARIO PENGUJIAN UAT (END-TO-END TEST SCENARIOS)

Berikut adalah 5 skenario uji terpandu (*guided test journeys*) yang diberikan kepada beta tester:

### Skenario UAT 1: Warga Mengecek Situasi Banjir Pagi Hari Tanpa Akun
* **Tujuan:** Memvalidasi kecepatan akses, kejelasan peta, dan filter insiden saat warga butuh info darurat.
* **Langkah-langkah:**
  1. Buka halaman utama aplikasi Waspada Jakarta di peramban ponsel.
  2. Klik tombol *"Jelajahi laporan tanpa akun"*.
  3. Pada halaman peta, klik chip filter *"Banjir/Cuaca"*.
  4. Ketik *"Jakarta Selatan"* di kolom pencarian.
  5. Pilih salah satu pin penanda di peta untuk membuka kartu ringkasan kejadian.
* **Kriteria Keberhasilan:**
  * Pengguna berhasil menemukan laporan genangan dalam waktu $\le 30$ detik tanpa hambatan pop-up login atau iklan.
  * Pin yang dipilih menampilkan lokasi yang akurat dan sesuai dengan kartu laporan di bawah peta.

---

### Skenario UAT 2: Warga Membaca Bukti dan Menemukan Perbedaan Fakta Laporan
* **Tujuan:** Menguji pemahaman pengguna terhadap klaim bukti dan penanganan perbedaan data antar-media (*discrepancy detection*).
* **Langkah-langkah:**
  1. Dari daftar laporan banjir, pilih insiden yang memiliki lencana *"Multi-Sumber"*.
  2. Klik *"Buka detail laporan"*.
  3. Perhatikan bagian *"Klaim Bukti & Sumber Berita"*.
  4. Periksa apakah terdapat kotak peringatan *"Perbedaan Laporan Fakta"*.
  5. Baca perbandingan kutipan berita antara dua media yang berbeda (contoh: Detik menyebut 40 cm, Antara menyebut 80 cm).
* **Kriteria Keberhasilan:**
  * Pengguna memahami bahwa data berasal dari dua media berbeda dengan estimasi berbeda, bukan kesalahan sistem.
  * Pengguna dapat mengklik tautan sumber asli untuk memverifikasi berita langsung di situs penerbit.

---

### Skenario UAT 3: Warga Mengatur Wilayah Tempat Tinggal & Memantau Pembaruan
* **Tujuan:** Memvalidasi kemudahan kustomisasi wilayah tanpa pelanggaran privasi data pengguna.
* **Langkah-langkah:**
  1. Buka menu *"Atur Minat / Ringkasan Saya"* (`#ringkasan-saya`).
  2. Pilih kecamatan dan kelurahan domisili (contoh: *"Kebayoran Baru - Senayan"*).
  3. Simpan preferensi.
  4. Buka tab *"Pusat Pembaruan"* (`#updates`).
  5. Periksa apakah sistem hanya menampilkan kabar keselamatan yang relevan dengan wilayah yang dipilih.
* **Kriteria Keberhasilan:**
  * Preferensi tersimpan tanpa meminta email, nomor telepon, atau data sensitif.
  * Saat halaman dimuat ulang (*refresh*), preferensi wilayah tetap tersimpan di peramban.

---

### Skenario UAT 4: Moderator Meninjau Proposal Insiden & Menangani Anomali
* **Tujuan:** Memverifikasi efisiensi kerja moderator dalam memvalidasi data AI sebelum dipublikasikan.
* **Langkah-langkah:**
  1. Buka konsol moderasi (`#review`).
  2. Pilih proposal teratas pada antrean peninjauan.
  3. Periksa kesesuaian kategori usulan AI dengan teks berita sumber.
  4. Amati apakah sistem menandai anomali (*discrepancy flag*).
  5. Tentukan keputusan: klik *"Setujui (Accept)"* jika valid, atau *"Tahan (Hold)"* jika membutuhkan verifikasi lapangan tambahan.
* **Kriteria Keberhasilan:**
  * Moderator dapat melihat ringkasan bukti dalam 1 layar tanpa perlu berpindah tab peramban.
  * Aksi persetujuan memperbarui status laporan secara seketika (*real-time*).

---

### Skenario UAT 5: Peneliti Mengeksplorasi Representasi Vektor Berita 3D
* **Tujuan:** Menguji fitur inovatif visualisasi clustering embedding berita untuk evaluasi ilmiah.
* **Langkah-langkah:**
  1. Akses menu *"Visualisasi 3D"* (`#embedding-3d`).
  2. Gunakan mouse/sentuhan jari untuk memutar sumbu 3D ($X, Y, Z$) dan memperbesar kluster partikel berita.
  3. Klik salah satu titik berita pada kluster kebakaran.
  4. Periksa daftar 5 berita terdekat secara semantik di panel inspeksi sebelah kanan.
* **Kriteria Keberhasilan:**
  * Visualisasi WebGL berputar dengan lancar tanpa lag ($\ge 30\text{ FPS}$).
  * Berita terdekat memiliki kemiripan topik kosinus (*cosine similarity*) yang logis dan konsisten.

---

## 5. TEMPLAT FORMULIR PENGUJIAN UAT (UAT TEST EXECUTION FORM)

Berikut adalah instrumen pengujian formal yang dibagikan kepada penguji (*tester sheet*):

### Identitas Penguji (Tester Information)
* **Nama Penguji / Mahasiswa:** `[ ..................................................... ]`
* **Role / Persona Uji:** `[ ] Warga Komuter  [ ] Warga Area Rawan  [ ] Relawan  [ ] Moderator  [ ] Akademisi`
* **Perangkat yang Digunakan:** `[ ] Ponsel Android  [ ] iPhone (iOS)  [ ] Laptop / PC Desktop`
* **Peramban (*Browser*):** `[ ] Google Chrome  [ ] Mozilla Firefox  [ ] Safari  [ ] Microsoft Edge`
* **Waktu Pengujian:** `[ Tanggal / Jam ......................................... ]`

---

### Tabel Lembar Kerja Kasus Uji UAT (UAT Checklist Matrix)

| No. | Kode Kasus Uji | Modul / Komponen | Instruksi Skenario Uji | Hasil yang Diharapkan | Hasil Aktual Pengguna | Status (Pass/Fail/Notes) | Rating (1-5) |
| :---: | :---: | :--- | :--- | :--- | :--- | :---: | :---: |
| **1** | **UAT-LND-01** | Landing Page | Buka tautan beranda utama aplikasi. | Halaman terbuka cepat, teks hero jelas, tidak ada tuntutan registrasi akun. | | | |
| **2** | **UAT-LND-02** | Reading Guide | Klik tab "Laporan", "Bukti", dan "Konteks". | Deskripsi panduan berganti lancar, menjelaskan batas keabsahan data secara jujur. | | | |
| **3** | **UAT-MAP-01** | Peta Insiden | Geser peta dan lakukan zoom ke kawasan Jakarta Pusat. | Peta memuat koordinat Jakarta dengan mulus, pin insiden tampak jelas. | | | |
| **4** | **UAT-MAP-02** | Sinkronisasi Pin | Klik salah satu pin genangan air di peta. | Kartu insiden terkait otomatis tersorot dan menampilkan ringkasan kejadian. | | | |
| **5** | **UAT-FLT-01** | Filter Kategori | Pilih filter "Banjir/Cuaca". | Daftar laporan hanya menyisakan kejadian banjir; kategori lain tersembunyi. | | | |
| **6** | **UAT-FLT-02** | Pencarian Wilayah | Masukkan nama kecamatan (misal: "Kebayoran Baru"). | Laporan terfilter sesuai kecocokan nama wilayah geospasial Jakarta. | | | |
| **7** | **UAT-DTL-01** | Detail Insiden | Buka halaman rincian laporan insiden publik. | Menampilkan estimasi waktu kejadian, kategori, dan deskripsi dampak secara rapi. | | | |
| **8** | **UAT-DTL-02** | Klaim & Sumber | Periksa kutipan bukti di bagian detail. | Terlihat nama media asal, tautan ke berita asli, dan label derajat dukungan bukti. | | | |
| **9** | **UAT-COR-01** | Deteksi Konflik | Buka insiden banjir dengan flag perbedaan fakta. | Muncul peringatan jelas jika Detik vs Antara beda tinggi air/korban tanpa memaksakan 1 angka. | | | |
| **10**| **UAT-PRF-01** | Preferensi Minat | Masukkan 2 kelurahan tempat beraktivitas lalu simpan. | Preferensi berhasil disimpan secara lokal tanpa meminta identitas pribadi. | | | |
| **11**| **UAT-UPD-01** | Pusat Pembaruan | Buka halaman Updates setelah preferensi diisi. | Muncul daftar pembaruan status terkini khusus untuk wilayah yang diminati. | | | |
| **12**| **UAT-MOD-01** | Moderator Queue | Akses halaman review antrean proposal moderator. | Menampilkan proposal insiden yang menunggu verifikasi beserta analisis AI. | | | |
| **13**| **UAT-MOD-02** | Aksi Moderasi | Lakukan aksi Accept pada salah satu proposal. | Status proposal berpindah ke disetujui dan tercatat dalam log audit sistem. | | | |
| **14**| **UAT-VIS-01** | Visualisasi 3D | Buka ruang visualisasi embedding 3D Three.js. | Partikel 3D dapat diputar dan diperbesar dengan lancar di layar perangkat. | | | |
| **15**| **UAT-VIS-02** | Inspeksi Kluster | Klik satu titik partikel berita dalam ruang 3D. | Menampilkan judul berita asal dan 5 berita terdekat berdasarkan kesamaan makna. | | | |
| **16**| **UAT-A11-01** | Aksesibilitas | Navigasi seluruh situs hanya menggunakan tombol TAB/Enter. | Indikator fokus terlihat jelas, seluruh tombol dan tautan dapat diakses tanpa mouse. | | | |
| **17**| **UAT-MOB-01** | Tampilan Mobile | Uji seluruh alur menggunakan peramban browser HP. | Tata letak tidak terpotong, teks nyaman dibaca, tombol ramah sentuhan jari (*touch-friendly*). | | | |

---

## 6. KUESIONER STANDAR USABILITY & TRUSTWORTHINESS

Setelah menyelesaikan seluruh skenario di atas, setiap tester diminta mengisi 2 kuesioner evaluasi:

### Bagian A: System Usability Scale (SUS) Standar
Beri penilaian dari angka **1 (Sangat Tidak Setuju)** hingga **5 (Sangat Setuju)**:

1. Saya merasa akan sering menggunakan sistem Waspada Jakarta saat ada potensi cuaca buruk / gangguan jalan. `[ 1 | 2 | 3 | 4 | 5 ]`
2. Saya merasa sistem ini terlalu rumit untuk digunakan oleh orang awam. `[ 1 | 2 | 3 | 4 | 5 ]`
3. Saya merasa antarmuka sistem Waspada Jakarta mudah digunakan. `[ 1 | 2 | 3 | 4 | 5 ]`
4. Saya merasa membutuhkan bantuan orang lain untuk dapat memahami navigasi sistem ini. `[ 1 | 2 | 3 | 4 | 5 ]`
5. Saya merasa fitur-fitur di dalam sistem (peta, filter, detail bukti) terintegrasi dengan sangat baik. `[ 1 | 2 | 3 | 4 | 5 ]`
6. Saya merasa ada terlalu banyak inkonsistensi pada tampilan aplikasi. `[ 1 | 2 | 3 | 4 | 5 ]`
7. Saya merasa orang lain dapat mempelajari cara menggunakan aplikasi ini dengan sangat cepat. `[ 1 | 2 | 3 | 4 | 5 ]`
8. Saya merasa aplikasi ini membingungkan saat pertama kali diakses. `[ 1 | 2 | 3 | 4 | 5 ]`
9. Saya merasa percaya diri saat menjelajahi laporan keselamatan di sistem ini. `[ 1 | 2 | 3 | 4 | 5 ]`
10. Saya merasa harus belajar banyak hal terlebih dahulu sebelum mengerti cara membaca laporan di sistem ini. `[ 1 | 2 | 3 | 4 | 5 ]`

> **Formula Skor SUS:**  
> $\text{Skor Pertanyaan Ganjil} = (\text{Skor} - 1)$  
> $\text{Skor Pertanyaan Genap} = (5 - \text{Skor})$  
> $\text{Total Skor SUS} = \sum (\text{Skor Terbobot}) \times 2.5$ (Rentang: 0 – 100, Target $\ge 75$ atau Grade A/B).

---

### Bagian B: AI Transparency, Discrepancy & Civic Trust Rubric
Beri penilaian dari angka **1 (Sangat Tidak Setuju)** hingga **5 (Sangat Setuju)**:

1. **Kejelasan Sumber Asal:** Saya tahu persis dari media atau instansi mana informasi insiden tersebut didapatkan. `[ 1 | 2 | 3 | 4 | 5 ]`
2. **Keterbukaan Perbedaan Fakta (*Discrepancy Clarity*):** Ketika dua media berbeda melaporkan ketinggian banjir yang berbeda, cara sistem menampilkan perbedaan tersebut terasa jujur dan membantu saya lebih waspada. `[ 1 | 2 | 3 | 4 | 5 ]`
3. **Ketiadaan Halusinasi / Klaim Palsu:** Sistem tidak terasa mengarang-ngarang kejadian yang tidak ada dasarnya. `[ 1 | 2 | 3 | 4 | 5 ]`
4. **Kenyamanan Privasi:** Saya merasa aman karena sistem tidak memaksa meminta data pribadi atau akun media sosial untuk sekadar membaca info bahaya. `[ 1 | 2 | 3 | 4 | 5 ]`
5. **Kesiapan Digunakan Sehari-hari:** Saya bersedia merekomendasikan Waspada Jakarta kepada keluarga dan rekan kerja di Jakarta. `[ 1 | 2 | 3 | 4 | 5 ]`

---

## 7. KRITERIA PENERIMAAN & KELULUSAN UAT (ACCEPTANCE & EXIT CRITERIA)

Pengujian Penerimaan Pengguna dinyatakan **DITERIMA (*ACCEPTED*)** apabila memenuhi seluruh ambang batas berikut:

| Kriteria Evaluasi | Ambang Batas Minimal (*Threshold*) | Status Evaluasi |
| :--- | :---: | :---: |
| **Tingkat Kelulusan Kasus Uji Kritis (UAT-01 s.d UAT-11)** | **100% Pass** (Tidak boleh ada fitur kunci yang crash/gagal) | Wajib Terpenuhi |
| **Tingkat Kelulusan Kasus Uji Pendukung (3D & Moderasi)** | $\ge 90\%$ Pass | Wajib Terpenuhi |
| **Rata-rata Skor System Usability Scale (SUS)** | **$\ge 75$** (Kategori *Good* hingga *Excellent*) | Target Metrik |
| **Tingkat Kepuasan Transparansi Bukti AI** | Rata-rata $\ge 4.0$ dari skala 5.0 | Target Metrik |
| **Tingkat Bug Kritis / Pemblokir (*Blocker Defects*)** | **0 Bug Kritis** yang belum terselesaikan | Wajib Terpenuhi |

---

## 8. FORMULIR PELAPORAN CACAT & UMPAN BALIK UAT (DEFECT LOGGING FORM)

Jika tester menemukan kelemahan, kebingungan antarmuka, atau galat fungsional selama pengujian, formulir berikut digunakan untuk merekam temuan:

```text
================================================================================
                    LEMBAR LAPORAN DEFECT / FEEDBACK UAT
================================================================================
ID Laporan        : DEF-UAT-____ (contoh: DEF-UAT-001)
Kode Kasus Uji    : [ UAT-___-___ ]
Tingkat Keparahan : [ ] Blocker (Sistem macet/crash)
                    [ ] Major (Fungsi tidak bekerja sebagaimana mestinya)
                    [ ] Minor (Masalah teks/tampilan/glitch kosmetik)
                    [ ] Saran Perbaikan (Peningkatan UX/Usability)

Deskripsi Masalah : 
................................................................................
................................................................................

Langkah Menemukan Masalah (Steps to Reproduce):
1. Buka halaman: ...............................................................
2. Klik tombol: ................................................................
3. Hasil yang muncul: ..........................................................

Ekspektasi Pengguna:
................................................................................

Tangkapan Layar (Screenshot URL / Lampiran):
[ Lampirkan berkas gambar jika ada ]

Status Tindak Lanjut: [ ] Open  [ ] Investigating  [ ] Fixed  [ ] Closed
================================================================================
```

---

## 9. KESIMPULAN

Dokumen Rencana dan Templat UAT ini menjadi panduan baku bagi tim pengembang Waspada Jakarta dalam memandu pengujian langsung di hadapan calon pengguna akhir dan dewan dosen. Melalui metodologi yang menggabungkan verifikasi fungsional, pengujian skenario berbasis persona, metrik *System Usability Scale* (SUS), serta evaluasi khusus transparansi rekonsiliasi AI multi-sumber, Waspada Jakarta dapat membuktikan kesiapan fungsional dan kelayakan produknya sebagai sistem informasi keselamatan sipil yang handal, etis, dan akuntabel.
